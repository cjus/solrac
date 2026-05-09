/**
 * @fileoverview Unit tests for ollama.ts: local-Ollama runner.
 * @proves End-to-end behavior of `runOllamaTurn` against a mocked Ollama
 *         HTTP API and a real bun:sqlite-backed `SolracDb`. Covers the happy
 *         path (NDJSON streaming, audit row, footer), history reconstruction
 *         (prior `>` rows fed back into the messages array), and three error
 *         shapes (timeout, ECONNREFUSED-style fetch reject, HTTP 404 model
 *         not found).
 *
 * Mock surface:
 *   - `fetch` is injected via `OllamaRunDeps.fetch`. Each test constructs a
 *     mock that returns a `Response` with a `ReadableStream` body for
 *     streaming tests, or a plain JSON body + non-200 status for error tests,
 *     or throws (typed via `error.name`) for connection/abort tests.
 *   - `TelegramClient` is a minimal partial that captures `sendMessage` and
 *     `editMessageText` calls into arrays for assertion.
 *   - `SolracDb` is the real implementation against a tmpdir-backed sqlite.
 *
 * Scenarios covered:
 *
 *   Happy path:
 *     - Streams 3 chunks + a final `done:true` frame; assistant text
 *       accumulates; audit row finalizes with `model='ollama:<name>'`,
 *       `cost_usd=0`, token counts populated, status='ok'.
 *     - Footer renders with the elapsed-seconds and model name.
 *
 *   History reconstruction:
 *     - Prior successful Ollama turns for the same chat appear in the
 *       outbound messages array as user/assistant pairs in chronological
 *       order; Claude rows for the same chat are NOT included; error/denied
 *       rows are NOT included; rows from a different chat are NOT included.
 *
 *   Error rendering:
 *     - HTTP 404 → `❌ ollama model not found: <model>` with pull hint.
 *     - fetch reject (TypeError → unreachable) → `❌ ollama unreachable: <url>`.
 *     - AbortError (timeout) → `❌ ollama timed out after Ns`.
 *     - In all error cases: audit row finalizes with status='error', the
 *       diagnostic in error_message, and no malformed Telegram render.
 *
 *   Render:
 *     - The streaming-stub edit is HTML-escaped (`<` → `&lt;`).
 *     - The final-edit footer differs from any streaming render so Telegram
 *       won't 400 on a no-op (load-bearing per the agent.ts pattern).
 *
 * Not covered (intentional):
 *   - Real Ollama process — that's the `manual smoke` step in the PLAN DoD.
 *   - Telegram throttle timing under sub-1.5s edit cadence — the throttle
 *     constant is shared with `agent.ts`; integration covered in the live
 *     dev-bot smoke.
 *
 * Cross-references:
 *   - ollama.ts — implementation
 *   - docs/ARCHITECTURE.md#ollama-routing — design discussion
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { openDb, type SolracDb } from "./db.ts";
import { buildOllamaCapabilityNote, runOllamaTurn, type OllamaRunDeps } from "./ollama.ts";
import type { TelegramClient } from "./telegram.ts";

const TEST_SOUL = "You are Solrac (test soul).";

interface SentMessage {
  chatId: number;
  text: string;
}
interface EditedMessage {
  chatId: number;
  messageId: number;
  text: string;
}

interface FakeTg extends TelegramClient {
  sent: SentMessage[];
  edits: EditedMessage[];
}

function makeFakeTg(): FakeTg {
  const sent: SentMessage[] = [];
  const edits: EditedMessage[] = [];
  const tg: Partial<FakeTg> = {
    sent,
    edits,
    sendMessage: async (chatId, text) => {
      sent.push({ chatId, text });
      return {
        message_id: sent.length,
        date: 0,
        chat: { id: chatId, type: "private" },
      } as never;
    },
    editMessageText: async (chatId, messageId, text) => {
      edits.push({ chatId, messageId, text });
      return true;
    },
  };
  return tg as FakeTg;
}

interface Harness {
  dir: string;
  db: SolracDb;
  tg: FakeTg;
}

const harnesses: Harness[] = [];

beforeEach(() => {
  harnesses.length = 0;
});

afterEach(() => {
  for (const h of harnesses) {
    try {
      h.db.close();
    } catch {}
    rmSync(h.dir, { recursive: true, force: true });
  }
});

async function newHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "solrac-ollama-"));
  const db = await openDb(dir);
  const tg = makeFakeTg();
  const h: Harness = { dir, db, tg };
  harnesses.push(h);
  return h;
}

// Build a fetch that returns a streamed Response made from `frames` (one JSON
// object per frame, each emitted as its own NDJSON line). Captures the request
// body into `captured.body` so tests can assert on the messages array.
function makeStreamingFetch(
  frames: Record<string, unknown>[],
): { fetch: typeof fetch; captured: { body: string | null; url: string | null } } {
  const captured: { body: string | null; url: string | null } = { body: null, url: null };
  const enc = new TextEncoder();
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    captured.url = String(url);
    captured.body = typeof init?.body === "string" ? init.body : null;
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i >= frames.length) {
          controller.close();
          return;
        }
        controller.enqueue(enc.encode(JSON.stringify(frames[i]) + "\n"));
        i++;
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "application/x-ndjson" },
    });
  }) as unknown as typeof fetch;
  return { fetch: f, captured };
}

function makeJsonFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      statusText: status === 404 ? "Not Found" : "Error",
    })) as unknown as typeof fetch;
}

function makeUnreachableFetch(): typeof fetch {
  return (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
}

function makeAbortFetch(): typeof fetch {
  return (async () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    throw err;
  }) as unknown as typeof fetch;
}

function defaultDeps(h: Harness, fetchImpl: typeof fetch): OllamaRunDeps {
  return {
    tg: h.tg,
    db: h.db,
    url: "http://localhost:11434",
    model: "llama3.2",
    timeoutMs: 60_000,
    historyLimit: 6,
    soul: TEST_SOUL,
    // Default tests don't write a SOLRAC.md; the path resolves to a missing
    // file and `readInstanceMd` returns null, so no overlay block is sent.
    instanceMdPath: join(h.dir, "SOLRAC.md"),
    fetch: fetchImpl,
  };
}

function readAuditRow(
  db: SolracDb,
  id: number,
): {
  status: string;
  response: string | null;
  cost_usd: number | null;
  agent_session_id: string | null;
  tool_calls: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  error_message: string | null;
  model: string;
} {
  return db.raw
    .query(
      "SELECT status, response, cost_usd, agent_session_id, tool_calls, input_tokens, output_tokens, error_message, model FROM audit WHERE id = ?",
    )
    .get(id) as never;
}

describe("runOllamaTurn — happy path", () => {
  test("streams chunks, accumulates response, finalizes audit row", async () => {
    const h = await newHarness();
    const { fetch: f, captured } = makeStreamingFetch([
      { message: { role: "assistant", content: "Hello" }, done: false },
      { message: { role: "assistant", content: ", " }, done: false },
      { message: { role: "assistant", content: "world!" }, done: false },
      { message: { role: "assistant", content: "" }, done: true, prompt_eval_count: 17, eval_count: 23 },
    ]);
    await runOllamaTurn(defaultDeps(h, f), {
      chatId: 100,
      fromId: 200,
      updateId: 1,
      prompt: "say hi",
    });
    const id = h.db.raw.query("SELECT MAX(id) AS id FROM audit").get() as { id: number };
    const row = readAuditRow(h.db, id.id);
    expect(row.status).toBe("ok");
    expect(row.response).toBe("Hello, world!");
    expect(row.cost_usd).toBe(0);
    expect(row.agent_session_id).toBeNull();
    expect(row.tool_calls).toBeNull();
    expect(row.input_tokens).toBe(17);
    expect(row.output_tokens).toBe(23);
    expect(row.error_message).toBeNull();
    expect(row.model).toBe("ollama:llama3.2");
    expect(captured.url).toBe("http://localhost:11434/api/chat");
    expect(h.tg.sent.length).toBe(1);
    expect(h.tg.sent[0]?.text).toContain("thinking");
    // At least one final edit; last one carries footer with model + elapsed.
    expect(h.tg.edits.length).toBeGreaterThanOrEqual(1);
    const lastEdit = h.tg.edits[h.tg.edits.length - 1]!;
    expect(lastEdit.text).toContain("Hello, world!");
    expect(lastEdit.text).toContain("ollama:llama3.2");
    expect(lastEdit.text).toMatch(/\d+\.\ds/);
  });

  test("HTML-escapes streamed content in the render", async () => {
    const h = await newHarness();
    const { fetch: f } = makeStreamingFetch([
      { message: { role: "assistant", content: "<script>x</script>" }, done: false },
      { message: { role: "assistant", content: "" }, done: true, prompt_eval_count: 1, eval_count: 1 },
    ]);
    await runOllamaTurn(defaultDeps(h, f), {
      chatId: 1,
      fromId: 1,
      updateId: 1,
      prompt: "raw",
    });
    const lastEdit = h.tg.edits[h.tg.edits.length - 1]!;
    expect(lastEdit.text).toContain("&lt;script&gt;");
    expect(lastEdit.text).not.toContain("<script>");
  });

  test("outbound messages array carries system prompt + current user prompt", async () => {
    const h = await newHarness();
    const { fetch: f, captured } = makeStreamingFetch([
      { message: { role: "assistant", content: "ok" }, done: true, prompt_eval_count: 1, eval_count: 1 },
    ]);
    await runOllamaTurn(defaultDeps(h, f), {
      chatId: 1,
      fromId: 1,
      updateId: 1,
      prompt: "what is 2+2?",
    });
    const body = JSON.parse(captured.body!) as {
      model: string;
      messages: { role: string; content: string }[];
      stream: boolean;
    };
    expect(body.model).toBe("llama3.2");
    expect(body.stream).toBe(true);
    // The default-engine flag is unset on `defaultDeps` so the matrix picks
    // the Claude-only-deploy variant of the note.
    const expectedNote = buildOllamaCapabilityNote({
      toolsEnabled: false,
      isDefaultEngine: false,
      toolNames: [],
    });
    expect(body.messages[0]).toEqual({
      role: "system",
      content: `${TEST_SOUL}\n\n${expectedNote}`,
    });
    // Without a SOLRAC.md present, no second system message; user prompt is
    // immediately after the SOUL system message.
    expect(body.messages[1]).toEqual({
      role: "user",
      content: "what is 2+2?",
    });
    expect(body.messages[body.messages.length - 1]).toEqual({
      role: "user",
      content: "what is 2+2?",
    });
  });

  test("injects SOLRAC.md as a second system message when present", async () => {
    const h = await newHarness();
    writeFileSync(join(h.dir, "SOLRAC.md"), "Operator: test-operator", "utf8");
    const { fetch: f, captured } = makeStreamingFetch([
      { message: { role: "assistant", content: "ok" }, done: true, prompt_eval_count: 1, eval_count: 1 },
    ]);
    await runOllamaTurn(defaultDeps(h, f), {
      chatId: 1,
      fromId: 1,
      updateId: 1,
      prompt: "ping",
    });
    const body = JSON.parse(captured.body!) as {
      messages: { role: string; content: string }[];
    };
    expect(body.messages[0]?.role).toBe("system");
    expect(body.messages[0]?.content).toContain(TEST_SOUL);
    expect(body.messages[1]).toEqual({
      role: "system",
      content: "<solrac-md>\nOperator: test-operator\n</solrac-md>",
    });
  });

  test("skips the SOLRAC.md system message on the unedited template", async () => {
    const h = await newHarness();
    writeFileSync(
      join(h.dir, "SOLRAC.md"),
      "<!-- solrac-md:unedited -->\n# Operator: ignored",
      "utf8",
    );
    const { fetch: f, captured } = makeStreamingFetch([
      { message: { role: "assistant", content: "ok" }, done: true, prompt_eval_count: 1, eval_count: 1 },
    ]);
    await runOllamaTurn(defaultDeps(h, f), {
      chatId: 1,
      fromId: 1,
      updateId: 1,
      prompt: "ping",
    });
    const body = JSON.parse(captured.body!) as {
      messages: { role: string; content: string }[];
    };
    // First message is SOUL+capability; second is the user prompt — no overlay.
    expect(body.messages[0]?.role).toBe("system");
    expect(body.messages[1]?.role).toBe("user");
  });
});

describe("runOllamaTurn — history reconstruction", () => {
  test("prior successful Ollama turns appear as user/assistant pairs in order", async () => {
    const h = await newHarness();
    // Seed two prior Ollama turns for chat 100; one earlier, one later.
    seedTurn(h.db, {
      chatId: 100,
      startedAt: 1000,
      prompt: "first user message",
      response: "first assistant reply",
      model: "ollama:llama3.2",
      status: "ok",
    });
    seedTurn(h.db, {
      chatId: 100,
      startedAt: 2000,
      prompt: "second user message",
      response: "second assistant reply",
      model: "ollama:llama3.2",
      status: "ok",
    });
    const { fetch: f, captured } = makeStreamingFetch([
      { message: { role: "assistant", content: "ok" }, done: true, prompt_eval_count: 1, eval_count: 1 },
    ]);
    await runOllamaTurn(defaultDeps(h, f), {
      chatId: 100,
      fromId: 200,
      updateId: 99,
      prompt: "third user message",
    });
    const body = JSON.parse(captured.body!) as {
      messages: { role: string; content: string }[];
    };
    // [system, user1, assistant1, user2, assistant2, user3]
    expect(body.messages.length).toBe(6);
    expect(body.messages[1]).toEqual({ role: "user", content: "first user message" });
    expect(body.messages[2]).toEqual({ role: "assistant", content: "first assistant reply" });
    expect(body.messages[3]).toEqual({ role: "user", content: "second user message" });
    expect(body.messages[4]).toEqual({ role: "assistant", content: "second assistant reply" });
    expect(body.messages[5]).toEqual({ role: "user", content: "third user message" });
  });

  test("Claude rows for same chat ARE included (cross-engine context)", async () => {
    const h = await newHarness();
    seedTurn(h.db, {
      chatId: 100,
      startedAt: 1000,
      prompt: "claude prompt",
      response: "claude reply",
      model: "claude:secondary:claude-opus-4-7",
      status: "ok",
    });
    const { fetch: f, captured } = makeStreamingFetch([
      { message: { role: "assistant", content: "ok" }, done: true, prompt_eval_count: 1, eval_count: 1 },
    ]);
    await runOllamaTurn(defaultDeps(h, f), {
      chatId: 100,
      fromId: 200,
      updateId: 1,
      prompt: "now ollama",
    });
    const body = JSON.parse(captured.body!) as {
      messages: { role: string; content: string }[];
    };
    // [system, user(claude prompt), assistant(claude reply), user(now ollama)]
    expect(body.messages.length).toBe(4);
    expect(body.messages[1]).toEqual({ role: "user", content: "claude prompt" });
    expect(body.messages[2]).toEqual({ role: "assistant", content: "claude reply" });
    expect(body.messages[3]).toEqual({ role: "user", content: "now ollama" });
  });

  test("interleaved Claude and Ollama turns appear in chronological order", async () => {
    const h = await newHarness();
    seedTurn(h.db, {
      chatId: 100,
      startedAt: 1000,
      prompt: "ollama early",
      response: "ollama early reply",
      model: "ollama:llama3.2",
      status: "ok",
    });
    seedTurn(h.db, {
      chatId: 100,
      startedAt: 2000,
      prompt: "claude middle",
      response: "claude middle reply",
      model: "claude:primary:claude-sonnet-4-6",
      status: "ok",
    });
    seedTurn(h.db, {
      chatId: 100,
      startedAt: 3000,
      prompt: "ollama late",
      response: "ollama late reply",
      model: "ollama:llama3.2",
      status: "ok",
    });
    const { fetch: f, captured } = makeStreamingFetch([
      { message: { role: "assistant", content: "ok" }, done: true, prompt_eval_count: 1, eval_count: 1 },
    ]);
    await runOllamaTurn(defaultDeps(h, f), {
      chatId: 100,
      fromId: 200,
      updateId: 1,
      prompt: "current",
    });
    const body = JSON.parse(captured.body!) as {
      messages: { role: string; content: string }[];
    };
    // [system, u1, a1, u2, a2, u3, a3, current]
    expect(body.messages.length).toBe(8);
    expect(body.messages[1]?.content).toBe("ollama early");
    expect(body.messages[3]?.content).toBe("claude middle");
    expect(body.messages[5]?.content).toBe("ollama late");
    expect(body.messages[7]?.content).toBe("current");
  });

  test("error/denied Ollama rows are NOT included", async () => {
    const h = await newHarness();
    seedTurn(h.db, {
      chatId: 100,
      startedAt: 1000,
      prompt: "errored prompt",
      response: null,
      model: "ollama:llama3.2",
      status: "error",
    });
    const { fetch: f, captured } = makeStreamingFetch([
      { message: { role: "assistant", content: "ok" }, done: true, prompt_eval_count: 1, eval_count: 1 },
    ]);
    await runOllamaTurn(defaultDeps(h, f), {
      chatId: 100,
      fromId: 200,
      updateId: 1,
      prompt: "next",
    });
    const body = JSON.parse(captured.body!) as {
      messages: { role: string; content: string }[];
    };
    expect(body.messages.length).toBe(2);
  });

  test("rows from a different chat are NOT included", async () => {
    const h = await newHarness();
    seedTurn(h.db, {
      chatId: 999,
      startedAt: 1000,
      prompt: "other chat",
      response: "other reply",
      model: "ollama:llama3.2",
      status: "ok",
    });
    const { fetch: f, captured } = makeStreamingFetch([
      { message: { role: "assistant", content: "ok" }, done: true, prompt_eval_count: 1, eval_count: 1 },
    ]);
    await runOllamaTurn(defaultDeps(h, f), {
      chatId: 100,
      fromId: 200,
      updateId: 1,
      prompt: "isolated",
    });
    const body = JSON.parse(captured.body!) as {
      messages: { role: string; content: string }[];
    };
    expect(body.messages.length).toBe(2);
  });

  test("history limit caps the number of prior turns", async () => {
    const h = await newHarness();
    for (let i = 0; i < 10; i++) {
      seedTurn(h.db, {
        chatId: 100,
        startedAt: 1000 + i,
        prompt: `u${i}`,
        response: `a${i}`,
        model: "ollama:llama3.2",
        status: "ok",
      });
    }
    const { fetch: f, captured } = makeStreamingFetch([
      { message: { role: "assistant", content: "ok" }, done: true, prompt_eval_count: 1, eval_count: 1 },
    ]);
    await runOllamaTurn({ ...defaultDeps(h, f), historyLimit: 3 }, {
      chatId: 100,
      fromId: 200,
      updateId: 1,
      prompt: "q",
    });
    const body = JSON.parse(captured.body!) as {
      messages: { role: string; content: string }[];
    };
    // [system, u7, a7, u8, a8, u9, a9, q] = 8
    expect(body.messages.length).toBe(8);
    expect(body.messages[1]).toEqual({ role: "user", content: "u7" });
    expect(body.messages[6]).toEqual({ role: "assistant", content: "a9" });
  });
});

describe("runOllamaTurn — error rendering", () => {
  test("HTTP 404 surfaces model-not-found with pull hint", async () => {
    const h = await newHarness();
    const f = makeJsonFetch(404, { error: "model 'llama3.2' not found, try pulling it first" });
    await runOllamaTurn(defaultDeps(h, f), {
      chatId: 1,
      fromId: 1,
      updateId: 1,
      prompt: "hi",
    });
    const id = h.db.raw.query("SELECT MAX(id) AS id FROM audit").get() as { id: number };
    const row = readAuditRow(h.db, id.id);
    expect(row.status).toBe("error");
    expect(row.error_message).toContain("model not found");
    expect(row.error_message).toContain("ollama pull llama3.2");
    const lastEdit = h.tg.edits[h.tg.edits.length - 1]!;
    expect(lastEdit.text).toContain("❌");
    expect(lastEdit.text).toContain("model not found");
  });

  test("fetch reject (unreachable) surfaces unreachable URL", async () => {
    const h = await newHarness();
    const f = makeUnreachableFetch();
    await runOllamaTurn(defaultDeps(h, f), {
      chatId: 1,
      fromId: 1,
      updateId: 1,
      prompt: "hi",
    });
    const id = h.db.raw.query("SELECT MAX(id) AS id FROM audit").get() as { id: number };
    const row = readAuditRow(h.db, id.id);
    expect(row.status).toBe("error");
    expect(row.error_message).toContain("unreachable");
    expect(row.error_message).toContain("http://localhost:11434");
  });

  test("AbortError (timeout) surfaces timeout message", async () => {
    const h = await newHarness();
    const f = makeAbortFetch();
    await runOllamaTurn({ ...defaultDeps(h, f), timeoutMs: 5_000 }, {
      chatId: 1,
      fromId: 1,
      updateId: 1,
      prompt: "hi",
    });
    const id = h.db.raw.query("SELECT MAX(id) AS id FROM audit").get() as { id: number };
    const row = readAuditRow(h.db, id.id);
    expect(row.status).toBe("error");
    expect(row.error_message).toContain("timed out");
    expect(row.error_message).toContain("5s");
  });

  test("non-404 HTTP error surfaces status + body", async () => {
    const h = await newHarness();
    const f = makeJsonFetch(500, { error: "out of memory" });
    await runOllamaTurn(defaultDeps(h, f), {
      chatId: 1,
      fromId: 1,
      updateId: 1,
      prompt: "hi",
    });
    const id = h.db.raw.query("SELECT MAX(id) AS id FROM audit").get() as { id: number };
    const row = readAuditRow(h.db, id.id);
    expect(row.status).toBe("error");
    expect(row.error_message).toContain("500");
    expect(row.error_message).toContain("out of memory");
  });
});

describe("recentChatTurns (db-level)", () => {
  test("returns rows in chronological order, capped at limit", async () => {
    const h = await newHarness();
    for (let i = 0; i < 4; i++) {
      seedTurn(h.db, {
        chatId: 7,
        startedAt: 100 + i,
        prompt: `p${i}`,
        response: `r${i}`,
        model: "ollama:llama3.2",
        status: "ok",
      });
    }
    const out = h.db.recentChatTurns(7, 2);
    expect(out.length).toBe(2);
    // Most recent two, oldest-first within them.
    expect(out[0]).toMatchObject({ prompt: "p2", response: "r2" });
    expect(out[1]).toMatchObject({ prompt: "p3", response: "r3" });
  });

  test("returns Claude rows alongside Ollama rows", async () => {
    const h = await newHarness();
    seedTurn(h.db, {
      chatId: 7,
      startedAt: 1,
      prompt: "claude_p",
      response: "claude_r",
      model: "claude:primary:claude-sonnet-4-6",
      status: "ok",
    });
    seedTurn(h.db, {
      chatId: 7,
      startedAt: 2,
      prompt: "ollama_p",
      response: "ollama_r",
      model: "ollama:llama3.2",
      status: "ok",
    });
    const out = h.db.recentChatTurns(7, 5);
    expect(out.length).toBe(2);
    expect(out[0]).toMatchObject({
      prompt: "claude_p",
      model: "claude:primary:claude-sonnet-4-6",
    });
    expect(out[1]).toMatchObject({ prompt: "ollama_p", model: "ollama:llama3.2" });
  });
});

describe("outOfBandForEngine (db-level)", () => {
  // Caller passes their own engine's prefix; the query returns turns from all
  // OTHER engines whose started_at exceeds this engine's most recent turn.
  // PLAN Step 12 generalizes the Step 11 outOfBandOllamaForClaude.
  const SECONDARY = "claude:secondary:%";
  const claudeSecondary = (extra: Partial<{ startedAt: number; prompt: string }>) => ({
    chatId: 7,
    startedAt: extra.startedAt ?? 1,
    prompt: extra.prompt ?? "claude",
    response: "ok",
    model: "claude:secondary:claude-opus-4-7",
    status: "ok" as const,
  });

  test("returns other-engine rows after the last successful turn of this engine", async () => {
    const h = await newHarness();
    // Seed: secondary-claude old, ollama old, secondary-claude recent, two
    // ollama after the recent claude. From the secondary tier's POV, only the
    // two trailing ollama turns are out-of-band.
    seedTurn(h.db, claudeSecondary({ startedAt: 1, prompt: "claude_old" }));
    seedTurn(h.db, {
      chatId: 7,
      startedAt: 2,
      prompt: "ollama_old",
      response: "ok",
      model: "ollama:llama3.2",
      status: "ok",
    });
    seedTurn(h.db, claudeSecondary({ startedAt: 3, prompt: "claude_recent" }));
    seedTurn(h.db, {
      chatId: 7,
      startedAt: 4,
      prompt: "ollama_after_claude_1",
      response: "ok",
      model: "ollama:llama3.2",
      status: "ok",
    });
    seedTurn(h.db, {
      chatId: 7,
      startedAt: 5,
      prompt: "ollama_after_claude_2",
      response: "ok",
      model: "ollama:llama3.2",
      status: "ok",
    });
    const out = h.db.outOfBandForEngine(7, SECONDARY, 10);
    expect(out.length).toBe(2);
    expect(out[0]?.prompt).toBe("ollama_after_claude_1");
    expect(out[1]?.prompt).toBe("ollama_after_claude_2");
  });

  test("returns ALL other-engine turns when this engine has no prior turn", async () => {
    const h = await newHarness();
    seedTurn(h.db, {
      chatId: 7,
      startedAt: 1,
      prompt: "ollama_a",
      response: "ok",
      model: "ollama:llama3.2",
      status: "ok",
    });
    seedTurn(h.db, {
      chatId: 7,
      startedAt: 2,
      prompt: "ollama_b",
      response: "ok",
      model: "ollama:llama3.2",
      status: "ok",
    });
    const out = h.db.outOfBandForEngine(7, SECONDARY, 10);
    expect(out.length).toBe(2);
  });

  test("returns empty array when chat has only this engine's history", async () => {
    const h = await newHarness();
    seedTurn(h.db, claudeSecondary({ startedAt: 1, prompt: "claude_only" }));
    expect(h.db.outOfBandForEngine(7, SECONDARY, 5)).toEqual([]);
  });

  test("respects limit", async () => {
    const h = await newHarness();
    for (let i = 0; i < 5; i++) {
      seedTurn(h.db, {
        chatId: 7,
        startedAt: i + 1,
        prompt: `p${i}`,
        response: "ok",
        model: "ollama:llama3.2",
        status: "ok",
      });
    }
    const out = h.db.outOfBandForEngine(7, SECONDARY, 2);
    expect(out.length).toBe(2);
    // ASC order: oldest first.
    expect(out[0]?.prompt).toBe("p0");
    expect(out[1]?.prompt).toBe("p1");
  });

  test("primary tier sees secondary tier's turns as out-of-band", async () => {
    const h = await newHarness();
    seedTurn(h.db, claudeSecondary({ startedAt: 1, prompt: "secondary_first" }));
    seedTurn(h.db, claudeSecondary({ startedAt: 2, prompt: "secondary_second" }));
    const out = h.db.outOfBandForEngine(7, "claude:primary:%", 10);
    expect(out.length).toBe(2);
    expect(out[0]?.prompt).toBe("secondary_first");
    expect(out[1]?.prompt).toBe("secondary_second");
  });
});

// Test-only helper: write a fully-formed audit row in one shot. Mirrors what
// runAgent / runOllamaTurn do via insertAudit + updateAuditEnd, but lets us
// pre-seed history without running real engines.
function seedTurn(
  db: SolracDb,
  args: {
    chatId: number;
    startedAt: number;
    prompt: string;
    response: string | null;
    model: string;
    status: "ok" | "error" | "denied";
  },
): void {
  const id = db.insertAudit({
    chatId: args.chatId,
    fromId: args.chatId,
    updateId: args.startedAt,
    prompt: args.prompt,
    startedAt: args.startedAt,
    model: args.model,
  });
  db.updateAuditEnd({
    id,
    response: args.response,
    toolCalls: null,
    inputTokens: null,
    outputTokens: null,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
    costUsd: args.status === "ok" && args.model.startsWith("ollama:") ? 0 : null,
    agentSessionId: null,
    status: args.status,
    errorMessage: args.status === "ok" ? null : "seeded",
    endedAt: args.startedAt + 50,
  });
}
