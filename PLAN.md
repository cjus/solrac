# PLAN: scheduled tasks (one-off + periodic)

Generalize `daily-report.ts` into a first-class scheduler that runs operator-authored prompt tasks on a timer. Reuse Solrac's existing primitives (turn queue, audit log, allowlist gate, cost caps) so safety machinery is automatic and the new module stays small.

This plan lives at the repo root (`solrac/PLAN.md`); `solrac-dev/CLAUDE.md` and `docs/ROADMAP.md#oq12-background-worker-mode` are the prior thinking it operationalizes.

---

## 1. Goal

An operator drops a markdown file into `./tasks/<name>/TASK.md`, restarts Solrac, and the prompt body fires on the configured schedule into a configured chat. One-off (`at: <iso>`) and periodic (`every: <duration>`, `daily_at: HH:MM`) cases are both supported.

Out of scope for v1: cron expressions, timezones, hot-reload, audit-only (no-Telegram-output) runs, peer-agent fan-out.

## 2. Why this shape

The user's instinct (markdown + frontmatter + prompt body) maps 1:1 onto an existing precedent:

- `src/skills.ts` already loads operator-authored markdown files with YAML-ish frontmatter and a prompt-template body. The schema parser, error handling, name-collision rules, and load-soft semantics are all reusable patterns.
- `src/daily-report.ts` is already the `setInterval` + meta-key-idempotency primitive. Today it hardcodes one job (yesterday's spend). The generalization is straightforward.
- `main.ts` (web transport, lines 856–871) already synthesizes `Update` shapes to push into the existing turn queue. Scheduled tasks can do the same — no new dispatch path.

The result: the scheduler is "load files like skills, fire like daily-report, dispatch like the web transport." Three known patterns composed, no new architectural surface.

## 3. File format

```markdown
---
name: morning-digest
description: Weekday morning Notion ticket digest.
schedule: daily_at 09:00          # OR `every 1h` OR `at 2026-05-15T13:00:00Z`
chat_id: 123456789                # default: first allowlist entry
# engine: ollama                  # primary | secondary | ollama
                                  # default: inherits config.defaultEngine (ollama on this deploy)
catch_up: true                    # default: true for periodic; ignored for one-off
enabled: true                     # default: true; lets operator pause without deleting
# max_cost_usd: 0.10              # optional per-task cap (Claude tiers only — Ollama is free)
boot_catch_up_jitter_s: 30        # optional; stagger boot fires by 0..N seconds
---

You are running as the morning digest. Open Notion (mcp__solrac__notion-search)
and list any "In progress" tickets with no update in the last 48h. Reply with a
short bullet list. If there are none, reply "All clear."
```

A task with no `engine:` line on this deploy runs against Ollama for free. Operators escalate individual digests to Anthropic by setting `engine: secondary` (Opus) or `engine: primary` (Sonnet) — same shape as a user typing `!` or `@` in chat.

### Where TASK.md files live

Operator-authored, one subdirectory per task:

```
<launch-cwd>/
└── tasks/                        ← $SOLRAC_TASKS_DIR (default: ./tasks)
    ├── morning-digest/
    │   └── TASK.md
    ├── weekly-pr-review/
    │   └── TASK.md
    └── one-off-2026-05-15/
        └── TASK.md
```

Same shape as `./skills/<name>/SKILL.md` and `./integrations/<name>/index.ts`. Path is launch-cwd-relative, override via `SOLRAC_TASKS_DIR=/abs/or/rel/path`. Loader walks one level deep — a flat layout (`tasks/morning-digest.md`) is rejected for symmetry with skills (the per-task subdir is reserved for future companion files: examples, fixtures, fixtures-replay tests).

### Schedule grammar (one of, not all)

| Form | Meaning | Example |
|------|---------|---------|
| `every <duration>` | Periodic interval from `last_run_at` | `every 1h`, `every 30m`, `every 24h` |
| `daily_at HH:MM` | Anchored daily fire (UTC) | `daily_at 09:00` |
| `at <ISO8601>` | Single fire at absolute time (one-off) | `at 2026-05-15T13:00:00Z` |

Duration suffixes: `s`, `m`, `h`, `d`. Reject anything else at parse time. No cron in v1 — keeps the parser ~30 LOC and avoids `cron-parser` as a dep (anti-goal: no extra dependencies).

### Validation

- `name` matches `/^[a-z0-9_]{1,32}$/` (same regex as skills).
- `engine`: optional. Defaults to `config.defaultEngine` (operator's deploy uses `ollama`, so unprefixed tasks run free on local inference). When set explicitly: ∈ `{primary, secondary, ollama}`. If `ollama`: boot fails loud when `OLLAMA_ENABLED=false` AND when `config.defaultEngine !== "ollama"` (PR-B removed the `>` prefix; Ollama is reachable only when it's the default engine, so a task that asks for it on a Claude-default deploy is unreachable and rejected at parse).
- `chat_id`: integer; default `config.allowlistBootstrap[0]`. NOT auto-allowlisted — `from.id` for synthetic updates is the operator (already allowlisted), not `chat_id`.
- `every <duration>`: minimum 5 minutes for Claude tiers (cost guard). Ollama tasks may go as low as 1 minute (`MIN_OLLAMA_INTERVAL_MIN=1`) since inference is free, but 1-min Ollama still pins the GPU — document the trade-off in `examples/tasks/README.md`.
- One-off `at`: parses ISO8601; rejects timezone-naive strings.
- `max_cost_usd`: optional positive number; **Claude tiers only** — silently ignored for `engine: ollama` (no cost to cap). Defaults to unset (per-chat hourly cap is the only gate). When set, the runner aborts the turn before tool calls if `audit.cost_usd` for this fire exceeds the cap. Wires through the existing `PreToolUse` hook alongside the per-chat / global guards.
- `boot_catch_up_jitter_s`: optional non-negative integer; default `0`. Scheduler delays the boot catch-up fire by `random(0, jitter_s)` seconds so 12 daily tasks don't pile up simultaneously on restart.
- Reject unknown frontmatter keys (matches skills behavior — typos shouldn't silently skip).

## 4. Module layout

```
src/scheduler.ts          NEW — loader + schedule parser + tick loop
src/scheduler.test.ts     NEW — parser + nextRunAt + catch-up semantics
examples/tasks/           NEW — README + minimal sample TASK.md
src/db.ts                 MODIFIED — scheduled_tasks table + idempotent ALTER
src/config.ts             MODIFIED — SOLRAC_TASKS_ENABLED + SOLRAC_TASKS_DIR
src/main.ts               MODIFIED — load + start + wire shutdown
src/lifecycle.ts          MODIFIED — add scheduler.stop() step
src/commands.ts           MODIFIED (Phase 2) — `/tasks` command
docs/USAGE.md             MODIFIED — operator-facing TASK.md tutorial
docs/CONFIG.md            MODIFIED — env vars + minimum-interval rule
docs/ARCHITECTURE.md      MODIFIED — scheduler section + dep graph entry
```

Dependency direction (extends `docs/ARCHITECTURE.md#module-map`):

```
scheduler  →  db + queue + telegram + log + config
```

No cycles. Scheduler sits at the same layer as `daily-report`.

## 5. Concrete data model

### Schema additions (idempotent ALTER, mirrors existing migrations in `db.ts`)

```sql
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  name TEXT PRIMARY KEY,
  last_run_at INTEGER,
  last_audit_id INTEGER,
  last_status TEXT,                    -- 'ok' | 'denied' | 'error' | NULL
  one_off_consumed INTEGER NOT NULL DEFAULT 0,
  source_path TEXT NOT NULL,
  source_hash TEXT NOT NULL,           -- SHA-256 of TASK.md; helps `/tasks status`
  updated_at INTEGER NOT NULL
);

-- Distinguish scheduled fires from user/system rows in the audit log.
ALTER TABLE audit ADD COLUMN origin TEXT NOT NULL DEFAULT 'user';   -- 'user' | 'scheduled' | 'system'
ALTER TABLE audit ADD COLUMN task_name TEXT;                        -- NULL except origin='scheduled'
CREATE INDEX IF NOT EXISTS idx_audit_task ON audit(task_name);
```

The existing `audit.model = 'engine:tier:modelId'` format stays unchanged — `origin` is orthogonal. Cost cap queries (`sumChatCostSince`, `sumCostSince`) ignore `origin`, so scheduled spend rolls into the same per-chat hourly cap. Intentional — a runaway task and a runaway user are equally dangerous to the bill.

### Synthetic `Update` shape (per fire)

```ts
const update: Update = {
  update_id: nextSyntheticId(),               // negative range, scheduler-local counter
  message: {
    message_id: nextSyntheticId(),
    date: Math.floor(Date.now() / 1000),
    chat: { id: task.chat_id, type: "private", first_name: "scheduler" },
    from: { id: operatorFromId, is_bot: false, first_name: "scheduler" },
    text: schedulerWirePrefix(task.engine) + task.body,
  },
};
```

`schedulerWirePrefix` maps `engine` to the existing prefix grammar relative to `config.defaultEngine`:

| Task `engine` | Deploy default = `ollama` | Deploy default = `primary` | Deploy default = `secondary` |
|---|---|---|---|
| (omitted) | no prefix → ollama | no prefix → primary | no prefix → secondary |
| `ollama` | no prefix → ollama | rejected at parse | rejected at parse |
| `primary` | `@<body>` | no prefix | `@<body>` |
| `secondary` | `!<body>` | `!<body>` | no prefix |

Reuses the engine dispatch already in `makeRunTurn`; nothing new to maintain.

`origin: 'scheduled'`, `task_name`, and (if set) `max_cost_usd` are passed alongside the prompt as runner-side context (a small extension to `AuditInsert` and to the `PreToolUse` hook factory) so the audit row records them and the per-task cap is enforced. Avoids leaking scheduler concepts into the prefix grammar.

**Verified (open-question #4):** `audit.update_id` is a plain `INTEGER` column with no UNIQUE constraint, no JOINs, and no indexes referencing it (`db.ts:107` and `idx_audit_*` confirm). Setting it to `NULL` for scheduled fires is safe. The scheduler does NOT call `db.claimUpdate(update_id)` — `handled_updates.update_id` IS PRIMARY KEY (`db.ts:83`), so a synthetic id colliding with a future Telegram poll offset would silently dedupe a real user message. The web transport already follows this pattern (synthetic Updates flow through `queue.enqueue` directly, never touching `claimUpdate`) and the scheduler does the same.

## 6. Scheduler primitive

```ts
// src/scheduler.ts (sketch)

export interface ScheduleSpec {
  kind: "every" | "daily_at" | "at";
  ms?: number;                  // for "every"
  hourUtc?: number;             // for "daily_at"
  minuteUtc?: number;           // for "daily_at"
  atMs?: number;                // for "at"
}

export interface Task {
  name: string;
  description: string;
  body: string;
  chatId: number;
  engine: "primary" | "secondary" | "ollama";
  spec: ScheduleSpec;
  catchUp: boolean;
  enabled: boolean;
  sourcePath: string;
  sourceHash: string;
}

// Pure: given spec + last_run_at + now, returns the next-fire ms or null
// (one-off + already consumed).
export function nextRunAt(spec: ScheduleSpec, lastRunAt: number | null, now: number): number | null;

export function startScheduler(deps: SchedulerDeps): { stop: () => void };
```

The driver:

```ts
function tick() {
  const now = Date.now();
  for (const t of registry.all) {
    if (!t.enabled) continue;
    const state = db.getTaskState(t.name);
    if (state?.one_off_consumed) continue;
    const due = nextRunAt(t.spec, state?.last_run_at ?? null, now);
    if (due === null) continue;
    if (now < due) continue;
    void fireTask(t, now);   // synthesize Update → queue.enqueue
    db.markTaskFired(t.name, now, t.spec.kind === "at" ? 1 : 0);
  }
}
const timer = setInterval(tick, 60_000);
tick();   // boot fire (catch-up) — matches daily-report
return { stop: () => clearInterval(timer) };
```

Single shared 60s tick. Tasks finer than 1 minute are out of scope (and rejected by the 5-min minimum); we don't need millisecond precision.

### Catch-up rules

- `every <duration>`, `last_run_at` is `(now - duration)` or older → fire once. Don't fire N times for N missed intervals.
- `daily_at HH:MM`, today's anchor has passed AND `last_run_at < today's anchor` → fire once.
- `at <iso>`, `at_ms < now` AND `!one_off_consumed` AND `catch_up=true` → fire once, then mark consumed.
- `at <iso>`, `at_ms < now` AND `catch_up=false` → mark consumed without firing. (Operator wanted "9am Tuesday" and Solrac was down at 9am — don't fire at 4pm.)

`catch_up: true` is the default for periodic, `false` for one-off. Documented.

## 7. Wiring (main.ts)

Mirror the skills wiring already in `main.ts`. Pseudo-diff:

```diff
+ const taskRegistry = config.tasksEnabled
+   ? loadTasksSync(config.tasksDir, ...)
+   : EMPTY_TASK_REGISTRY;
+ logTaskLoadResult(config.tasksDir, taskRegistry);
  ...
  installShutdown({ tracker, db, pidPath, pollAbort, server, webServer, scheduler });
+ const scheduler = config.tasksEnabled && taskRegistry.size() > 0
+   ? startScheduler({
+       db, registry: taskRegistry, queue,
+       operatorFromId: config.allowlistBootstrap[0]!,
+       defaultEngine: config.defaultEngine,
+     })
+   : null;
```

Lifecycle stops the scheduler BEFORE `pollAbort.abort()` so no new fires land mid-shutdown. In-flight task turns drain through the existing tracker.

## 8. Auditability and operator visibility

Phase 1 (must ship):

- Every fire writes one `audit` row with `origin='scheduled'`, `task_name=<name>`. Existing cost cap, error_message, status columns all populate as for a user turn.
- `scheduled_tasks` table tracks `last_run_at`, `last_status`, `last_audit_id`, `one_off_consumed`. Operator queries it directly via sqlite3 if needed.

Phase 2 (follow-up):

- `/tasks` slash command — list loaded tasks with last/next fire and status. Reuse `commands.ts` dispatcher.
- `/tasks run <name>` — manual trigger (synthesizes a fire). Useful for debugging without waiting for the next anchor.

## 9. Safety analysis

| Risk | Mitigation |
|------|------------|
| Misconfigured `every: 1m` task → cost runaway | 5-min minimum at parse. Per-chat hourly cap is the eventual safety net. |
| Task fires while user is mid-conversation in the same chat | KeyedMutex serializes per-chat — task waits behind user message (correct behavior; documented). |
| Scheduled task uses tools that prompt for confirmation → no operator at the keyboard at 3am | Confirmation broker times out at 60s and fail-closes (already true for tier-3 tools). Task body should be written for tools that auto-allow OR tier-3 tools the operator pre-trusts. Document in `examples/tasks/README.md`. |
| Fires during shutdown drain | Scheduler stops first; `pollAbort` aborts after; tracker drains in-flight turns. Same shape as poll-loop shutdown. |
| Synthetic `update_id` collides with Telegram poll id space | Use a negative-int counter (web transport already does this). `handled_updates` is bypassed for scheduled fires (no dedupe needed — scheduler is the only source of these ids). |
| Operator deletes TASK.md mid-run | Scheduler is boot-loaded only. Edits/deletes take effect on next restart. Matches skills/integrations contract. |
| Loop detector trips on a task that hits the same tool repeatedly across many fires | Loop detector is per-turn, not per-task. Each fire starts fresh. Correct. |

## 10. Test surface

Co-located, `bun:test`, no mocking framework — same as the rest of Solrac.

- `scheduler.test.ts`:
  - Parser: every shape valid + invalid path produces a clear error.
  - `nextRunAt` for `every`, `daily_at`, `at` × {never run, just ran, missed window}.
  - `catch_up` true/false behavior on one-off.
  - 5-min minimum enforced.
- `db.test.ts` additions: round-trip on `scheduled_tasks` insert/update/get; idempotent ALTER.
- `commands.test.ts` (Phase 2): parse `/tasks` and `/tasks run <name>`.

Smoke test: a flood-style harness with two synthetic tasks (one `every 5s`, one `at <past>`) confirms (a) periodic fires advance, (b) one-off marks consumed, (c) drain on signal stops the loop. Add as `test/smokes/scheduler.ts`.

## 11. Phasing

### Phase 1 — minimum viable scheduler (1–2 days)

- [ ] `db.ts`: schema additions + idempotent ALTERs + new prepared statements (`getTaskState`, `markTaskFired`, `setTaskOneOffConsumed`).
- [ ] `config.ts`: `SOLRAC_TASKS_ENABLED` (default `false`), `SOLRAC_TASKS_DIR` (default `./tasks`).
- [ ] `scheduler.ts`: parser, registry, tick loop, synthetic-Update construction.
- [ ] `main.ts`: load registry, start scheduler, pass to lifecycle.
- [ ] `lifecycle.ts`: stop scheduler before `pollAbort.abort()`.
- [ ] `examples/tasks/`: README + a `morning-digest` sample.
- [ ] Tests: `scheduler.test.ts`, additions to `db.test.ts`.
- [ ] Docs: USAGE.md tutorial, CONFIG.md env vars, ARCHITECTURE.md scheduler section.

### Phase 2 — operator visibility (~half day)

- [ ] `/tasks` command (list, status).
- [ ] `/tasks run <name>` manual trigger.
- [ ] `commands.test.ts` additions.
- [ ] Update `BOT_COMMAND_REGISTRY` so Telegram autocomplete shows it.

### Phase 3 — deferred

- cron expressions (probably never; `every` + `daily_at` covers 90% of real cases).
- Timezones (operator can use `daily_at` in UTC and do the math).
- `notify: false` (audit-only). Requires a "no Telegram output" mode in the runners; not free.
- Hot-reload via FS watch — explicit anti-goal today; matches skills/integrations.

## 12. Documentation hits

- `docs/USAGE.md` — new "Scheduled tasks" section: TASK.md format, schedule grammar, examples.
- `docs/CONFIG.md` — `SOLRAC_TASKS_ENABLED`, `SOLRAC_TASKS_DIR`, 5-min minimum interval rule.
- `docs/ARCHITECTURE.md` — module map entry; scheduler section under "Lifecycle"; mention in "Concurrency model" that scheduled fires share the same queue.
- `docs/ROADMAP.md` — close OQ#12 once Phase 1 ships.
- `CLAUDE.md` (under `solrac-dev/`) — add a "Scheduled tasks" learning if the implementation surfaces a gotcha.

## 13. Resolved decisions

All five Phase-1 questions resolved (operator, 2026-05-10):

1. **Result delivery** → stream into the configured Telegram chat. Same UX as a user-typed turn; `notify: false` (audit-only) deferred to Phase 3.
2. **`engine: ollama` post-PR-B** → fail loud at parse when `defaultEngine !== "ollama"`. Validation is in §3 above.
3. **Per-task max cost cap** → `max_cost_usd` frontmatter field, optional. Wires through the existing `PreToolUse` hook as a fourth pre-flight check (after global, per-chat, loop). Aborts the turn when this fire's cumulative `cost_usd` exceeds the cap. Silently ignored when `engine: ollama` (no cost to cap on this deploy's default path). Tested in `scheduler.test.ts` + a dedicated row in `policy.test.ts`.
4. **`audit.update_id` collision** → verified safe: no UNIQUE, no JOIN, no index. Scheduled fires write `NULL` `update_id` and bypass `handled_updates`. See §5.
5. **Boot-catch-up jitter** → `boot_catch_up_jitter_s` frontmatter field (per-task, default `0`). Scheduler defers the catch-up fire by `random(0, jitter_s)` ms. Tasks the operator wants to fire deterministically leave it at `0`; daily digests that all anchor at 09:00 set it to e.g. `300` so they spread across 5 minutes.

## 14. Open follow-ups

None blocking Phase 1. Tracked for later:

- Phase 3 candidates listed in §11 (cron, timezones, `notify: false`, hot-reload).
- Operator UX: should `/tasks` show the next-fire time in the operator's local timezone or UTC? Defer until the command lands.
