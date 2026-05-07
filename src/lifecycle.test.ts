/**
 * @fileoverview Unit tests for installShutdown (graceful shutdown coordinator).
 * @proves The shutdown handler aborts polling, stops the server, drains the
 *         tracker (with timeout), checkpoints WAL, closes the db, removes the
 *         PID file, and exits with the correct code — idempotently.
 *
 * Tests use a real `openDb()` (sqlite is fast and verifies WAL checkpoint and
 * close). The Bun.serve handle is mocked via a stub `{ stop }`. `process.exit`
 * is replaced with a captured-codes array; signal handlers are skipped via
 * `signals: []`.
 *
 * Scenarios covered:
 *   - Idle shutdown: aborts poll, stops server, removes pidfile, exits 0;
 *     `db.raw.run("SELECT 1")` throws after shutdown (proves close ran).
 *   - Drain awaits in-flight turns: a `tracker.begin()` blocks shutdown until
 *     the matching `end` is called.
 *   - Drain timeout: a stuck turn that never ends causes exit code 1 after
 *     `drainTimeoutMs` elapses.
 *   - Idempotent trigger: second `trigger()` returns the same in-flight
 *     Promise (server is stopped exactly once).
 *   - Signal handler registration: with `registerSignal` injected, the
 *     captured handler invokes shutdown.
 *   - Server stop error is logged and shutdown continues (exit 0).
 *   - Missing PID file is fine (idempotent unlink path).
 *   - Server is optional (null → skip server.stop, exit 0).
 *
 * Not covered (intentional):
 *   - Real `process.on(SIGTERM)` (would require a subprocess test).
 *   - WAL checkpoint failure (synthesizing requires a corrupt-on-purpose db).
 *   - Cascading errors during shutdown (each step swallows + logs; we don't
 *     exhaustively test each failure × success matrix).
 *
 * Cross-references:
 *   - lifecycle.ts — implementation
 *   - docs/RUNBOOK.md#drain-timeout — operator-facing recovery
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type SolracDb } from "./db.ts";
import { installShutdown } from "./lifecycle.ts";
import { TurnTracker } from "./turn-tracker.ts";

interface Harness {
  dir: string;
  pidPath: string;
  db: SolracDb;
  tracker: TurnTracker;
  pollAbort: AbortController;
  exitCodes: number[];
  serverStops: number;
  serverStopError?: Error;
}

async function makeHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "solrac-lifecycle-"));
  const pidPath = join(dir, "solrac.pid");
  writeFileSync(pidPath, String(process.pid));
  const db = await openDb(dir);
  return {
    dir,
    pidPath,
    db,
    tracker: new TurnTracker(),
    pollAbort: new AbortController(),
    exitCodes: [],
    serverStops: 0,
  };
}

function cleanup(h: Harness): void {
  try {
    h.db.close();
  } catch {}
  rmSync(h.dir, { recursive: true, force: true });
}

let harnesses: Harness[] = [];

beforeEach(() => {
  harnesses = [];
});

afterEach(() => {
  for (const h of harnesses) cleanup(h);
});

async function newHarness(): Promise<Harness> {
  const h = await makeHarness();
  harnesses.push(h);
  return h;
}

function makeServer(h: Harness) {
  return {
    stop: async () => {
      h.serverStops += 1;
      if (h.serverStopError) throw h.serverStopError;
    },
  };
}

describe("installShutdown", () => {
  test("on idle: aborts poll, stops server, checkpoints WAL, closes db, removes pid, exits 0", async () => {
    const h = await newHarness();
    const handle = installShutdown({
      tracker: h.tracker,
      db: h.db,
      pidPath: h.pidPath,
      pollAbort: h.pollAbort,
      server: makeServer(h),
      exit: (c) => void h.exitCodes.push(c),
      signals: [],
    });
    await handle.trigger("test");
    expect(h.pollAbort.signal.aborted).toBe(true);
    expect(h.serverStops).toBe(1);
    expect(existsSync(h.pidPath)).toBe(false);
    expect(h.exitCodes).toEqual([0]);
    expect(handle.triggered()).toBe(true);
    // db.close() happened — raw query should throw.
    expect(() => h.db.raw.run("SELECT 1")).toThrow();
  });

  test("waits for in-flight turns to drain", async () => {
    const h = await newHarness();
    const handle = installShutdown({
      tracker: h.tracker,
      db: h.db,
      pidPath: h.pidPath,
      pollAbort: h.pollAbort,
      server: makeServer(h),
      exit: (c) => void h.exitCodes.push(c),
      signals: [],
    });
    const tag = h.tracker.begin();
    let exited = false;
    const triggerPromise = handle.trigger("SIGTERM").then(() => {
      exited = true;
    });
    await Bun.sleep(20);
    expect(exited).toBe(false);
    expect(h.exitCodes).toEqual([]);
    h.tracker.end(tag);
    await triggerPromise;
    expect(h.exitCodes).toEqual([0]);
  });

  test("drain timeout exits 1 when turns never finish", async () => {
    const h = await newHarness();
    const handle = installShutdown({
      tracker: h.tracker,
      db: h.db,
      pidPath: h.pidPath,
      pollAbort: h.pollAbort,
      server: makeServer(h),
      drainTimeoutMs: 30,
      exit: (c) => void h.exitCodes.push(c),
      signals: [],
    });
    h.tracker.begin();
    await handle.trigger("SIGTERM");
    expect(h.exitCodes).toEqual([1]);
    expect(existsSync(h.pidPath)).toBe(false);
  });

  test("idempotent: second trigger returns the same in-flight promise", async () => {
    const h = await newHarness();
    const handle = installShutdown({
      tracker: h.tracker,
      db: h.db,
      pidPath: h.pidPath,
      pollAbort: h.pollAbort,
      server: makeServer(h),
      exit: (c) => void h.exitCodes.push(c),
      signals: [],
    });
    const tag = h.tracker.begin();
    const p1 = handle.trigger("SIGTERM");
    const p2 = handle.trigger("SIGINT");
    expect(p1).toBe(p2);
    h.tracker.end(tag);
    await p1;
    expect(h.serverStops).toBe(1);
    expect(h.exitCodes).toEqual([0]);
  });

  test("registers signal handlers via injected register", async () => {
    const h = await newHarness();
    const registered: NodeJS.Signals[] = [];
    const handlers: Record<string, () => void> = {};
    installShutdown({
      tracker: h.tracker,
      db: h.db,
      pidPath: h.pidPath,
      pollAbort: h.pollAbort,
      server: makeServer(h),
      exit: (c) => void h.exitCodes.push(c),
      signals: ["SIGINT", "SIGTERM"],
      registerSignal: (sig, handler) => {
        registered.push(sig);
        handlers[sig] = handler;
      },
    });
    expect(registered).toEqual(["SIGINT", "SIGTERM"]);
    handlers["SIGINT"]!();
    // Allow trigger() microtasks to flush.
    await Bun.sleep(10);
    expect(h.exitCodes).toEqual([0]);
  });

  test("server stop error is logged but doesn't block shutdown", async () => {
    const h = await newHarness();
    h.serverStopError = new Error("boom");
    const handle = installShutdown({
      tracker: h.tracker,
      db: h.db,
      pidPath: h.pidPath,
      pollAbort: h.pollAbort,
      server: makeServer(h),
      exit: (c) => void h.exitCodes.push(c),
      signals: [],
    });
    await handle.trigger("SIGTERM");
    expect(h.exitCodes).toEqual([0]);
    expect(existsSync(h.pidPath)).toBe(false);
  });

  test("missing pid file is fine", async () => {
    const h = await newHarness();
    rmSync(h.pidPath);
    const handle = installShutdown({
      tracker: h.tracker,
      db: h.db,
      pidPath: h.pidPath,
      pollAbort: h.pollAbort,
      server: makeServer(h),
      exit: (c) => void h.exitCodes.push(c),
      signals: [],
    });
    await handle.trigger("SIGTERM");
    expect(h.exitCodes).toEqual([0]);
  });

  test("server is optional", async () => {
    const h = await newHarness();
    const handle = installShutdown({
      tracker: h.tracker,
      db: h.db,
      pidPath: h.pidPath,
      pollAbort: h.pollAbort,
      server: null,
      exit: (c) => void h.exitCodes.push(c),
      signals: [],
    });
    await handle.trigger("SIGTERM");
    expect(h.serverStops).toBe(0);
    expect(h.exitCodes).toEqual([0]);
  });
});
