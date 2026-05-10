/**
 * @fileoverview SQLite (bun:sqlite) connection, schema, and prepared statements.
 * @purpose Single home for the on-disk store. Opens the database in WAL mode,
 *          applies the schema if absent, and returns a typed `SolracDb` with
 *          prepared statements for every query Solrac issues at runtime.
 *
 * Why bun:sqlite: in-process, zero-deps, transactional, fast enough for our
 * load (audit writes top out at <100/s under sustained flood). WAL mode allows
 * concurrent readers while a single writer holds the log. `busy_timeout` of
 * 5000ms guards against rare lock contention from CLI tools (sqlite3 shells)
 * touching the file while Solrac is running. `foreign_keys = ON` keeps
 * `audit.parent_turn_id` honest for the future sub-agent enable.
 *
 * The schema covers five tables:
 *   - `meta`             — key-value store (poll_offset, cost_report_last_date)
 *   - `allowlist`        — per-from.id permission list
 *   - `handled_updates`  — INSERT OR IGNORE idempotency surface for poll loop
 *   - `sessions`         — per-chat SDK session id, for `Options.resume`
 *   - `audit`            — append-mostly log of every attempted turn
 *
 * `audit` carries `tree_id` and `parent_turn_id` columns even though sub-agents
 * are disabled in v1 (see docs/ARCHITECTURE.md#sqlite-schema). The columns
 * exist now so a future enable PR doesn't require migration. v1 always sets
 * `tree_id = own row id, parent_turn_id = NULL`.
 *
 * Position in the dependency graph:
 *   log → db → consumed by allowlist, session, policy, agent, poll, lifecycle,
 *              daily-report, main, server (via stats snapshot)
 *
 * Exports:
 *   - `openDb(dataDir)` — async factory; mkdir's the dir, opens/migrates the
 *     db, returns a `SolracDb`.
 *   - `SolracDb` — interface with `raw` (escape hatch), `getMeta`, `setMeta`,
 *     `claimUpdate`, `insertAudit`, `updateAuditEnd`, `sumChatCostSince`,
 *     `sumCostSince`, `sumCostsByChatBetween`, `close`.
 *   - `AuditInsert`, `AuditEnd`, `ChatCostRow` — row shapes.
 *
 * Key invariants:
 *   - WAL mode is set BEFORE the schema is applied; `journal_mode = WAL`
 *     persists across restarts so this is idempotent.
 *   - `claimUpdate` uses `INSERT OR IGNORE` and returns `true` only when the
 *     row was actually inserted. The poll loop uses this for dedupe.
 *   - `insertAudit` returns the row id AND immediately writes `tree_id = id`
 *     in a separate UPDATE. Two-statement sequence; if you collapse it, you
 *     break the v1 sub-agent contract.
 *   - `idx_audit_chat_started` is the index used by `sumChatCostSince` (the
 *     cost-cap query). Keep it; cost-cap fires before every tool call.
 *
 * Gotchas:
 *   - `raw` is exposed for the lifecycle module to issue
 *     `PRAGMA wal_checkpoint(TRUNCATE)` and for tests to bypass the prepared
 *     statements. Don't use it in app code; prepared statements are typed and
 *     amortize plan caching.
 *   - `sumCostsByChatBetween` filters `cost_usd IS NOT NULL` so denied/error
 *     rows (which have null `cost_usd`) don't show up in the daily report.
 *   - `close()` is the public seam for lifecycle. After `close`, `raw` throws
 *     on every operation — that's how lifecycle tests verify closure.
 *
 * Cross-references:
 *   - docs/ARCHITECTURE.md#sqlite-schema — schema rationale + column purposes
 *   - docs/OPERATIONS.md#audit-queries — operator-facing canned queries
 *   - lifecycle.ts — WAL checkpoint and close on graceful shutdown
 */

import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { log } from "./log.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS allowlist (
  user_id INTEGER PRIMARY KEY,
  added_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS handled_updates (
  update_id INTEGER PRIMARY KEY,
  handled_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  chat_id INTEGER PRIMARY KEY,
  -- DEPRECATED (PLAN Step 12): pre-tier-routing session id, kept for rollback
  -- compatibility. Step 12 splits this into primary_session_id +
  -- secondary_session_id (added via ALTER below for upgraded databases). New
  -- writes only touch the per-tier columns; this column may be non-null on
  -- pre-Step-12 rows but is otherwise unused.
  agent_session_id TEXT,
  primary_session_id TEXT,
  secondary_session_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tree_id INTEGER NOT NULL,
  parent_turn_id INTEGER,
  chat_id INTEGER NOT NULL,
  from_id INTEGER NOT NULL,
  update_id INTEGER,
  agent_session_id TEXT,
  prompt TEXT,
  response TEXT,
  tool_calls TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,
  status TEXT NOT NULL DEFAULT 'in_progress',
  error_message TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  model TEXT NOT NULL DEFAULT 'claude',
  FOREIGN KEY (parent_turn_id) REFERENCES audit(id)
);

