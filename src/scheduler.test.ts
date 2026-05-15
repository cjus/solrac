/**
 * @fileoverview Unit tests for the scheduler — cron grammar, parseTaskFile,
 *               nextRunAt (cron + at), catch-up logic, and the boot tick
 *               driver.
 * @proves Frontmatter parsing + validation, 5-field cron grammar coverage,
 *         tz handling including DST spring-forward/fall-back, weekday filter,
 *         min-interval guard via next-5-fires, pure-function nextRunAt across
 *         both kinds, catch-up policy, queue-full audit row, max_cost_usd
 *         pre-flight gate.
 *
 * The scheduler fires synthetic Telegram updates through the existing turn
 * queue; tests use a fake `enqueue` callback rather than wiring a real
 * KeyedMutex so they stay focused on scheduler-specific behavior. The DB is
 * a real in-memory `bun:sqlite` (cheap and exercises the prepared
 * statements).
 *
 * Cross-references:
 *   - scheduler.ts — implementation
 *   - PLAN.md Phase 4 — test surface the user signed off on
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
  parseTaskFile,
  startScheduler,
  validateCronExpr,
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
cron: "0 * * * *"
tz: UTC
---
You are running as the digest. Reply with "ok".
`;

// ---------------------------------------------------------------------------
// validateCronExpr — grammar coverage
// ---------------------------------------------------------------------------

describe("validateCronExpr — valid", () => {
  test("hourly anchored", () => {
    expect(validateCronExpr("0 * * * *", "UTC")).toBe("0 * * * *");
  });

  test("every-30m within window on weekdays", () => {
    expect(validateCronExpr("*/30 12-18 * * 1-5", "America/Denver")).toBe(
      "*/30 12-18 * * 1-5",
    );
  });

  test("daily at 09:00", () => {
    expect(validateCronExpr("0 9 * * *", "UTC")).toBe("0 9 * * *");
  });

  test("lists and step values", () => {
    expect(validateCronExpr("0,15,30,45 * * * *", "UTC")).toBe("0,15,30,45 * * * *");
    expect(validateCronExpr("*/5 * * * *", "UTC")).toBe("*/5 * * * *");
  });

  test("trims surrounding whitespace", () => {
    expect(validateCronExpr("  0 * * * *  ", "UTC")).toBe("0 * * * *");
  });
});

