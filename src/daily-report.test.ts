/**
 * @fileoverview Unit tests for the daily cost report cron.
 * @proves `formatReport` produces the expected HTML; `runDailyReport`
 *         correctly windows yesterday-only audit rows, sends the message,
 *         advances the meta key on success, and leaves it untouched on
 *         failure (so the next tick retries).
 *
 * Tests use a real `openDb()` (fast) and a fake `TelegramClient` that records
 * every `sendMessage` call and can be configured to fail the next call.
 * Time is injected via `now: () => fixed` so window math is deterministic.
 *
 * Scenarios covered:
 *
 *   formatReport:
 *     - Empty rows → "No billable activity" message.
 *     - Multiple rows summed correctly + per-chat lines.
 *
 *   runDailyReport:
 *     - First run sends the report and sets `meta.cost_report_last_date`.
 *     - Second run within the same UTC day is a no-op (returns
 *       'skipped_already_sent', no second send).
 *     - Excludes today's costs (window is `[yesterday, today)`).
 *     - Send failure does NOT advance the meta key — next run succeeds.
 *     - Zero-activity days still send (with no-activity message).
 *
 * Not covered (intentional):
 *   - The `setInterval` cron loop (we test the per-tick function directly).
 *   - Telegram-side success of the actual DM (we trust `sendMessage`'s
 *     contract; failures are surfaced by the throw path).
 *
 * Cross-references:
 *   - daily-report.ts — implementation
 *   - docs/OPERATIONS.md#daily-cost-report — operator-facing semantics
 *   - docs/RUNBOOK.md#cost-report-missing — recovery
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatReport, runDailyReport } from "./daily-report.ts";
import { openDb, type SolracDb } from "./db.ts";
import type { TelegramClient } from "./telegram.ts";

interface FakeTg extends TelegramClient {
  sent: Array<{ chatId: number; text: string }>;
  failNext: boolean;
}

function makeFakeTg(): FakeTg {
  const sent: Array<{ chatId: number; text: string }> = [];
  const tg: Partial<FakeTg> = {
    sent,
    failNext: false,
    sendMessage: async (chatId, text) => {
      if (tg.failNext) {
        tg.failNext = false;
        throw new Error("network down");
      }
      sent.push({ chatId, text });
      return { message_id: sent.length, date: 0, chat: { id: chatId, type: "private" } } as never;
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
  const dir = mkdtempSync(join(tmpdir(), "solrac-daily-"));
  const db = await openDb(dir);
  const tg = makeFakeTg();
  const h: Harness = { dir, db, tg };
  harnesses.push(h);
  return h;
}

function insertTurn(db: SolracDb, chatId: number, startedAt: number, costUsd: number): void {
  const id = db.insertAudit({
    chatId,
    fromId: chatId,
    updateId: Math.floor(startedAt + chatId),
    prompt: "",
    startedAt,
    model: "claude",
  });
  db.updateAuditEnd({
    id,
    response: null,
    toolCalls: null,
    inputTokens: null,
    outputTokens: null,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
    costUsd,
    agentSessionId: null,
    status: "ok",
    errorMessage: null,
    endedAt: startedAt + 100,
  });
}

const NOW = new Date("2026-04-28T15:00:00Z");
const TODAY_MIDNIGHT = Date.UTC(2026, 3, 28); // 2026-04-28T00:00Z
const YESTERDAY_MIDNIGHT = TODAY_MIDNIGHT - 86_400_000;
const now = () => NOW;

describe("formatReport", () => {
  test("empty rows → no-activity message", () => {
    const text = formatReport(YESTERDAY_MIDNIGHT, []);
    expect(text).toContain("2026-04-27");
    expect(text).toContain("No billable activity");
  });

  test("rows are summed and listed", () => {
    const text = formatReport(YESTERDAY_MIDNIGHT, [
      { chatId: 100, spent: 0.5, turns: 3 },
      { chatId: 200, spent: 0.25, turns: 1 },
    ]);
    expect(text).toContain("2026-04-27");
    expect(text).toContain("Total: $0.7500 across 2 chat(s)");
    expect(text).toContain("chat 100: $0.5000 (3 turns)");
    expect(text).toContain("chat 200: $0.2500 (1 turns)");
  });
});

describe("runDailyReport", () => {
  test("first run sends, sets meta, returns 'sent'", async () => {
    const h = await newHarness();
    insertTurn(h.db, 100, YESTERDAY_MIDNIGHT + 3600_000, 0.42);
    const out = await runDailyReport({
      db: h.db,
      tg: h.tg,
      targetChatId: 999,
      now,
    });
    expect(out).toBe("sent");
    expect(h.tg.sent.length).toBe(1);
    expect(h.tg.sent[0]!.chatId).toBe(999);
    expect(h.tg.sent[0]!.text).toContain("$0.4200");
    expect(h.db.getMeta("cost_report_last_date")).toBe("2026-04-28");
  });

  test("second run within same day is a no-op", async () => {
    const h = await newHarness();
    h.db.setMeta("cost_report_last_date", "2026-04-28");
    const out = await runDailyReport({
      db: h.db,
      tg: h.tg,
      targetChatId: 999,
      now,
    });
    expect(out).toBe("skipped_already_sent");
    expect(h.tg.sent.length).toBe(0);
  });

  test("excludes today's costs (window is yesterday only)", async () => {
    const h = await newHarness();
    insertTurn(h.db, 100, YESTERDAY_MIDNIGHT + 1000, 0.1);
    insertTurn(h.db, 100, TODAY_MIDNIGHT + 1000, 0.99); // today, should NOT count
    const out = await runDailyReport({
      db: h.db,
      tg: h.tg,
      targetChatId: 999,
      now,
    });
    expect(out).toBe("sent");
    expect(h.tg.sent[0]!.text).toContain("$0.1000");
    expect(h.tg.sent[0]!.text).not.toContain("0.9900");
  });

  test("send failure does not advance meta (so retries next tick)", async () => {
    const h = await newHarness();
    insertTurn(h.db, 100, YESTERDAY_MIDNIGHT + 1000, 0.1);
    h.tg.failNext = true;
    const out = await runDailyReport({
      db: h.db,
      tg: h.tg,
      targetChatId: 999,
      now,
    });
    expect(out).toBe("send_failed");
    expect(h.db.getMeta("cost_report_last_date")).toBeNull();
    // next call succeeds and advances meta
    const out2 = await runDailyReport({
      db: h.db,
      tg: h.tg,
      targetChatId: 999,
      now,
    });
    expect(out2).toBe("sent");
    expect(h.db.getMeta("cost_report_last_date")).toBe("2026-04-28");
  });

  test("reports zero-activity day with no rows", async () => {
    const h = await newHarness();
    const out = await runDailyReport({
      db: h.db,
      tg: h.tg,
      targetChatId: 999,
      now,
    });
    expect(out).toBe("sent");
    expect(h.tg.sent[0]!.text).toContain("No billable activity");
  });
});
