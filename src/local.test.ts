/**
 * @fileoverview Unit tests for `local.ts`.
 * @proves Capability-note matrix (pure), audit-tag invariant
 *         (`local:<backend>:<model>`), driver-error → render translation,
 *         and token-count capture from `done` events.
 *
 * Wire-format edge cases (NDJSON / SSE parsing) belong in
 * `local-driver.test.ts`. Tool-loop behavior belongs in
 * `local-tools.test.ts`. This file exercises only the runner-level
 * concerns that survive the driver abstraction.
 */

import { describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import type { Message } from "@grammyjs/types";
import {
  buildLocalCapabilityNote,
  buildToolCapabilityNote,
  runLocalTurn,
} from "./local.ts";
import {
  type LocalChatEvent,
  type LocalDriver,
  type LocalStreamChatOpts,
  LocalDriverError,
} from "./local-driver.ts";
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
  backend: "ollama" | "lmstudio",
  events: LocalChatEvent[] | Error,
): LocalDriver {
  return {
    backend,
    async probe() {
      return { ok: true };
    },
    async *streamChat(_opts: LocalStreamChatOpts): AsyncIterable<LocalChatEvent> {
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

describe("buildToolCapabilityNote", () => {
  test("defers to buildLocalCapabilityNote with toolsEnabled=true", () => {
    const a = buildToolCapabilityNote(["x"], true);
    const b = buildLocalCapabilityNote({
      toolsEnabled: true,
      isDefaultEngine: true,
      toolNames: ["x"],
    });
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// runLocalTurn — integration with real db + fake tg + fake driver
// ---------------------------------------------------------------------------

describe("runLocalTurn — audit tag invariant", () => {
  test("ollama backend writes audit.model = 'local:ollama:<model>'", async () => {
    const { db, dir } = await freshDb("local-audit-ollama");
    try {
      const { tg } = makeFakeTg();
      const driver = fakeDriver("ollama", [
        { kind: "text", delta: "hello" },
        { kind: "done", inputTokens: 5, outputTokens: 3 },
      ]);
      await runLocalTurn(
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
    const { db, dir } = await freshDb("local-audit-lmstudio");
    try {
      const { tg } = makeFakeTg();
      const driver = fakeDriver("lmstudio", [
        { kind: "text", delta: "hello" },
        { kind: "done", inputTokens: 5, outputTokens: 3 },
      ]);
      await runLocalTurn(
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

describe("runLocalTurn — error rendering", () => {
  test("LocalDriverError unreachable → audit status='error', edit shows error", async () => {
    const { db, dir } = await freshDb("local-err-unreachable");
    try {
      const { tg, edits } = makeFakeTg();
      const driver = fakeDriver(
        "ollama",
        new LocalDriverError("ollama", "unreachable", "unreachable: http://x"),
      );
      await runLocalTurn(
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

  test("LocalDriverError model_missing → error_message preserves pull hint", async () => {
    const { db, dir } = await freshDb("local-err-model");
    try {
      const { tg } = makeFakeTg();
      const driver = fakeDriver(
        "ollama",
        new LocalDriverError(
          "ollama",
          "model_missing",
          "model not found: gemma3:e4b — pull with `ollama pull gemma3:e4b` on the host",
          404,
        ),
      );
      await runLocalTurn(
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
    const { db, dir } = await freshDb("local-err-stream");
    try {
      const { tg } = makeFakeTg();
      const driver = fakeDriver("ollama", [
        { kind: "text", delta: "started" },
        { kind: "error", message: "OOM" },
      ]);
      await runLocalTurn(
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

describe("runLocalTurn — token capture", () => {
  test("done event token counts flow into audit", async () => {
    const { db, dir } = await freshDb("local-tokens");
    try {
      const { tg } = makeFakeTg();
      const driver = fakeDriver("ollama", [
        { kind: "text", delta: "answer" },
        { kind: "done", inputTokens: 42, outputTokens: 17 },
      ]);
      await runLocalTurn(
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
      // Local engine is always zero-cost.
      expect(row.cost_usd).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
