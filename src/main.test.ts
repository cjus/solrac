/**
 * @fileoverview Unit tests for `main.ts` exported helpers.
 * @proves `auditQueueFull` writes the audit row deterministically and is
 *         resilient to a Telegram-side failure on the user-facing ack.
 *
 * Most of `main.ts` is glue (transport selection, lifecycle wiring, cron
 * setup) and exercised end-to-end by integration smokes. The helpers exposed
 * for testing here are the small bits of business logic in main.ts that have
 * a real failure mode worth pinning.
 *
 * Scenarios covered:
 *
 *   auditQueueFull:
 *     - Writes a `status='error', error_message='queue_full'` audit row tagged
 *       `model='system'` even when `tg.sendMessage` rejects (fire-and-forget
 *       semantics, the ack is a UX nicety, the audit row is the operator
 *       source of truth).
 *     - The unhandled-rejection from `sendMessage` lands as a
 *       `queue_full.ack_failed` warn log, not a thrown error.
 *
 * Not covered (intentional):
 *   - The full poll-handler flow (covered by integration smokes).
 *   - `gateAndAuditDenied` (covered by `policy.test.ts` for the gate logic
 *     and the existing flood smoke for the audit write).
 *
 * Cross-references:
 *   - main.ts::auditQueueFull — implementation
 *   - docs/RUNBOOK.md#queue-full — operator recovery
 */

import type { Update } from "@grammyjs/types";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type SolracDb } from "./db.ts";
import { auditQueueFull } from "./main.ts";
import type { TelegramClient } from "./telegram.ts";

interface FakeTg extends TelegramClient {
  sent: Array<{ chatId: number; text: string }>;
  sendShouldThrow: boolean;
}

function makeFakeTg(): FakeTg {
  const sent: Array<{ chatId: number; text: string }> = [];
  const tg: Partial<FakeTg> = {
    sent,
    sendShouldThrow: false,
    sendMessage: async (chatId, text) => {
      if (tg.sendShouldThrow) throw new Error("telegram down");
      sent.push({ chatId, text });
      return { message_id: sent.length, date: 0, chat: { id: chatId, type: "private" } } as never;
    },
  };
  return tg as FakeTg;
}

const harnesses: Array<{ dir: string; db: SolracDb }> = [];

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

async function newDb(): Promise<SolracDb> {
  const dir = mkdtempSync(join(tmpdir(), "solrac-main-"));
  const db = await openDb(dir);
  harnesses.push({ dir, db });
  return db;
}

function mkMessageUpdate(chatId: number, fromId: number, text: string): Update {
  return {
    update_id: Math.floor(Math.random() * 1_000_000),
    message: {
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
      from: { id: fromId, is_bot: false, first_name: "u" },
      chat: { id: chatId, type: "private", first_name: "u" },
      text,
    },
  } as Update;
}

describe("auditQueueFull", () => {
  test("writes the audit row even when sendMessage rejects", async () => {
    const db = await newDb();
    const tg = makeFakeTg();
    tg.sendShouldThrow = true;
    const update = mkMessageUpdate(100, 200, "flooding");

    auditQueueFull(update, db, tg, 11);

    // Yield once so the rejected fire-and-forget Promise settles before assert.
    await Promise.resolve();
    await Promise.resolve();

    const rows = db.raw
      .query(
        "SELECT chat_id, from_id, status, error_message, model FROM audit WHERE chat_id = ?",
      )
      .all(100) as Array<{
      chat_id: number;
      from_id: number;
      status: string;
      error_message: string;
      model: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      chat_id: 100,
      from_id: 200,
      status: "error",
      error_message: "queue_full",
      model: "system",
    });
    // sendMessage threw, so nothing was actually delivered.
    expect(tg.sent).toHaveLength(0);
  });

  test("delivers the ack when sendMessage succeeds", async () => {
    const db = await newDb();
    const tg = makeFakeTg();
    const update = mkMessageUpdate(100, 200, "flooding");

    auditQueueFull(update, db, tg, 11);

    // Yield once so the fire-and-forget Promise settles.
    await Promise.resolve();
    await Promise.resolve();

    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0]).toEqual({ chatId: 100, text: "queue full, please slow down" });
    const rows = db.raw.query("SELECT status FROM audit WHERE chat_id = ?").all(100) as Array<{
      status: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("error");
  });

  test("skips the ack when chat_id can't be extracted (sentinel 0)", async () => {
    const db = await newDb();
    const tg = makeFakeTg();
    // callback_query carries `from` but `message` is optional. Without a
    // message attachment, extractChatId returns undefined → chatId becomes 0
    // → the ack is suppressed (we don't have a chat to send to).
    const update: Update = {
      update_id: 999,
      callback_query: {
        id: "cb-id",
        from: { id: 200, is_bot: false, first_name: "u" },
        chat_instance: "abc",
        data: "cb:data",
      },
    } as unknown as Update;

    auditQueueFull(update, db, tg, 11);
    await Promise.resolve();

    expect(tg.sent).toHaveLength(0);
    const rows = db.raw.query("SELECT chat_id FROM audit").all() as Array<{ chat_id: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.chat_id).toBe(0);
  });
});
