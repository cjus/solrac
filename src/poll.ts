/**
 * @fileoverview Long-poll Telegram transport with PID file and dedupe.
 * @purpose Drive Solrac in poll mode: long-poll `getUpdates` (timeout=30s)
 *          against Telegram, advance the offset, dedupe by `update_id`, and
 *          dispatch each update to the handler. Also acquires the PID file
 *          on boot to prevent the "zombie poller" pattern.
 *
 * Telegram permits exactly ONE consumer per bot token at a time. The PID
 * file is Solrac's defense against accidentally spawning two instances on
 * the same machine. On boot, if a PID file exists and that PID is alive
 * (`kill -0` returns success), refuse to start. If the PID is dead (ESRCH),
 * unlink the stale file and proceed.
 *
 * If `getUpdates` returns 409 Conflict (another consumer is polling), we
 * `process.exit(1)` immediately. systemd's `Restart=on-failure` brings the
 * process back; the next boot's stale-PID detection cleans up if we left
 * the PID file behind. This is intentional fast-fail — see
 * docs/RUNBOOK.md#409-conflict.
 *
 * The dedupe pattern: every update goes through `db.claimUpdate(update_id)`
 * which is `INSERT OR IGNORE` on the `handled_updates` PK. If the insert
 * succeeds (rowsChanged > 0), this is a fresh update — run the handler.
 * Otherwise it's a duplicate (e.g. we restarted after handling but before
 * advancing the offset) — log and skip. Idempotency under restart.
 *
 * The poll loop is structured so:
 *   1. claimUpdate (idempotency)
 *   2. handler (may async-fire turn into the queue and return)
 *   3. db.setMeta('poll_offset', update_id + 1)
 * Crash between (1) and (3) means the next boot re-fetches starting at the
 * old offset; the dedupe in (1) prevents reprocessing.
 *
 * Position in the dependency graph:
 *   telegram + db + log → poll → consumed by main
 *
 * Exports:
 *   - `acquirePidFile(dataDir)` — async: mkdir, stale-detect, write our PID;
 *     returns the path. Throws if a live instance owns the file.
 *   - `startPolling({tg, db, handler, signal?})` — main loop. Resolves on abort.
 *   - `PollDeps` — input shape.
 *
 * Key invariants:
 *   - PID file at `data/solrac.pid` is owned by exactly one Solrac instance.
 *     `acquirePidFile` either acquires it or throws.
 *   - 409 → `process.exit(1)`. NEVER retry; that would race forever.
 *   - The handler call is `await`ed; the handler is expected to be sync-fast
 *     (it queues to `void work()`). Long handler awaits delay the offset
 *     advance and risk reprocessing on crash.
 *   - `claimUpdate` MUST happen before `handler(update)`. Reversing would
 *     drop updates on a crash between handler completion and the claim.
 *
 * Gotchas:
 *   - `isAlive(pid)` returns `true` when `kill -0` returns EPERM — the PID
 *     is alive but owned by another user. Treat as occupied; refuse to start.
 *   - `signal?.aborted` is checked at the top of every iteration AND
 *     `tg.getUpdates` is passed the signal. Lifecycle's `pollAbort.abort()`
 *     unblocks the long-poll within ms.
 *   - `handler_error` logs and continues — we DON'T re-throw. The offset
 *     still advances. Otherwise a handler bug would loop the same bad update
 *     forever.
 *   - `process.exit(1)` on 409 BYPASSES lifecycle, so the PID file is left
 *     behind. That's intentional: stale-PID detection on next boot cleans
 *     it up. If you wire lifecycle into this path, ensure the cleanup path
 *     is still race-safe with systemd's restart.
 *
 * Cross-references:
 *   - docs/RUNBOOK.md#409-conflict — recovery procedure
 *   - docs/RUNBOOK.md#zombie-poller — stale-PID detection
 *   - main.ts — passes `pollAbort.signal` and the handler closure
 *   - lifecycle.ts — owns the PID-file unlink on graceful shutdown
 */

import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Update } from "@grammyjs/types";
import type { SolracDb } from "./db.ts";
import { log } from "./log.ts";
import { TelegramConflictError, type TelegramClient } from "./telegram.ts";

