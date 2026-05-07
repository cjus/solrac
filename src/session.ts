/**
 * @fileoverview Per-chat, per-tier SDK session id store for `Options.resume`.
 * @purpose Persist the Claude Agent SDK's `session_id` so the next turn for
 *          the same chat AND tier resumes the previous conversation.
 *          Sessions survive process restarts.
 *
 * The Anthropic Agent SDK returns `result.session_id` at the end of every
 * `query()`; passing the same id back via `Options.resume` re-attaches the
 * next call to that conversation. PLAN Step 12 introduced two Claude tiers
 * (primary / secondary) each running on a different model id; the SDK
 * sessions are model-bound so each tier needs its own persisted session id.
 * Cross-tier context is bridged separately via `db.outOfBandForEngine`.
 *
 * Why a dedicated module: we want the `chat_id ↔ session_id` mapping to be a
 * typed seam, not loose UPSERT statements scattered through `agent.ts`. The
 * store also gives us a single place to swap implementations if v2 wants
 * per-tree session forking ([OQ#8](docs/ROADMAP.md#oq8-sub-agent-enablement)).
 *
 * Position in the dependency graph:
 *   db → session → consumed by agent
 *
 * Exports:
 *   - `createSessionStore(db)` — factory; returns `SessionStore`.
 *   - `SessionStore` — interface with `getSessionId(chatId, tier)` and
 *     `setSessionId(chatId, tier, id)`. `getSession(chatId)` retained for
 *     diagnostics.
 *   - `SessionRow` — row shape (camelCase; raw row uses snake_case).
 *   - `SessionTier` — `'primary' | 'secondary'`.
 *
 * Key invariants:
 *   - One row per `chat_id` (PK). Upsert via `ON CONFLICT(chat_id) DO UPDATE`.
 *   - Each per-tier column is nullable; null = "fresh conversation, no resume".
 *   - The pre-Step-12 `agent_session_id` column is intentionally untouched on
 *     reads/writes — kept for rollback compatibility only.
 *
 * Gotchas:
 *   - To force a fresh SDK conversation for a chat, `UPDATE sessions SET
 *     <tier>_session_id = NULL WHERE chat_id = ?`. Bot will start a new SDK
 *     session on the next turn for that tier.
 *   - The mapping is unidirectional: chat → session. Reverse lookup is not
 *     supported in v1.
 *   - `created_at` is preserved across upserts; only the relevant tier id +
 *     `updated_at` change.
 *
 * Cross-references:
 *   - docs/USAGE.md#session — user-facing semantics
 *   - agent.ts::runAgent — sole consumer; reads + writes around `query()`
 *   - docs/SDK_NOTES.md — verified `Options.resume` and `result.session_id` shapes
 */

import type { SolracDb } from "./db.ts";

export type SessionTier = "primary" | "secondary";

export interface SessionRow {
  chatId: number;
  primarySessionId: string | null;
  secondarySessionId: string | null;
  // PNX-167 — non-null when a `/compact` ran for that tier and the next turn
  // hasn't consumed the summary yet. `summaryAt` is the millisecond timestamp
  // of the compact; used as the cutoff for `recentChatTurnsForEngine` so a
  // back-to-back `/compact` ignores already-summarized turns.
  primarySummary: string | null;
  primarySummaryAt: number | null;
  secondarySummary: string | null;
  secondarySummaryAt: number | null;
  createdAt: number;
  updatedAt: number;
}

// Pulled out separately so callers get the timestamp without the whole row.
export interface SessionSummary {
  text: string;
  at: number;
}

export interface SessionStore {
  getSessionId: (chatId: number, tier: SessionTier) => string | null;
  setSessionId: (chatId: number, tier: SessionTier, sessionId: string) => void;
  // PNX-167 — drop the SDK session id for a tier without touching the
  // summary. `/compact` calls this after persisting the summary so the next
  // turn starts fresh; `runAgent` calls it implicitly via `clearAll` when
  // the user `/clear`s.
  clearSessionId: (chatId: number, tier: SessionTier) => void;
  getSession: (chatId: number) => SessionRow | null;
  // PNX-167 — `/compact` summary CRUD.
  getSummary: (chatId: number, tier: SessionTier) => SessionSummary | null;
  setSummary: (chatId: number, tier: SessionTier, text: string, at: number) => void;
  clearSummary: (chatId: number, tier: SessionTier) => void;
  // PNX-167 — drop session id AND summary in one statement. Used by `/clear`.
  clearAll: (chatId: number, tier: SessionTier) => void;
}

interface SessionRowRaw {
  chat_id: number;
  primary_session_id: string | null;
  secondary_session_id: string | null;
  primary_summary: string | null;
  primary_summary_at: number | null;
  secondary_summary: string | null;
  secondary_summary_at: number | null;
  created_at: number;
  updated_at: number;
}

