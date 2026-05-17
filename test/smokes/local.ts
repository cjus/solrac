// Live smoke: drives runEngineTurn against a real engine-slot backend (Ollama,
// LMStudio, or OpenRouter) with a stub Telegram client. Proves the whole
// pipeline end-to-end without touching the live bot or .env:
//   1. Driver event-stream parsing matches what the real backend emits.
//   2. Audit row finalizes correctly (model='<mode>:<backend>:<name>',
//      cost_usd matches the mode: 0 for local, > 0 for remote, tokens populated).
//   3. History reconstruction (turn 2 sees turn 1's prompt+response).
//   4. Telegram render path (stub-then-edit) produces sensible final text.
//   5. (tools-on) A time_now tool call round-trips via runToolLoop; audit
//      row's tool_calls JSON references the tool. Skipped unless
//      `LOCAL_TOOLS_ENABLED=true` in env.
//
// Runs against http://localhost:11434 (ollama default) or :1234 (lmstudio
// default) per the backend. Override via env:
//   LOCAL_BACKEND=ollama LOCAL_MODEL=gemma4:e4b npm run smoke:local
//   LOCAL_BACKEND=lmstudio LOCAL_MODEL=qwen2.5-7b npm run smoke:local
//
// OpenRouter (remote) mode — requires REMOTE_API_KEY; charges per-token:
//   LOCAL_BACKEND=openrouter LOCAL_MODEL=openai/gpt-4o-mini REMOTE_API_KEY=sk-or-… npm run smoke:local
//
// To exercise the tools-on path:
//   LOCAL_TOOLS_ENABLED=true npm run smoke:local

import type { Message } from "@grammyjs/types";
import { runEngineTurn } from "../../src/engine.ts";
import type { EngineBackend, EngineDriver } from "../../src/engine-driver.ts";
import { createLocalDriver } from "../../src/local-driver.ts";
import { createRemoteDriver } from "../../src/remote-driver.ts";
import type { ConfirmationBroker } from "../../src/policy.ts";
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import timeIntegration from "../../src/integrations-builtin/time/index.ts";
import { createIntegrationContext } from "../../src/integrations.ts";
import type { TelegramClient } from "../../src/telegram.ts";
import { openTestDb, reportAndExit, type Phase } from "./harness.ts";

const BACKEND = parseBackend(process.env.LOCAL_BACKEND);
// Remote mode kicks in only when LOCAL_BACKEND=openrouter. The same env knob
// covers all three backends to keep the smoke surface small.
const MODE: "local" | "remote" = BACKEND === "openrouter" ? "remote" : "local";
const REMOTE_API_KEY = process.env.REMOTE_API_KEY ?? "";
const URL =
  process.env.LOCAL_URL ??
  (BACKEND === "openrouter"
    ? "https://openrouter.ai/api/v1"
    : BACKEND === "lmstudio"
      ? "http://localhost:1234"
      : "http://localhost:11434");
const MODEL =
  process.env.LOCAL_MODEL ??
  (BACKEND === "openrouter"
    ? "openai/gpt-4o-mini"
    : BACKEND === "lmstudio"
      ? "qwen2.5-7b"
      : "gemma4:e4b");

function parseBackend(raw: string | undefined): EngineBackend {
  if (raw === "lmstudio") return "lmstudio";
  if (raw === "openrouter") return "openrouter";
  return "ollama";
}

// Backend-specific hint substring expected in error messages for the
// bad-model phase. Each backend has its own "model missing" copy.
const PULL_HINT =
  BACKEND === "openrouter"
    ? "openrouter"
    : BACKEND === "lmstudio"
      ? "lms load"
      : "ollama pull";

// Hard-skip OpenRouter without a key — the smoke makes real billed API
// calls. Print a clear message + exit 0 so CI / sweep runs don't break.
if (BACKEND === "openrouter" && !REMOTE_API_KEY) {
  // eslint-disable-next-line no-console
  console.log(
    "local-smoke: BACKEND=openrouter requested but REMOTE_API_KEY is not set. " +
      "Skipping (this smoke makes real billed API calls; set REMOTE_API_KEY to run).",
  );
  process.exit(0);
}

interface CapturedTg extends TelegramClient {
  sent: { chatId: number; text: string }[];
  edits: { chatId: number; messageId: number; text: string }[];
}