const META_KEY_OFFSET = "poll_offset";

export interface PollDeps {
  tg: TelegramClient;
  db: SolracDb;
  handler: (update: Update) => Promise<void>;
  signal?: AbortSignal;
}

/**
 * Acquire `data/solrac.pid` atomically.
 *
 * Uses `openSync(path, "wx")` (`O_CREAT|O_EXCL`) so two instances racing the
 * same path can't both pass an alive-check and both clobber the file. The
 * old non-atomic form (`existsSync → isAlive → unlinkSync → Bun.write`) had
 * a window where two crashed-and-restarting processes under
 * `Restart=on-failure` could both observe a dead PID, both unlink, and both
 * win. The race-loss outcome there is silent — both think they own the bot.
 *
 * Algorithm:
 *   1. Try `openSync(path, "wx")`. Success → write our PID, done.
 *   2. EEXIST → read the existing PID. If alive (kill -0 ok or EPERM),
 *      refuse to start.
 *   3. Dead PID → unlink (ENOENT means another racer beat us, fine), retry
 *      `openSync(path, "wx")` once.
 *   4. Second EEXIST → another instance won between our unlink and our
 *      open; throw `pidfile.race_lost` so the operator can investigate.
 */
export async function acquirePidFile(dataDir: string): Promise<string> {
  await mkdir(dataDir, { recursive: true });
  const pidPath = join(dataDir, "solrac.pid");
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const fd = openSync(pidPath, "wx");
      try {
        writeSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      log.info("pidfile.acquired", { pidPath, pid: process.pid });
      return pidPath;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
      if (attempt === 2) {
        throw new Error(
          `pidfile.race_lost: another instance acquired ${pidPath} between our unlink and exclusive open`,
        );
      }
      const raw = readFileSync(pidPath, "utf8").trim();
      const oldPid = Number(raw);
      if (Number.isInteger(oldPid) && oldPid > 0 && isAlive(oldPid)) {
        throw new Error(
          `another solrac instance is running (pid=${oldPid}, ${pidPath}); refusing to start`,
        );
      }
      log.warn("pidfile.stale", { oldPid, pidPath });
      try {
        unlinkSync(pidPath);
      } catch (unlinkErr) {
        if ((unlinkErr as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkErr;
      }
    }
  }
  throw new Error("pidfile.unreachable: exhausted retry loop");
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw err;
  }
}

export async function startPolling({ tg, db, handler, signal }: PollDeps): Promise<void> {
  const stored = db.getMeta(META_KEY_OFFSET);
  let offset = stored ? Number(stored) : 0;
  if (!Number.isInteger(offset) || offset < 0) offset = 0;
  log.info("poll.start", { offset, resumed: stored !== null });
  while (!signal?.aborted) {
    let updates: Update[];
    try {
      updates = await tg.getUpdates(
        { offset, timeout: 30, allowed_updates: ["message", "callback_query"] },
        signal,
      );
    } catch (err) {
      if (err instanceof TelegramConflictError) {
        log.error("poll.conflict", { description: err.description });
        process.exit(1);
      }
      if ((err as { name?: string }).name === "AbortError") {
        log.info("poll.aborted");
        return;
      }
      log.warn("poll.error", { error: (err as Error).message });
      await Bun.sleep(1000);
      continue;
    }
    for (const update of updates) {
      const msg = update.message ?? update.edited_message;
      const cq = update.callback_query;
      log.info("update.received", {
        update_id: update.update_id,
        chat_id: msg?.chat.id ?? cq?.message?.chat.id ?? null,
        from_id: msg?.from?.id ?? cq?.from.id ?? null,
        text: (msg?.text ?? cq?.data ?? "").slice(0, 80),
      });
      const claimed = db.claimUpdate(update.update_id);
      if (!claimed) {
        log.debug("update.dedup", { update_id: update.update_id });
      } else {
        try {
          await handler(update);
        } catch (err) {
          log.error("poll.handler_error", {
            update_id: update.update_id,
            error: (err as Error).message,
          });
        }
      }
      offset = update.update_id + 1;
      db.setMeta(META_KEY_OFFSET, String(offset));
    }
  }
}
