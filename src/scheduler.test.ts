/**
 * @fileoverview Unit tests for the scheduler — parser, schedule grammar,
 *               nextRunAt, catch-up logic, and the boot tick driver.
 * @proves Frontmatter parsing + validation, schedule grammar coverage,
 *         pure-function nextRunAt across all kinds, catch-up policy by
 *         kind × {never run, just ran, missed window}, queue-full audit
 *         row, max_cost_usd pre-flight gate.
 *
 * The scheduler fires synthetic Telegram updates through the existing turn
 * queue; tests use a fake `enqueue` callback rather than wiring a real
 * KeyedMutex so they stay focused on scheduler-specific behavior. The DB is
 * a real in-memory `bun:sqlite` (cheap and exercises the prepared
 * statements).
 *
 * Cross-references:
 *   - scheduler.ts — implementation
 *   - skills.test.ts — parser test pattern this mirrors
 *   - PLAN.md §10 — test surface the user signed off on
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Update } from "@grammyjs/types";
import { openDb, type SolracDb } from "./db.ts";
import {
  EMPTY_TASK_REGISTRY,
  getScheduledContext,
  loadTasksSync,
  nextRunAt,
  parseScheduleSpec,
  parseTaskFile,
  startScheduler,
  type ScheduleSpec,
  type SchedulerHandle,
  type Task,
  type TaskRegistry,
} from "./scheduler.ts";
import type { EnqueueResult } from "./queue.ts";

const dirs: string[] = [];
const dbs: SolracDb[] = [];

beforeEach(() => {
  dirs.length = 0;
  dbs.length = 0;
});

afterEach(() => {
  for (const db of dbs) {
    try {
      db.close();
    } catch {}
  }
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix = "solrac-scheduler-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function freshDb(): Promise<SolracDb> {
  const dir = tempDir("solrac-scheduler-db-");
  const db = await openDb(dir);
  dbs.push(db);
  return db;
}

function writeTask(root: string, name: string, content: string): string {
  const sub = join(root, name);
  mkdirSync(sub, { recursive: true });
  const path = join(sub, "TASK.md");
  writeFileSync(path, content);
  return path;
}

const MINIMAL = `---
name: digest
description: A digest task.
schedule: every 1h
---
You are running as the digest. Reply with "ok".
`;

// ---------------------------------------------------------------------------
// parseScheduleSpec — grammar coverage
// ---------------------------------------------------------------------------

describe("parseScheduleSpec — every", () => {
  test("every 1h → 3600000ms", () => {
    const spec = parseScheduleSpec("every 1h");
    expect(spec.kind).toBe("every");
    if (spec.kind === "every") expect(spec.ms).toBe(3_600_000);
  });

  test("every 30m → 1800000ms", () => {
    const spec = parseScheduleSpec("every 30m");
    if (spec.kind === "every") expect(spec.ms).toBe(1_800_000);
  });

  test("every 24h → 86400000ms", () => {
    const spec = parseScheduleSpec("every 24h");
    if (spec.kind === "every") expect(spec.ms).toBe(86_400_000);
  });

  test("every 1d → 86400000ms", () => {
    const spec = parseScheduleSpec("every 1d");
    if (spec.kind === "every") expect(spec.ms).toBe(86_400_000);
  });

  test("every 30s → 30000ms", () => {
    const spec = parseScheduleSpec("every 30s");
    if (spec.kind === "every") expect(spec.ms).toBe(30_000);
  });

  test("every 0h rejected (not positive)", () => {
    expect(() => parseScheduleSpec("every 0h")).toThrow(/positive integer/);
  });

  test("every -1h rejected", () => {
    expect(() => parseScheduleSpec("every -1h")).toThrow(/unrecognized form/);
  });

  test("every 1y rejected (unknown unit)", () => {
    expect(() => parseScheduleSpec("every 1y")).toThrow(/unrecognized form/);
  });
});

describe("parseScheduleSpec — daily_at", () => {
  test("daily_at 09:00 → hour=9 minute=0", () => {
    const spec = parseScheduleSpec("daily_at 09:00");
    expect(spec.kind).toBe("daily_at");
    if (spec.kind === "daily_at") {
      expect(spec.hourUtc).toBe(9);
      expect(spec.minuteUtc).toBe(0);
    }
  });

  test("daily_at 23:59 valid", () => {
    const spec = parseScheduleSpec("daily_at 23:59");
    if (spec.kind === "daily_at") {
      expect(spec.hourUtc).toBe(23);
      expect(spec.minuteUtc).toBe(59);
    }
  });

  test("daily_at 24:00 rejected", () => {
    expect(() => parseScheduleSpec("daily_at 24:00")).toThrow(/hour out of range/);
  });

  test("daily_at 09:60 rejected", () => {
    expect(() => parseScheduleSpec("daily_at 09:60")).toThrow(/minute out of range/);
  });

  test("daily_at 9:00 (single-digit hour) accepted", () => {
    const spec = parseScheduleSpec("daily_at 9:00");
    if (spec.kind === "daily_at") expect(spec.hourUtc).toBe(9);
  });
});

describe("parseScheduleSpec — at", () => {
  test("at 2026-05-15T13:00:00Z → atMs is the parsed timestamp", () => {
    const spec = parseScheduleSpec("at 2026-05-15T13:00:00Z");
    expect(spec.kind).toBe("at");
    if (spec.kind === "at") {
      expect(spec.atMs).toBe(Date.parse("2026-05-15T13:00:00Z"));
    }
  });

  test("at with explicit offset accepted", () => {
    const spec = parseScheduleSpec("at 2026-05-15T13:00:00+02:00");
    expect(spec.kind).toBe("at");
  });

  test("timezone-naive at rejected", () => {
    expect(() => parseScheduleSpec("at 2026-05-15T13:00:00")).toThrow(/timezone-naive/);
  });

  test("malformed iso rejected", () => {
    expect(() => parseScheduleSpec("at not-a-date Z")).toThrow(/not a valid ISO8601/);
  });
});

describe("parseScheduleSpec — invalid", () => {
  test("empty rejected", () => {
    expect(() => parseScheduleSpec("")).toThrow();
  });

  test("garbage rejected", () => {
    expect(() => parseScheduleSpec("randomly")).toThrow(/unrecognized form/);
  });
});

// ---------------------------------------------------------------------------
// nextRunAt — pure timestamp computation
// ---------------------------------------------------------------------------

describe("nextRunAt — every", () => {
  const spec: ScheduleSpec = { kind: "every", ms: 3_600_000 }; // 1h

  test("never run → fire on next tick (returns now)", () => {
    const now = 1_000_000_000;
    expect(nextRunAt(spec, null, now)).toBe(now);
  });

  test("just ran → next due is lastRunAt + ms", () => {
    const lastRun = 1_000_000_000;
    expect(nextRunAt(spec, lastRun, lastRun + 100)).toBe(lastRun + 3_600_000);
  });

  test("missed window (lastRun is older than interval) → next due is in the past, fires immediately", () => {
    const lastRun = 1_000_000_000;
    const now = lastRun + 7_200_000; // 2h later
    const due = nextRunAt(spec, lastRun, now);
    expect(due).toBe(lastRun + 3_600_000);
    expect(due!).toBeLessThanOrEqual(now);
  });
});

describe("nextRunAt — daily_at", () => {
  const spec: ScheduleSpec = { kind: "daily_at", hourUtc: 9, minuteUtc: 0 };

  test("before today's anchor, never run → next due is today's anchor", () => {
    const now = Date.UTC(2026, 0, 15, 8, 30); // 08:30 UTC
    const due = nextRunAt(spec, null, now);
    expect(due).toBe(Date.UTC(2026, 0, 15, 9, 0));
  });

  test("after today's anchor, never run → next due is today's anchor (catch-up)", () => {
    const now = Date.UTC(2026, 0, 15, 14, 0);
    const due = nextRunAt(spec, null, now);
    expect(due).toBe(Date.UTC(2026, 0, 15, 9, 0));
  });

  test("already fired today → next due is tomorrow's anchor", () => {
    const now = Date.UTC(2026, 0, 15, 14, 0);
    const lastRun = Date.UTC(2026, 0, 15, 9, 5);
    const due = nextRunAt(spec, lastRun, now);
    expect(due).toBe(Date.UTC(2026, 0, 16, 9, 0));
  });
});

describe("nextRunAt — at", () => {
  test("never run → next due is atMs", () => {
    const spec: ScheduleSpec = { kind: "at", atMs: 1_500_000_000 };
    expect(nextRunAt(spec, null, 1_000_000_000)).toBe(1_500_000_000);
  });

  test("already ran → null (one-off consumed)", () => {
    const spec: ScheduleSpec = { kind: "at", atMs: 1_500_000_000 };
    expect(nextRunAt(spec, 1_500_000_000, 2_000_000_000)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseTaskFile — happy path + schema rejection
// ---------------------------------------------------------------------------

describe("parseTaskFile — valid", () => {
  test("minimal task", () => {
    const t = parseTaskFile(MINIMAL, "/tmp/TASK.md", { defaultEngine: "ollama" });
    expect(t.name).toBe("digest");
    expect(t.description).toBe("A digest task.");
    expect(t.spec.kind).toBe("every");
    expect(t.engine).toBe("ollama"); // inherits default
    expect(t.catchUp).toBe(true);
    expect(t.enabled).toBe(true);
    expect(t.maxCostUsd).toBeNull();
    expect(t.bootCatchUpJitterS).toBe(0);
  });

  test("explicit engine: primary on ollama-default deploy", () => {
    const c = `---
name: heavy
description: Heavy task.
schedule: every 6h
engine: primary
---
Body.`;
    const t = parseTaskFile(c, "/p", { defaultEngine: "ollama" });
    expect(t.engine).toBe("primary");
  });

  test("explicit engine: secondary parses", () => {
    const c = `---
name: opus
description: Opus task.
schedule: every 6h
engine: secondary
---
Body.`;
    const t = parseTaskFile(c, "/p", { defaultEngine: "ollama" });
    expect(t.engine).toBe("secondary");
  });

  test("max_cost_usd kept on Claude tier", () => {
    const c = `---
name: digest
description: x
schedule: every 1h
engine: secondary
max_cost_usd: 0.25
---
Body.`;
    const t = parseTaskFile(c, "/p", { defaultEngine: "ollama" });
    expect(t.maxCostUsd).toBe(0.25);
  });

  test("max_cost_usd ignored on ollama (silently nulled)", () => {
    const c = `---
name: digest
description: x
schedule: every 1h
max_cost_usd: 0.25
---
Body.`;
    const t = parseTaskFile(c, "/p", { defaultEngine: "ollama" });
    expect(t.maxCostUsd).toBeNull();
  });

  test("one-off task defaults catch_up to false", () => {
    const c = `---
name: alarm
description: x
schedule: at 2026-05-15T13:00:00Z
---
Body.`;
    const t = parseTaskFile(c, "/p", { defaultEngine: "ollama" });
    expect(t.catchUp).toBe(false);
  });

  test("chat_id parsed as integer", () => {
    const c = `---
name: digest
description: x
schedule: every 1h
chat_id: -100123456789
---
Body.`;
    const t = parseTaskFile(c, "/p", { defaultEngine: "ollama" });
    expect(t.chatId).toBe(-100123456789);
  });

  test("source_hash is stable for identical content", () => {
    const a = parseTaskFile(MINIMAL, "/p", { defaultEngine: "ollama" });
    const b = parseTaskFile(MINIMAL, "/p", { defaultEngine: "ollama" });
    expect(a.sourceHash).toBe(b.sourceHash);
  });
});

describe("parseTaskFile — rejection", () => {
  test("missing schedule rejected", () => {
    const c = `---
name: digest
description: x
---
Body.`;
    expect(() => parseTaskFile(c, "/p", { defaultEngine: "ollama" })).toThrow(/schedule/);
  });

  test("engine: ollama on primary-default deploy rejected", () => {
    const c = `---
name: digest
description: x
schedule: every 1h
engine: ollama
---
Body.`;
    expect(() => parseTaskFile(c, "/p", { defaultEngine: "primary" })).toThrow(
      /unreachable when SOLRAC_DEFAULT_ENGINE != ollama/,
    );
  });

  test("engine: ollama on secondary-default deploy rejected", () => {
    const c = `---
name: digest
description: x
schedule: every 1h
engine: ollama
---
Body.`;
    expect(() => parseTaskFile(c, "/p", { defaultEngine: "secondary" })).toThrow(
      /unreachable/,
    );
  });

  test("every <5min on Claude tier rejected", () => {
    const c = `---
name: too_fast
description: x
schedule: every 1m
engine: primary
---
Body.`;
    expect(() => parseTaskFile(c, "/p", { defaultEngine: "ollama" })).toThrow(
      /interval too short/,
    );
  });

  test("every 1m on ollama allowed", () => {
    const c = `---
name: fast_local
description: x
schedule: every 1m
engine: ollama
---
Body.`;
    const t = parseTaskFile(c, "/p", { defaultEngine: "ollama" });
    expect(t.spec.kind).toBe("every");
    if (t.spec.kind === "every") expect(t.spec.ms).toBe(60_000);
  });

  test("max_cost_usd negative rejected", () => {
    const c = `---
name: digest
description: x
schedule: every 1h
engine: primary
max_cost_usd: -1
---
Body.`;
    expect(() => parseTaskFile(c, "/p", { defaultEngine: "ollama" })).toThrow(/positive number/);
  });

  test("boot_catch_up_jitter_s negative rejected", () => {
    const c = `---
name: digest
description: x
schedule: every 1h
boot_catch_up_jitter_s: -1
---
Body.`;
    expect(() => parseTaskFile(c, "/p", { defaultEngine: "ollama" })).toThrow(/non-negative/);
  });

  test("unknown frontmatter key rejected", () => {
    const c = `---
name: digest
description: x
schedule: every 1h
unknownkey: foo
---
Body.`;
    expect(() => parseTaskFile(c, "/p", { defaultEngine: "ollama" })).toThrow(/unknown frontmatter/);
  });

  test("empty body rejected", () => {
    const c = `---
name: digest
description: x
schedule: every 1h
---
`;
    expect(() => parseTaskFile(c, "/p", { defaultEngine: "ollama" })).toThrow(/body must be non-empty/);
  });

  test("hyphen in name rejected (Telegram constraint)", () => {
    const c = `---
name: morning-digest
description: x
schedule: every 1h
---
Body.`;
    expect(() => parseTaskFile(c, "/p", { defaultEngine: "ollama" })).toThrow(/"name" must match/);
  });
});

// ---------------------------------------------------------------------------
// loadTasksSync — filesystem discovery
// ---------------------------------------------------------------------------

describe("loadTasksSync", () => {
  test("missing directory → empty registry + one error", () => {
    const result = loadTasksSync("/nonexistent/path", "ollama");
    expect(result.loadedCount).toBe(0);
    expect(result.errors.length).toBe(1);
    expect(result.registry).toBe(EMPTY_TASK_REGISTRY);
  });

  test("empty directory → empty registry, no errors", () => {
    const dir = tempDir();
    const result = loadTasksSync(dir, "ollama");
    expect(result.loadedCount).toBe(0);
    expect(result.errors.length).toBe(0);
  });

  test("two valid tasks → both registered", () => {
    const dir = tempDir();
    writeTask(dir, "morning", MINIMAL);
    writeTask(dir, "evening", MINIMAL.replace("name: digest", "name: digest2"));
    const result = loadTasksSync(dir, "ollama");
    expect(result.loadedCount).toBe(2);
    expect(result.errors.length).toBe(0);
  });

  test("subdir without TASK.md silently skipped", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "no_task"), { recursive: true });
    writeTask(dir, "valid", MINIMAL);
    const result = loadTasksSync(dir, "ollama");
    expect(result.loadedCount).toBe(1);
    expect(result.errors.length).toBe(0);
  });

  test("malformed TASK.md does not break sibling loads", () => {
    const dir = tempDir();
    writeTask(dir, "broken", "no frontmatter here");
    writeTask(dir, "valid", MINIMAL);
    const result = loadTasksSync(dir, "ollama");
    expect(result.loadedCount).toBe(1);
    expect(result.errors.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// startScheduler — boot pass + tick driver + queue-full handling
// ---------------------------------------------------------------------------

interface FakeQueue {
  enqueued: Update[];
  enqueue(update: Update): EnqueueResult;
  dropMode: "ok" | "queue_full";
}

function newFakeQueue(): FakeQueue {
  const q: FakeQueue = {
    enqueued: [],
    dropMode: "ok",
    enqueue(update) {
      if (q.dropMode === "queue_full") {
        return { kind: "dropped_queue_full", depth: 99, key: 1 };
      }
      q.enqueued.push(update);
      return { kind: "enqueued" };
    },
  };
  return q;
}

function singleTaskRegistry(task: Task): TaskRegistry {
  return Object.freeze({
    all: Object.freeze([task]),
    get: (name: string) => (name === task.name ? task : undefined),
    size: () => 1,
  });
}

const FROZEN_NOW = 1_700_000_000_000; // 2023-11 — predictable test clock

describe("startScheduler — boot fire", () => {
  test("every 1h, never run → fires on boot tick", async () => {
    const db = await freshDb();
    const queue = newFakeQueue();
    const task = parseTaskFile(MINIMAL, "/p/TASK.md", { defaultEngine: "ollama" });
    const registry = singleTaskRegistry(task);

    let intervalFn: (() => void) | null = null;
    const handle: SchedulerHandle = startScheduler({
      db,
      registry,
      enqueue: queue.enqueue,
      operatorFromId: 100,
      defaultEngine: "ollama",
      defaultChatId: 100,
      now: () => FROZEN_NOW,
      setInterval: (fn) => {
        intervalFn = fn;
        return 0;
      },
      clearInterval: () => {},
    });

    expect(queue.enqueued.length).toBe(1);
    expect(queue.enqueued[0]!.message?.text).toBe(task.body);
    const ctx = getScheduledContext(queue.enqueued[0]!.message);
    expect(ctx?.name).toBe("digest");

    handle.stop();
    expect(intervalFn).not.toBeNull();
  });

  test("catch_up: false, just-rebooted with periodic task → does NOT fire on boot", async () => {
    const db = await freshDb();
    const queue = newFakeQueue();
    const c = `---
name: deferred
description: x
schedule: every 1h
catch_up: false
---
Body.`;
    const task = parseTaskFile(c, "/p", { defaultEngine: "ollama" });
    const registry = singleTaskRegistry(task);

    const handle = startScheduler({
      db,
      registry,
      enqueue: queue.enqueue,
      operatorFromId: 100,
      defaultEngine: "ollama",
      defaultChatId: 100,
      now: () => FROZEN_NOW,
      setInterval: () => 0,
      clearInterval: () => {},
    });

    expect(queue.enqueued.length).toBe(0);
    // last_run_at was bumped to now so the next tick won't catch up either.
    const state = db.getTaskState("deferred");
    expect(state?.lastRunAt).toBe(FROZEN_NOW);
    handle.stop();
  });

  test("at <past>, catch_up: false → marked consumed without firing", async () => {
    const db = await freshDb();
    const queue = newFakeQueue();
    const past = new Date(FROZEN_NOW - 86_400_000).toISOString();
    const c = `---
name: past_alarm
description: x
schedule: at ${past}
catch_up: false
---
Body.`;
    const task = parseTaskFile(c, "/p", { defaultEngine: "ollama" });
    const registry = singleTaskRegistry(task);

    const handle = startScheduler({
      db,
      registry,
      enqueue: queue.enqueue,
      operatorFromId: 100,
      defaultEngine: "ollama",
      defaultChatId: 100,
      now: () => FROZEN_NOW,
      setInterval: () => 0,
      clearInterval: () => {},
    });

    expect(queue.enqueued.length).toBe(0);
    const state = db.getTaskState("past_alarm");
    expect(state?.oneOffConsumed).toBe(true);
    handle.stop();
  });

  test("at <past>, catch_up: true → fires once and marks consumed", async () => {
    const db = await freshDb();
    const queue = newFakeQueue();
    const past = new Date(FROZEN_NOW - 86_400_000).toISOString();
    const c = `---
name: late_alarm
description: x
schedule: at ${past}
catch_up: true
---
Body.`;
    const task = parseTaskFile(c, "/p", { defaultEngine: "ollama" });
    const registry = singleTaskRegistry(task);

    const handle = startScheduler({
      db,
      registry,
      enqueue: queue.enqueue,
      operatorFromId: 100,
      defaultEngine: "ollama",
      defaultChatId: 100,
      now: () => FROZEN_NOW,
      setInterval: () => 0,
      clearInterval: () => {},
    });

    expect(queue.enqueued.length).toBe(1);
    const state = db.getTaskState("late_alarm");
    expect(state?.oneOffConsumed).toBe(true);
    handle.stop();
  });

  test("disabled task does not fire", async () => {
    const db = await freshDb();
    const queue = newFakeQueue();
    const c = `---
name: paused
description: x
schedule: every 1h
enabled: false
---
Body.`;
    const task = parseTaskFile(c, "/p", { defaultEngine: "ollama" });
    const registry = singleTaskRegistry(task);

    const handle = startScheduler({
      db,
      registry,
      enqueue: queue.enqueue,
      operatorFromId: 100,
      defaultEngine: "ollama",
      defaultChatId: 100,
      now: () => FROZEN_NOW,
      setInterval: () => 0,
      clearInterval: () => {},
    });

    expect(queue.enqueued.length).toBe(0);
    handle.stop();
  });

  test("queue_full → audit row written with origin='scheduled'; no enqueued update", async () => {
    const db = await freshDb();
    const queue = newFakeQueue();
    queue.dropMode = "queue_full";
    const task = parseTaskFile(MINIMAL, "/p", { defaultEngine: "ollama" });
    const registry = singleTaskRegistry(task);

    const handle = startScheduler({
      db,
      registry,
      enqueue: queue.enqueue,
      operatorFromId: 100,
      defaultEngine: "ollama",
      defaultChatId: 100,
      now: () => FROZEN_NOW,
      setInterval: () => 0,
      clearInterval: () => {},
    });

    expect(queue.enqueued.length).toBe(0);
    const rows = db.raw
      .query("SELECT origin, task_name, status, error_message FROM audit")
      .all() as Array<{
      origin: string;
      task_name: string;
      status: string;
      error_message: string;
    }>;
    expect(rows.length).toBe(1);
    expect(rows[0]!.origin).toBe("scheduled");
    expect(rows[0]!.task_name).toBe("digest");
    expect(rows[0]!.status).toBe("error");
    expect(rows[0]!.error_message).toBe("queue_full");
    handle.stop();
  });
});

describe("startScheduler — engine prefix mapping in synthesized text", () => {
  test("task engine matches default → no prefix", async () => {
    const db = await freshDb();
    const queue = newFakeQueue();
    const task = parseTaskFile(MINIMAL, "/p", { defaultEngine: "ollama" });
    const handle = startScheduler({
      db,
      registry: singleTaskRegistry(task),
      enqueue: queue.enqueue,
      operatorFromId: 100,
      defaultEngine: "ollama",
      defaultChatId: 100,
      now: () => FROZEN_NOW,
      setInterval: () => 0,
      clearInterval: () => {},
    });
    expect(queue.enqueued[0]!.message?.text).not.toMatch(/^[@!]/);
    handle.stop();
  });

  test("engine: primary on ollama default → @-prefixed text", async () => {
    const db = await freshDb();
    const queue = newFakeQueue();
    const c = `---
name: hot
description: x
schedule: every 1h
engine: primary
---
fetch the weather`;
    const task = parseTaskFile(c, "/p", { defaultEngine: "ollama" });
    const handle = startScheduler({
      db,
      registry: singleTaskRegistry(task),
      enqueue: queue.enqueue,
      operatorFromId: 100,
      defaultEngine: "ollama",
      defaultChatId: 100,
      now: () => FROZEN_NOW,
      setInterval: () => 0,
      clearInterval: () => {},
    });
    expect(queue.enqueued[0]!.message?.text).toMatch(/^@/);
    handle.stop();
  });

  test("engine: secondary on ollama default → !-prefixed text", async () => {
    const db = await freshDb();
    const queue = newFakeQueue();
    const c = `---
name: hot
description: x
schedule: every 1h
engine: secondary
---
think deeply`;
    const task = parseTaskFile(c, "/p", { defaultEngine: "ollama" });
    const handle = startScheduler({
      db,
      registry: singleTaskRegistry(task),
      enqueue: queue.enqueue,
      operatorFromId: 100,
      defaultEngine: "ollama",
      defaultChatId: 100,
      now: () => FROZEN_NOW,
      setInterval: () => 0,
      clearInterval: () => {},
    });
    expect(queue.enqueued[0]!.message?.text).toMatch(/^!/);
    handle.stop();
  });
});

describe("startScheduler — synthetic update_id is negative", () => {
  test("update_id is < 0 (avoids handled_updates collision)", async () => {
    const db = await freshDb();
    const queue = newFakeQueue();
    const task = parseTaskFile(MINIMAL, "/p", { defaultEngine: "ollama" });
    const handle = startScheduler({
      db,
      registry: singleTaskRegistry(task),
      enqueue: queue.enqueue,
      operatorFromId: 100,
      defaultEngine: "ollama",
      defaultChatId: 100,
      now: () => FROZEN_NOW,
      setInterval: () => 0,
      clearInterval: () => {},
    });
    const u = queue.enqueued[0]!;
    expect(u.update_id).toBeLessThan(0);
    handle.stop();
  });
});

describe("startScheduler — max_cost_usd pre-flight", () => {
  test("Claude task with prior costs ≥ cap → skips, denial audit row", async () => {
    const db = await freshDb();
    const queue = newFakeQueue();

    // Seed a prior scheduled fire with cost = 0.30 in the past 30 minutes.
    const priorAuditId = db.insertAudit({
      chatId: 100,
      fromId: 100,
      updateId: null,
      prompt: "task:expensive",
      startedAt: FROZEN_NOW - 30 * 60 * 1000,
      model: "claude:secondary:claude-opus-4-7",
      origin: "scheduled",
      taskName: "expensive",
    });
    db.updateAuditEnd({
      id: priorAuditId,
      response: "ok",
      toolCalls: null,
      inputTokens: 100,
      outputTokens: 100,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
      costUsd: 0.30,
      agentSessionId: null,
      status: "ok",
      errorMessage: null,
      endedAt: FROZEN_NOW - 30 * 60 * 1000 + 1000,
    });

    const c = `---
name: expensive
description: x
schedule: every 1h
engine: secondary
max_cost_usd: 0.20
---
Body.`;
    const task = parseTaskFile(c, "/p", { defaultEngine: "ollama" });

    const handle = startScheduler({
      db,
      registry: singleTaskRegistry(task),
      enqueue: queue.enqueue,
      operatorFromId: 100,
      defaultEngine: "ollama",
      defaultChatId: 100,
      now: () => FROZEN_NOW,
      setInterval: () => 0,
      clearInterval: () => {},
    });

    expect(queue.enqueued.length).toBe(0);
    const denialRow = db.raw
      .query(
        "SELECT status, error_message FROM audit WHERE task_name = ? AND status = 'denied'",
      )
      .get("expensive") as { status: string; error_message: string } | null;
    expect(denialRow).not.toBeNull();
    expect(denialRow!.error_message).toMatch(/task_cost_cap/);
    handle.stop();
  });

  test("ollama task ignores max_cost_usd silently", async () => {
    const db = await freshDb();
    const queue = newFakeQueue();
    const c = `---
name: free_run
description: x
schedule: every 1h
max_cost_usd: 0.01
---
Body.`;
    const task = parseTaskFile(c, "/p", { defaultEngine: "ollama" });
    expect(task.maxCostUsd).toBeNull(); // already nulled at parse

    const handle = startScheduler({
      db,
      registry: singleTaskRegistry(task),
      enqueue: queue.enqueue,
      operatorFromId: 100,
      defaultEngine: "ollama",
      defaultChatId: 100,
      now: () => FROZEN_NOW,
      setInterval: () => 0,
      clearInterval: () => {},
    });

    expect(queue.enqueued.length).toBe(1);
    handle.stop();
  });
});

// ---------------------------------------------------------------------------
// getScheduledContext — runner-side recovery
// ---------------------------------------------------------------------------

describe("getScheduledContext", () => {
  test("returns context when set on the message", async () => {
    const db = await freshDb();
    const queue = newFakeQueue();
    const task = parseTaskFile(MINIMAL, "/p", { defaultEngine: "ollama" });
    const handle = startScheduler({
      db,
      registry: singleTaskRegistry(task),
      enqueue: queue.enqueue,
      operatorFromId: 100,
      defaultEngine: "ollama",
      defaultChatId: 100,
      now: () => FROZEN_NOW,
      setInterval: () => 0,
      clearInterval: () => {},
    });
    const ctx = getScheduledContext(queue.enqueued[0]!.message);
    expect(ctx).not.toBeUndefined();
    expect(ctx?.name).toBe("digest");
    handle.stop();
  });

  test("returns undefined for a vanilla user message", () => {
    const update: Update = {
      update_id: 42,
      message: {
        message_id: 1,
        date: 0,
        chat: { id: 100, type: "private", first_name: "u" },
        from: { id: 100, is_bot: false, first_name: "u" },
        text: "hello",
      },
    };
    expect(getScheduledContext(update.message)).toBeUndefined();
  });

  test("returns undefined when message is undefined", () => {
    expect(getScheduledContext(undefined)).toBeUndefined();
  });
});
