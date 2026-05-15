/**
 * @fileoverview Scheduled-task loader, schedule grammar parser, and tick driver.
 * @purpose Generalize the daily-report cron primitive into a first-class
 *          scheduler that runs operator-authored prompt tasks (TASK.md
 *          frontmatter + body) on a timer. Tasks fire as synthetic Telegram
 *          updates through the existing turn queue so the existing safety
 *          machinery — allowlist gate, cost caps, policy hooks, shutdown
 *          drain — applies automatically.
 *
 * Three composed pieces:
 *
 *   1. Loader — reads `<tasksDir>/<name>/TASK.md`, parses YAML-ish frontmatter
 *      (mirrors `skills.ts`'s schema-restricted parser), validates the schema,
 *      and returns a frozen `TaskRegistry`. Fail-soft: a malformed TASK.md
 *      adds an error to the result but does not throw; boot continues.
 *
 *   2. Schedule grammar — two forms, parsed into a discriminated union
 *      `ScheduleSpec`:
 *        - `cron: <5-field expr>`  unix cron in the task's `tz` (default
 *                                  host tz). Anchored cadence — no drift.
 *        - `at: <ISO8601>`         absolute one-off
 *      Exactly one of `cron:` or `at:` must be present. `cron-parser` 5.x
 *      handles tz + DST (spring-forward skipped, fall-back single fire).
 *      `nextRunAt(task, lastRunAt, now)` is a pure function used by both
 *      the tick loop and the unit tests; no I/O.
 *
 *   3. Tick driver — single shared `setInterval(60_000)` scans the registry,
 *      compares `nextRunAt(...)` to now, fires due tasks via the injected
 *      `enqueue` (the existing turn queue's enqueue, so tasks share the
 *      KeyedMutex / Semaphore / TurnTracker with user-typed turns).
 *
 * Synthetic-update construction:
 *
 *   The tick driver synthesizes a `Update` shape with negative `update_id`
 *   (avoids any chance of colliding with Telegram's positive offset space),
 *   `from.id = operator` (passes the allowlist gate), `chat.id = task.chatId`
 *   (the task's configured target chat), and `text` containing an explicit
 *   engine prefix when the task's `engine` differs from `config.defaultEngine`.
 *   A `__solrac_scheduled` field on the message carries the task identifier
 *   and the optional `max_cost_usd` cap; the runners (agent.ts, local.ts)
 *   read this off the message via main.ts::makeRunTurn and propagate it into
 *   the audit row (`origin='scheduled'`, `task_name=<name>`).
 *
 * Catch-up policy (per task):
 *
 *   - `cron`, `last_run_at` set AND next cron fire after it is in the past:
 *     fire ONCE on the next tick (NOT N times for N missed slots).
 *   - `cron`, never run (`last_run_at` null): does NOT boot-fire — waits
 *     for the next cron tick. (cron is anchored, not stateful: a fresh
 *     deploy at 14:00 with `0 9 * * *` waits until tomorrow 09:00.)
 *   - `at`, `at_ms < now` AND `!one_off_consumed`: fire once iff `catch_up`,
 *     else mark consumed without firing.
 *
 *   `catch_up: true` is the default for `cron`, `false` for `at`.
 *   `boot_catch_up_jitter_s` deferrs the boot fire by `random(0, jitter_s)`
 *   seconds so 12 daily tasks don't pile up simultaneously on restart.
 *
 * Position in the dependency graph:
 *   db + queue + telegram + log + config → scheduler → consumed by main
 *
 * Exports:
 *   - `Task`, `TaskRegistry`, `ScheduleSpec`, `ScheduledTaskContext` — types.
 *   - `EMPTY_TASK_REGISTRY` — sentinel when scheduling is disabled.
 *   - `loadTasksSync(dir, defaultEngine)` — boot loader, returns registry + errors.
 *   - `validateCronExpr(raw, tz)` — pure cron validator (wraps cron-parser).
 *   - `parseTaskFile(content, sourcePath, defaultEngine)` — pure parser.
 *   - `nextRunAt(task, lastRunAt, now)` — pure timestamp computation.
 *   - `startScheduler(deps)` — installs the tick loop; returns `{ stop }`.
 *   - `getScheduledContext(message)` — runner-side helper to recover task
 *     metadata off a message that flowed through the queue.
 *   - `tasksToBotCommands(tasks)` — Phase 2 helper for `/tasks` autocomplete.
 *
 * Key invariants:
 *   - The synthetic `update_id` field on the message is a NEGATIVE integer
 *     drawn from a per-process counter. Scheduled fires NEVER write to
 *     `handled_updates` (`db.claimUpdate(...)`) — that table's PRIMARY KEY
 *     is `update_id`, and a synthetic id colliding with a future Telegram
 *     poll offset would silently dedupe a real user message.
 *   - `audit.update_id` is set to NULL for scheduled fires (column is plain
 *     INTEGER, no UNIQUE / no JOIN, so NULL is safe — verified via grep on
 *     `db.ts` and the rest of `src/`).
 *   - Engine `local` is rejected at parse when `config.defaultEngine !==
 *     "local"`; the local engine is reachable
 *     only as the deploy default.
 *   - The tick loop is driven by ONE shared `setInterval(60_000)`. Boot fire
 *     runs the first tick immediately so tasks with `bootFireAt <= now`
 *     fire without waiting 60s.
 *   - On shutdown: scheduler.stop() is called BEFORE pollAbort.abort() so
 *     no new fires land mid-drain. In-flight task turns drain through the
 *     existing TurnTracker.
 *
 * Gotchas:
 *   - The frontmatter parser is duplicated from `skills.ts` (schema differs)
 *     rather than refactored into a shared module — keeps this PR focused.
 *     If a third user emerges, factor a `frontmatter.ts` module.
 *   - `boot_catch_up_jitter_s` is in-memory state per-process. A restart
 *     mid-jitter recomputes from scratch; brief and harmless.
 *   - `max_cost_usd` is a pre-flight check (sum of THIS task's costs in past
 *     1 hour ≥ cap → skip and write a denial row). It does NOT abort an
 *     in-flight turn; cost only arrives at end-of-turn from the SDK.
 *     Silently ignored for `engine: local` (free).
 *
 * Cross-references:
 *   - PLAN.md — design source
 *   - daily-report.ts — the cron-primitive precedent
 *   - skills.ts — frontmatter parser pattern
 *   - main.ts — wiring + makeRunTurn extraction of scheduled context
 *   - examples/tasks/ — operator-facing template
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Update } from "@grammyjs/types";
import { CronExpressionParser } from "cron-parser";
import type { DefaultEngine } from "./config.ts";
import type { SolracDb } from "./db.ts";
import { log } from "./log.ts";
import type { EnqueueResult } from "./queue.ts";
import type { BotCommand } from "./telegram.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskEngine = "primary" | "secondary" | "local";

export type ScheduleSpec =
  | { kind: "cron"; expr: string }
  | { kind: "at"; atMs: number };

export interface Task {
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly chatId: number | null;
  readonly engine: TaskEngine;
  readonly spec: ScheduleSpec;
  // Resolved at parse time; never null. For `at` tasks this is informational
  // only (the timestamp is absolute); for `cron` tasks it governs which
  // wall-clock the expression evaluates against.
  readonly tz: string;
  readonly catchUp: boolean;
  readonly enabled: boolean;
  readonly maxCostUsd: number | null;
  readonly bootCatchUpJitterS: number;
  readonly sourcePath: string;
  readonly sourceHash: string;
}

export interface TaskLoadError {
  readonly path: string;
  readonly message: string;
}

export interface TaskRegistry {
  readonly all: ReadonlyArray<Task>;
  get(name: string): Task | undefined;
  size(): number;
}

export interface TaskLoadResult {
  readonly registry: TaskRegistry;
  readonly errors: ReadonlyArray<TaskLoadError>;
  readonly loadedCount: number;
}

export const EMPTY_TASK_REGISTRY: TaskRegistry = Object.freeze({
  all: Object.freeze([] as ReadonlyArray<Task>),
  get: () => undefined,
  size: () => 0,
});

// Carried on the synthesized `Message` so the runners can recover task
// identity + per-task cap without scheduler having to import them. Read on
// the runner side via `getScheduledContext(message)`.
export interface ScheduledTaskContext {
  readonly name: string;
  readonly maxCostUsd: number | null;
}

// Identical regex shape to skills' name regex; same Telegram-bot-command
// constraints apply.
const NAME_RE = /^[a-z0-9_]{1,32}$/;
const MAX_DESCRIPTION_LEN = 256;
const FRONTMATTER_DELIM = "---";

// 5-min minimum for Claude tiers (cost runaway guard). The local engine is
// free so the floor is 1 minute, but a 1-min local task still pins the GPU —
// operator's problem, document in examples.
const MIN_CLAUDE_INTERVAL_MS = 5 * 60 * 1000;
const MIN_LOCAL_INTERVAL_MS = 1 * 60 * 1000;

// Per-task hourly cap pre-flight window. Matches the per-chat cap shape.
const HOURLY_WINDOW_MS = 60 * 60 * 1000;

// Tick cadence — scheduler is intended for hourly/daily granularity, not
// sub-minute. 60s tick is plenty.
const TICK_INTERVAL_MS = 60_000;

const FIELD_KEY = "__solrac_scheduled";

// ---------------------------------------------------------------------------
// Frontmatter parser (schema-restricted YAML subset)
// ---------------------------------------------------------------------------
//
// Same shape as skills.ts but intentionally duplicated to keep PR scope tight.
// Accepts: `key: scalar`, `key: "quoted"`, `key: 'quoted'`, integers, floats,
// booleans. Rejects: arrays (not needed here), nested maps, multi-line.

type ScalarValue = string | number | boolean;

function parseValue(raw: string, line: number): ScalarValue {
  const v = raw.trim();
  if (v === "") return "";
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+$/.test(v)) return Number(v);
  if (/^-?\d+\.\d+$/.test(v)) return Number(v);
  const s = parseStringScalar(v);
  if (s === null) throw new Error(`line ${line}: unparseable value "${raw}"`);
  return s;
}

function parseStringScalar(raw: string): string | null {
  if (raw === "") return "";
  if (
    (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) ||
    (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2)
  ) {
    return raw.slice(1, -1);
  }
  if (raw.includes('"') || raw.includes("'")) return null;
  return raw;
}

interface RawFrontmatter {
  readonly fields: Readonly<Record<string, ScalarValue>>;
}

function parseFrontmatter(yaml: string): RawFrontmatter {
  const fields: Record<string, ScalarValue> = {};
  const lines = yaml.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const raw = lines[i]!;
    const stripped = raw.replace(/\s+#.*$/, "").trim();
    if (stripped === "") continue;
    const m = /^([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(stripped);
    if (!m) {
      throw new Error(`line ${lineNo}: malformed frontmatter line: "${raw}"`);
    }
    const key = m[1]!;
    if (key in fields) {
      throw new Error(`line ${lineNo}: duplicate key "${key}"`);
    }
    fields[key] = parseValue(m[2]!, lineNo);
  }
  return { fields };
}

// ---------------------------------------------------------------------------
// Schedule grammar parser — 5-field unix cron OR ISO8601 `at`
// ---------------------------------------------------------------------------

/**
 * Validate a 5-field cron expression and the tz it'll be evaluated under.
 * Returns the normalized expression on success; throws with a contextual
 * error on failure. cron-parser is permissive (accepts 4-field, 6-field,
 * empty string, `@daily`/`@hourly`); we pre-validate at our layer for
 * tighter semantics and clearer error messages.
 */