CREATE INDEX IF NOT EXISTS idx_audit_tree ON audit(tree_id);
CREATE INDEX IF NOT EXISTS idx_audit_chat_started ON audit(chat_id, started_at);

-- Scheduler: per-task persistent state. One row per task name; loader upserts
-- source_path/source_hash on boot. Tick loop reads last_run_at and one_off_consumed
-- to decide whether a fire is due. last_audit_id + last_status are operator-facing
-- breadcrumbs surfaced by /tasks.
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  name TEXT PRIMARY KEY,
  last_run_at INTEGER,
  last_audit_id INTEGER,
  last_status TEXT,
  one_off_consumed INTEGER NOT NULL DEFAULT 0,
  source_path TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

export interface AuditInsert {
  chatId: number;
  fromId: number;
  // Nullable: scheduled fires synthesize negative ids that never reach
  // handled_updates; passing null avoids any chance of poll-offset collision.
  updateId: number | null;
  prompt: string;
  startedAt: number;
  // Identifies which engine handled the turn. Used by cross-engine queries
  // (recentChatTurns / outOfBandForEngine) to compute the current engine's
  // cutoff and exclude its own rows. Format (PLAN Step 12):
  //   - 'claude:primary:<modelId>'   — Claude primary tier (`!` or no prefix)
  //   - 'claude:secondary:<modelId>' — Claude secondary tier (`@`)
  //   - 'ollama:<modelId>'           — Ollama (`>`)
  //   - 'system'                     — denial / queue-full rows (no engine ran)
  // Pre-Step-12 rows tagged 'claude' are migrated to
  // 'claude:secondary:claude-opus-4-7' on first boot; agent.ts always passes
  // the full string explicitly.
  model: string;
  // Scheduler — distinguishes user-typed from scheduler-fired turns.
  // Defaults to 'user' when omitted (matches legacy rows). 'tool_call' is
  // written by the skill-tool dispatcher when the Ollama agent calls a
  // skill via natural language (vs. operator typing `/<skill>`).
  origin?: "user" | "scheduled" | "system" | "tool_call";
  // Scheduler — task identifier on origin='scheduled' rows; null otherwise.
  taskName?: string | null;
}

export interface AuditEnd {
  id: number;
  response: string | null;
  toolCalls: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  // PNX-167 — prompt-cache telemetry. Both nullable for non-Anthropic engines
  // (Ollama returns no cache numbers; system rows have nothing to report).
  // The actual tokens-on-the-wire for an Anthropic call are
  //   inputTokens + cacheCreationInputTokens + cacheReadInputTokens
  // (the "fresh" + "cache write" + "cache read" segments).
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
  costUsd: number | null;
  agentSessionId: string | null;
  status: "ok" | "error" | "denied";
  errorMessage: string | null;
  endedAt: number;
}

export interface ChatCostRow {
  chatId: number;
  spent: number;
  turns: number;
}

export interface ChatHistoryRow {
  prompt: string;
  response: string;
  model: string;
}

// PNX-167 — token + cost stats for the most recent successful turn of a
// (chat, engine) pair. Powers the `/context` command's display of "what the
// SDK will replay on the next turn." For an Anthropic-resumed session the
// useful number is `inputTokens + cacheReadInputTokens + cacheCreationInputTokens`
// (the actual on-the-wire input); for Ollama or system rows the cache fields
// are null and the consumer should treat them as zero.
export interface TurnStats {
  startedAt: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
  costUsd: number | null;
}