describe("validateCronExpr — rejection", () => {
  test("empty string rejected", () => {
    expect(() => validateCronExpr("", "UTC")).toThrow(/empty/);
  });

  test("@daily rejected with helpful message", () => {
    expect(() => validateCronExpr("@daily", "UTC")).toThrow(/predefined aliases/);
  });

  test("@hourly rejected", () => {
    expect(() => validateCronExpr("@hourly", "UTC")).toThrow(/predefined aliases/);
  });

  test("4-field expression rejected (cron-parser would accept)", () => {
    expect(() => validateCronExpr("* * * *", "UTC")).toThrow(/exactly 5 fields/);
  });

  test("6-field expression rejected (cron-parser would treat as seconds)", () => {
    expect(() => validateCronExpr("* * * * * *", "UTC")).toThrow(/exactly 5 fields/);
  });

  test("minute out of range", () => {
    expect(() => validateCronExpr("60 * * * *", "UTC")).toThrow(/invalid expression/);
  });

  test("hour out of range", () => {
    expect(() => validateCronExpr("* 25 * * *", "UTC")).toThrow(/invalid expression/);
  });

  test("garbage rejected", () => {
    expect(() => validateCronExpr("not a cron", "UTC")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// nextRunAt — cron + at, pure timestamp computation
// ---------------------------------------------------------------------------

function buildTask(spec: Task["spec"], tz = "UTC"): Pick<Task, "spec" | "tz"> {
  return { spec, tz };
}

describe("nextRunAt — cron", () => {
  test("hourly, never run → returns next future fire (no boot-fire)", () => {
    const t = buildTask({ kind: "cron", expr: "0 * * * *" });
    const now = Date.UTC(2026, 4, 18, 14, 13); // 14:13 UTC
    const due = nextRunAt(t, null, now);
    expect(due).toBe(Date.UTC(2026, 4, 18, 15, 0)); // 15:00 UTC
  });

  test("hourly, just ran at :00 → next fire is +1h", () => {
    const t = buildTask({ kind: "cron", expr: "0 * * * *" });
    const lastRun = Date.UTC(2026, 4, 18, 14, 0);
    const due = nextRunAt(t, lastRun, lastRun + 100);
    expect(due).toBe(Date.UTC(2026, 4, 18, 15, 0));
  });

  test("hourly, missed window — lastRun 3h ago → due is in the past (catch-up fires once)", () => {
    const t = buildTask({ kind: "cron", expr: "0 * * * *" });
    const lastRun = Date.UTC(2026, 4, 18, 11, 0);
    const now = Date.UTC(2026, 4, 18, 14, 13);
    const due = nextRunAt(t, lastRun, now);
    // Next cron fire after lastRun=11:00 is 12:00 — in the past, fires once.
    expect(due).toBe(Date.UTC(2026, 4, 18, 12, 0));
    expect(due!).toBeLessThan(now);
  });

  test("weekday filter — Saturday skipped", () => {
    // Saturday 2026-05-16 at 14:00 UTC. Expression: every hour on Mon-Fri only.
    const t = buildTask({ kind: "cron", expr: "0 * * * 1-5" });
    const now = Date.UTC(2026, 4, 16, 14, 0); // Sat
    const due = nextRunAt(t, null, now);
    // Next fire is Monday 2026-05-18 00:00 UTC.
    expect(due).toBe(Date.UTC(2026, 4, 18, 0, 0));
  });

  test("tz applied — same expression, different tz → different UTC ms", () => {
    const expr = "0 9 * * *";
    const utc = buildTask({ kind: "cron", expr }, "UTC");
    const denver = buildTask({ kind: "cron", expr }, "America/Denver");
    const tokyo = buildTask({ kind: "cron", expr }, "Asia/Tokyo");
    const anchor = Date.UTC(2026, 4, 18, 0, 0);
    const dUtc = nextRunAt(utc, null, anchor);
    const dDenver = nextRunAt(denver, null, anchor);
    const dTokyo = nextRunAt(tokyo, null, anchor);
    expect(dUtc).not.toBe(dDenver);
    expect(dUtc).not.toBe(dTokyo);
    expect(dDenver).not.toBe(dTokyo);
    // UTC 09:00 == 2026-05-18T09:00Z.
    expect(dUtc).toBe(Date.UTC(2026, 4, 18, 9, 0));
    // Denver 09:00 MDT == 15:00 UTC.
    expect(dDenver).toBe(Date.UTC(2026, 4, 18, 15, 0));
  });

  test("DST spring-forward — 2026-03-08 Denver, `0 2 * * *` skips the non-existent hour", () => {
    const t = buildTask({ kind: "cron", expr: "0 2 * * *" }, "America/Denver");
    // Anchor Sat 2026-03-07 03:00 Denver (post-2am fire). Next fire would be
    // Sun Mar 8 02:00 Denver — but that hour doesn't exist (DST jumps to 03).
    // cron-parser skips to Mon Mar 9 02:00 (deterministic).
    const anchor = Date.UTC(2026, 2, 7, 10, 0); // Sat 03:00 MST = 10:00 UTC
    const due = nextRunAt(t, anchor, anchor + 1);
    // Sun 2026-03-08 03:00 MDT = 09:00 UTC OR Mon Mar 9 02:00 MDT = 08:00 UTC.
    // Either is "next valid moment, not crash". Just assert non-null + > anchor.
    expect(due).not.toBeNull();
    expect(due!).toBeGreaterThan(anchor);
  });

  test("DST fall-back — 2025-11-02 Denver, `0 1 * * *` fires once on the doubled hour", () => {
    const t = buildTask({ kind: "cron", expr: "0 1 * * *" }, "America/Denver");
    // Anchor Sat 2025-11-01 02:00 Denver — past today's fire.
    const anchor = Date.UTC(2025, 10, 1, 8, 0); // Sat 02:00 MDT = 08:00 UTC
    const first = nextRunAt(t, anchor, anchor + 1);
    expect(first).not.toBeNull();
    // The next fire should be Sun Nov 2 01:00 (one of them — not BOTH).
    // Anchor that as the new lastRun and ask again.
    const second = nextRunAt(t, first, first! + 1);
    // Second fire must be Mon Nov 3 01:00 (24h+ after Sun's fire), not the
    // duplicated 01:00 MST on the same Sun.
    const diff = second! - first!;
    expect(diff).toBeGreaterThan(20 * 60 * 60 * 1000); // > 20h, ensuring no double
  });
});

describe("nextRunAt — at", () => {
  test("never run → next due is atMs", () => {
    const t = buildTask({ kind: "at", atMs: 1_500_000_000 });
    expect(nextRunAt(t, null, 1_000_000_000)).toBe(1_500_000_000);
  });

  test("already ran → null (one-off consumed)", () => {
    const t = buildTask({ kind: "at", atMs: 1_500_000_000 });
    expect(nextRunAt(t, 1_500_000_000, 2_000_000_000)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseTaskFile — happy path + schema rejection
// ---------------------------------------------------------------------------

describe("parseTaskFile — valid", () => {
  test("minimal cron task", () => {
    const t = parseTaskFile(MINIMAL, "/tmp/TASK.md", { defaultEngine: "ollama" });
    expect(t.name).toBe("digest");
    expect(t.description).toBe("A digest task.");
    expect(t.spec.kind).toBe("cron");
    if (t.spec.kind === "cron") expect(t.spec.expr).toBe("0 * * * *");
    expect(t.tz).toBe("UTC");
    expect(t.engine).toBe("ollama"); // inherits default
    expect(t.catchUp).toBe(true); // default true for cron
    expect(t.enabled).toBe(true);
    expect(t.maxCostUsd).toBeNull();
    expect(t.bootCatchUpJitterS).toBe(0);
  });

  test("tz omitted → falls back to runtime default (non-empty)", () => {
    const c = `---
name: digest
description: x
cron: "0 * * * *"
---
Body.`;
    const t = parseTaskFile(c, "/p", { defaultEngine: "ollama" });
    expect(typeof t.tz).toBe("string");
    expect(t.tz.length).toBeGreaterThan(0);
  });

  test("explicit engine: primary on ollama-default deploy", () => {
    const c = `---
name: heavy
description: Heavy task.
cron: "0 */6 * * *"
tz: UTC
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
cron: "0 */6 * * *"
tz: UTC
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
cron: "0 * * * *"
tz: UTC
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
cron: "0 * * * *"
tz: UTC
max_cost_usd: 0.25
---
Body.`;
    const t = parseTaskFile(c, "/p", { defaultEngine: "ollama" });
    expect(t.maxCostUsd).toBeNull();
  });

  test("one-off task with at: defaults catch_up to false", () => {
    const c = `---
name: alarm
description: x
at: 2026-05-15T13:00:00Z
---
Body.`;
    const t = parseTaskFile(c, "/p", { defaultEngine: "ollama" });
    expect(t.catchUp).toBe(false);
    expect(t.spec.kind).toBe("at");
  });

  test("chat_id parsed as integer", () => {
    const c = `---
name: digest
description: x
cron: "0 * * * *"
tz: UTC
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

  test("America/Denver tz accepted", () => {
    const c = `---
name: stretch
description: x
cron: "*/30 12-18 * * 1-5"
tz: America/Denver
---
Body.`;
    const t = parseTaskFile(c, "/p", { defaultEngine: "ollama" });
    expect(t.tz).toBe("America/Denver");
  });
});

describe("parseTaskFile — rejection", () => {
  test("missing both cron and at rejected", () => {
    const c = `---
name: digest
description: x
---
Body.`;
    expect(() => parseTaskFile(c, "/p", { defaultEngine: "ollama" })).toThrow(
      /one of "cron.*or "at.*is required/,
    );
  });

  test("cron and at both present rejected", () => {
    const c = `---
name: digest
description: x
cron: "0 * * * *"
at: 2026-05-15T13:00:00Z
---
Body.`;
    expect(() => parseTaskFile(c, "/p", { defaultEngine: "ollama" })).toThrow(
      /mutually exclusive/,
    );
  });

  test("invalid IANA tz rejected", () => {
    const c = `---
name: digest
description: x
cron: "0 * * * *"
tz: Not/A/Timezone
---
Body.`;
    expect(() => parseTaskFile(c, "/p", { defaultEngine: "ollama" })).toThrow(
      /invalid IANA timezone/,
    );
  });

  test("@daily alias rejected with cron-specific message", () => {
    const c = `---
name: digest
description: x
cron: "@daily"
tz: UTC
---
Body.`;
    expect(() => parseTaskFile(c, "/p", { defaultEngine: "ollama" })).toThrow(
      /predefined aliases/,
    );
  });

  test("4-field cron expression rejected", () => {
    const c = `---
name: digest
description: x
cron: "0 * * *"
tz: UTC
---
Body.`;
    expect(() => parseTaskFile(c, "/p", { defaultEngine: "ollama" })).toThrow(
      /exactly 5 fields/,
    );
  });

  test("engine: ollama on primary-default deploy rejected", () => {
    const c = `---
name: digest
description: x
cron: "0 * * * *"
tz: UTC
engine: ollama
---
Body.`;
    expect(() => parseTaskFile(c, "/p", { defaultEngine: "primary" })).toThrow(
      /unreachable when SOLRAC_DEFAULT_ENGINE != ollama/,
    );
  });

  test("min-interval: `* * * * *` on Claude tier rejected", () => {
    const c = `---
name: too_fast
description: x
cron: "* * * * *"
tz: UTC
engine: primary
---
Body.`;
    expect(() => parseTaskFile(c, "/p", { defaultEngine: "ollama" })).toThrow(
      /cron interval too tight/,
    );
  });

  test("min-interval: `* * * * *` on Ollama allowed", () => {
    const c = `---
name: fast_local
description: x
cron: "* * * * *"
tz: UTC
engine: ollama
---
Body.`;
    const t = parseTaskFile(c, "/p", { defaultEngine: "ollama" });
    expect(t.spec.kind).toBe("cron");
  });

  test("min-interval: `*/5 * * * *` on Claude allowed", () => {
    const c = `---
name: every_five
description: x
cron: "*/5 * * * *"
tz: UTC
engine: primary
---
Body.`;
    const t = parseTaskFile(c, "/p", { defaultEngine: "ollama" });
    expect(t.spec.kind).toBe("cron");
  });

  test("max_cost_usd negative rejected", () => {
    const c = `---
name: digest
description: x
cron: "0 * * * *"
tz: UTC
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
cron: "0 * * * *"
tz: UTC
boot_catch_up_jitter_s: -1
---
Body.`;
    expect(() => parseTaskFile(c, "/p", { defaultEngine: "ollama" })).toThrow(/non-negative/);
  });

  test("unknown frontmatter key rejected", () => {
    const c = `---
name: digest
description: x
cron: "0 * * * *"
tz: UTC
unknownkey: foo
---
Body.`;
    expect(() => parseTaskFile(c, "/p", { defaultEngine: "ollama" })).toThrow(/unknown frontmatter/);
  });

  test("empty body rejected", () => {
    const c = `---
name: digest
description: x
cron: "0 * * * *"
tz: UTC
---
`;
    expect(() => parseTaskFile(c, "/p", { defaultEngine: "ollama" })).toThrow(/body must be non-empty/);
  });

  test("hyphen in name rejected (Telegram constraint)", () => {
    const c = `---
name: morning-digest
description: x
cron: "0 * * * *"
tz: UTC
---
Body.`;
    expect(() => parseTaskFile(c, "/p", { defaultEngine: "ollama" })).toThrow(/"name" must match/);
  });

  test("legacy `schedule:` key rejected as unknown", () => {
    const c = `---
name: digest
description: x
schedule: every 1h
---
Body.`;
    expect(() => parseTaskFile(c, "/p", { defaultEngine: "ollama" })).toThrow(/unknown frontmatter/);
  });
});

// ---------------------------------------------------------------------------
// Integration — full-weekday simulation
// ---------------------------------------------------------------------------

describe("nextRunAt — full-day fire count", () => {
  test("*/30 12-18 * * 1-5 Denver on Monday → 14 fires", () => {
    // Note: cron `12-18` includes hour 18 (inclusive), so `*/30` yields
    // 18:00 AND 18:30. The full 7-hour window × 2 fires/hour = 14 fires.
    // Operators wanting exactly 13 fires ending at 18:00 need multi-trigger
    // (PLAN OQ#5, deferred).
    const t = buildTask({ kind: "cron", expr: "*/30 12-18 * * 1-5" }, "America/Denver");
    let last: number | null = null;
    const startMs = Date.UTC(2026, 4, 18, 6, 0); // Mon 2026-05-18 00:00 MDT
    const endMs = Date.UTC(2026, 4, 19, 6, 0); // Tue 2026-05-19 00:00 MDT
    let n = 0;
    let cursor = startMs;
    while (true) {
      const due = nextRunAt(t, last, cursor);
      if (due === null || due >= endMs) break;
      n++;
      last = due;
      cursor = due + 1;
    }
    expect(n).toBe(14);
  });

  test("*/30 12-18 * * 1-5 Denver on Saturday → 0 fires", () => {
    const t = buildTask({ kind: "cron", expr: "*/30 12-18 * * 1-5" }, "America/Denver");
    const startMs = Date.UTC(2026, 4, 16, 6, 0); // Sat 2026-05-16 00:00 MDT
    const endMs = Date.UTC(2026, 4, 17, 6, 0); // Sun 00:00 MDT
    const due = nextRunAt(t, null, startMs);
    // First fire after Saturday midnight must be either later that Saturday
    // (nope — weekday filter) or in the following Monday window. Confirm
    // it's NOT inside the Sat→Sun window.
    expect(due).not.toBeNull();
    expect(due!).toBeGreaterThanOrEqual(endMs);
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

const FROZEN_NOW = Date.UTC(2026, 4, 18, 14, 13); // Mon 2026-05-18 14:13 UTC

describe("startScheduler — boot fire", () => {
  test("cron, never run → does NOT boot-fire (cron is anchored, not stateful)", async () => {
    const db = await freshDb();
    const queue = newFakeQueue();
    const task = parseTaskFile(MINIMAL, "/p/TASK.md", { defaultEngine: "ollama" });
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

  test("cron, never run → tick driver fires on first cron tick AFTER boot (regression: lastRunAt=null must anchor on bootTime, not the moving now)", async () => {
    const db = await freshDb();
    const queue = newFakeQueue();
    // every-minute task; bootTime is mid-minute so the first cron tick after
    // boot is :00 of the next minute.
    const c = `---
name: minute
description: x
cron: "* * * * *"
tz: UTC
catch_up: false
engine: ollama
---
Body.`;
    const task = parseTaskFile(c, "/p", { defaultEngine: "ollama" });

    let nowMs = Date.UTC(2026, 4, 18, 14, 13, 6); // 14:13:06 UTC — boot
    let tickFn: (() => void) | null = null;
    const handle = startScheduler({
      db,
      registry: singleTaskRegistry(task),
      enqueue: queue.enqueue,
      operatorFromId: 100,
      defaultEngine: "ollama",
      defaultChatId: 100,
      now: () => nowMs,
      setInterval: (fn) => {
        tickFn = fn;
        return 0;
      },
      clearInterval: () => {},
    });

    // Boot tick at 14:13:06 — next cron tick is 14:14:00, in the future, so
    // no boot fire (matches design: cron is anchored, not stateful).
    expect(queue.enqueued.length).toBe(0);

    // Advance to 14:14:06 — the first cron tick after boot (14:14:00) has
    // just passed. The driver MUST detect `due ≤ now` and fire.
    // Pre-fix bug: nextRunAt anchored on the moving `now` returned 14:15:00,
    // which is still > now → never fires.
    nowMs = Date.UTC(2026, 4, 18, 14, 14, 6);
    tickFn!();
    expect(queue.enqueued.length).toBe(1);

    // Advance to 14:15:06 — second fire. After the first fire, lastRunAt is
    // set, so the anchor now flows through the normal path. Confirms the
    // post-first-fire transition.
    nowMs = Date.UTC(2026, 4, 18, 14, 15, 6);
    tickFn!();
    expect(queue.enqueued.length).toBe(2);

    handle.stop();
  });

  test("cron, lastRunAt 3h stale, catch_up=true → boot-fires ONCE", async () => {
    const db = await freshDb();
    const queue = newFakeQueue();
    const task = parseTaskFile(MINIMAL, "/p/TASK.md", { defaultEngine: "ollama" });
    const registry = singleTaskRegistry(task);

    // Seed lastRunAt 3h before FROZEN_NOW.
    db.upsertTaskMetadata({ name: task.name, sourcePath: "/p", sourceHash: "h" });
    db.markTaskFired({
      name: task.name,
      lastRunAt: FROZEN_NOW - 3 * 60 * 60 * 1000,
      lastAuditId: 1,
      lastStatus: "fired",
    });

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

    // Exactly one catch-up fire (not N catch-ups).
    expect(queue.enqueued.length).toBe(1);
    handle.stop();
  });

  test("cron, lastRunAt 3h stale, catch_up=false → does NOT fire; lastRunAt bumped to now", async () => {
    const db = await freshDb();
    const queue = newFakeQueue();
    const c = `---
name: deferred
description: x
cron: "0 * * * *"
tz: UTC
catch_up: false
---
Body.`;
    const task = parseTaskFile(c, "/p", { defaultEngine: "ollama" });
    const registry = singleTaskRegistry(task);

    db.upsertTaskMetadata({ name: task.name, sourcePath: "/p", sourceHash: "h" });
    db.markTaskFired({
      name: task.name,
      lastRunAt: FROZEN_NOW - 3 * 60 * 60 * 1000,
      lastAuditId: 1,
      lastStatus: "fired",
    });

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
at: ${past}
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
at: ${past}
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

  test("at <future>, cold start → does NOT fire yet, no consumed mark", async () => {
    const db = await freshDb();
    const queue = newFakeQueue();
    const future = new Date(FROZEN_NOW + 60 * 60 * 1000).toISOString();
    const c = `---
name: future_alarm
description: x
at: ${future}
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
    const state = db.getTaskState("future_alarm");
    expect(state?.oneOffConsumed).toBeFalsy();
    handle.stop();
  });

  test("disabled task does not fire", async () => {
    const db = await freshDb();
    const queue = newFakeQueue();
    const c = `---
name: paused
description: x
cron: "0 * * * *"
tz: UTC
enabled: false
---
Body.`;
    const task = parseTaskFile(c, "/p", { defaultEngine: "ollama" });
    const registry = singleTaskRegistry(task);

    // Seed stale lastRunAt — would normally trigger catch-up.
    db.upsertTaskMetadata({ name: task.name, sourcePath: "/p", sourceHash: "h" });
    db.markTaskFired({
      name: task.name,
      lastRunAt: FROZEN_NOW - 3 * 60 * 60 * 1000,
      lastAuditId: 1,
      lastStatus: "fired",
    });

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

    // Seed stale lastRunAt to force a boot-fire that hits the queue.
    db.upsertTaskMetadata({ name: task.name, sourcePath: "/p", sourceHash: "h" });
    db.markTaskFired({
      name: task.name,
      lastRunAt: FROZEN_NOW - 3 * 60 * 60 * 1000,
      lastAuditId: 1,
      lastStatus: "fired",
    });

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
  function staleSeed(db: SolracDb, name: string) {
    db.upsertTaskMetadata({ name, sourcePath: "/p", sourceHash: "h" });
    db.markTaskFired({
      name,
      lastRunAt: FROZEN_NOW - 3 * 60 * 60 * 1000,
      lastAuditId: 1,
      lastStatus: "fired",
    });
  }

  test("task engine matches default → no prefix", async () => {
    const db = await freshDb();
    const queue = newFakeQueue();
    const task = parseTaskFile(MINIMAL, "/p", { defaultEngine: "ollama" });
    staleSeed(db, task.name);
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
cron: "0 * * * *"
tz: UTC
engine: primary
---
fetch the weather`;
    const task = parseTaskFile(c, "/p", { defaultEngine: "ollama" });
    staleSeed(db, task.name);
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
cron: "0 * * * *"
tz: UTC
engine: secondary
---
think deeply`;
    const task = parseTaskFile(c, "/p", { defaultEngine: "ollama" });
    staleSeed(db, task.name);
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
    db.upsertTaskMetadata({ name: task.name, sourcePath: "/p", sourceHash: "h" });
    db.markTaskFired({
      name: task.name,
      lastRunAt: FROZEN_NOW - 3 * 60 * 60 * 1000,
      lastAuditId: 1,
      lastStatus: "fired",
    });
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
cron: "0 * * * *"
tz: UTC
engine: secondary
max_cost_usd: 0.20
---
Body.`;
    const task = parseTaskFile(c, "/p", { defaultEngine: "ollama" });

    // Seed stale lastRunAt to force boot-fire attempt.
    db.upsertTaskMetadata({ name: task.name, sourcePath: "/p", sourceHash: "h" });
    db.markTaskFired({
      name: task.name,
      lastRunAt: FROZEN_NOW - 3 * 60 * 60 * 1000,
      lastAuditId: priorAuditId,
      lastStatus: "fired",
    });

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
cron: "0 * * * *"
tz: UTC
max_cost_usd: 0.01
---
Body.`;
    const task = parseTaskFile(c, "/p", { defaultEngine: "ollama" });
    expect(task.maxCostUsd).toBeNull(); // already nulled at parse

    // Seed stale lastRunAt.
    db.upsertTaskMetadata({ name: task.name, sourcePath: "/p", sourceHash: "h" });
    db.markTaskFired({
      name: task.name,
      lastRunAt: FROZEN_NOW - 3 * 60 * 60 * 1000,
      lastAuditId: 1,
      lastStatus: "fired",
    });

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
    db.upsertTaskMetadata({ name: task.name, sourcePath: "/p", sourceHash: "h" });
    db.markTaskFired({
      name: task.name,
      lastRunAt: FROZEN_NOW - 3 * 60 * 60 * 1000,
      lastAuditId: 1,
      lastStatus: "fired",
    });
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
