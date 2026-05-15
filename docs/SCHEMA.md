# SQLite schema and query cookbook

Solrac persists everything in a single SQLite file at `${DATA_DIR}/solrac.sqlite` (default `./data/solrac.sqlite`). This doc covers the schema, the indexes, and a task-oriented query cookbook for debugging, forensics, and inspection.

For schema rationale (why each table exists, sub-agent column reservations) see [ARCHITECTURE.md#sqlite-schema](./ARCHITECTURE.md#sqlite-schema). For cost-focused operator queries see [OPERATIONS.md#audit-queries](./OPERATIONS.md#audit-queries). This doc complements both — fewer "what are the columns" questions, more "find me the chats that mixed engines mid-conversation" questions.

## Connecting

Solrac uses [`bun:sqlite`](https://bun.sh/docs/api/sqlite) in-process; there is no separate database server. To inspect or query while the service is running, point the `sqlite3` CLI (or any SQLite client) at the same file:

```sh
sqlite3 data/solrac.sqlite
```

WAL mode means readers don't block the running process and vice-versa. Treat the running Solrac as a single writer; CLI tools should stay read-only unless the service is stopped (otherwise contention can show up as `database is locked` errors after the 5-second `busy_timeout`).

Pragmas Solrac sets at boot:

| Pragma | Value | Why |
|---|---|---|
| `journal_mode` | `WAL` | concurrent readers + single writer; persists across restarts |
| `busy_timeout` | `5000` | tolerate brief lock contention from CLI tools |
| `foreign_keys` | `ON` | keeps `audit.parent_turn_id` honest for the future sub-agent enable |

## Tables at a glance

| Table | Row shape | Lifecycle |
|---|---|---|
| `meta` | key→value | poll cursor + daily-report idempotency markers |
| `allowlist` | one row per allowed `from.id` | seeded from `ALLOWLIST_BOOTSTRAP` on every boot |
| `handled_updates` | one row per Telegram `update_id` we've claimed | grows monotonically; never deleted in v1 |
| `sessions` | one row per chat | per-tier SDK session ids + pending `/compact` summaries |
| `audit` | one row per attempted turn (allowed, denied, queue-full, tool-call sub-row) | append-mostly; the source of truth |
| `scheduled_tasks` | one row per loaded `TASK.md` | upserted at boot; `last_run_at` / `one_off_consumed` updated by the tick loop |

Authoritative source for shapes + migrations: `src/db.ts` (look at the `SCHEMA` constant and the post-`SCHEMA` `ALTER TABLE` block).

## Schema reference

### `meta`

```sql
meta(key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)
```

Keys currently in use:

| Key | Written by | Read by |
|---|---|---|
| `poll_offset` | `poll.ts` after each batch claim | `poll.ts` next `getUpdates` call |
| `cost_report_last_date` | `daily-report.ts` after a successful DM | `daily-report.ts` boot check (idempotency) |

`updated_at` is `Date.now()` (ms epoch). The schema only gains keys here; it never removes them.

### `allowlist`

```sql
allowlist(user_id INTEGER PRIMARY KEY, added_at INTEGER)
```

Seeded from `ALLOWLIST_BOOTSTRAP` on **every** boot. Manual additions via direct SQL persist across restarts as long as the env var keeps including them. Removing a user means removing from BOTH the env and the table.

### `handled_updates`

```sql
handled_updates(update_id INTEGER PRIMARY KEY, handled_at INTEGER)
```

Per-`update_id` idempotency surface. `INSERT OR IGNORE` returns "claimed" / "already-claimed" — the dedupe primitive in `poll.ts`. Never pruned in v1; even at thousands of updates a day, the table stays small.

### `sessions`

```sql
sessions(
  chat_id              INTEGER PRIMARY KEY,
  agent_session_id     TEXT,    -- DEPRECATED pre-tier column; kept for rollback compat
  primary_session_id   TEXT,    -- SDK session id for the primary tier (Sonnet, `@`)
  secondary_session_id TEXT,    -- SDK session id for the secondary tier (Opus, `!`)
  primary_summary      TEXT,    -- pending /compact summary for primary tier
  primary_summary_at   INTEGER, -- ms cutoff for the next /compact source-window
  secondary_summary    TEXT,
  secondary_summary_at INTEGER,
  created_at           INTEGER,
  updated_at           INTEGER
)
```

Anthropic SDK sessions are model-bound: each tier needs its own id. New writes only touch the per-tier columns. Ollama is stateless, so it has no row in `sessions`.

`<tier>_summary` is set by `/compact` and consumed once on the next user turn for that tier; cleared on success, left intact on error. `<tier>_summary_at` is the cutoff passed to `recentChatTurnsForEngine` so back-to-back `/compact` doesn't re-summarize the same window.

### `audit`

```sql
audit(
  id                              INTEGER PRIMARY KEY AUTOINCREMENT,
  tree_id                         INTEGER NOT NULL,        -- v1: always = own id
  parent_turn_id                  INTEGER REFERENCES audit(id),  -- v1: always NULL
  chat_id                         INTEGER NOT NULL,
  from_id                         INTEGER NOT NULL,
  update_id                       INTEGER,                 -- nullable: scheduled fires + tool_call sub-rows synthesize ids
  agent_session_id                TEXT,                    -- SDK session id (Claude only)
  prompt                          TEXT,                    -- truncated to 256 chars on insert
  response                        TEXT,
  tool_calls                      TEXT,                    -- JSON: [{name, input}, ...]
  input_tokens                    INTEGER,                 -- post-cache fresh input
  output_tokens                   INTEGER,
  cache_creation_input_tokens     INTEGER,                 -- tokens written to cache
  cache_read_input_tokens         INTEGER,                 -- tokens read from cache
  cost_usd                        REAL,
  status                          TEXT NOT NULL DEFAULT 'in_progress',
  error_message                   TEXT,
  started_at                      INTEGER NOT NULL,
  ended_at                        INTEGER,
  model                           TEXT NOT NULL DEFAULT 'claude',
  origin                          TEXT NOT NULL DEFAULT 'user',   -- user | scheduled | tool_call | system
  task_name                       TEXT                            -- non-null when origin='scheduled'
)
```

Two-write lifecycle per turn:

1. **Insert** with `status='in_progress'`, `started_at=Date.now()`, `prompt` (truncated), `model`. Returns the row id; same statement immediately runs `UPDATE audit SET tree_id = id WHERE id = ?` so `tree_id = own id`.
2. **Update** at turn end with `response`, `tool_calls`, all four token fields, `cost_usd`, `agent_session_id` (Claude only), `status` ∈ `'ok' | 'error' | 'denied'`, `error_message`, `ended_at`.

Rows that reach the end-of-turn update are the ones that ran an SDK or Ollama call. Rows that were rejected before the turn started (allowlist deny, queue-full, `claimUpdate` collision, etc.) skip the second write — they stay at `status='in_progress'` if the rejection path forgot to mark them, or at `status='denied'` if the rejection path explicitly ended the row.

#### `status` values

| Value | Meaning |
|---|---|
| `in_progress` | Insert succeeded; turn is currently running, OR (rare) the process died mid-turn before the update could land. |
| `ok` | Turn completed cleanly. `cost_usd` and token counts are populated for Claude tiers; null for Ollama. |
| `error` | Turn ran but threw or surfaced an SDK error. `error_message` carries the reason. |
| `denied` | Pre-flight rejection (allowlist, queue full, throttle). `cost_usd` and tokens are null. |

#### `model` format (engine identity)

Three-segment shape so tier/backend identity stays stable across model-id bumps. Skill invocations append a fourth segment so operator-typed `/<skill>` and agent-driven tool calls are greppable per skill name.

| Format | Engine / source | Example |
|---|---|---|
| `claude:primary:<modelId>` | Claude primary tier (`@` prefix) | `claude:primary:claude-sonnet-4-6` |
| `claude:secondary:<modelId>` | Claude secondary tier (`!` prefix) | `claude:secondary:claude-opus-4-7` |
| `local:<backend>:<modelId>` | local engine (default engine); `<backend>` ∈ `ollama` / `lmstudio` | `local:ollama:gemma4:e4b`, `local:lmstudio:qwen2.5-7b` |
| `claude:<tier>:<modelId>:skill:<name>` | Claude-tier skill invocation | `claude:primary:claude-sonnet-4-6:skill:tldr` |
| `local:<backend>:<modelId>:skill:<name>` | local-tier skill invocation (slash or tool call) | `local:ollama:gemma4:e4b:skill:tldr` |
| `system` | rejection rows that didn't run an engine | `system` |
| `claude` | legacy pre-tier rows (retagged to `claude:secondary:claude-opus-4-7` on first boot) | rare; should be zero post-migration |
| `ollama:<modelId>` | **legacy** pre-rename rows; retagged in place to `local:ollama:<modelId>` on first boot under the `local-engine` migration. Read queries match this pattern for one release cycle. | rare; should be zero post-migration |

Cross-engine queries use SQL `LIKE` on the prefix: `model LIKE 'claude:primary:%'` survives a future `claude-sonnet-4-6 → 4-8` upgrade; `model LIKE 'local:%'` survives a backend swap. Per-skill activity: `model LIKE '%:skill:tldr'`.

> **Dual-pattern reads.** `outOfBandForEngine` and `hasLocalTurnsSince` match BOTH `local:%` and legacy `ollama:%` for one release to keep partial-migration deployments correct. Operator queries against `audit` should prefer `local:%`; legacy `ollama:%` rows will not reappear because the boot migration retags them in place.

#### `origin` values

Distinguishes user-typed turns from scheduler fires and tool-driven sub-calls. All four values share the audit table — the audit log is the single source of truth across surfaces.

| Value | Meaning |
|---|---|
| `user` | Operator typed a message (or a slash command) into Telegram or the web UI. The default. |
| `scheduled` | The scheduler fired a `TASK.md` per its schedule. `task_name` is the matching task name. `update_id` is null. |
| `tool_call` | The Ollama agent called a `tool: true` skill mid-tool-loop via `skills__<name>`. The parent turn's row stays `origin='user'`; this is a sub-row tracking the skill execution. `update_id` carries the parent turn's id. |
| `system` | Pre-flight rejection (queue-full, denied, etc.) or other internal write that didn't dispatch a turn. |

Quick filter: `WHERE origin IN ('scheduled','tool_call')` → just the agent / scheduler activity, no human typing.

#### `tool_calls` shape

JSON array of `{name, input}` objects, e.g.:

```json
[
  {"name": "Read", "input": {"file_path": "/etc/hosts"}},
  {"name": "Bash", "input": {"command": "ls -la"}}
]
```

`json_extract` and `json_each` make this query-friendly — see the cookbook below.

#### Token columns

The Anthropic API returns four token counts per turn. The actual on-the-wire input is `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` — without all three, the audit log dramatically under-reports the input size on resumed sessions (most of the input lives in `cache_read_input_tokens`).

| Column | Anthropic field | What it costs |
|---|---|---|
| `input_tokens` | `input_tokens` | full price (the fresh, post-cache portion) |
| `cache_creation_input_tokens` | `cache_creation_input_tokens` | premium (1.25× input rate); writes to the prompt cache |
| `cache_read_input_tokens` | `cache_read_input_tokens` | discount (0.1× input rate); reads from the cache |
| `output_tokens` | `output_tokens` | full output rate |

Ollama and `system` rows have all four set to NULL.

### `scheduled_tasks`

```sql
scheduled_tasks(
  name              TEXT PRIMARY KEY,    -- matches TASK.md frontmatter `name:`
  last_run_at       INTEGER,             -- ms epoch; null until first fire
  last_audit_id     INTEGER,             -- audit.id of most recent fire (operator breadcrumb)
  last_status       TEXT,                -- 'ok' | 'error' | 'denied' from the last run
  one_off_consumed  INTEGER NOT NULL DEFAULT 0,   -- 1 once an `at <ISO>` task has fired
  source_path       TEXT NOT NULL,       -- absolute path to the TASK.md file
  source_hash       TEXT NOT NULL,       -- content hash; future use (operator-detect drift)
  updated_at        INTEGER NOT NULL
)
```

One row per task loaded at boot. The loader upserts `source_path / source_hash / updated_at`; the tick loop updates `last_*` on each fire (and flips `one_off_consumed = 1` for `at <ISO>` tasks). When a `TASK.md` is removed from disk, the row stays — operators query `scheduled_tasks LEFT JOIN` the registry at runtime. `/tasks` slash command joins this table with the in-memory registry to render last/next fire info.

## Indexes

| Index | Columns | Used by |
|---|---|---|
| `idx_audit_tree` | `(tree_id)` | reserved for sub-agent fan-out queries (v1: unused, every row's tree_id = own id) |
| `idx_audit_chat_started` | `(chat_id, started_at)` | the cost-cap query path (`db.sumChatCostSince`) — fires before every Claude tool call |
| `idx_audit_chat_model_started` | `(chat_id, model, started_at)` | engine-scoped queries: `outOfBandForEngine`, `recentChatTurnsForEngine`, `lastSuccessfulTurnAt`, `countChatTurnsForEngine`, etc. |
| `idx_audit_task_started` | `(task_name, started_at)` | scheduler queries: per-task cost windows (`max_cost_usd` pre-flight) and operator audit dumps |

The first two are declared in the `SCHEMA` constant; the others are created after the migration block so they can reference columns added incrementally on existing databases.

To check what indexes the query planner actually picks for a query:

```sql
EXPLAIN QUERY PLAN
SELECT SUM(cost_usd) FROM audit WHERE chat_id = 1 AND started_at >= 0;
```

Look for `USING INDEX idx_audit_chat_started` in the output.

## Query cookbook

Time helpers. Solrac stores all timestamps as `Date.now()` ms-since-epoch. Common conversions:

```sql
-- ms to a human string
datetime(started_at/1000, 'unixepoch')

-- "now" as ms
strftime('%s','now') * 1000

-- "1 hour ago" as ms
(strftime('%s','now') - 3600) * 1000

-- start of today UTC, as ms
strftime('%s','now','start of day') * 1000
```

OPERATIONS.md covers cost forensics (today's spend per chat, engine breakdown, expensive turns, denial-rate ranking, tool-use frequency). The queries below are non-overlapping — debugging, inspection, sanity checks.

### Health & sanity

**Is the database alive and what's in it?**

```sql
SELECT 'meta' AS t, COUNT(*) AS n FROM meta
UNION ALL SELECT 'allowlist',       COUNT(*) FROM allowlist
UNION ALL SELECT 'handled_updates', COUNT(*) FROM handled_updates
UNION ALL SELECT 'sessions',        COUNT(*) FROM sessions
UNION ALL SELECT 'audit',           COUNT(*) FROM audit;
```

**Time since the last successful turn (any chat, any engine).**

```sql
SELECT
  ROUND((strftime('%s','now') - MAX(started_at)/1000) / 60.0, 1) AS minutes_since_last_ok
FROM audit WHERE status = 'ok';
```

A bot that's been deployed but answers nothing for an hour will show a large value here.

**Stuck `in_progress` rows.** While Solrac is running, only currently-active turns should be `in_progress`. Anything stuck for more than a few minutes points to a turn that crashed mid-flight (process died, SDK threw before the second write).

```sql
SELECT id, chat_id, datetime(started_at/1000, 'unixepoch') AS started, model
FROM audit
WHERE status = 'in_progress'
  AND started_at < (strftime('%s','now') - 300) * 1000
ORDER BY started_at;
```

If this returns rows after Solrac has been up >5 minutes, investigate logs near each `started_at` for the failure.

**Database file footprint.**

```sql
SELECT page_count * page_size / 1024.0 / 1024.0 AS mb
FROM pragma_page_count(), pragma_page_size();
```

Plus the WAL on disk: `ls -lh data/solrac.sqlite-wal`. A WAL >50 MB after a clean shutdown means the checkpoint failed (see RUNBOOK).

### Pollution defense

**Top floods by `from.id` over the last hour.**

```sql
SELECT from_id, COUNT(*) AS attempts,
       SUM(CASE WHEN status = 'denied' THEN 1 ELSE 0 END) AS denied,
       SUM(CASE WHEN status = 'ok'     THEN 1 ELSE 0 END) AS ran
FROM audit
WHERE started_at >= (strftime('%s','now') - 3600) * 1000
GROUP BY from_id
ORDER BY attempts DESC
LIMIT 10;
```

A non-allowlisted `from.id` racking up `denied` rows is the throttle working. Sustained `denied` from the same id at 1/minute is the denial-throttle ceiling — if it's higher, the throttle is misconfigured.

**Queue-full rejections.**

```sql
SELECT chat_id, COUNT(*) AS dropped, MAX(started_at) AS latest_ms
FROM audit
WHERE status = 'denied' AND error_message LIKE '%queue_full%'
GROUP BY chat_id
ORDER BY dropped DESC;
```

If a chat shows up here, the user pasted faster than `MAX_CHAT_QUEUE_DEPTH=10` could drain. Tell them to break long inputs into shorter messages.

**Allowlist deny pattern.**

```sql
SELECT from_id, COUNT(*) AS denials,
       MIN(datetime(started_at/1000,'unixepoch')) AS first_seen,
       MAX(datetime(started_at/1000,'unixepoch')) AS last_seen
FROM audit
WHERE status = 'denied' AND error_message LIKE '%not allowed%'
GROUP BY from_id
ORDER BY denials DESC;
```

Useful for spotting stranger probes vs. genuine "I added myself wrong" mistakes.

### Session inspection

**Per-chat session state (which tiers are warm).**

```sql
SELECT chat_id,
       primary_session_id   IS NOT NULL AS has_primary,
       secondary_session_id IS NOT NULL AS has_secondary,
       primary_summary      IS NOT NULL AS pending_compact_primary,
       secondary_summary    IS NOT NULL AS pending_compact_secondary,
       datetime(updated_at/1000,'unixepoch') AS last_used
FROM sessions
ORDER BY updated_at DESC;
```

`has_primary=1, has_secondary=0` is the common shape for a chat that mostly uses `@`. A chat with both columns null but a row in the table is a chat that ran `/clear all` recently.

**Pending `/compact` summaries that haven't been consumed yet.**

```sql
SELECT chat_id,
       LENGTH(primary_summary)   AS primary_len,
       LENGTH(secondary_summary) AS secondary_len,
       datetime(primary_summary_at/1000,  'unixepoch') AS primary_at,
       datetime(secondary_summary_at/1000,'unixepoch') AS secondary_at
FROM sessions
WHERE primary_summary IS NOT NULL OR secondary_summary IS NOT NULL;
```

A summary that's been pending for days means the user `/compact`'d but hasn't sent a follow-up turn for that tier.

**Sessions never used after creation (created_at == updated_at).**

```sql
SELECT chat_id, datetime(created_at/1000,'unixepoch') AS created
FROM sessions WHERE created_at = updated_at;
```

**Stale sessions (no turns in 30 days).**

```sql
SELECT chat_id, datetime(updated_at/1000,'unixepoch') AS last_used
FROM sessions
WHERE updated_at < (strftime('%s','now') - 30*86400) * 1000;
```

### Forensics: trace one turn end-to-end

**Everything for a Telegram `update_id`.**

```sql
SELECT id, chat_id, from_id, status, model,
       datetime(started_at/1000,'unixepoch') AS started,
       datetime(ended_at/1000,  'unixepoch') AS ended,
       cost_usd, error_message,
       SUBSTR(prompt,   1, 80) AS prompt_head,
       SUBSTR(response, 1, 80) AS response_head
FROM audit WHERE update_id = <update_id>;
```

**Tool calls for a single turn.**

```sql
SELECT json_extract(value, '$.name')  AS tool_name,
       json_extract(value, '$.input') AS input
FROM audit, json_each(audit.tool_calls)
WHERE audit.id = <audit_id>;
```

**Last 5 turns for a chat with full prompt/response (use sparingly — `prompt` is truncated to 256 chars on insert; `response` can be large).**

```sql
SELECT id, model, status,
       datetime(started_at/1000,'unixepoch') AS started,
       cost_usd, prompt, response
FROM audit
WHERE chat_id = <chat_id> AND status = 'ok'
ORDER BY started_at DESC LIMIT 5;
```

### Performance: latency, cache, throughput

**Slowest turns (wall-clock).**

```sql
SELECT id, chat_id, model,
       (ended_at - started_at) AS ms,
       input_tokens, output_tokens, cost_usd,
       SUBSTR(prompt, 1, 60) AS prompt_head
FROM audit
WHERE status = 'ok' AND ended_at IS NOT NULL
ORDER BY (ended_at - started_at) DESC
LIMIT 10;
```

Useful for spotting `Bash` calls that timed out, or huge multi-tool agent loops.

**Cache effectiveness per Claude tier (last 7 days).**

```sql
SELECT
  model,
  COUNT(*) AS turns,
  SUM(input_tokens)                 AS fresh_in,
  SUM(cache_creation_input_tokens)  AS cache_writes,
  SUM(cache_read_input_tokens)      AS cache_reads,
  SUM(output_tokens)                AS out_toks,
  ROUND(
    1.0 * SUM(cache_read_input_tokens) /
    NULLIF(SUM(input_tokens) + SUM(cache_read_input_tokens) + SUM(cache_creation_input_tokens), 0),
    3) AS cache_read_share
FROM audit
WHERE status = 'ok'
  AND model LIKE 'claude:%'
  AND started_at >= (strftime('%s','now') - 7*86400) * 1000
GROUP BY model
ORDER BY turns DESC;
```

A `cache_read_share` near 0.7+ on long-running chats means the SDK's prompt cache is doing its job. Below 0.3 with many turns hints that sessions are getting reset (frequent `/clear`, errored sessions dropping their id, or schema-bouncing on a model id change).

**Hourly request rate (last 24h).**

```sql
SELECT strftime('%Y-%m-%d %H:00', started_at/1000, 'unixepoch') AS hour,
       COUNT(*) AS turns,
       SUM(CASE WHEN status='ok'     THEN 1 ELSE 0 END) AS ok,
       SUM(CASE WHEN status='error'  THEN 1 ELSE 0 END) AS err,
       SUM(CASE WHEN status='denied' THEN 1 ELSE 0 END) AS deny,
       ROUND(SUM(cost_usd), 4) AS spent
FROM audit
WHERE started_at >= (strftime('%s','now') - 86400) * 1000
GROUP BY hour
ORDER BY hour;
```

**Cost-cap firing rate over time.**

```sql
SELECT strftime('%Y-%m-%d', started_at/1000, 'unixepoch') AS day,
       COUNT(*) AS cap_hits
FROM audit
WHERE error_message LIKE 'policy_deny: cost cap%'
GROUP BY day
ORDER BY day DESC LIMIT 30;
```

Frequent hits suggest either too-low cap, too-chatty workflows, or a runaway agent pattern that needs investigation.

### Cross-engine analysis

**Chats that mixed engines in the last 7 days.**

```sql
SELECT chat_id,
       COUNT(DISTINCT model) AS engines_used,
       GROUP_CONCAT(DISTINCT model) AS engines,
       COUNT(*) AS turns
FROM audit
WHERE status = 'ok'
  AND started_at >= (strftime('%s','now') - 7*86400) * 1000
GROUP BY chat_id
HAVING engines_used > 1
ORDER BY turns DESC;
```

These are the chats exercising the cross-engine context bridge most. Useful for sanity-checking the OOB injection logic — pick one and look at the order of `model` values across its recent turns.

**Engine-handoff sequences for a chat (which engine ran each turn).**

```sql
SELECT id, datetime(started_at/1000,'unixepoch') AS started, model, cost_usd,
       SUBSTR(prompt, 1, 50) AS prompt_head
FROM audit
WHERE chat_id = <chat_id> AND status = 'ok'
ORDER BY started_at DESC LIMIT 30;
```

**Local-engine tools-on adoption.** When `LOCAL_TOOLS_ENABLED=true`, the local engine writes `tool_calls` to audit. Count how often:

```sql
SELECT
  COUNT(*)                                                     AS local_turns,
  SUM(CASE WHEN tool_calls IS NOT NULL THEN 1 ELSE 0 END)      AS turns_with_tools,
  ROUND(
    AVG(CASE WHEN tool_calls IS NOT NULL THEN json_array_length(tool_calls) END),
    2) AS avg_tools_per_tool_turn
FROM audit
WHERE (model LIKE 'local:%' OR model LIKE 'ollama:%')          -- dual-pattern: legacy rows for one release
  AND status = 'ok'
  AND started_at >= (strftime('%s','now') - 7*86400) * 1000;
```

### Tool inspection

**Tool-call distribution per Claude tier (last 7 days).**

```sql
WITH tools AS (
  SELECT a.model AS engine, json_extract(j.value, '$.name') AS tool_name
  FROM audit a, json_each(a.tool_calls) j
  WHERE a.tool_calls IS NOT NULL
    AND a.started_at >= (strftime('%s','now') - 7*86400) * 1000
)
SELECT engine, tool_name, COUNT(*) AS n
FROM tools
GROUP BY engine, tool_name
ORDER BY engine, n DESC;
```

**Most common Bash commands the agent ran.** `tool_calls[*].input.command` is the field; `json_extract` parses the JSON column.

```sql
WITH bash AS (
  SELECT json_extract(j.value, '$.input.command') AS cmd
  FROM audit a, json_each(a.tool_calls) j
  WHERE a.tool_calls IS NOT NULL
    AND json_extract(j.value, '$.name') = 'Bash'
)
SELECT
  -- first token only — collapse `git log -10` and `git log` to "git log..."
  SUBSTR(cmd, 1, INSTR(cmd || ' ', ' ') - 1) AS first_token,
  COUNT(*) AS n
FROM bash
GROUP BY first_token
ORDER BY n DESC LIMIT 20;
```

**Tool calls per turn distribution (where do the long agent loops live?).**

```sql
SELECT model,
       COUNT(*) AS turns,
       AVG(json_array_length(tool_calls)) AS avg_tools,
       MAX(json_array_length(tool_calls)) AS max_tools
FROM audit
WHERE status = 'ok' AND tool_calls IS NOT NULL
GROUP BY model
ORDER BY avg_tools DESC;
```

A `max_tools` close to whatever loop or iteration cap is in play hints at agent thrash.

### Allowlist

**Who can talk to the bot, and when were they added.**

```sql
SELECT user_id, datetime(added_at/1000,'unixepoch') AS added
FROM allowlist ORDER BY added_at;
```

**Allowed users with no successful turns yet.** Either freshly-added or never-engaged.

```sql
SELECT a.user_id, datetime(a.added_at/1000,'unixepoch') AS added
FROM allowlist a
LEFT JOIN audit r
  ON r.from_id = a.user_id AND r.status = 'ok'
WHERE r.id IS NULL;
```

### Migration sanity (run after a schema bump)

**Legacy `claude` tag should be zero post-boot.** If non-zero, the retag migration didn't run.

```sql
SELECT COUNT(*) FROM audit WHERE model = 'claude';
```

**Pre-tier sessions: rows still using the deprecated single-session column.**

```sql
SELECT chat_id
FROM sessions
WHERE agent_session_id   IS NOT NULL
  AND primary_session_id IS NULL
  AND secondary_session_id IS NULL;
```

A chat in this state will work — `agent.ts` handles the legacy column on read — but a `/clear` followed by a fresh turn migrates it to per-tier columns.

**`audit` columns that should exist after the cache-token migration.**

```sql
SELECT name FROM pragma_table_info('audit')
WHERE name IN ('cache_creation_input_tokens', 'cache_read_input_tokens');
```

Should return both rows. Missing rows mean an upgraded database that hasn't been booted yet on a current Solrac.

## Maintenance

**Integrity check.** Walks the b-tree, verifies internal consistency. Returns `ok` or a list of corruptions.

```sql
PRAGMA integrity_check;
```

**Force-checkpoint the WAL** (useful before a backup, or to shrink a fat WAL after a flood). Solrac calls this automatically on graceful shutdown.

```sql
PRAGMA wal_checkpoint(TRUNCATE);
```

**Reclaim space after deletes** (rare in v1 — Solrac doesn't delete anything by default).

```sql
VACUUM;
```

`VACUUM` rewrites the entire DB; do it offline if the file is large. With WAL on, `VACUUM` issues a checkpoint as part of the rewrite.

**Inspect actual schema and indexes.**

```sh
sqlite3 data/solrac.sqlite '.schema audit'
sqlite3 data/solrac.sqlite '.indexes audit'
```

**Compare actual columns against `db.ts`.** The migration block is idempotent but not perfectly self-documenting; dumping `pragma_table_info` is the truth source.

```sql
SELECT name, type, "notnull" AS not_null, dflt_value AS default_value
FROM pragma_table_info('audit')
ORDER BY cid;
```

## Things you can't answer from sqlite alone

The `audit` log is the source of truth for "what did the bot do?" but it's not a full trace. These signals live elsewhere:

| Question | Where |
|---|---|
| Why did a tool call need confirmation? | `log.policy.confirm_request` JSON events |
| Did the user tap allow or deny on a tier-3 prompt? | `log.policy.confirm_resolved` events |
| What did the agent read or write inside its workspace? | `data/workspaces/<chatId>/` |
| Why did the SDK throw mid-stream? | `log.agent.error` (full stack) |
| What was the operator's `SOLRAC.md` overlay at the time? | not persisted; re-read each turn |
| Telegram-side delivery failures | `log.telegram.*` events |

`journalctl -u solrac.service -o cat | jq 'select(.update_id == <id>)'` is the standard way to fish a turn's full event stream out of structured logs.

## Related docs

- [ARCHITECTURE.md#sqlite-schema](./ARCHITECTURE.md#sqlite-schema) — schema rationale and design decisions
- [OPERATIONS.md#audit-queries](./OPERATIONS.md#audit-queries) — cost-focused operator queries
- [OPERATIONS.md#backup-and-restore](./OPERATIONS.md#backup-and-restore) — backup procedure
- [RUNBOOK.md#db-corruption](./RUNBOOK.md#db-corruption) — recovery from `database disk image is malformed`
- `src/db.ts` — schema source of truth, prepared statements, migrations