export interface SolracDb {
  readonly raw: Database;
  getMeta: (key: string) => string | null;
  setMeta: (key: string, value: string) => void;
  claimUpdate: (updateId: number) => boolean;
  insertAudit: (row: AuditInsert) => number;
  updateAuditEnd: (row: AuditEnd) => void;
  sumChatCostSince: (chatId: number, sinceMs: number) => number;
  sumCostSince: (sinceMs: number) => number;
  sumCostsByChatBetween: (startMs: number, endMs: number) => ChatCostRow[];
  // Returns the most recent N successful chat turns (every engine: both
  // Claude tiers AND Ollama) for a chat, oldest first, so they can be
  // assembled into a stateful conversation context. The `model` field tags
  // origin. The Ollama runner uses this for its messages array so Claude
  // turns aren't invisible to follow-up Ollama questions. PLAN Step 11.5
  // (generalized in Step 12).
  //
  // `sinceMs` (default 0) filters out rows with `started_at <= sinceMs`.
  // Ollama callers pass `sessions.getOllamaCutoff(chatId) ?? 0` so a
  // `/clear ollama` cutoff truncates the visible history. Other callers
  // (web client) leave it at 0 — the audit log is still the source of
  // truth for operator-facing views.
  recentChatTurns: (chatId: number, limit: number, sinceMs?: number) => ChatHistoryRow[];
  // Returns successful turns from OTHER engines that happened AFTER this
  // engine's most recent successful turn. `currentEnginePrefix` is a SQL LIKE
  // pattern naming this engine (e.g. 'claude:primary:%', 'claude:secondary:%',
  // 'ollama:%'). The Claude tier runners use this to inject "out-of-band"
  // context (other-tier Claude turns + Ollama turns) on top of their own SDK
  // session resume. Window naturally narrows on the next turn for this engine
  // because its cutoff `MAX(started_at)` has advanced. PLAN Step 12.
  //
  // INVARIANT: `currentEnginePrefix` MUST be constructed from a typed enum
  // (e.g. `\`claude:${SessionTier}:%\``), never from user-provided text. The
  // `%` wildcard is intentional and load-bearing; if a caller passed a
  // prefix without `%` (or with extra wildcards) the NOT-LIKE-exclusion
  // could silently match too few or too many rows. The current call sites
  // (agent.ts, ollama.ts) construct this safely; new callers must too.
  //
  // `ollamaCutoffMs` (default 0) hides Ollama rows with `started_at <=
  // cutoff` from the bridge — implements the source-of-truth semantics of
  // `/clear ollama` for Claude tiers (the cleared turns disappear from
  // Sonnet/Opus's bridge too, not just from Ollama's own history).
  outOfBandForEngine: (
    chatId: number,
    currentEnginePrefix: string,
    limit: number,
    ollamaCutoffMs?: number,
  ) => ChatHistoryRow[];
  // Cheap existence probe: any successful Ollama turn for this chat with
  // `started_at > sinceMs`? Used by `/clear ollama` to render an honest
  // "Already clean" reply when the cutoff is already at or past the most
  // recent turn. O(1) via `idx_audit_chat_model_started`.
  hasOllamaTurnsSince: (chatId: number, sinceMs: number) => boolean;
  // PNX-167 — count of successful turns for a chat scoped to a single engine.
  // Used by `/status` to surface "12 turns on primary in this chat." Same
  // index path as `outOfBandForEngine` (`idx_audit_chat_model_started`).
  countChatTurnsForEngine: (chatId: number, enginePrefix: string) => number;
  // PR-B — time-windowed variant. Counts successful turns for chat+engine
  // started at or after `sinceMs`. Used by `/status` to surface "ollama
  // turns: N (last 24h)" so the inversion-default chat shows its activity
  // even when no Claude session state exists.
  countChatTurnsForEngineSince: (
    chatId: number,
    enginePrefix: string,
    sinceMs: number,
  ) => number;
  // PNX-167 — MAX(started_at) for a chat+engine where status='ok'. Returns
  // null when no successful row matches. Powers the "last 14:32 UTC" line in
  // `/status`.
  lastSuccessfulTurnAt: (chatId: number, enginePrefix: string) => number | null;
  // PNX-167 — source material for `/compact`. Most recent N successful turns
  // for chat+engine, in chronological order, filtered to `started_at > sinceMs`
  // (pass `previous summary_at` or 0). Honors the same INVARIANT as
  // `outOfBandForEngine`: `enginePrefix` MUST be a typed-enum-derived LIKE
  // pattern (e.g. `claude:primary:%`), never user-supplied text.
  recentChatTurnsForEngine: (
    chatId: number,
    enginePrefix: string,
    limit: number,
    sinceMs: number,
  ) => ChatHistoryRow[];
  // PNX-167 — last successful turn's full token + cost shape. Used by
  // `/context` to render "estimated next-turn input." Returns null if no
  // successful row matches.
  lastTurnStatsForEngine: (chatId: number, enginePrefix: string) => TurnStats | null;
  // PNX-167 — sum of LENGTH(prompt)+LENGTH(response) over status='ok' rows
  // for chat+engine. Approximate audit-table footprint of the conversation.
  // NOT the API's view of context size (that's `lastTurnStatsForEngine`'s
  // tokens) — `prompt` is truncated at MAX_AUDIT_PROMPT_LEN per row, so this
  // undercounts. Useful as a quick "how much chatter has accumulated" gauge.
  sumChatBytesForEngine: (chatId: number, enginePrefix: string) => number;
  // Scheduler — per-task persistent state.
  getTaskState: (name: string) => ScheduledTaskRow | null;
  listTaskStates: () => ScheduledTaskRow[];
  upsertTaskMetadata: (row: { name: string; sourcePath: string; sourceHash: string }) => void;
  markTaskFired: (row: {
    name: string;
    lastRunAt: number;
    lastAuditId: number | null;
    lastStatus: string | null;
  }) => void;
  setTaskOneOffConsumed: (row: {
    name: string;
    lastRunAt: number;
    lastAuditId: number | null;
    lastStatus: string | null;
  }) => void;
  setTaskLastRunOnly: (name: string, lastRunAt: number) => void;
  sumTaskCostSince: (taskName: string, sinceMs: number) => number;
  close: () => void;
}

export interface ScheduledTaskRow {
  name: string;
  lastRunAt: number | null;
  lastAuditId: number | null;
  lastStatus: string | null;
  oneOffConsumed: boolean;
  sourcePath: string;
  sourceHash: string;
  updatedAt: number;
}

