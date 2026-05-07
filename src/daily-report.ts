/**
 * @fileoverview Daily cost report cron: DM yesterday's per-chat spend.
 * @purpose On boot and every 24h after, query yesterday's `audit` rows
 *          grouped by `chat_id` and DM the formatted summary to the first
 *          allowlist entry (typically the operator). Idempotent via a meta
 *          key so duplicate ticks don't double-send.
 *
 * The cron primitive is `setInterval(24h)` with a boot-time fire, gated by
 * `meta.cost_report_last_date` (UTC date string). Process restarts can't
 * cause double-sends because the meta key is checked first; missed days
 * catch up on next boot because the boot-fire runs immediately.
 *
 * Send failure (e.g. Telegram unreachable) leaves the meta key UNCHANGED so
 * the next tick retries. This is the right default — if the operator is on
 * a flaky network, missing one DM and getting it later is better than
 * silently dropping it.
 *
 * The window is "yesterday in UTC" — `[utcMidnightToday - 86400000,
 * utcMidnightToday)`. UTC keeps the boundary unambiguous regardless of host
 * timezone; production hosts are typically UTC anyway.
 *
 * Position in the dependency graph:
 *   db + telegram + log → daily-report → consumed by main
 *
 * Exports:
 *   - `runDailyReport(deps)` — async; runs once. Returns `"sent" |
 *     "skipped_already_sent" | "send_failed"`. Pure-ish (mutates meta + tg).
 *   - `formatReport(yesterdayStart, rows)` — pure formatter; emits HTML.
 *   - `startDailyReportCron(deps, intervalMs?)` — fires once + on interval;
 *     returns `{ stop }`.
 *   - `DailyReportDeps`, `DailyReportCronHandle`, `DailyReportOutcome`.
 *
 * Key invariants:
 *   - Meta key (`cost_report_last_date`) is set ONLY after a successful
 *     `tg.sendMessage`. Failure paths leave it unchanged so the next tick
 *     retries.
 *   - The window is `[yesterdayStart, todayStart)` — half-open. Today's
 *     turns are NEVER in yesterday's report.
 *   - `now` is injectable for tests; defaults to `new Date()`.
 *   - `formatReport` HTML-escapes `yDate` even though it's a known-safe
 *     ISO date string. Defense-in-depth costs nothing.
 *
 * Gotchas:
 *   - `cost_report_last_date` is the string `YYYY-MM-DD` (UTC). To force a
 *     re-fire, `DELETE FROM meta WHERE key = 'cost_report_last_date'` and
 *     restart. See docs/RUNBOOK.md#cost-report-missing.
 *   - Empty rows produce a "No billable activity." message — distinct from
 *     "didn't send today" so operators can confirm the cron fired.
 *   - The interval default is exactly 24h; over many years this drifts due
 *     to setInterval's "approximately every X ms" semantics, but the meta
 *     key idempotency makes drift harmless.
 *   - Cron does NOT start when `allowlistBootstrap.length === 0`. main.ts
 *     guards this; if you wire the cron elsewhere, replicate the guard.
 *
 * Cross-references:
 *   - docs/OPERATIONS.md#daily-cost-report — operator-facing semantics
 *   - docs/RUNBOOK.md#cost-report-missing — recovery procedure
 *   - main.ts — wiring + guard on `allowlistBootstrap.length`
 */

import type { ChatCostRow, SolracDb } from "./db.ts";
import { log } from "./log.ts";
import { htmlEscapeText, type TelegramClient } from "./telegram.ts";

const META_KEY = "cost_report_last_date";
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export interface DailyReportDeps {
  db: SolracDb;
  tg: TelegramClient;
  targetChatId: number;
  now?: () => Date;
}

export type DailyReportOutcome = "sent" | "skipped_already_sent" | "send_failed";

export async function runDailyReport(deps: DailyReportDeps): Promise<DailyReportOutcome> {
  const now = deps.now?.() ?? new Date();
  const todayKey = utcDateString(now);
  if (deps.db.getMeta(META_KEY) === todayKey) {
    return "skipped_already_sent";
  }

  const todayStart = utcMidnightMs(now);
  const yesterdayStart = todayStart - ONE_DAY_MS;
  const rows = deps.db.sumCostsByChatBetween(yesterdayStart, todayStart);
  const text = formatReport(yesterdayStart, rows);

  try {
    await deps.tg.sendMessage(deps.targetChatId, text, { parse_mode: "HTML" });
  } catch (err) {
    log.warn("cost_report.send_failed", { error: (err as Error).message });
    return "send_failed";
  }

  deps.db.setMeta(META_KEY, todayKey);
  log.info("cost_report.sent", { date: todayKey, chats: rows.length });
  return "sent";
}

export function formatReport(yesterdayStart: number, rows: ChatCostRow[]): string {
  const yDate = utcDateString(new Date(yesterdayStart));
  if (rows.length === 0) {
    return `<b>solrac · daily cost report (${htmlEscapeText(yDate)})</b>\nNo billable activity.`;
  }
  const total = rows.reduce((s, r) => s + r.spent, 0);
  const lines = [
    `<b>solrac · daily cost report (${htmlEscapeText(yDate)})</b>`,
    `Total: $${total.toFixed(4)} across ${rows.length} chat(s)`,
    "",
    ...rows.map((r) => `· chat ${r.chatId}: $${r.spent.toFixed(4)} (${r.turns} turns)`),
  ];
  return lines.join("\n");
}

function utcDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function utcMidnightMs(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export interface DailyReportCronHandle {
  stop: () => void;
}

export function startDailyReportCron(
  deps: DailyReportDeps,
  intervalMs: number = ONE_DAY_MS,
): DailyReportCronHandle {
  const tick = () => {
    void runDailyReport(deps).catch((err) => {
      log.warn("cost_report.error", { error: (err as Error).message });
    });
  };
  // Fire on boot to catch up on any missed day; idempotent via meta key.
  tick();
  const timer = setInterval(tick, intervalMs);
  return {
    stop: () => clearInterval(timer),
  };
}