export function createSessionStore(db: SolracDb): SessionStore {
  // Two prepared upserts — one per tier — because SQLite can't parameterize
  // a column name. The tier enum is internal (TS-checked), not user-supplied,
  // so this is type-safe by construction.
  const stUpsertPrimary = db.raw.prepare(
    "INSERT INTO sessions (chat_id, primary_session_id, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(chat_id) DO UPDATE SET " +
      "primary_session_id = excluded.primary_session_id, " +
      "updated_at = excluded.updated_at",
  );
  const stUpsertSecondary = db.raw.prepare(
    "INSERT INTO sessions (chat_id, secondary_session_id, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(chat_id) DO UPDATE SET " +
      "secondary_session_id = excluded.secondary_session_id, " +
      "updated_at = excluded.updated_at",
  );
  const stGet = db.raw.prepare(
    "SELECT chat_id, primary_session_id, secondary_session_id, " +
      "primary_summary, primary_summary_at, " +
      "secondary_summary, secondary_summary_at, " +
      "created_at, updated_at " +
      "FROM sessions WHERE chat_id = ?",
  );
  // PNX-167 — UPDATE-only paths. They never INSERT a row: a chat with no
  // session and no summary doesn't need a `sessions` row to "represent
  // nothing." Get-after-no-insert returns null, which the callers handle.
  const stClearSessionPrimary = db.raw.prepare(
    "UPDATE sessions SET primary_session_id = NULL, updated_at = ? WHERE chat_id = ?",
  );
  const stClearSessionSecondary = db.raw.prepare(
    "UPDATE sessions SET secondary_session_id = NULL, updated_at = ? WHERE chat_id = ?",
  );
  // Summary writes UPSERT because `/compact` may run on a chat that has no
  // prior `sessions` row (no successful turn yet → no setSessionId yet, but
  // the user's `/compact` could still produce a row pinning the cutoff).
  // In practice `/compact` only runs after at least one successful turn, but
  // making the write structurally tolerant of the no-row case avoids a hidden
  // dependency.
  const stUpsertSummaryPrimary = db.raw.prepare(
    "INSERT INTO sessions (chat_id, primary_summary, primary_summary_at, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT(chat_id) DO UPDATE SET " +
      "primary_summary = excluded.primary_summary, " +
      "primary_summary_at = excluded.primary_summary_at, " +
      "updated_at = excluded.updated_at",
  );
  const stUpsertSummarySecondary = db.raw.prepare(
    "INSERT INTO sessions (chat_id, secondary_summary, secondary_summary_at, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT(chat_id) DO UPDATE SET " +
      "secondary_summary = excluded.secondary_summary, " +
      "secondary_summary_at = excluded.secondary_summary_at, " +
      "updated_at = excluded.updated_at",
  );
  const stClearSummaryPrimary = db.raw.prepare(
    "UPDATE sessions SET primary_summary = NULL, primary_summary_at = NULL, updated_at = ? WHERE chat_id = ?",
  );
  const stClearSummarySecondary = db.raw.prepare(
    "UPDATE sessions SET secondary_summary = NULL, secondary_summary_at = NULL, updated_at = ? WHERE chat_id = ?",
  );
  const stClearAllPrimary = db.raw.prepare(
    "UPDATE sessions SET primary_session_id = NULL, " +
      "primary_summary = NULL, primary_summary_at = NULL, " +
      "updated_at = ? WHERE chat_id = ?",
  );
  const stClearAllSecondary = db.raw.prepare(
    "UPDATE sessions SET secondary_session_id = NULL, " +
      "secondary_summary = NULL, secondary_summary_at = NULL, " +
      "updated_at = ? WHERE chat_id = ?",
  );

  return {
    getSessionId(chatId, tier) {
      const row = stGet.get(chatId) as SessionRowRaw | null;
      if (!row) return null;
      return tier === "primary" ? row.primary_session_id : row.secondary_session_id;
    },
    setSessionId(chatId, tier, sessionId) {
      const now = Date.now();
      const stmt = tier === "primary" ? stUpsertPrimary : stUpsertSecondary;
      stmt.run(chatId, sessionId, now, now);
    },
    clearSessionId(chatId, tier) {
      const stmt = tier === "primary" ? stClearSessionPrimary : stClearSessionSecondary;
      stmt.run(Date.now(), chatId);
    },
    getSession(chatId) {
      const row = stGet.get(chatId) as SessionRowRaw | null;
      if (!row) return null;
      return {
        chatId: row.chat_id,
        primarySessionId: row.primary_session_id,
        secondarySessionId: row.secondary_session_id,
        primarySummary: row.primary_summary,
        primarySummaryAt: row.primary_summary_at,
        secondarySummary: row.secondary_summary,
        secondarySummaryAt: row.secondary_summary_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    },
    getSummary(chatId, tier) {
      const row = stGet.get(chatId) as SessionRowRaw | null;
      if (!row) return null;
      const text = tier === "primary" ? row.primary_summary : row.secondary_summary;
      const at = tier === "primary" ? row.primary_summary_at : row.secondary_summary_at;
      if (text === null || at === null) return null;
      return { text, at };
    },
    setSummary(chatId, tier, text, at) {
      const now = Date.now();
      const stmt = tier === "primary" ? stUpsertSummaryPrimary : stUpsertSummarySecondary;
      stmt.run(chatId, text, at, now, now);
    },
    clearSummary(chatId, tier) {
      const stmt = tier === "primary" ? stClearSummaryPrimary : stClearSummarySecondary;
      stmt.run(Date.now(), chatId);
    },
    clearAll(chatId, tier) {
      const stmt = tier === "primary" ? stClearAllPrimary : stClearAllSecondary;
      stmt.run(Date.now(), chatId);
    },
  };
}
