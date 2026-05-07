/**
 * @fileoverview Graceful shutdown coordinator: SIGINT/SIGTERM → drain → exit.
 * @purpose Run an idempotent shutdown sequence that aborts the poll loop,
 *          stops the HTTP server, drains in-flight turns (with timeout),
 *          checkpoints WAL, closes the database, removes the PID file, and
 *          exits with a code reflecting whether drain completed.
 *
 * systemd sends SIGTERM on `systemctl stop`, then waits `TimeoutStopSec=90`
 * before escalating to SIGKILL. Solrac's drain budget defaults to 60s — 30s
 * of slack before systemd kills us. If drain succeeds, we exit 0 (systemd
 * stays down). If drain times out, we exit 1 (treated as failure → systemd
 * restarts on `Restart=on-failure`).
 *
 * The handler is idempotent: a second SIGTERM during shutdown returns the
 * same in-flight Promise; doesn't double-drain. The first signal wins.
 *
 * Test injectability: `exit`, `signals`, and `registerSignal` are optional
 * deps so tests can avoid touching `process.on` and `process.exit`. Tests
 * pass `signals: []` and call `handle.trigger(reason)` directly.
 *
 * Position in the dependency graph:
 *   db + log + turn-tracker → lifecycle → consumed by main
 *
 * Exports:
 *   - `installShutdown(deps)` — register signal handlers, return `{ trigger,
 *     triggered }`. `trigger(reason)` is exposed for tests and explicit calls.
 *   - `ShutdownDeps` — input shape (tracker, db, pidPath, pollAbort, server,
 *     drainTimeoutMs?, exit?, signals?, registerSignal?).
 *   - `ShutdownHandle` — returned shape.
 *   - `ShutdownServer` — minimal Bun.serve-like interface (only `stop()`).
 *
 * Key invariants:
 *   - `triggered` is set BEFORE `pending` so a second `trigger()` call sees
 *     a pending Promise to return.
 *   - The order of operations matters:
 *       1. abort poll (stop accepting new updates)
 *       2. stop HTTP server (close /health, /stats)
 *       3. drain tracker (wait for in-flight turns) — bounded by timeout
 *       4. WAL checkpoint (collapse WAL into main file)
 *       5. db.close() (release file handles)
 *       6. unlink PID file
 *       7. exit
 *     Steps 1 and 2 are non-blocking. Step 3 is bounded. Steps 4–6 are fast
 *     and safe even on timeout (database is left consistent).
 *   - Errors in any step LOG and continue. We never throw from a step;
 *     shutdown should always reach `exit()`.
 *
 * Gotchas:
 *   - The drain-vs-timeout race uses Promise.race; the timer is cleared after
 *     the race even on the drain branch (otherwise we'd leak the timer).
 *   - `exit(code)` is called via injection so tests don't kill the test
 *     runner. In production, `process.exit` ends the process before the
 *     Promise returned by `trigger()` settles to the original caller — but
 *     since shutdown only fires once and the caller doesn't await the result,
 *     that's acceptable.
 *   - PID file unlink uses `existsSync` first to avoid an ENOENT throw on
 *     re-entrancy. The `if (existsSync) unlinkSync` race is fine here —
 *     only this process should be touching the PID file.
 *
 * Cross-references:
 *   - docs/ARCHITECTURE.md#lifecycle — sequence diagram + rationale
 *   - docs/RUNBOOK.md#drain-timeout — recovery if drain hangs
 *   - main.ts — installs the shutdown right after wiring queue + server
 *   - poll.ts — the `signal` parameter wired up by lifecycle
 */

import { existsSync, unlinkSync } from "node:fs";
import type { SolracDb } from "./db.ts";
import { log } from "./log.ts";
import type { TurnTracker } from "./turn-tracker.ts";

export interface ShutdownServer {
  stop: (closeActiveConnections?: boolean) => void | Promise<void>;
}

export interface ShutdownDeps {
  tracker: TurnTracker;
  db: SolracDb;
  pidPath: string;
  pollAbort: AbortController;
  server?: ShutdownServer | null;
  drainTimeoutMs?: number;
  exit?: (code: number) => void;
  signals?: NodeJS.Signals[];
  registerSignal?: (signal: NodeJS.Signals, handler: () => void) => void;
}

export interface ShutdownHandle {
  trigger: (reason: string) => Promise<void>;
  triggered: () => boolean;
}

// systemd's TimeoutStopSec is 90s; leave a 30s margin so the process exits
// before systemd issues SIGKILL.
const DEFAULT_DRAIN_TIMEOUT_MS = 60_000;
const DEFAULT_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

export function installShutdown(deps: ShutdownDeps): ShutdownHandle {
  const drainTimeoutMs = deps.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  const exit = deps.exit ?? ((code) => process.exit(code));
  const signals = deps.signals ?? DEFAULT_SIGNALS;
  const registerSignal =
    deps.registerSignal ?? ((sig, handler) => void process.on(sig, handler));

  let triggered = false;
  let pending: Promise<void> | null = null;

  const trigger = (reason: string): Promise<void> => {
    if (pending) return pending;
    triggered = true;
    pending = run(reason);
    return pending;
  };

  const run = async (reason: string): Promise<void> => {
    log.info("shutdown.start", { reason, inFlight: deps.tracker.count });

    deps.pollAbort.abort();

    if (deps.server) {
      try {
        await deps.server.stop();
        log.info("shutdown.server_stopped");
      } catch (err) {
        log.warn("shutdown.server_stop_failed", { error: (err as Error).message });
      }
    }

    const timedOut = await drainWithTimeout(deps.tracker, drainTimeoutMs);
    if (timedOut) {
      log.error("shutdown.drain_timeout", {
        drainTimeoutMs,
        inFlight: deps.tracker.count,
      });
    } else {
      log.info("shutdown.drained");
    }

    try {
      deps.db.raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      log.info("shutdown.wal_checkpointed");
    } catch (err) {
      log.warn("shutdown.wal_checkpoint_failed", { error: (err as Error).message });
    }

    try {
      deps.db.close();
      log.info("shutdown.db_closed");
    } catch (err) {
      log.warn("shutdown.db_close_failed", { error: (err as Error).message });
    }

    try {
      if (existsSync(deps.pidPath)) {
        unlinkSync(deps.pidPath);
        log.info("shutdown.pidfile_removed", { pidPath: deps.pidPath });
      }
    } catch (err) {
      log.warn("shutdown.pidfile_remove_failed", { error: (err as Error).message });
    }

    log.info("shutdown.done", { timedOut });
    exit(timedOut ? 1 : 0);
  };

  for (const signal of signals) {
    registerSignal(signal, () => {
      void trigger(signal);
    });
  }

  return {
    trigger,
    triggered: () => triggered,
  };
}

async function drainWithTimeout(tracker: TurnTracker, timeoutMs: number): Promise<boolean> {
  if (tracker.count === 0) return false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const drain = tracker.drain().then<"drained">(() => "drained");
  const result = await Promise.race([drain, timeout]);
  if (timer) clearTimeout(timer);
  return result === "timeout";
}