export async function openDb(dataDir: string): Promise<SolracDb> {
  await mkdir(dataDir, { recursive: true });
  const dbPath = join(dataDir, "solrac.sqlite");
  const db = new Database(dbPath, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 5000");
  db.run("PRAGMA foreign_keys = ON");
  db.run(SCHEMA);
  // PLAN Step 11.3 — additive migration for pre-Step-11 databases. The
  // `model` column lives in the CREATE TABLE for fresh installs; for an
  // existing solrac.sqlite the ALTER backfills every row to 'claude' and
  // becomes a no-op on subsequent boots. SQLite's PRAGMA table_info returns
  // one row per column.
  //
  // The model-aware index is created AFTER the migration so it can reference
  // the new column on both fresh installs (column came from CREATE TABLE) and
  // upgraded databases (column came from ALTER above).
  const auditCols = db.query("PRAGMA table_info(audit)").all() as { name: string }[];
  if (!auditCols.some((c) => c.name === "model")) {
    db.run("ALTER TABLE audit ADD COLUMN model TEXT NOT NULL DEFAULT 'claude'");
    log.info("db.migrated", { migration: "audit.model_column_added" });
  }
  // PNX-167 — capture prompt-cache telemetry so /context (and follow-up
  // dashboards) can show the *actual* tokens replayed on each turn rather
  // than just the post-cache fresh portion. Resumed SDK sessions trade most
  // of their input via the cache; without these columns the audit log
  // dramatically under-reports real context size.
  if (!auditCols.some((c) => c.name === "cache_creation_input_tokens")) {
    db.run("ALTER TABLE audit ADD COLUMN cache_creation_input_tokens INTEGER");
    log.info("db.migrated", { migration: "audit.cache_creation_input_tokens_added" });
  }
  if (!auditCols.some((c) => c.name === "cache_read_input_tokens")) {
    db.run("ALTER TABLE audit ADD COLUMN cache_read_input_tokens INTEGER");
    log.info("db.migrated", { migration: "audit.cache_read_input_tokens_added" });
  }
  // Scheduler — origin distinguishes user-typed turns from scheduler fires
  // and from synthetic system rows (denials/queue-full). task_name carries
  // the task identifier on origin='scheduled' rows. Both additive + nullable
  // (origin defaults to 'user' for legacy rows).
  if (!auditCols.some((c) => c.name === "origin")) {
    db.run("ALTER TABLE audit ADD COLUMN origin TEXT NOT NULL DEFAULT 'user'");
    log.info("db.migrated", { migration: "audit.origin_added" });
  }
  if (!auditCols.some((c) => c.name === "task_name")) {
    db.run("ALTER TABLE audit ADD COLUMN task_name TEXT");
    log.info("db.migrated", { migration: "audit.task_name_added" });
  }
  // PLAN Step 12 — additive migration. Pre-Step-12 sessions had a single
  // `agent_session_id` (the SDK session for the then-default SOLRAC_MODEL =
  // claude-opus-4-7, which is now the secondary tier). The two new columns
  // are nullable so existing rows survive without backfill; new code writes
  // only the per-tier columns. ALTER is idempotent across boots.
  const sessionCols = db.query("PRAGMA table_info(sessions)").all() as { name: string }[];
  if (!sessionCols.some((c) => c.name === "primary_session_id")) {
    db.run("ALTER TABLE sessions ADD COLUMN primary_session_id TEXT");
    log.info("db.migrated", { migration: "sessions.primary_session_id_added" });
  }
  if (!sessionCols.some((c) => c.name === "secondary_session_id")) {
    db.run("ALTER TABLE sessions ADD COLUMN secondary_session_id TEXT");
    log.info("db.migrated", { migration: "sessions.secondary_session_id_added" });
  }
  // PNX-167 — additive columns for /compact: per-tier summary text + the
  // millisecond timestamp at which it was produced. The summary is consumed
  // once on the next fresh-session turn for that tier (see agent.ts) and
  // cleared on success. The timestamp is the cutoff passed to
  // `recentChatTurnsForEngine` so a back-to-back `/compact` doesn't
  // re-summarize already-condensed turns.
  if (!sessionCols.some((c) => c.name === "primary_summary")) {
    db.run("ALTER TABLE sessions ADD COLUMN primary_summary TEXT");
    log.info("db.migrated", { migration: "sessions.primary_summary_added" });
  }
  if (!sessionCols.some((c) => c.name === "primary_summary_at")) {
    db.run("ALTER TABLE sessions ADD COLUMN primary_summary_at INTEGER");
    log.info("db.migrated", { migration: "sessions.primary_summary_at_added" });
  }
  if (!sessionCols.some((c) => c.name === "secondary_summary")) {
    db.run("ALTER TABLE sessions ADD COLUMN secondary_summary TEXT");
    log.info("db.migrated", { migration: "sessions.secondary_summary_added" });
  }
  if (!sessionCols.some((c) => c.name === "secondary_summary_at")) {
    db.run("ALTER TABLE sessions ADD COLUMN secondary_summary_at INTEGER");
    log.info("db.migrated", { migration: "sessions.secondary_summary_at_added" });
  }
  // `/clear ollama` cutoff — millisecond timestamp at which the operator
  // wiped this chat's Ollama context. `recentChatTurns` (Ollama's own history
  // reconstruction) AND `outOfBandForEngine` (Claude's cross-engine bridge)
  // both filter Ollama rows with `started_at <= cutoff`. NULL = never cleared.
  // Ollama is stateless so there's no SDK session to drop; the cutoff IS the
  // session boundary. Additive + nullable so existing rows survive.
  if (!sessionCols.some((c) => c.name === "ollama_cutoff_ms")) {
    db.run("ALTER TABLE sessions ADD COLUMN ollama_cutoff_ms INTEGER");
    log.info("db.migrated", { migration: "sessions.ollama_cutoff_ms_added" });
  }
  // PLAN Step 12 — retag legacy `audit.model='claude'` rows. They ran on the
  // then-default SOLRAC_MODEL=claude-opus-4-7, which is now the secondary
  // tier. Cross-tier out-of-band queries key off the prefix
  // `claude:secondary:%` so legacy rows must adopt the same shape to avoid
  // showing up as "out of band" to themselves. Predicate-idempotent: after
  // first boot, no row matches `model = 'claude'` so subsequent UPDATEs change
  // zero rows.
  //
  // Implicit invariant: `'claude'` is RESERVED as the legacy tag. Any row
  // inserted post-migration with `model = 'claude'` (e.g. via a manual
  // recovery script or a future bug) will be silently retagged on the next
  // boot. New code must use the three-segment format
  // (`claude:primary:<id>` / `claude:secondary:<id>`); see `AuditInsert`.
  // The full-table scan on every boot is a tiny operator cost (the index on
  // `(chat_id, model, started_at)` lets SQLite do a partial scan) and using
  // a meta-key gate would couple migration state to a separate table — not
  // worth the complication for a row count that's bounded by data age.
  const legacyTagged = db
    .prepare("UPDATE audit SET model = 'claude:secondary:claude-opus-4-7' WHERE model = 'claude'")
    .run();
  if (legacyTagged.changes > 0) {
    log.info("db.migrated", {
      migration: "audit.legacy_claude_retagged",
      rowsChanged: legacyTagged.changes,
    });
  }
  db.run("CREATE INDEX IF NOT EXISTS idx_audit_chat_model_started ON audit(chat_id, model, started_at)");
  // Scheduler — supports `/tasks` per-task lookups and the per-task max_cost_usd
  // pre-flight query. Cheap; one row per scheduled fire only.
  db.run("CREATE INDEX IF NOT EXISTS idx_audit_task_started ON audit(task_name, started_at)");
  log.info("db.opened", { dbPath });

  const stGetMeta = db.prepare("SELECT value FROM meta WHERE key = ?");
  const stSetMeta = db.prepare(
    "INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  );
  const stClaim = db.prepare(
    "INSERT OR IGNORE INTO handled_updates (update_id, handled_at) VALUES (?, ?)",
  );
  const stInsertAudit = db.prepare(
    "INSERT INTO audit (tree_id, chat_id, from_id, update_id, prompt, status, started_at, model, origin, task_name) " +
      "VALUES (0, ?, ?, ?, ?, 'in_progress', ?, ?, ?, ?)",
  );
  const stSetTreeId = db.prepare("UPDATE audit SET tree_id = ? WHERE id = ?");
  const stUpdateEnd = db.prepare(
    "UPDATE audit SET response = ?, tool_calls = ?, input_tokens = ?, output_tokens = ?, " +
      "cache_creation_input_tokens = ?, cache_read_input_tokens = ?, " +
      "cost_usd = ?, agent_session_id = ?, status = ?, error_message = ?, ended_at = ? " +
      "WHERE id = ?",
  );
  // Cost cap is per-chat-per-window. tree_id grouping doesn't matter in v1
  // (sub-agents disabled, so each top-level turn is its own tree); summing all
  // rows for chat_id in the window is equivalent and stays correct once
  // sub-agents land.
  const stSumChatCost = db.prepare(
    "SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM audit " +
      "WHERE chat_id = ? AND started_at >= ?",
  );
  const stSumCostSince = db.prepare(
    "SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM audit WHERE started_at >= ?",
  );
  const stSumCostsByChatBetween = db.prepare(
    "SELECT chat_id, COALESCE(SUM(cost_usd), 0) AS spent, COUNT(*) AS turns " +
      "FROM audit WHERE started_at >= ? AND started_at < ? AND cost_usd IS NOT NULL " +
      "GROUP BY chat_id ORDER BY spent DESC",
  );
  // PLAN Step 11.5, generalized in Step 12: stateful chat history returning
  // ALL successful turns for the chat regardless of engine. The
  // `prompt IS NOT NULL AND response IS NOT NULL` predicate already excludes
  // denial/queue-full rows (which have null response), so we don't need an
  // explicit model filter — every engine's successful turns flow through.
  // Returns DESC for cheap LIMIT, then the consumer reverses for chronological
  // order. Each row carries its own `model` tag so the consumer can render an
  // origin label.
  // `started_at > ?` floor (default 0 from caller) implements the
  // `/clear ollama` cutoff. Strict `>` matches the back-to-back-/clear
  // semantics in commands.ts: setting cutoff to `Date.now()` immediately
  // hides every existing turn including any inserted in the same ms.
  const stRecentChat = db.prepare(
    "SELECT prompt, response, model FROM audit " +
      "WHERE chat_id = ? AND status = 'ok' " +
      "AND prompt IS NOT NULL AND response IS NOT NULL " +
      "AND started_at > ? " +
      "ORDER BY started_at DESC LIMIT ?",
  );
  // Out-of-band turns for any engine. Caller passes their own engine's prefix
  // (e.g. 'claude:primary:%' or 'ollama:%'). Returns rows from OTHER engines
  // (NOT LIKE the prefix) whose `started_at` is greater than the most recent
  // successful turn of THIS engine. Used by both Claude tiers to bridge
  // context across engine boundaries; once injected, the next turn for this
  // engine naturally sees an empty window because the cutoff has advanced.
  // Excludes 'system' rows (denials/queue-full) and Ollama uses this query
  // too — the symmetry means Ollama's own history reconstruction can layer
  // on top if needed (today it uses `recentChatTurns` directly).
  // `(model NOT LIKE 'ollama:%' OR started_at > ?)` honors the ollama
  // cutoff for the cross-engine bridge (decision B in PLAN). When the caller
  // passes 0 (no cutoff set) the clause is a no-op. When set, Ollama turns
  // pre-cutoff stay invisible to Claude tiers too — the user said /clear
  // means /clear, not "/clear-but-only-from-its-own-history".
  const stOutOfBandOther = db.prepare(
    "SELECT prompt, response, model FROM audit " +
      "WHERE chat_id = ? AND model NOT LIKE ? AND status = 'ok' " +
      "AND prompt IS NOT NULL AND response IS NOT NULL " +
      "AND (model NOT LIKE 'ollama:%' OR started_at > ?) " +
      "AND started_at > COALESCE(" +
      "  (SELECT MAX(started_at) FROM audit WHERE chat_id = ? AND model LIKE ? AND status = 'ok'), " +
      "  0" +
      ") " +
      "ORDER BY started_at ASC LIMIT ?",
  );
  // Existence probe used by `/clear ollama` for the "Already clean" reply.
  const stHasOllamaSince = db.prepare(
    "SELECT 1 FROM audit " +
      "WHERE chat_id = ? AND model LIKE 'ollama:%' AND status = 'ok' " +
      "AND prompt IS NOT NULL AND response IS NOT NULL " +
      "AND started_at > ? LIMIT 1",
  );
  // PNX-167 — engine-scoped helpers. All three use the
  // `idx_audit_chat_model_started` index. `countChatTurnsForEngine` and
  // `lastSuccessfulTurnAt` ignore the `prompt/response IS NOT NULL` predicate
  // because they're informational (failed-mid-turn rows still count as
  // attempts); `recentChatTurnsForEngine` enforces it because the result is
  // fed back into a model and a NULL response would render as "undefined."
  const stCountChatForEngine = db.prepare(
    "SELECT COUNT(*) AS n FROM audit " +
      "WHERE chat_id = ? AND model LIKE ? AND status = 'ok'",
  );
  // PR-B — time-windowed engine count. Powers the "ollama turns: N (last
  // 24h)" line in `/status`; with the inversion most chats no longer have
  // Claude session-state to surface, but Ollama turns can still be tallied
  // for at-a-glance activity. Same `idx_audit_chat_model_started` index path
  // as `stCountChatForEngine`.
  const stCountChatForEngineSince = db.prepare(
    "SELECT COUNT(*) AS n FROM audit " +
      "WHERE chat_id = ? AND model LIKE ? AND status = 'ok' AND started_at >= ?",
  );
  const stLastChatForEngine = db.prepare(
    "SELECT MAX(started_at) AS at FROM audit " +
      "WHERE chat_id = ? AND model LIKE ? AND status = 'ok'",
  );
  // Returns turns AFTER `sinceMs` (strict >). The caller passes
  // `previousSummary?.at ?? 0` so a fresh chat sees the entire history and a
  // post-/compact chat sees only the un-summarized window.
  const stRecentChatForEngine = db.prepare(
    "SELECT prompt, response, model FROM audit " +
      "WHERE chat_id = ? AND model LIKE ? AND status = 'ok' " +
      "AND prompt IS NOT NULL AND response IS NOT NULL " +
      "AND started_at > ? " +
      "ORDER BY started_at DESC LIMIT ?",
  );
  const stLastTurnStats = db.prepare(
    "SELECT started_at, input_tokens, output_tokens, " +
      "cache_creation_input_tokens, cache_read_input_tokens, cost_usd " +
      "FROM audit " +
      "WHERE chat_id = ? AND model LIKE ? AND status = 'ok' " +
      "ORDER BY started_at DESC LIMIT 1",
  );
  // SUM over text columns. SQLite returns NULL when the chat+engine has no
  // matching rows; coalesce to 0 so the closure always returns a number.
  const stSumChatBytes = db.prepare(
    "SELECT COALESCE(SUM(LENGTH(COALESCE(prompt, '')) + LENGTH(COALESCE(response, ''))), 0) AS bytes " +
      "FROM audit " +
      "WHERE chat_id = ? AND model LIKE ? AND status = 'ok'",
  );
  // Scheduler — per-task state (boot-loaded; tick reads/writes; /tasks reads).
  const stGetTaskState = db.prepare(
    "SELECT name, last_run_at, last_audit_id, last_status, one_off_consumed, source_path, source_hash, updated_at " +
      "FROM scheduled_tasks WHERE name = ?",
  );
  const stListTaskStates = db.prepare(
    "SELECT name, last_run_at, last_audit_id, last_status, one_off_consumed, source_path, source_hash, updated_at " +
      "FROM scheduled_tasks ORDER BY name ASC",
  );
  const stUpsertTaskMetadata = db.prepare(
    "INSERT INTO scheduled_tasks (name, source_path, source_hash, updated_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(name) DO UPDATE SET source_path = excluded.source_path, " +
      "source_hash = excluded.source_hash, updated_at = excluded.updated_at",
  );
  const stMarkTaskFired = db.prepare(
    "INSERT INTO scheduled_tasks (name, last_run_at, last_audit_id, last_status, source_path, source_hash, updated_at) " +
      "VALUES (?, ?, ?, ?, '', '', ?) " +
      "ON CONFLICT(name) DO UPDATE SET last_run_at = excluded.last_run_at, " +
      "last_audit_id = excluded.last_audit_id, last_status = excluded.last_status, " +
      "updated_at = excluded.updated_at",
  );
  const stSetTaskOneOffConsumed = db.prepare(
    "UPDATE scheduled_tasks SET one_off_consumed = 1, last_run_at = ?, " +
      "last_audit_id = ?, last_status = ?, updated_at = ? WHERE name = ?",
  );
  const stSetTaskLastRunOnly = db.prepare(
    "INSERT INTO scheduled_tasks (name, last_run_at, source_path, source_hash, updated_at) " +
      "VALUES (?, ?, '', '', ?) " +
      "ON CONFLICT(name) DO UPDATE SET last_run_at = excluded.last_run_at, " +
      "updated_at = excluded.updated_at",
  );
  // Pre-flight cap query: cumulative cost for THIS task in the past window.
  // Used by the per-task `max_cost_usd` gate; matches the per-chat hourly cap
  // shape (`sumChatCostSince`) so behavior is consistent.
  const stSumTaskCostSince = db.prepare(
    "SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM audit " +
      "WHERE task_name = ? AND started_at >= ?",
  );

  return {
    raw: db,
    getMeta(key) {
      const row = stGetMeta.get(key) as { value: string } | null;
      return row ? row.value : null;
    },
    setMeta(key, value) {
      stSetMeta.run(key, value, Date.now());
    },
    claimUpdate(updateId) {
      const result = stClaim.run(updateId, Date.now());
      return result.changes > 0;
    },
    insertAudit(row) {
      const r = stInsertAudit.run(
        row.chatId,
        row.fromId,
        row.updateId,
        row.prompt,
        row.startedAt,
        row.model,
        row.origin ?? "user",
        row.taskName ?? null,
      );
      const id = Number(r.lastInsertRowid);
      stSetTreeId.run(id, id);
      return id;
    },
    updateAuditEnd(row) {
      stUpdateEnd.run(
        row.response,
        row.toolCalls,
        row.inputTokens,
        row.outputTokens,
        row.cacheCreationInputTokens,
        row.cacheReadInputTokens,
        row.costUsd,
        row.agentSessionId,
        row.status,
        row.errorMessage,
        row.endedAt,
        row.id,
      );
    },
    sumChatCostSince(chatId, sinceMs) {
      const row = stSumChatCost.get(chatId, sinceMs) as { spent: number | null } | null;
      return row?.spent ?? 0;
    },
    sumCostSince(sinceMs) {
      const row = stSumCostSince.get(sinceMs) as { spent: number | null } | null;
      return row?.spent ?? 0;
    },
    sumCostsByChatBetween(startMs, endMs) {
      const rows = stSumCostsByChatBetween.all(startMs, endMs) as Array<{
        chat_id: number;
        spent: number;
        turns: number;
      }>;
      return rows.map((r) => ({ chatId: r.chat_id, spent: r.spent, turns: r.turns }));
    },
    recentChatTurns(chatId, limit, sinceMs = 0) {
      const rows = stRecentChat.all(chatId, sinceMs, limit) as ChatHistoryRow[];
      // Reverse to chronological order so the caller can append directly to a
      // chat-style messages array.
      return rows.reverse();
    },
    outOfBandForEngine(chatId, currentEnginePrefix, limit, ollamaCutoffMs = 0) {
      // Already ordered ASC. Args:
      //   1: chatId (outer SELECT scope)
      //   2: currentEnginePrefix (NOT LIKE — exclude this engine's own rows)
      //   3: ollamaCutoffMs (the decision-B clause; 0 = no cutoff)
      //   4: chatId (correlated subquery scope)
      //   5: currentEnginePrefix (subquery LIKE — find this engine's cutoff)
      //   6: limit
      return stOutOfBandOther.all(
        chatId,
        currentEnginePrefix,
        ollamaCutoffMs,
        chatId,
        currentEnginePrefix,
        limit,
      ) as ChatHistoryRow[];
    },
    hasOllamaTurnsSince(chatId, sinceMs) {
      return stHasOllamaSince.get(chatId, sinceMs) !== null;
    },
    countChatTurnsForEngine(chatId, enginePrefix) {
      const row = stCountChatForEngine.get(chatId, enginePrefix) as { n: number } | null;
      return row?.n ?? 0;
    },
    countChatTurnsForEngineSince(chatId, enginePrefix, sinceMs) {
      const row = stCountChatForEngineSince.get(chatId, enginePrefix, sinceMs) as
        | { n: number }
        | null;
      return row?.n ?? 0;
    },
    lastSuccessfulTurnAt(chatId, enginePrefix) {
      const row = stLastChatForEngine.get(chatId, enginePrefix) as { at: number | null } | null;
      return row?.at ?? null;
    },
    recentChatTurnsForEngine(chatId, enginePrefix, limit, sinceMs) {
      const rows = stRecentChatForEngine.all(
        chatId,
        enginePrefix,
        sinceMs,
        limit,
      ) as ChatHistoryRow[];
      // DESC for cheap LIMIT; reverse to chronological for the consumer.
      return rows.reverse();
    },
    lastTurnStatsForEngine(chatId, enginePrefix) {
      const row = stLastTurnStats.get(chatId, enginePrefix) as
        | {
            started_at: number;
            input_tokens: number | null;
            output_tokens: number | null;
            cache_creation_input_tokens: number | null;
            cache_read_input_tokens: number | null;
            cost_usd: number | null;
          }
        | null;
      if (!row) return null;
      return {
        startedAt: row.started_at,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        cacheCreationInputTokens: row.cache_creation_input_tokens,
        cacheReadInputTokens: row.cache_read_input_tokens,
        costUsd: row.cost_usd,
      };
    },
    sumChatBytesForEngine(chatId, enginePrefix) {
      const row = stSumChatBytes.get(chatId, enginePrefix) as { bytes: number | null } | null;
      return row?.bytes ?? 0;
    },
    getTaskState(name) {
      const row = stGetTaskState.get(name) as
        | {
            name: string;
            last_run_at: number | null;
            last_audit_id: number | null;
            last_status: string | null;
            one_off_consumed: number;
            source_path: string;
            source_hash: string;
            updated_at: number;
          }
        | null;
      if (!row) return null;
      return {
        name: row.name,
        lastRunAt: row.last_run_at,
        lastAuditId: row.last_audit_id,
        lastStatus: row.last_status,
        oneOffConsumed: row.one_off_consumed === 1,
        sourcePath: row.source_path,
        sourceHash: row.source_hash,
        updatedAt: row.updated_at,
      };
    },
    listTaskStates() {
      const rows = stListTaskStates.all() as Array<{
        name: string;
        last_run_at: number | null;
        last_audit_id: number | null;
        last_status: string | null;
        one_off_consumed: number;
        source_path: string;
        source_hash: string;
        updated_at: number;
      }>;
      return rows.map((row) => ({
        name: row.name,
        lastRunAt: row.last_run_at,
        lastAuditId: row.last_audit_id,
        lastStatus: row.last_status,
        oneOffConsumed: row.one_off_consumed === 1,
        sourcePath: row.source_path,
        sourceHash: row.source_hash,
        updatedAt: row.updated_at,
      }));
    },
    upsertTaskMetadata(row) {
      stUpsertTaskMetadata.run(row.name, row.sourcePath, row.sourceHash, Date.now());
    },
    markTaskFired(row) {
      stMarkTaskFired.run(
        row.name,
        row.lastRunAt,
        row.lastAuditId,
        row.lastStatus,
        Date.now(),
      );
    },
    setTaskOneOffConsumed(row) {
      stSetTaskOneOffConsumed.run(
        row.lastRunAt,
        row.lastAuditId,
        row.lastStatus,
        Date.now(),
        row.name,
      );
    },
    setTaskLastRunOnly(name, lastRunAt) {
      stSetTaskLastRunOnly.run(name, lastRunAt, Date.now());
    },
    sumTaskCostSince(taskName, sinceMs) {
      const row = stSumTaskCostSince.get(taskName, sinceMs) as { spent: number | null } | null;
      return row?.spent ?? 0;
    },
    close() {
      db.close();
    },
  };
}