export function validateCronExpr(raw: string, tz: string): string {
  const v = raw.trim();
  if (v === "") {
    throw new Error('cron: expression is empty (use a 5-field expression like "*/30 12-18 * * 1-5")');
  }
  if (v.startsWith("@")) {
    throw new Error(
      `cron: predefined aliases like "${v}" are not supported. Use the 5-field equivalent ` +
        `(e.g., @daily → "0 0 * * *", @hourly → "0 * * * *")`,
    );
  }
  const fieldCount = v.split(/\s+/).length;
  if (fieldCount !== 5) {
    throw new Error(
      `cron: expected exactly 5 fields (minute hour day-of-month month day-of-week), got ${fieldCount} in "${v}"`,
    );
  }
  try {
    CronExpressionParser.parse(v, { tz });
  } catch (err) {
    throw new Error(`cron: invalid expression "${v}" (tz=${tz}): ${(err as Error).message}`);
  }
  return v;
}

/** Parse an ISO8601 absolute timestamp; reject tz-naive strings. */
function parseAtField(raw: string): number {
  const isoStr = raw.trim();
  if (!/(Z|[+\-]\d{2}:\d{2})$/.test(isoStr)) {
    throw new Error(
      `at: timezone-naive timestamp rejected (got "${isoStr}"); use a Z suffix or explicit offset`,
    );
  }
  const atMs = Date.parse(isoStr);
  if (!Number.isFinite(atMs)) {
    throw new Error(`at: not a valid ISO8601 timestamp (got "${isoStr}")`);
  }
  return atMs;
}

