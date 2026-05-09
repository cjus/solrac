// PLAN Step 11 live smoke: drives runOllamaTurn against a real local Ollama
// with a stub Telegram client. Proves the whole pipeline end-to-end without
// touching the live bot or .env:
//   1. Streaming NDJSON parsing matches what real Ollama emits.
//   2. Audit row finalizes correctly (model='ollama:<name>', cost_usd=0, tokens).
//   3. History reconstruction (turn 2 sees turn 1's prompt+response in messages).
//   4. Telegram render path (stub-then-edit) produces sensible final text.
//   5. (PR-A) Tools-on path: a time_now tool call round-trips via runToolLoop,
//      audit row has tool_calls populated. Skipped unless
//      `OLLAMA_TOOLS_ENABLED=true` in env.
//
// Runs against http://localhost:11434 by default. Override via env:
//   OLLAMA_URL=http://localhost:11434 OLLAMA_MODEL=gemma4:e4b npm run smoke:ollama
//
// To exercise the tools-on path:
//   OLLAMA_TOOLS_ENABLED=true npm run smoke:ollama

import type { Message } from "@grammyjs/types";
import { runOllamaTurn } from "../../src/ollama.ts";
import type { ConfirmationBroker } from "../../src/policy.ts";
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import timeIntegration from "../../src/integrations-builtin/time/index.ts";
import { createIntegrationContext } from "../../src/integrations.ts";
import type { TelegramClient } from "../../src/telegram.ts";
import { openTestDb, reportAndExit, type Phase } from "./harness.ts";

const URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const MODEL = process.env.OLLAMA_MODEL ?? "gemma4:e4b";

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
  console.log(`ollama-smoke: URL=${URL} MODEL=${MODEL}`);

  const { db } = await openTestDb("ollama-smoke");
  const tg = makeCapturedTg();
  const deps = {
    tg,
    db,
    url: URL,
    model: MODEL,
    timeoutMs: 120_000,
    historyLimit: 6,
    // PNX-167: smoke runs a synthetic SOUL inline; no SOLRAC.md path on disk
    // so `readInstanceMd` returns null and no overlay block is sent.
    soul: "You are Solrac (smoke).",
    instanceMdPath: "/tmp/solrac-ollama-smoke-no-such-file.md",
  };

  const phases: Phase[] = [];
  const CHAT = 8001;
  const FROM = 9001;

  // ── Turn 1: cold call. No history, just system + user. ────────────────────
  const t0 = Date.now();
  await runOllamaTurn(deps, {
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
    name: "turn 1: model column tagged ollama:<name>",
    expected: `model=ollama:${MODEL}`,
    actual: `model=${row1.model}`,
    pass: row1.model === `ollama:${MODEL}`,
  });
  phases.push({
    name: "turn 1: cost_usd is 0 (Ollama is free)",
    expected: "cost_usd=0",
    actual: `cost_usd=${row1.cost_usd}`,
    pass: row1.cost_usd === 0,
  });
  phases.push({
    name: "turn 1: agent_session_id null (Ollama is sessionless)",
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
    name: "turn 1: input_tokens populated from prompt_eval_count",
    expected: "input_tokens > 0",
    actual: `input_tokens=${row1.input_tokens}`,
    pass: typeof row1.input_tokens === "number" && row1.input_tokens > 0,
  });
  phases.push({
    name: "turn 1: output_tokens populated from eval_count",
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

  // The bot should have sent exactly one stub message (the 🦙 thinking stub),
  // then issued ≥1 edits as the stream came in. Final edit must contain footer
  // with model + elapsed time.
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
  phases.push({
    name: "turn 1: final edit carries footer with model + seconds",
    expected: "footer matches /ollama:<model> · \\d+\\.\\ds/",
    actual: `last edit ends with: …${lastEdit1.slice(-80)}`,
    pass: new RegExp(`ollama:${escapeRegex(MODEL)} · \\d+\\.\\ds`).test(lastEdit1),
  });

  // ── Turn 2: follow-up. recentChatTurns should now return turn 1, so the ─
  // outbound messages array carries [system, user1, asst1, user2]. We can't
  // peek inside the real fetch from this smoke (it goes straight to Ollama),
  // so we verify history reconstruction at the db layer instead.
  const tg2 = makeCapturedTg();
  await runOllamaTurn(
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
    name: "turn 2: model column tagged ollama:<name>",
    expected: `model=ollama:${MODEL}`,
    actual: `model=${row2.model}`,
    pass: row2.model === `ollama:${MODEL}`,
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
  await runOllamaTurn(
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
    name: "bad model: error_message contains 'not found'",
    expected: "error_message contains 'not found'",
    actual: `error_message=${truncate(row3.error_message ?? "", 100)}`,
    pass: typeof row3.error_message === "string" && row3.error_message.includes("not found"),
  });
  const lastEdit3 = tg3.edits[tg3.edits.length - 1]?.text ?? "";
  phases.push({
    name: "bad model: telegram render shows ❌ with pull hint",
    expected: "last edit contains '❌' + 'ollama pull'",
    actual: `last edit: ${truncate(lastEdit3, 120)}`,
    pass: lastEdit3.includes("❌") && lastEdit3.includes("ollama pull"),
  });

  // ── Tools-on path (PR-A). Skipped unless `OLLAMA_TOOLS_ENABLED=true`. ──
  if (process.env.OLLAMA_TOOLS_ENABLED === "true") {
    // Load the built-in `time` integration the same way main.ts would.
    const ctx = createIntegrationContext();
    const timeMod = await timeIntegration(ctx);
    const tools: ReadonlyArray<SdkMcpToolDefinition<any>> = timeMod.tools;
    const toolTiers = new Map(
      tools.map((t) => [t.name, timeMod.meta?.tier ?? "confirm"] as const),
    );
    // Stub broker — `time_now` is `auto` tier so this is never consulted; we
    // wire one in to satisfy the OllamaRunDeps shape and to make the path
    // work on the off chance the integration's tier changes.
    const broker: Pick<ConfirmationBroker, "request"> = {
      request: async () => "allow",
    };

    const tg4 = makeCapturedTg();
    await runOllamaTurn(
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
      name: "tools-on: model column tagged ollama:<name>",
      expected: `model=ollama:${MODEL}`,
      actual: `model=${row4.model}`,
      pass: row4.model === `ollama:${MODEL}`,
    });
    phases.push({
      name: "tools-on: audit tool_calls JSON references time_now",
      expected: "tool_calls JSON contains 'time_now'",
      actual: `tool_calls=${truncate(row4.tool_calls ?? "null", 120)}`,
      pass:
        typeof row4.tool_calls === "string" &&
        row4.tool_calls.includes("time_now"),
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
      "tools-on smoke: skipped (OLLAMA_TOOLS_ENABLED!=true). Set the env to exercise.",
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

  reportAndExit("ollama-smoke", phases);
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