function makeCapturedTg(): CapturedTg {
  const sent: CapturedTg["sent"] = [];
  const edits: CapturedTg["edits"] = [];
  const tg: Partial<CapturedTg> = {
    sent,
    edits,
    sendMessage: async (chatId, text) => {
      sent.push({ chatId, text });
      const msg: Message = {
        message_id: sent.length,
        date: 0,
        chat: { id: chatId, type: "private" },
      } as Message;
      return msg;
    },
    editMessageText: async (chatId, messageId, text) => {
      edits.push({ chatId, messageId, text });
      return true;
    },
  };
  return tg as CapturedTg;
}

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(`local-smoke: BACKEND=${BACKEND} URL=${URL} MODEL=${MODEL}`);

  const { db } = await openTestDb("local-smoke");
  const tg = makeCapturedTg();
  const driver: EngineDriver =
    BACKEND === "openrouter"
      ? createRemoteDriver(BACKEND, { url: URL, apiKey: REMOTE_API_KEY })
      : createLocalDriver(BACKEND, { url: URL });
  const deps = {
    tg,
    db,
    driver,
    model: MODEL,
    timeoutMs: 120_000,
    historyLimit: 6,
    // No SOLRAC.md path on disk → `readInstanceMd` returns null and no overlay
    // block is sent.
    soul: "You are Solrac (smoke).",
    instanceMdPath: "/tmp/solrac-local-smoke-no-such-file.md",
  };

  const phases: Phase[] = [];
  const CHAT = 8001;
  const FROM = 9001;
  const EXPECTED_MODEL_TAG = `${MODE}:${BACKEND}:${MODEL}`;

  // ── Turn 1: cold call. No history, just system + user. ────────────────────
  const t0 = Date.now();
  await runEngineTurn(deps, {
    chatId: CHAT,
    fromId: FROM,
    updateId: 1001,
    prompt: "Reply with exactly the word: pineapple",
  });
  const elapsed1 = Date.now() - t0;
  // eslint-disable-next-line no-console
  console.log(`turn 1: elapsed ${elapsed1}ms; ${tg.edits.length} edits`);

  const row1 = db.raw
    .query(
      "SELECT status, response, cost_usd, agent_session_id, tool_calls, model, input_tokens, output_tokens FROM audit WHERE id = 1",
    )
    .get() as {
    status: string;
    response: string | null;
    cost_usd: number | null;
    agent_session_id: string | null;
    tool_calls: string | null;
    model: string;
    input_tokens: number | null;
    output_tokens: number | null;
  };

  phases.push({
    name: "turn 1: audit row finalized status=ok",
    expected: "status=ok",
    actual: `status=${row1.status}`,
    pass: row1.status === "ok",
  });
  phases.push({
    name: `turn 1: model column tagged ${MODE}:<backend>:<name>`,
    expected: `model=${EXPECTED_MODEL_TAG}`,
    actual: `model=${row1.model}`,
    pass: row1.model === EXPECTED_MODEL_TAG,
  });
  // Cost expectation forks on mode:
  //   local  → exactly 0 (on-host backends are free).
  //   remote → > 0 (OpenRouter bills per turn; the streaming usage.cost
  //            field flowed through resolveAuditCost into audit.cost_usd).
  phases.push({
    name:
      MODE === "remote"
        ? "turn 1: cost_usd > 0 (remote mode captures OpenRouter cost)"
        : "turn 1: cost_usd is 0 (local engine is free)",
    expected: MODE === "remote" ? "cost_usd > 0" : "cost_usd=0",
    actual: `cost_usd=${row1.cost_usd}`,
    pass:
      MODE === "remote"
        ? typeof row1.cost_usd === "number" && row1.cost_usd > 0
        : row1.cost_usd === 0,
  });
  phases.push({
    name: "turn 1: agent_session_id null (local engine is sessionless)",
    expected: "agent_session_id=null",
    actual: `agent_session_id=${row1.agent_session_id}`,
    pass: row1.agent_session_id === null,
  });
  phases.push({
    name: "turn 1: tool_calls null (pure inference)",
    expected: "tool_calls=null",
    actual: `tool_calls=${row1.tool_calls}`,
    pass: row1.tool_calls === null,
  });
  phases.push({
    name: "turn 1: input_tokens populated from done event",
    expected: "input_tokens > 0",
    actual: `input_tokens=${row1.input_tokens}`,
    pass: typeof row1.input_tokens === "number" && row1.input_tokens > 0,
  });
  phases.push({
    name: "turn 1: output_tokens populated from done event",
    expected: "output_tokens > 0",
    actual: `output_tokens=${row1.output_tokens}`,
    pass: typeof row1.output_tokens === "number" && row1.output_tokens > 0,
  });
  phases.push({
    name: "turn 1: response non-empty",
    expected: "response.length > 0",
    actual: `response.length=${row1.response?.length ?? 0}`,
    pass: typeof row1.response === "string" && row1.response.length > 0,
  });

  // The bot sent exactly one stub message (💻 thinking…) then issued ≥1 edits
  // as the stream came in. Final edit must contain footer with model + secs.
  phases.push({
    name: "turn 1: stub message sent once",
    expected: "sent.length=1",
    actual: `sent.length=${tg.sent.length}`,
    pass: tg.sent.length === 1,
  });
  phases.push({
    name: "turn 1: at least one streaming/final edit",
    expected: "edits.length >= 1",
    actual: `edits.length=${tg.edits.length}`,
    pass: tg.edits.length >= 1,
  });
  const lastEdit1 = tg.edits[tg.edits.length - 1]?.text ?? "";
  const footerRe = new RegExp(`local:${escapeRegex(BACKEND)}:${escapeRegex(MODEL)} · \\d+\\.\\ds`);
  phases.push({
    name: "turn 1: final edit carries footer with model + seconds",
    expected: `footer matches ${footerRe}`,
    actual: `last edit ends with: …${lastEdit1.slice(-80)}`,
    pass: footerRe.test(lastEdit1),
  });

  // ── Turn 2: follow-up. recentChatTurns now returns turn 1. ────────────────
  const tg2 = makeCapturedTg();
  await runEngineTurn(
    { ...deps, tg: tg2 },
    {
      chatId: CHAT,
      fromId: FROM,
      updateId: 1002,
      prompt: "What word did you just say?",
    },
  );
  const row2 = db.raw
    .query("SELECT status, response, model FROM audit WHERE id = 2")
    .get() as { status: string; response: string | null; model: string };
  phases.push({
    name: "turn 2: audit row finalized status=ok",
    expected: "status=ok",
    actual: `status=${row2.status}`,
    pass: row2.status === "ok",
  });
  phases.push({
    name: `turn 2: model column tagged ${MODE}:<backend>:<name>`,
    expected: `model=${EXPECTED_MODEL_TAG}`,
    actual: `model=${row2.model}`,
    pass: row2.model === EXPECTED_MODEL_TAG,
  });

  const history = db.recentChatTurns(CHAT, 6);
  phases.push({
    name: "recentChatTurns returns 2 chronological rows",
    expected: "length=2; [0].prompt='Reply with exactly...', [1].prompt='What word...'",
    actual: `length=${history.length}; [0].prompt='${truncate(history[0]?.prompt ?? "", 30)}', [1].prompt='${truncate(history[1]?.prompt ?? "", 30)}'`,
    pass:
      history.length === 2 &&
      history[0]?.prompt.startsWith("Reply with exactly") &&
      history[1]?.prompt.startsWith("What word"),
  });

  // ── Error path: bad model name → audit row status='error' with hint ───────
  const tg3 = makeCapturedTg();
  await runEngineTurn(
    { ...deps, tg: tg3, model: "definitely-not-a-real-model" },
    {
      chatId: CHAT,
      fromId: FROM,
      updateId: 1003,
      prompt: "this should 404",
    },
  );
  const row3 = db.raw
    .query("SELECT status, error_message, model FROM audit WHERE id = 3")
    .get() as { status: string; error_message: string | null; model: string };
  phases.push({
    name: "bad model: audit row status=error",
    expected: "status=error",
    actual: `status=${row3.status}`,
    pass: row3.status === "error",
  });
  phases.push({
    name: "bad model: error_message contains backend-specific pull/load hint",
    expected: `error_message contains '${PULL_HINT}'`,
    actual: `error_message=${truncate(row3.error_message ?? "", 100)}`,
    pass:
      typeof row3.error_message === "string" && row3.error_message.includes(PULL_HINT),
  });
  const lastEdit3 = tg3.edits[tg3.edits.length - 1]?.text ?? "";
  phases.push({
    name: "bad model: telegram render shows ❌ with hint",
    expected: `last edit contains '❌' + '${PULL_HINT}'`,
    actual: `last edit: ${truncate(lastEdit3, 120)}`,
    pass: lastEdit3.includes("❌") && lastEdit3.includes(PULL_HINT),
  });

  // ── Tools-on path. Skipped unless `LOCAL_TOOLS_ENABLED=true`. ─────────────
  if (process.env.LOCAL_TOOLS_ENABLED === "true") {
    // Load the built-in `time` integration the same way main.ts would.
    const ctx = createIntegrationContext(
      process.env.SOLRAC_HOME ?? "/tmp/solrac-smoke-home",
    );
    const timeMod = await timeIntegration(ctx);
    const tools: ReadonlyArray<SdkMcpToolDefinition<any>> = timeMod.tools;
    const toolTiers = new Map(
      tools.map((t) => [t.name, timeMod.meta?.tier ?? "confirm"] as const),
    );
    // Stub broker — `time_now` is `auto` tier so this is never consulted; we
    // wire one in to satisfy the deps shape.
    const broker: Pick<ConfirmationBroker, "request"> = {
      request: async () => ({ decision: "allow", finalize: async () => {} }),
    };

    const tg4 = makeCapturedTg();
    await runEngineTurn(
      {
        ...deps,
        tg: tg4,
        toolEnabled: true,
        tools,
        toolTiers,
        broker,
        maxToolIterations: 4,
      },
      {
        chatId: CHAT,
        fromId: FROM,
        updateId: 1004,
        prompt:
          "What is the current time in Tokyo? Use the time_now tool to get an accurate answer.",
      },
    );
    const row4 = db.raw
      .query(
        "SELECT status, response, tool_calls, error_message, model FROM audit WHERE id = 4",
      )
      .get() as {
      status: string;
      response: string | null;
      tool_calls: string | null;
      error_message: string | null;
      model: string;
    };
    phases.push({
      name: "tools-on: audit row finalized status=ok",
      expected: "status=ok",
      actual: `status=${row4.status} error_message=${row4.error_message ?? ""}`,
      pass: row4.status === "ok",
    });
    phases.push({
      name: `tools-on: model column tagged ${MODE}:<backend>:<name>`,
      expected: `model=${EXPECTED_MODEL_TAG}`,
      actual: `model=${row4.model}`,
      pass: row4.model === EXPECTED_MODEL_TAG,
    });
    phases.push({
      name: "tools-on: audit tool_calls JSON references time_now",
      expected: "tool_calls JSON contains 'time_now'",
      actual: `tool_calls=${truncate(row4.tool_calls ?? "null", 120)}`,
      pass:
        typeof row4.tool_calls === "string" && row4.tool_calls.includes("time_now"),
    });
    const lastEdit4 = tg4.edits[tg4.edits.length - 1]?.text ?? "";
    phases.push({
      name: "tools-on: final edit shows tools-aware footer",
      expected: "footer matches /\\d+ tools · \\d+\\.\\ds/",
      actual: `last edit ends with: …${lastEdit4.slice(-80)}`,
      pass: /\d+ tools · \d+\.\ds/.test(lastEdit4),
    });
    phases.push({
      name: "tools-on: assistant response references time/Tokyo",
      expected: "response mentions time-of-day terms",
      actual: `response.length=${row4.response?.length ?? 0}`,
      pass:
        typeof row4.response === "string" &&
        /\d|time|tokyo|jst|jp/i.test(row4.response),
    });
  } else {
    // eslint-disable-next-line no-console
    console.log(
      "tools-on smoke: skipped (LOCAL_TOOLS_ENABLED!=true). Set the env to exercise.",
    );
  }

  // ── Print response samples for human eyeball ──────────────────────────────
  // eslint-disable-next-line no-console
  console.log(`\n--- turn 1 response (${row1.response?.length ?? 0} chars) ---`);
  // eslint-disable-next-line no-console
  console.log(row1.response);
  // eslint-disable-next-line no-console
  console.log(`\n--- turn 2 response (${row2.response?.length ?? 0} chars) ---`);
  // eslint-disable-next-line no-console
  console.log(row2.response);
  // eslint-disable-next-line no-console
  console.log("");

  reportAndExit("local-smoke", phases);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("smoke crashed:", err);
  process.exit(1);
});