/**
 * Validate an IANA timezone name (e.g., "America/Denver", "UTC"). Uses the
 * platform's tz database via `Intl.DateTimeFormat` — produces a clean error
 * before cron-parser would emit a cryptic "CronDate: unhandled timestamp".
 */
function validateTz(tz: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw new Error(`tz: invalid IANA timezone "${tz}"`);
  }
}

/** Resolve the host's local IANA timezone (explicit env > runtime default). */
function resolveHostTz(): string {
  const envTz = process.env.TZ;
  if (envTz && envTz.trim() !== "") {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: envTz });
      return envTz;
    } catch {
      // fall through to runtime default
    }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

// ---------------------------------------------------------------------------
// nextRunAt — pure timestamp computation
// ---------------------------------------------------------------------------

/**
 * Returns the ms timestamp at which this task is next due, or `null` if the
 * task should not fire again (one-off already consumed). Used by both the
 * tick driver (which compares to `now`) and tests.
 *
 * Semantics:
 *   - `cron`: returns `iter.next()` anchored at `lastRunAt ?? bootMs ?? now`.
 *     When `lastRunAt` is set, the anchor is the previous fire — `iter.next()`
 *     returns the next cron tick after that. When `lastRunAt` is null and a
 *     stable `bootMs` is provided, the anchor is boot time — `iter.next()`
 *     returns the first cron tick AFTER boot, which stays fixed across
 *     subsequent ticks so the driver can detect `due ≤ now` and fire. When
 *     both are null, the anchor falls back to `now` (display-time queries
 *     from `commands.ts::formatNextFire` use this path — they want "next
 *     fire from this moment").
 *   - `at`: returns `atMs` while `lastRunAt === null`; returns `null` once
 *     the task has fired (one-off).
 *
 * The `bootMs` parameter is what makes scheduled fires actually happen for
 * never-run cron tasks: without it, anchoring on the moving `now` produces a
 * `due` that advances with every tick and never crosses `due ≤ now`. The
 * tick driver passes the process boot time; display callers omit it.
 */
