/**
 * @fileoverview Unit tests for `engine.ts`.
 * @proves Capability-note matrix (pure), audit-tag invariant
 *         (`<mode>:<backend>:<model>`), driver-error → render translation,
 *         and token-count capture from `done` events.
 *
 * Wire-format edge cases (NDJSON / SSE parsing) belong in
 * `local-driver.test.ts` / `remote-driver.test.ts`. Tool-loop behavior
 * belongs in `engine-tools.test.ts`. This file exercises only the
 * runner-level concerns that survive the driver abstraction.
 */

import { describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import type { Message } from "@grammyjs/types";
import { runEngineTurn, scrubLocalControlTokens } from "./engine.ts";
import {
  type EngineChatEvent,
  type EngineDriver,
  type EngineStreamChatOpts,
  EngineDriverError,
} from "./engine-driver.ts";
import { buildLocalCapabilityNote } from "./local-driver.ts";
import { buildRemoteCapabilityNote } from "./remote-driver.ts";
import { openDb, type SolracDb } from "./db.ts";
import type { SendMessageOpts, TelegramClient } from "./telegram.ts";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface RecordedSend {
  chatId: number;
  text: string;
  opts?: SendMessageOpts;
}
interface RecordedEdit {
  chatId: number;
  messageId: number;
  text: string;
}

function makeFakeTg(): {
  tg: TelegramClient;
  sends: RecordedSend[];
  edits: RecordedEdit[];
} {
  const sends: RecordedSend[] = [];
  const edits: RecordedEdit[] = [];
  let nextMid = 1000;
  const tg = {
    async getUpdates() {
      return [];
    },
    async sendMessage(chatId: number, text: string, opts?: SendMessageOpts) {
      sends.push({ chatId, text, opts });
      const message_id = nextMid++;
      return {
        message_id,
        date: 0,
        chat: { id: chatId, type: "private" },
        text,
      } as unknown as Message;
    },
    async editMessageText(chatId: number, messageId: number, text: string) {
      edits.push({ chatId, messageId, text });
      return true;
    },
  } as unknown as TelegramClient;
  return { tg, sends, edits };
}

function fakeDriver(
  backend: "ollama" | "lmstudio" | "openrouter",
  events: EngineChatEvent[] | Error,
): EngineDriver {
  return {
    backend,
    mode: backend === "openrouter" ? "remote" : "local",
    async probe() {
      return { ok: true };
    },
    async *streamChat(_opts: EngineStreamChatOpts): AsyncIterable<EngineChatEvent> {
      if (events instanceof Error) throw events;
      for (const evt of events) yield evt;
    },
  };
}

async function freshDb(name: string): Promise<{ db: SolracDb; dir: string }> {
  const dir = `./data/test/${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const db = await openDb(dir);
  return { db, dir };
}

const SOUL = "you are solrac.";

// ---------------------------------------------------------------------------
// Capability-note matrix
// ---------------------------------------------------------------------------

describe("buildLocalCapabilityNote", () => {
  test("tools=on, isDefaultEngine=true → tools listed + escalation hint", () => {
    const note = buildLocalCapabilityNote({
      toolsEnabled: true,
      isDefaultEngine: true,
      toolNames: ["time_now", "echo_say"],
    });
    expect(note).toMatch(/time_now, echo_say/);
    expect(note).toMatch(/`@`/);
    expect(note).toMatch(/`!`/);
  });

  test("tools=off, isDefaultEngine=true → escalation hint without tools list", () => {
    const note = buildLocalCapabilityNote({
      toolsEnabled: false,
      isDefaultEngine: true,
      toolNames: [],
    });
    expect(note).toMatch(/do not have tools/);
    expect(note).toMatch(/re-send the message prefixed with/);
  });

  test("tools=off, isDefaultEngine=false → tools-less escape hatch", () => {
    const note = buildLocalCapabilityNote({
      toolsEnabled: false,
      isDefaultEngine: false,
      toolNames: [],
    });
    expect(note).toMatch(/do not have tools/);
    // Different copy from the default-engine variant.
    expect(note).not.toMatch(/default chat engine/);
  });
});

// ---------------------------------------------------------------------------
// runEngineTurn — integration with real db + fake tg + fake driver
// ---------------------------------------------------------------------------

describe("runEngineTurn — audit tag invariant", () => {
  test("ollama backend writes audit.model = 'local:ollama:<model>'", async () => {
    const { db, dir } = await freshDb("engine-audit-ollama");
    try {
      const { tg } = makeFakeTg();
      const driver = fakeDriver("ollama", [
        { kind: "text", delta: "hello" },
        { kind: "done", inputTokens: 5, outputTokens: 3, costUsd: null },
      ]);
      await runEngineTurn(
        {
          tg,
          db,
          driver,
          model: "gemma3:e4b",
          timeoutMs: 5000,
          historyLimit: 6,
          soul: SOUL,
          instanceMdPath: "/dev/null/nope",
          isDefaultEngine: true,
        },
        { chatId: 42, fromId: 7, updateId: 1, prompt: "hi" },
      );
      const rows = db.raw.query("SELECT model FROM audit").all() as Array<{ model: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.model).toBe("local:ollama:gemma3:e4b");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("lmstudio backend writes audit.model = 'local:lmstudio:<model>'", async () => {
    const { db, dir } = await freshDb("engine-audit-lmstudio");
    try {
      const { tg } = makeFakeTg();
      const driver = fakeDriver("lmstudio", [
        { kind: "text", delta: "hello" },
        { kind: "done", inputTokens: 5, outputTokens: 3, costUsd: null },
      ]);
      await runEngineTurn(
        {
          tg,
          db,
          driver,
          model: "qwen2.5-7b",
          timeoutMs: 5000,
          historyLimit: 6,
          soul: SOUL,
          instanceMdPath: "/dev/null/nope",
          isDefaultEngine: true,
        },
        { chatId: 42, fromId: 7, updateId: 1, prompt: "hi" },
      );
      const rows = db.raw.query("SELECT model FROM audit").all() as Array<{
        model: string;
      }>;
      expect(rows[0]!.model).toBe("local:lmstudio:qwen2.5-7b");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("runEngineTurn — error rendering", () => {
  test("EngineDriverError unreachable → audit status='error', edit shows error", async () => {
    const { db, dir } = await freshDb("engine-err-unreachable");
    try {
      const { tg, edits } = makeFakeTg();
      const driver = fakeDriver(
        "ollama",
        new EngineDriverError("ollama", "unreachable", "unreachable: http://x"),
      );
      await runEngineTurn(
        {
          tg,
          db,
          driver,
          model: "m",
          timeoutMs: 5000,
          historyLimit: 6,
          soul: SOUL,
          instanceMdPath: "/dev/null/nope",
        },
        { chatId: 1, fromId: 2, updateId: 1, prompt: "hi" },
      );
      const row = db.raw.query("SELECT status, error_message FROM audit").get() as {
        status: string;
        error_message: string;
      };
      expect(row.status).toBe("error");
      expect(row.error_message).toMatch(/unreachable/);
      // The final edit should render the error.
      const lastEdit = edits.at(-1);
      expect(lastEdit?.text).toMatch(/error/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("EngineDriverError model_missing → error_message preserves pull hint", async () => {
    const { db, dir } = await freshDb("engine-err-model");
    try {
      const { tg } = makeFakeTg();
      const driver = fakeDriver(
        "ollama",
        new EngineDriverError(
          "ollama",
          "model_missing",
          "model not found: gemma3:e4b — pull with `ollama pull gemma3:e4b` on the host",
          404,
        ),
      );
      await runEngineTurn(
        {
          tg,
          db,
          driver,
          model: "gemma3:e4b",
          timeoutMs: 5000,
          historyLimit: 6,
          soul: SOUL,
          instanceMdPath: "/dev/null/nope",
        },
        { chatId: 1, fromId: 2, updateId: 1, prompt: "hi" },
      );
      const row = db.raw.query("SELECT status, error_message FROM audit").get() as {
        status: string;
        error_message: string;
      };
      expect(row.status).toBe("error");
      expect(row.error_message).toMatch(/ollama pull/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("in-stream error event also lands as audit status='error'", async () => {
    const { db, dir } = await freshDb("engine-err-stream");
    try {
      const { tg } = makeFakeTg();
      const driver = fakeDriver("ollama", [
        { kind: "text", delta: "started" },
        { kind: "error", message: "OOM" },
      ]);
      await runEngineTurn(
        {
          tg,
          db,
          driver,
          model: "m",
          timeoutMs: 5000,
          historyLimit: 6,
          soul: SOUL,
          instanceMdPath: "/dev/null/nope",
        },
        { chatId: 1, fromId: 2, updateId: 1, prompt: "hi" },
      );
      const row = db.raw.query("SELECT status, error_message FROM audit").get() as {
        status: string;
        error_message: string;
      };
      expect(row.status).toBe("error");
      expect(row.error_message).toMatch(/OOM/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("runEngineTurn — token capture", () => {
  test("done event token counts flow into audit", async () => {
    const { db, dir } = await freshDb("engine-tokens");
    try {
      const { tg } = makeFakeTg();
      const driver = fakeDriver("ollama", [
        { kind: "text", delta: "answer" },
        { kind: "done", inputTokens: 42, outputTokens: 17, costUsd: null },
      ]);
      await runEngineTurn(
        {
          tg,
          db,
          driver,
          model: "m",
          timeoutMs: 5000,
          historyLimit: 6,
          soul: SOUL,
          instanceMdPath: "/dev/null/nope",
        },
        { chatId: 1, fromId: 2, updateId: 1, prompt: "hi" },
      );
      const row = db.raw
        .query("SELECT input_tokens, output_tokens, cost_usd FROM audit")
        .get() as { input_tokens: number; output_tokens: number; cost_usd: number };
      expect(row.input_tokens).toBe(42);
      expect(row.output_tokens).toBe(17);
      // Local mode is always zero-cost.
      expect(row.cost_usd).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("runEngineTurn — remote mode (OpenRouter)", () => {
  test("audit.model is 'remote:openrouter:<model>' with the slash-bearing slug intact", async () => {
    const { db, dir } = await freshDb("remote-audit-tag");
    try {
      const { tg } = makeFakeTg();
      const driver = fakeDriver("openrouter", [
        { kind: "text", delta: "hi" },
        { kind: "done", inputTokens: 12, outputTokens: 3, costUsd: 0.00007 },
      ]);
      await runEngineTurn(
        {
          tg,
          db,
          driver,
          model: "anthropic/claude-3.5-sonnet",
          timeoutMs: 5000,
          historyLimit: 6,
          soul: SOUL,
          instanceMdPath: "/dev/null/nope",
          isDefaultEngine: true,
        },
        { chatId: 99, fromId: 7, updateId: 1, prompt: "hello" },
      );
      const row = db.raw
        .query("SELECT model FROM audit")
        .get() as { model: string };
      expect(row.model).toBe("remote:openrouter:anthropic/claude-3.5-sonnet");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("driver-reported costUsd is written to audit.cost_usd in remote mode", async () => {
    // The load-bearing path. Without this, remote turns bypass the hourly
    // cost cap (COALESCE(SUM(cost_usd), 0) treats a 0 write as free).
    const { db, dir } = await freshDb("remote-cost-capture");
    try {
      const { tg } = makeFakeTg();
      const driver = fakeDriver("openrouter", [
        { kind: "text", delta: "answer" },
        { kind: "done", inputTokens: 100, outputTokens: 50, costUsd: 0.00125 },
      ]);
      await runEngineTurn(
        {
          tg,
          db,
          driver,
          model: "openai/gpt-4o-mini",
          timeoutMs: 5000,
          historyLimit: 6,
          soul: SOUL,
          instanceMdPath: "/dev/null/nope",
        },
        { chatId: 1, fromId: 2, updateId: 1, prompt: "hi" },
      );
      const row = db.raw
        .query("SELECT cost_usd FROM audit")
        .get() as { cost_usd: number };
      expect(row.cost_usd).toBe(0.00125);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("remote mode with null costUsd → audit.cost_usd is NULL (not 0)", async () => {
    // Defensive: if OpenRouter ever stops including cost, we must NOT write
    // 0 (that would silently bypass the cap query) — null preserves the
    // audit row but excludes it from the cap sum.
    const { db, dir } = await freshDb("remote-cost-missing");
    try {
      const { tg } = makeFakeTg();
      const driver = fakeDriver("openrouter", [
        { kind: "text", delta: "answer" },
        { kind: "done", inputTokens: 10, outputTokens: 2, costUsd: null },
      ]);
      await runEngineTurn(
        {
          tg,
          db,
          driver,
          model: "openai/gpt-4o-mini",
          timeoutMs: 5000,
          historyLimit: 6,
          soul: SOUL,
          instanceMdPath: "/dev/null/nope",
        },
        { chatId: 1, fromId: 2, updateId: 1, prompt: "hi" },
      );
      const row = db.raw
        .query("SELECT cost_usd FROM audit")
        .get() as { cost_usd: number | null };
      expect(row.cost_usd).toBe(null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("local mode ignores driver costUsd and writes 0", async () => {
    // Symmetric guard: even if a future local-mode driver started reporting
    // a cost field, we ignore it — local mode is always free.
    const { db, dir } = await freshDb("local-mode-cost-zero");
    try {
      const { tg } = makeFakeTg();
      const driver = fakeDriver("ollama", [
        { kind: "text", delta: "answer" },
        // Pretend a driver erroneously reports cost even in local mode.
        { kind: "done", inputTokens: 5, outputTokens: 3, costUsd: 0.99 },
      ]);
      await runEngineTurn(
        {
          tg,
          db,
          driver,
          model: "gemma3:e4b",
          timeoutMs: 5000,
          historyLimit: 6,
          soul: SOUL,
          instanceMdPath: "/dev/null/nope",
        },
        { chatId: 1, fromId: 2, updateId: 1, prompt: "hi" },
      );
      const row = db.raw
        .query("SELECT cost_usd FROM audit")
        .get() as { cost_usd: number };
      expect(row.cost_usd).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("buildRemoteCapabilityNote", () => {
  test("injects per-token cost framing", () => {
    const note = buildRemoteCapabilityNote({
      toolsEnabled: false,
      isDefaultEngine: true,
      toolNames: [],
    });
    expect(note).toMatch(/per-token via OpenRouter/);
    expect(note).not.toMatch(/cost the operator nothing/);
  });

  test("local builder keeps the free-cost framing", () => {
    const note = buildLocalCapabilityNote({
      toolsEnabled: false,
      isDefaultEngine: true,
      toolNames: [],
    });
    expect(note).toMatch(/cost the operator nothing/);
  });

});

describe("scrubLocalControlTokens", () => {
  test("strips paired <|channel>...<channel|> block including header content", () => {
    const input = "<|channel>thought<channel|>It is 8:44 PM in London.";
    expect(scrubLocalControlTokens(input)).toBe("It is 8:44 PM in London.");
  });

  test("strips multiline channel block with leading whitespace", () => {
    const input =
      "<|channel>thought\n<channel|>Logged: https://www.notion.so/abc";
    expect(scrubLocalControlTokens(input)).toBe(
      "Logged: https://www.notion.so/abc",
    );
  });

  test("suppresses an unclosed opener mid-stream", () => {
    expect(scrubLocalControlTokens("<|channel>thought")).toBe("");
    expect(scrubLocalControlTokens("Hi.<|channel>par")).toBe("Hi.");
  });

  test("strips stray symmetric harmony tokens", () => {
    expect(scrubLocalControlTokens("<|start|>hello<|end|>")).toBe("hello");
    expect(
      scrubLocalControlTokens("<|message|>real content<|return|>"),
    ).toBe("real content");
  });

  test("strips orphan closing tokens", () => {
    expect(scrubLocalControlTokens("leftover<channel|>real")).toBe(
      "leftoverreal",
    );
  });

  test("leaves normal text alone", () => {
    const txt = "Pipes | are fine. <html> tags too.";
    expect(scrubLocalControlTokens(txt)).toBe(txt);
  });

  test("handles multiple blocks in one buffer", () => {
    const input =
      "<|channel>thought<channel|>first.<|channel>analysis<channel|>second.";
    expect(scrubLocalControlTokens(input)).toBe("first.second.");
  });
});