export function nextRunAt(
  task: Pick<Task, "spec" | "tz">,
  lastRunAt: number | null,
  now: number,
  bootMs?: number,
): number | null {
  if (task.spec.kind === "at") {
    if (lastRunAt !== null) return null;
    return task.spec.atMs;
  }
  // cron
  const anchorMs = lastRunAt ?? bootMs ?? now;
  const iter = CronExpressionParser.parse(task.spec.expr, {
    tz: task.tz,
    currentDate: new Date(anchorMs),
  });
  return iter.next().getTime();
}

// ---------------------------------------------------------------------------
// Task file parser (frontmatter + body + schema validation)
// ---------------------------------------------------------------------------

const ALLOWED_KEYS = new Set([
  "name",
  "description",
  "cron",
  "at",
  "tz",
  "chat_id",
  "engine",
  "catch_up",
  "enabled",
  "max_cost_usd",
  "boot_catch_up_jitter_s",
]);

export interface ParseTaskOpts {
  defaultEngine: DefaultEngine;
}

export function parseTaskFile(
  content: string,
  sourcePath: string,
  opts: ParseTaskOpts,
): Task {
  const normalized = content.replace(/\r\n/g, "\n").replace(/^﻿/, "");
  const trimmed = normalized.replace(/^\s+/, "");
  if (!trimmed.startsWith(FRONTMATTER_DELIM + "\n") && trimmed !== FRONTMATTER_DELIM) {
    throw new Error(`${sourcePath}: file must begin with "---" frontmatter delimiter`);
  }
  const afterOpen = trimmed.slice(FRONTMATTER_DELIM.length + 1);
  const closeIdx = afterOpen.indexOf("\n" + FRONTMATTER_DELIM);
  if (closeIdx === -1) {
    throw new Error(`${sourcePath}: missing closing "---" frontmatter delimiter`);
  }
  const yaml = afterOpen.slice(0, closeIdx);
  const afterClose = afterOpen.slice(closeIdx + 1 + FRONTMATTER_DELIM.length);
  const body = afterClose.replace(/^[ \t]*\n/, "").trim();

  let raw: RawFrontmatter;
  try {
    raw = parseFrontmatter(yaml);
  } catch (err) {
    throw new Error(`${sourcePath}: ${(err as Error).message}`);
  }

  const f = raw.fields;
  for (const k of Object.keys(f)) {
    if (!ALLOWED_KEYS.has(k)) {
      throw new Error(
        `${sourcePath}: unknown frontmatter key "${k}" (allowed: ${[...ALLOWED_KEYS].sort().join(", ")})`,
      );
    }
  }

  // name
  const nameVal = f.name;
  if (typeof nameVal !== "string" || nameVal === "") {
    throw new Error(`${sourcePath}: "name" is required and must be a non-empty string`);
  }
  const name = nameVal.toLowerCase();
  if (!NAME_RE.test(name)) {
    throw new Error(`${sourcePath}: "name" must match ${NAME_RE.source} (got "${nameVal}")`);
  }

  // description
  const descVal = f.description;
  if (typeof descVal !== "string" || descVal.trim() === "") {
    throw new Error(`${sourcePath}: "description" is required and must be a non-empty string`);
  }
  if (descVal.length > MAX_DESCRIPTION_LEN) {
    throw new Error(`${sourcePath}: "description" must be ≤${MAX_DESCRIPTION_LEN} chars (got ${descVal.length})`);
  }

  // tz — explicit > $TZ > runtime default. Resolved BEFORE cron validation
  // so the parser sees the same tz the runtime will use.
  let tz: string;
  if ("tz" in f) {
    const v = f.tz;
    if (typeof v !== "string" || v.trim() === "") {
      throw new Error(`${sourcePath}: "tz" must be a non-empty IANA timezone string`);
    }
    try {
      validateTz(v);
    } catch (err) {
      throw new Error(`${sourcePath}: ${(err as Error).message}`);
    }
    tz = v;
  } else {
    tz = resolveHostTz();
  }

  // cron / at — exactly one required.
  const hasCron = "cron" in f;
  const hasAt = "at" in f;
  if (hasCron && hasAt) {
    throw new Error(`${sourcePath}: "cron" and "at" are mutually exclusive — pick one`);
  }
  if (!hasCron && !hasAt) {
    throw new Error(
      `${sourcePath}: one of "cron: <5-field expr>" or "at: <ISO8601>" is required`,
    );
  }
  let spec: ScheduleSpec;
  if (hasCron) {
    const v = f.cron;
    if (typeof v !== "string" || v.trim() === "") {
      throw new Error(`${sourcePath}: "cron" must be a non-empty 5-field expression`);
    }
    try {
      const expr = validateCronExpr(v, tz);
      spec = { kind: "cron", expr };
    } catch (err) {
      throw new Error(`${sourcePath}: ${(err as Error).message}`);
    }
  } else {
    const v = f.at;
    if (typeof v !== "string" || v.trim() === "") {
      throw new Error(`${sourcePath}: "at" must be a non-empty ISO8601 timestamp`);
    }
    try {
      const atMs = parseAtField(v);
      spec = { kind: "at", atMs };
    } catch (err) {
      throw new Error(`${sourcePath}: ${(err as Error).message}`);
    }
  }

  // engine — defaults to deploy default. When explicit `local`, refuse if
  // the deploy default isn't local. Legacy `engine: ollama` is hard-rejected
  // with a rename hint.
  let engine: TaskEngine = opts.defaultEngine === "local" ? "local" : opts.defaultEngine;
  if ("engine" in f) {
    const engineVal = f.engine;
    if (engineVal === "ollama") {
      throw new Error(
        `${sourcePath}: "engine: ollama" is no longer accepted — replace with "engine: local" ` +
          `(the local engine now supports multiple backends via LOCAL_BACKEND)`,
      );
    }
    if (engineVal !== "primary" && engineVal !== "secondary" && engineVal !== "local") {
      throw new Error(`${sourcePath}: "engine" must be primary | secondary | local (got "${String(engineVal)}")`);
    }
    if (engineVal === "local" && opts.defaultEngine !== "local") {
      throw new Error(
        `${sourcePath}: "engine: local" is unreachable when SOLRAC_DEFAULT_ENGINE != local. ` +
          `Set SOLRAC_DEFAULT_ENGINE=local or use engine: primary/secondary`,
      );
    }
    engine = engineVal;
  }

  // Min-interval guard for cron tasks. Inspect the first 5 fire times after
  // a fixed anchor; reject if any consecutive gap < tier floor. Rejects
  // pathological `* * * * *` on Claude tiers at load time with a clear error.
  // `at` tasks are one-off; no interval to police.
  if (spec.kind === "cron") {
    const minMs = engine === "local" ? MIN_LOCAL_INTERVAL_MS : MIN_CLAUDE_INTERVAL_MS;
    const iter = CronExpressionParser.parse(spec.expr, {
      tz,
      currentDate: new Date(0),
    });
    let prev = iter.next().getTime();
    for (let i = 0; i < 5; i++) {
      const cur = iter.next().getTime();
      const gap = cur - prev;
      if (gap < minMs) {
        throw new Error(
          `${sourcePath}: cron interval too tight for engine=${engine} ` +
            `(gap ${gap}ms < min ${minMs}ms in expression "${spec.expr}")`,
        );
      }
      prev = cur;
    }
  }

  // chat_id (optional; falls back to operator's first allowlist entry at fire time)
  let chatId: number | null = null;
  if ("chat_id" in f) {
    const v = f.chat_id;
    if (typeof v !== "number" || !Number.isInteger(v)) {
      throw new Error(`${sourcePath}: "chat_id" must be an integer`);
    }
    chatId = v;
  }

  // catch_up — default true for periodic, false for one-off
  let catchUp = spec.kind !== "at";
  if ("catch_up" in f) {
    const v = f.catch_up;
    if (typeof v !== "boolean") throw new Error(`${sourcePath}: "catch_up" must be true/false`);
    catchUp = v;
  }

  // enabled — default true
  let enabled = true;
  if ("enabled" in f) {
    const v = f.enabled;
    if (typeof v !== "boolean") throw new Error(`${sourcePath}: "enabled" must be true/false`);
    enabled = v;
  }

  // max_cost_usd — optional positive number; ignored for local engine
  let maxCostUsd: number | null = null;
  if ("max_cost_usd" in f) {
    const v = f.max_cost_usd;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      throw new Error(`${sourcePath}: "max_cost_usd" must be a positive number`);
    }
    maxCostUsd = engine === "local" ? null : v;
  }

  // boot_catch_up_jitter_s — optional non-negative integer
  let bootCatchUpJitterS = 0;
  if ("boot_catch_up_jitter_s" in f) {
    const v = f.boot_catch_up_jitter_s;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
      throw new Error(`${sourcePath}: "boot_catch_up_jitter_s" must be a non-negative integer`);
    }
    bootCatchUpJitterS = v;
  }

  if (body === "") {
    throw new Error(`${sourcePath}: body must be non-empty (no prompt template)`);
  }

  const sourceHash = createHash("sha256").update(content).digest("hex").slice(0, 16);

  return Object.freeze({
    name,
    description: descVal,
    body,
    chatId,
    engine,
    spec,
    tz,
    catchUp,
    enabled,
    maxCostUsd,
    bootCatchUpJitterS,
    sourcePath,
    sourceHash,
  });
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export function loadTasksSync(
  dir: string,
  defaultEngine: DefaultEngine,
): TaskLoadResult {
  const errors: TaskLoadError[] = [];
  const byName = new Map<string, Task>();

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    errors.push({
      path: dir,
      message: `cannot read tasks directory: ${(err as Error).message}`,
    });
    return { registry: EMPTY_TASK_REGISTRY, errors, loadedCount: 0 };
  }

  for (const entry of entries.sort()) {
    const subdir = join(dir, entry);
    let isDir: boolean;
    try {
      isDir = statSync(subdir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    const taskPath = join(subdir, "TASK.md");
    let content: string;
    try {
      content = readFileSync(taskPath, "utf8");
    } catch {
      continue;
    }
    let task: Task;
    try {
      task = parseTaskFile(content, taskPath, { defaultEngine });
    } catch (err) {
      errors.push({ path: taskPath, message: (err as Error).message });
      continue;
    }
    if (byName.has(task.name)) {
      const first = byName.get(task.name)!;
      errors.push({
        path: taskPath,
        message: `task name "${task.name}" already loaded from ${first.sourcePath}; this file is ignored`,
      });
      continue;
    }
    byName.set(task.name, task);
  }

  const all = Object.freeze([...byName.values()]);
  const registry: TaskRegistry = Object.freeze({
    all,
    get: (name: string) => byName.get(name.toLowerCase()),
    size: () => byName.size,
  });
  return { registry, errors, loadedCount: byName.size };
}

export function logTaskLoadResult(dir: string, result: TaskLoadResult): void {
  log.info("scheduler.tasks_loaded", {
    dir,
    count: result.loadedCount,
    errors: result.errors.length,
  });
  for (const e of result.errors) {
    log.warn("scheduler.task_load_error", { path: e.path, message: e.message });
  }
}

// ---------------------------------------------------------------------------
// Synthetic update construction
// ---------------------------------------------------------------------------

// Negative-int counter avoids any chance of colliding with Telegram's positive
// poll-offset space. Process-local; restart resets to -1, which is fine since
// `audit.update_id` carries no constraints (verified) and scheduler fires
// don't write to handled_updates.
let nextSyntheticId = -1;
function takeSyntheticId(): number {
  const id = nextSyntheticId;
  nextSyntheticId -= 1;
  return id;
}

/** Engine-prefix mapping: relative to the deploy default. */
function buildEnginePrefix(taskEngine: TaskEngine, defaultEngine: DefaultEngine): string {
  if (taskEngine === defaultEngine) return "";
  if (taskEngine === "primary") return "@";
  if (taskEngine === "secondary") return "!";
  // local with non-local default is rejected at parse — unreachable here.
  throw new Error(`unreachable: engine=${taskEngine} default=${defaultEngine}`);
}

/**
 * Synthesize an `Update` for the queue. Carries `__solrac_scheduled` on the
 * message so `main.ts::makeRunTurn` can extract the task identity and
 * propagate it into the runner's audit row.
 */
function synthesizeUpdate(
  task: Task,
  chatId: number,
  operatorFromId: number,
  defaultEngine: DefaultEngine,
  now: number,
): Update {
  const prefix = buildEnginePrefix(task.engine, defaultEngine);
  const text = prefix + task.body;
  const ctx: ScheduledTaskContext = { name: task.name, maxCostUsd: task.maxCostUsd };
  // Cast extension: attaching __solrac_scheduled is a load-bearing string key
  // recovered by getScheduledContext on the runner side. Documented in the
  // file header.
  const message = {
    message_id: takeSyntheticId(),
    date: Math.floor(now / 1000),
    chat: { id: chatId, type: "private" as const, first_name: "scheduler" },
    from: { id: operatorFromId, is_bot: false, first_name: "scheduler" },
    text,
    [FIELD_KEY]: ctx,
  };
  return {
    update_id: takeSyntheticId(),
    message: message as unknown as NonNullable<Update["message"]>,
  };
}

/**
 * Read the scheduled-task context off a message that flowed through the
 * queue. Returns undefined for user-typed messages.
 */
export function getScheduledContext(
  message: NonNullable<Update["message"]> | undefined,
): ScheduledTaskContext | undefined {
  if (!message) return undefined;
  const v = (message as { [FIELD_KEY]?: ScheduledTaskContext })[FIELD_KEY];
  return v;
}

// ---------------------------------------------------------------------------
// Tick driver
// ---------------------------------------------------------------------------

export interface SchedulerDeps {
  db: SolracDb;
  registry: TaskRegistry;
  // Reuses the existing turn queue so scheduled fires share KeyedMutex /
  // Semaphore / TurnTracker with user-typed turns.
  enqueue: (update: Update) => EnqueueResult;
  // First allowlist entry — synthetic updates use this as `from.id` so the
  // existing allowlist gate passes without scheduler having to bypass it.
  operatorFromId: number;
  // Used to compute engine-prefix mapping per fire.
  defaultEngine: DefaultEngine;
  // Optional fallback chat id when a TASK.md omits `chat_id`. main.ts passes
  // the operator's chat id (== `operatorFromId` for DMs) so unconfigured
  // tasks DM the operator like the daily report does.
  defaultChatId: number;
  // Injectables for tests.
  now?: () => number;
  random?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export interface SchedulerHandle {
  stop: () => void;
  // Test surface: trigger a single tick now (bypasses the interval).
  tick: () => void;
  // Manual fire used by `/tasks run <name>`. Bypasses the schedule clock,
  // honors max_cost_usd + queue-full + enabled checks. Returns a result for
  // the operator-facing reply.
  triggerNow: (name: string) => TriggerNowResult;
}

export type TriggerNowResult =
  | { kind: "fired"; name: string }
  | { kind: "unknown_task"; name: string }
  | { kind: "disabled"; name: string }
  | { kind: "one_off_consumed"; name: string };

interface TaskRuntime {
  task: Task;
  // Set on boot for catch-up tasks with jitter > 0; after consumption
  // (the boot-fire actually happens), reset to null.
  bootFireAt: number | null;
  // Process boot time. Used as the stable anchor for never-run cron tasks
  // so the tick driver can detect `due ≤ now` once the wall clock crosses
  // the first cron tick after boot. Without this, `nextRunAt(task, null,
  // now)` would re-anchor on the moving `now` every tick and `due` would
  // always be in the future.
  bootAnchor: number;
}

export function startScheduler(deps: SchedulerDeps): SchedulerHandle {
  const now = deps.now ?? (() => Date.now());
  const random = deps.random ?? Math.random;
  const setIntervalFn = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const clearIntervalFn =
    deps.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));

  const runtimes = new Map<string, TaskRuntime>();

  // Boot pass: register metadata, decide catch-up disposition, compute
  // jittered boot fire timestamps. This is the only place we touch
  // `setTaskOneOffConsumed` / `setTaskLastRunOnly` for the no-catch-up paths.
  const bootNow = now();
  for (const t of deps.registry.all) {
    deps.db.upsertTaskMetadata({
      name: t.name,
      sourcePath: t.sourcePath,
      sourceHash: t.sourceHash,
    });
    if (!t.enabled) {
      runtimes.set(t.name, { task: t, bootFireAt: null, bootAnchor: bootNow });
      continue;
    }
    const state = deps.db.getTaskState(t.name);
    if (state?.oneOffConsumed) {
      runtimes.set(t.name, { task: t, bootFireAt: null, bootAnchor: bootNow });
      continue;
    }
    const due = nextRunAt(t, state?.lastRunAt ?? null, bootNow, bootNow);
    if (due === null) {
      runtimes.set(t.name, { task: t, bootFireAt: null, bootAnchor: bootNow });
      continue;
    }
    const wouldFireOnBoot = due <= bootNow;
    if (wouldFireOnBoot && !t.catchUp) {
      // Skip the catch-up fire. For one-off, mark consumed; for periodic,
      // bump last_run_at to now so the NEXT due is `now + interval`.
      if (t.spec.kind === "at") {
        deps.db.setTaskOneOffConsumed({
          name: t.name,
          lastRunAt: bootNow,
          lastAuditId: null,
          lastStatus: "skipped_no_catch_up",
        });
      } else {
        deps.db.setTaskLastRunOnly(t.name, bootNow);
      }
      runtimes.set(t.name, { task: t, bootFireAt: null, bootAnchor: bootNow });
      continue;
    }
    let bootFireAt: number | null = null;
    if (wouldFireOnBoot && t.bootCatchUpJitterS > 0) {
      const jitterMs = Math.floor(random() * t.bootCatchUpJitterS * 1000);
      bootFireAt = bootNow + jitterMs;
    }
    runtimes.set(t.name, { task: t, bootFireAt, bootAnchor: bootNow });
  }

  function fireTask(rt: TaskRuntime, fireAt: number): void {
    const task = rt.task;

    // Per-task hourly cost cap — pre-flight check. Skip and write a denial
    // audit row when the cap fires. `null` cap (unset OR local) → no-op.
    if (task.maxCostUsd !== null && task.engine !== "local") {
      const spent = deps.db.sumTaskCostSince(task.name, fireAt - HOURLY_WINDOW_MS);
      if (spent >= task.maxCostUsd) {
        const chatId = task.chatId ?? deps.defaultChatId;
        const auditId = deps.db.insertAudit({
          chatId,
          fromId: deps.operatorFromId,
          updateId: null,
          prompt: `task:${task.name}`,
          startedAt: fireAt,
          model: "system",
          origin: "scheduled",
          taskName: task.name,
        });
        deps.db.updateAuditEnd({
          id: auditId,
          response: null,
          toolCalls: null,
          inputTokens: null,
          outputTokens: null,
          cacheCreationInputTokens: null,
          cacheReadInputTokens: null,
          costUsd: null,
          agentSessionId: null,
          status: "denied",
          errorMessage: `task_cost_cap: $${spent.toFixed(4)} ≥ $${task.maxCostUsd.toFixed(4)} in past hour`,
          endedAt: fireAt,
        });
        deps.db.markTaskFired({
          name: task.name,
          lastRunAt: fireAt,
          lastAuditId: auditId,
          lastStatus: "denied",
        });
        log.warn("scheduler.task_cost_cap", {
          name: task.name,
          spent,
          cap: task.maxCostUsd,
          auditId,
        });
        return;
      }
    }

    const chatId = task.chatId ?? deps.defaultChatId;
    const update = synthesizeUpdate(
      task,
      chatId,
      deps.operatorFromId,
      deps.defaultEngine,
      fireAt,
    );
    const result = deps.enqueue(update);
    if (result.kind === "dropped_queue_full") {
      // Parity with main.ts::auditQueueFull but tagged origin='scheduled'.
      // We do NOT send "queue full" into the chat — for scheduled fires the
      // chat may be a digest channel and the noise is the operator's
      // problem, not the audience's.
      const auditId = deps.db.insertAudit({
        chatId,
        fromId: deps.operatorFromId,
        updateId: null,
        prompt: `task:${task.name}`,
        startedAt: fireAt,
        model: "system",
        origin: "scheduled",
        taskName: task.name,
      });
      deps.db.updateAuditEnd({
        id: auditId,
        response: null,
        toolCalls: null,
        inputTokens: null,
        outputTokens: null,
        cacheCreationInputTokens: null,
        cacheReadInputTokens: null,
        costUsd: null,
        agentSessionId: null,
        status: "error",
        errorMessage: "queue_full",
        endedAt: fireAt,
      });
      log.warn("scheduler.task_dropped_queue_full", {
        name: task.name,
        chatId,
        depth: result.depth,
        auditId,
      });
      return;
    }
    deps.db.markTaskFired({
      name: task.name,
      lastRunAt: fireAt,
      lastAuditId: null,
      lastStatus: "fired",
    });
    if (task.spec.kind === "at") {
      deps.db.setTaskOneOffConsumed({
        name: task.name,
        lastRunAt: fireAt,
        lastAuditId: null,
        lastStatus: "fired",
      });
    }
    log.info("scheduler.task_fired", {
      name: task.name,
      chatId,
      engine: task.engine,
      kind: task.spec.kind,
    });
  }

  function tick(): void {
    const t = now();
    for (const rt of runtimes.values()) {
      if (!rt.task.enabled) continue;
      const state = deps.db.getTaskState(rt.task.name);
      if (state?.oneOffConsumed) continue;

      // Boot-fire path (jittered).
      if (rt.bootFireAt !== null) {
        if (t < rt.bootFireAt) continue;
        rt.bootFireAt = null;
        fireTask(rt, t);
        continue;
      }

      const due = nextRunAt(rt.task, state?.lastRunAt ?? null, t, rt.bootAnchor);
      if (due === null) continue;
      if (t < due) continue;
      fireTask(rt, t);
    }
  }

  // First tick fires immediately so jitter=0 boot-catch-up tasks don't wait
  // 60 seconds. The interval drives subsequent ticks.
  tick();
  const handle = setIntervalFn(tick, TICK_INTERVAL_MS);

  function triggerNow(name: string): TriggerNowResult {
    const rt = runtimes.get(name.toLowerCase());
    if (!rt) return { kind: "unknown_task", name };
    if (!rt.task.enabled) return { kind: "disabled", name };
    const state = deps.db.getTaskState(rt.task.name);
    if (state?.oneOffConsumed) return { kind: "one_off_consumed", name };
    fireTask(rt, now());
    return { kind: "fired", name };
  }

  return {
    stop: () => clearIntervalFn(handle),
    tick,
    triggerNow,
  };
}

// ---------------------------------------------------------------------------
// Phase 2 helpers
// ---------------------------------------------------------------------------

/** Convert tasks to Telegram bot-command shape (used in autocomplete). */
export function tasksToBotCommands(tasks: ReadonlyArray<Task>): ReadonlyArray<BotCommand> {
  return tasks.map((t) => ({
    command: t.name,
    description: `[task] ${t.description.replace(/\s+/g, " ").trim()}`.slice(0, 256),
  }));
}
