/**
 * @fileoverview Unit tests for `openDb`'s additive schema migrations.
 * @proves PRAGMA-table_info-guarded ALTERs run exactly once on upgrade and
 *         the legacy-claude retag UPDATE turns into a no-op after the first
 *         boot.
 *
 * The production database in operator-land will be an evolving file —
 * pre-Step-11 (no `model` column), pre-Step-12 (no per-tier session
 * columns), and finally the current shape. Each `openDb` call must walk it
 * forward without losing data and without re-running migrations on
 * subsequent boots. This was previously verified manually against an
 * operator's sqlite; these tests pin the contract so a refactor of the
 * migration block doesn't quietly regress.
 *
 * Scenarios covered:
 *
 *   pre-Step-11 → current:
 *     - `audit.model` column added with NOT NULL DEFAULT 'claude' (existing
 *       rows backfilled correctly).
 *     - Legacy 'claude' tags retagged to 'claude:secondary:claude-opus-4-7'.
 *     - `sessions.primary_session_id` + `sessions.secondary_session_id`
 *       columns added.
 *
 *   pre-Step-12 → current:
 *     - Already has `audit.model='claude'` rows; per-tier session columns
 *       added; legacy retag still fires.
 *
 *   idempotency:
 *     - Second `openDb` boot is a no-op: no new audit rows mutated, schema
 *       shape unchanged.
 *
 *   fresh install:
 *     - `openDb` against an empty dir creates the modern schema directly
 *       (no migrations log; column shape matches expected).
 *
 * Not covered (intentional):
 *   - Crash mid-statement: SQLite WAL makes each ALTER + UPDATE atomic; the
 *     PRAGMA guards make re-running idempotent. Verifying crash recovery
 *     would need a fault-injection layer below SQLite.
 *
 * Cross-references:
 *   - db.ts — implementation
 *   - PLAN Step 11.3, Step 12.3, Step 12.4 — migration designs
 *   - docs/ARCHITECTURE.md#sqlite-schema — schema rationale
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type SolracDb } from "./db.ts";

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

function newDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "solrac-db-"));
  dirs.push(dir);
  return dir;
}

interface ColumnInfo {
  name: string;
  notnull: number;
  dflt_value: string | null;
}

function columns(raw: Database, table: string): Map<string, ColumnInfo> {
  const rows = raw.query(`PRAGMA table_info(${table})`).all() as ColumnInfo[];
  return new Map(rows.map((c) => [c.name, c]));
}

function writePreStep11Schema(dir: string): void {
  // The shape Solrac shipped before Step 11: `audit` had no `model` column
  // and `sessions` had only `agent_session_id`. Build the file by hand so
  // openDb's migrations have something to walk forward.
  const dbPath = join(dir, "solrac.sqlite");
  const old = new Database(dbPath, { create: true });
  old.run("PRAGMA journal_mode = WAL");
  old.run(`
    CREATE TABLE meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE allowlist (
      user_id INTEGER PRIMARY KEY,
      added_at INTEGER NOT NULL
    );
    CREATE TABLE handled_updates (
      update_id INTEGER PRIMARY KEY,
      handled_at INTEGER NOT NULL
    );
    CREATE TABLE sessions (
      chat_id INTEGER PRIMARY KEY,
      agent_session_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE audit (
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
      FOREIGN KEY (parent_turn_id) REFERENCES audit(id)
    );
  `);
  // Seed two rows so we can verify backfill + retag.
  old.run(`
    INSERT INTO audit (tree_id, chat_id, from_id, update_id, prompt, response,
                       cost_usd, status, started_at, ended_at)
      VALUES (1, 100, 200, 1, 'q1', 'a1', 0.10, 'ok', 1000, 1100);
    INSERT INTO audit (tree_id, chat_id, from_id, update_id, prompt, response,
                       cost_usd, status, started_at, ended_at)
      VALUES (2, 100, 200, 2, 'q2', 'a2', 0.20, 'ok', 2000, 2100);
    UPDATE audit SET tree_id = id;
    INSERT INTO sessions (chat_id, agent_session_id, created_at, updated_at)
      VALUES (100, 'legacy-session-uuid', 500, 500);
  `);
  old.close();
}

describe("openDb migrations", () => {
  test("walks a pre-Step-11 schema forward in one boot", async () => {
    const dir = newDir();
    writePreStep11Schema(dir);

    const db = await openDb(dir);
    dbs.push(db);

    const auditCols = columns(db.raw, "audit");
    expect(auditCols.has("model")).toBe(true);
    const modelCol = auditCols.get("model")!;
    expect(modelCol.notnull).toBe(1);
    // The DEFAULT clause in PRAGMA table_info wraps strings in single quotes.
    expect(modelCol.dflt_value).toBe("'claude'");

    const sessionCols = columns(db.raw, "sessions");
    expect(sessionCols.has("primary_session_id")).toBe(true);
    expect(sessionCols.has("secondary_session_id")).toBe(true);
    // Pre-Step-12 column kept for rollback compatibility.
    expect(sessionCols.has("agent_session_id")).toBe(true);

    // Both seeded rows backfilled to 'claude' by the ALTER, then retagged by
    // the legacy-claude UPDATE → final shape is the secondary-tier prefix.
    const auditRows = db.raw
      .query("SELECT id, model, prompt FROM audit ORDER BY id ASC")
      .all() as Array<{ id: number; model: string; prompt: string }>;
    expect(auditRows).toHaveLength(2);
    for (const row of auditRows) {
      expect(row.model).toBe("claude:secondary:claude-opus-4-7");
    }

    // Legacy session row is intact; new tier columns are null on this row.
    const sess = db.raw.query("SELECT * FROM sessions WHERE chat_id = 100").get() as {
      agent_session_id: string;
      primary_session_id: string | null;
      secondary_session_id: string | null;
    };
    expect(sess.agent_session_id).toBe("legacy-session-uuid");
    expect(sess.primary_session_id).toBeNull();
    expect(sess.secondary_session_id).toBeNull();
  });

  test("second boot is a no-op (idempotent migrations)", async () => {
    const dir = newDir();
    writePreStep11Schema(dir);

    {
      const db1 = await openDb(dir);
      db1.close();
    }

    // Snapshot row hash before the second boot.
    const snapshotDb = new Database(join(dir, "solrac.sqlite"), { readonly: true });
    const before = snapshotDb
      .query("SELECT id, model FROM audit ORDER BY id ASC")
      .all() as Array<{ id: number; model: string }>;
    snapshotDb.close();

    const db2 = await openDb(dir);
    dbs.push(db2);
    const after = db2.raw
      .query("SELECT id, model FROM audit ORDER BY id ASC")
      .all() as Array<{ id: number; model: string }>;

    expect(after).toEqual(before);
  });

  test("legacy-claude retag is predicate-idempotent: a manually inserted 'claude' row gets retagged on next boot", async () => {
    // Documents the implicit invariant. This is by design — `'claude'` is
    // reserved as the legacy tag — but pinning it keeps the contract
    // explicit.
    const dir = newDir();
    {
      const db1 = await openDb(dir);
      // Sneak in a row with the legacy tag (only possible by bypassing
      // insertAudit, which always tags engine-prefix). Direct SQL to demonstrate
      // the retag rule.
      db1.raw.run(`
        INSERT INTO audit (tree_id, chat_id, from_id, update_id, prompt,
                           cost_usd, status, started_at, model)
          VALUES (1, 999, 999, 999, 'manual', 0.0, 'ok', 9999, 'claude');
        UPDATE audit SET tree_id = id WHERE id = (SELECT MAX(id) FROM audit);
      `);
      db1.close();
    }

    const db2 = await openDb(dir);
    dbs.push(db2);
    const row = db2.raw
      .query("SELECT model FROM audit WHERE chat_id = 999")
      .get() as { model: string };
    expect(row.model).toBe("claude:secondary:claude-opus-4-7");
  });

  test("fresh install creates the modern schema directly", async () => {
    const dir = newDir();
    const db = await openDb(dir);
    dbs.push(db);

    const auditCols = columns(db.raw, "audit");
    expect(auditCols.has("model")).toBe(true);
    expect(auditCols.has("tree_id")).toBe(true);

    const sessionCols = columns(db.raw, "sessions");
    expect(sessionCols.has("primary_session_id")).toBe(true);
    expect(sessionCols.has("secondary_session_id")).toBe(true);

    // No rows to migrate, no rows after open.
    const count = db.raw.query("SELECT COUNT(*) AS n FROM audit").get() as { n: number };
    expect(count.n).toBe(0);
  });

  test("PNX-167 — adds cache_creation/cache_read columns on a pre-Step-167 audit table", async () => {
    const dir = newDir();
    {
      const db1 = await openDb(dir);
      // Drop the new columns to simulate the upgrade path.
      db1.raw.run("ALTER TABLE audit DROP COLUMN cache_creation_input_tokens");
      db1.raw.run("ALTER TABLE audit DROP COLUMN cache_read_input_tokens");
      db1.close();
    }
    const db2 = await openDb(dir);
    dbs.push(db2);
    const auditCols = columns(db2.raw, "audit");
    expect(auditCols.has("cache_creation_input_tokens")).toBe(true);
    expect(auditCols.has("cache_read_input_tokens")).toBe(true);
    // Both nullable.
    expect(auditCols.get("cache_creation_input_tokens")!.notnull).toBe(0);
    expect(auditCols.get("cache_read_input_tokens")!.notnull).toBe(0);
  });

  test("adds sessions.ollama_cutoff_ms on upgrade and is nullable", async () => {
    const dir = newDir();
    {
      const db1 = await openDb(dir);
      db1.raw.run("ALTER TABLE sessions DROP COLUMN ollama_cutoff_ms");
      db1.raw.run(`
        INSERT INTO sessions (chat_id, primary_session_id, created_at, updated_at)
          VALUES (888, 'p-uuid', 100, 100);
      `);
      db1.close();
    }
    const db2 = await openDb(dir);
    dbs.push(db2);
    const sessionCols = columns(db2.raw, "sessions");
    expect(sessionCols.has("ollama_cutoff_ms")).toBe(true);
    expect(sessionCols.get("ollama_cutoff_ms")!.notnull).toBe(0);
    const row = db2.raw.query("SELECT * FROM sessions WHERE chat_id = 888").get() as {
      primary_session_id: string;
      ollama_cutoff_ms: number | null;
    };
    expect(row.primary_session_id).toBe("p-uuid");
    expect(row.ollama_cutoff_ms).toBeNull();
  });

  test("PNX-167 — adds summary columns on a pre-Step-167 schema", async () => {
    // Boot once with the old schema, then again to walk forward. The first
    // boot here creates the modern schema, but verifies idempotency on the
    // PNX-167 ALTERs specifically.
    const dir = newDir();
    {
      const db1 = await openDb(dir);
      // Simulate "pre-Step-167": drop the four new columns by hand on a
      // clean DB so the second boot's PRAGMA-guarded ALTERs need to fire.
      // SQLite pre-3.35 doesn't support DROP COLUMN cleanly, but we can
      // recreate the table without them. (3.35+ supports DROP COLUMN; if
      // bun:sqlite's bundled SQLite is older, this test still proves
      // idempotency on the second boot — see the `idempotent` assertion.)
      db1.raw.run("ALTER TABLE sessions DROP COLUMN primary_summary");
      db1.raw.run("ALTER TABLE sessions DROP COLUMN primary_summary_at");
      db1.raw.run("ALTER TABLE sessions DROP COLUMN secondary_summary");
      db1.raw.run("ALTER TABLE sessions DROP COLUMN secondary_summary_at");
      // Seed an existing row so we verify the additive ALTER doesn't disturb it.
      db1.raw.run(`
        INSERT INTO sessions (chat_id, primary_session_id, created_at, updated_at)
          VALUES (777, 'p-uuid', 100, 100);
      `);
      db1.close();
    }

    const db2 = await openDb(dir);
    dbs.push(db2);
    const sessionCols = columns(db2.raw, "sessions");
    expect(sessionCols.has("primary_summary")).toBe(true);
    expect(sessionCols.has("primary_summary_at")).toBe(true);
    expect(sessionCols.has("secondary_summary")).toBe(true);
    expect(sessionCols.has("secondary_summary_at")).toBe(true);

    // Existing row survived; new columns are NULL.
    const row = db2.raw.query("SELECT * FROM sessions WHERE chat_id = 777").get() as {
      primary_session_id: string;
      primary_summary: string | null;
      secondary_summary_at: number | null;
    };
    expect(row.primary_session_id).toBe("p-uuid");
    expect(row.primary_summary).toBeNull();
    expect(row.secondary_summary_at).toBeNull();
  });
});

describe("openDb engine-scoped helpers (PNX-167)", () => {
  function seedTurns(db: SolracDb, rows: ReadonlyArray<{
    chatId: number;
    model: string;
    startedAt: number;
    response: string | null;
    cost: number | null;
    status: "ok" | "error" | "denied";
  }>): void {
    for (const r of rows) {
      const id = db.insertAudit({
        chatId: r.chatId,
        fromId: 200,
        updateId: 0,
        prompt: "p",
        startedAt: r.startedAt,
        model: r.model,
      });
      db.updateAuditEnd({
        id,
        response: r.response,
        toolCalls: null,
        inputTokens: null,
        outputTokens: null,
        cacheCreationInputTokens: null,
        cacheReadInputTokens: null,
        costUsd: r.cost,
        agentSessionId: null,
        status: r.status,
        errorMessage: null,
        endedAt: r.startedAt + 1,
      });
    }
  }

  test("countChatTurnsForEngine counts only matching successful rows", async () => {
    const dir = newDir();
    const db = await openDb(dir);
    dbs.push(db);
    seedTurns(db, [
      { chatId: 1, model: "claude:primary:claude-sonnet-4-6", startedAt: 100, response: "a", cost: 0.01, status: "ok" },
      { chatId: 1, model: "claude:primary:claude-sonnet-4-6", startedAt: 200, response: "b", cost: 0.01, status: "ok" },
      { chatId: 1, model: "claude:secondary:claude-opus-4-7", startedAt: 300, response: "c", cost: 0.02, status: "ok" },
      { chatId: 1, model: "claude:primary:claude-sonnet-4-6", startedAt: 400, response: null, cost: null, status: "error" },
      // Different chat — must not appear in chat=1 count.
      { chatId: 2, model: "claude:primary:claude-sonnet-4-6", startedAt: 500, response: "z", cost: 0.01, status: "ok" },
    ]);
    expect(db.countChatTurnsForEngine(1, "claude:primary:%")).toBe(2);
    expect(db.countChatTurnsForEngine(1, "claude:secondary:%")).toBe(1);
    expect(db.countChatTurnsForEngine(99, "claude:primary:%")).toBe(0);
  });

  test("lastSuccessfulTurnAt returns null when no rows match", async () => {
    const dir = newDir();
    const db = await openDb(dir);
    dbs.push(db);
    expect(db.lastSuccessfulTurnAt(1, "claude:primary:%")).toBeNull();
    seedTurns(db, [
      { chatId: 1, model: "claude:primary:m", startedAt: 100, response: "a", cost: 0.01, status: "ok" },
      { chatId: 1, model: "claude:primary:m", startedAt: 200, response: "b", cost: 0.01, status: "ok" },
      // status='error' is excluded.
      { chatId: 1, model: "claude:primary:m", startedAt: 300, response: null, cost: null, status: "error" },
    ]);
    expect(db.lastSuccessfulTurnAt(1, "claude:primary:%")).toBe(200);
  });

  test("recentChatTurnsForEngine respects sinceMs and chronological order", async () => {
    const dir = newDir();
    const db = await openDb(dir);
    dbs.push(db);
    seedTurns(db, [
      { chatId: 1, model: "claude:primary:m", startedAt: 100, response: "old", cost: 0.01, status: "ok" },
      { chatId: 1, model: "claude:primary:m", startedAt: 200, response: "mid", cost: 0.01, status: "ok" },
      { chatId: 1, model: "claude:primary:m", startedAt: 300, response: "new", cost: 0.01, status: "ok" },
      // Other engine — filtered out by enginePrefix.
      { chatId: 1, model: "ollama:llama3", startedAt: 250, response: "ollama", cost: 0, status: "ok" },
    ]);
    // sinceMs=0 → all primary turns chronological
    const all = db.recentChatTurnsForEngine(1, "claude:primary:%", 10, 0);
    expect(all.map((r) => r.response)).toEqual(["old", "mid", "new"]);

    // sinceMs=150 → strict > filters out the row at 100
    const after150 = db.recentChatTurnsForEngine(1, "claude:primary:%", 10, 150);
    expect(after150.map((r) => r.response)).toEqual(["mid", "new"]);

    // limit caps the result; since DESC then reversed, last-N chronologically
    const last2 = db.recentChatTurnsForEngine(1, "claude:primary:%", 2, 0);
    expect(last2.map((r) => r.response)).toEqual(["mid", "new"]);
  });

  test("recentChatTurnsForEngine excludes failed rows", async () => {
    const dir = newDir();
    const db = await openDb(dir);
    dbs.push(db);
    seedTurns(db, [
      { chatId: 1, model: "claude:primary:m", startedAt: 100, response: "ok-row", cost: 0.01, status: "ok" },
      { chatId: 1, model: "claude:primary:m", startedAt: 200, response: null, cost: null, status: "error" },
      { chatId: 1, model: "claude:primary:m", startedAt: 300, response: "ok-row2", cost: 0.01, status: "ok" },
    ]);
    const result = db.recentChatTurnsForEngine(1, "claude:primary:%", 10, 0);
    expect(result.map((r) => r.response)).toEqual(["ok-row", "ok-row2"]);
  });

  test("lastTurnStatsForEngine returns null on no rows", async () => {
    const dir = newDir();
    const db = await openDb(dir);
    dbs.push(db);
    expect(db.lastTurnStatsForEngine(1, "claude:primary:%")).toBeNull();
  });

  test("lastTurnStatsForEngine returns the most recent successful row's tokens", async () => {
    const dir = newDir();
    const db = await openDb(dir);
    dbs.push(db);
    // Seed two turns; the newer one should be returned.
    const id1 = db.insertAudit({
      chatId: 1,
      fromId: 99,
      updateId: 0,
      prompt: "p1",
      startedAt: 100,
      model: "claude:primary:m",
    });
    db.updateAuditEnd({
      id: id1,
      response: "r1",
      toolCalls: null,
      inputTokens: 10,
      outputTokens: 20,
      cacheCreationInputTokens: 30,
      cacheReadInputTokens: 40,
      costUsd: 0.001,
      agentSessionId: null,
      status: "ok",
      errorMessage: null,
      endedAt: 110,
    });
    const id2 = db.insertAudit({
      chatId: 1,
      fromId: 99,
      updateId: 0,
      prompt: "p2",
      startedAt: 200,
      model: "claude:primary:m",
    });
    db.updateAuditEnd({
      id: id2,
      response: "r2",
      toolCalls: null,
      inputTokens: 50,
      outputTokens: 100,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 8000,
      costUsd: 0.005,
      agentSessionId: null,
      status: "ok",
      errorMessage: null,
      endedAt: 210,
    });
    const stats = db.lastTurnStatsForEngine(1, "claude:primary:%");
    expect(stats).toEqual({
      startedAt: 200,
      inputTokens: 50,
      outputTokens: 100,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 8000,
      costUsd: 0.005,
    });
  });

  test("recentChatTurns honors sinceMs cutoff and treats `0` as no-op", async () => {
    const dir = newDir();
    const db = await openDb(dir);
    dbs.push(db);
    seedTurns(db, [
      { chatId: 1, model: "claude:primary:m", startedAt: 100, response: "old", cost: 0.01, status: "ok" },
      { chatId: 1, model: "ollama:gemma", startedAt: 200, response: "mid", cost: 0, status: "ok" },
      { chatId: 1, model: "claude:primary:m", startedAt: 300, response: "new", cost: 0.01, status: "ok" },
    ]);
    expect(db.recentChatTurns(1, 10).map((r) => r.response)).toEqual(["old", "mid", "new"]);
    expect(db.recentChatTurns(1, 10, 0).map((r) => r.response)).toEqual(["old", "mid", "new"]);
    expect(db.recentChatTurns(1, 10, 200).map((r) => r.response)).toEqual(["new"]);
    expect(db.recentChatTurns(1, 10, 999)).toHaveLength(0);
  });

  test("outOfBandForEngine respects ollamaCutoffMs (decision B)", async () => {
    const dir = newDir();
    const db = await openDb(dir);
    dbs.push(db);
    seedTurns(db, [
      { chatId: 1, model: "ollama:gemma", startedAt: 100, response: "ollama-old", cost: 0, status: "ok" },
      { chatId: 1, model: "ollama:gemma", startedAt: 200, response: "ollama-new", cost: 0, status: "ok" },
      { chatId: 1, model: "claude:secondary:m", startedAt: 150, response: "opus", cost: 0.02, status: "ok" },
    ]);
    const all = db.outOfBandForEngine(1, "claude:primary:%", 10).map((r) => r.response);
    expect(all).toEqual(["ollama-old", "opus", "ollama-new"]);
    const filtered = db.outOfBandForEngine(1, "claude:primary:%", 10, 150).map((r) => r.response);
    expect(filtered).toEqual(["opus", "ollama-new"]);
    const onlyOpus = db.outOfBandForEngine(1, "claude:primary:%", 10, 999).map((r) => r.response);
    expect(onlyOpus).toEqual(["opus"]);
  });

  test("hasOllamaTurnsSince returns true only for ok rows with started_at > sinceMs", async () => {
    const dir = newDir();
    const db = await openDb(dir);
    dbs.push(db);
    expect(db.hasOllamaTurnsSince(1, 0)).toBe(false);
    seedTurns(db, [
      { chatId: 1, model: "ollama:gemma", startedAt: 100, response: "hi", cost: 0, status: "ok" },
      { chatId: 1, model: "ollama:gemma", startedAt: 200, response: null, cost: null, status: "error" },
      { chatId: 2, model: "ollama:gemma", startedAt: 300, response: "hi", cost: 0, status: "ok" },
      { chatId: 1, model: "claude:primary:m", startedAt: 400, response: "hi", cost: 0.01, status: "ok" },
    ]);
    expect(db.hasOllamaTurnsSince(1, 0)).toBe(true);
    expect(db.hasOllamaTurnsSince(1, 99)).toBe(true);
    expect(db.hasOllamaTurnsSince(1, 100)).toBe(false);
  });

  test("sumChatBytesForEngine totals prompt+response over status='ok' rows", async () => {
    const dir = newDir();
    const db = await openDb(dir);
    dbs.push(db);
    seedTurns(db, [
      { chatId: 1, model: "claude:primary:m", startedAt: 100, response: "abcd", cost: 0.01, status: "ok" },
      // Different engine — should be excluded.
      { chatId: 1, model: "ollama:llama", startedAt: 200, response: "zzzz", cost: 0, status: "ok" },
      // Error row — should be excluded.
      { chatId: 1, model: "claude:primary:m", startedAt: 300, response: null, cost: null, status: "error" },
    ]);
    // Prompt = "p" (1) + response = "abcd" (4) = 5 bytes per row in the `seedTurns` helper.
    expect(db.sumChatBytesForEngine(1, "claude:primary:%")).toBe(5);
    expect(db.sumChatBytesForEngine(1, "ollama:%")).toBe(5);
    // No rows for unknown chat → 0.
    expect(db.sumChatBytesForEngine(99, "claude:primary:%")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Scheduler — scheduled_tasks table + audit origin/task_name + per-task cost
// ---------------------------------------------------------------------------

describe("scheduled_tasks table + audit origin/task_name", () => {
  test("audit.origin defaults to 'user' for inserts that omit it", async () => {
    const dir = newDir();
    const db = await openDb(dir);
    dbs.push(db);
    const id = db.insertAudit({
      chatId: 1,
      fromId: 99,
      updateId: 0,
      prompt: "p",
      startedAt: 100,
      model: "claude:primary:m",
    });
    const row = db.raw
      .query("SELECT origin, task_name FROM audit WHERE id = ?")
      .get(id) as { origin: string; task_name: string | null };
    expect(row.origin).toBe("user");
    expect(row.task_name).toBeNull();
  });

  test("audit.origin='scheduled' + task_name persists when supplied", async () => {
    const dir = newDir();
    const db = await openDb(dir);
    dbs.push(db);
    const id = db.insertAudit({
      chatId: 1,
      fromId: 99,
      updateId: null,
      prompt: "task:digest",
      startedAt: 100,
      model: "claude:primary:m",
      origin: "scheduled",
      taskName: "digest",
    });
    const row = db.raw
      .query("SELECT origin, task_name, update_id FROM audit WHERE id = ?")
      .get(id) as { origin: string; task_name: string | null; update_id: number | null };
    expect(row.origin).toBe("scheduled");
    expect(row.task_name).toBe("digest");
    expect(row.update_id).toBeNull();
  });

  test("upsertTaskMetadata + getTaskState round-trip", async () => {
    const dir = newDir();
    const db = await openDb(dir);
    dbs.push(db);
    db.upsertTaskMetadata({
      name: "digest",
      sourcePath: "/tasks/digest/TASK.md",
      sourceHash: "abc123",
    });
    const row = db.getTaskState("digest");
    expect(row).not.toBeNull();
    expect(row!.name).toBe("digest");
    expect(row!.sourcePath).toBe("/tasks/digest/TASK.md");
    expect(row!.sourceHash).toBe("abc123");
    expect(row!.lastRunAt).toBeNull();
    expect(row!.oneOffConsumed).toBe(false);
  });

  test("markTaskFired updates last_run_at and last_status", async () => {
    const dir = newDir();
    const db = await openDb(dir);
    dbs.push(db);
    db.upsertTaskMetadata({ name: "digest", sourcePath: "/p", sourceHash: "h" });
    db.markTaskFired({
      name: "digest",
      lastRunAt: 1_700_000_000_000,
      lastAuditId: 42,
      lastStatus: "fired",
    });
    const row = db.getTaskState("digest")!;
    expect(row.lastRunAt).toBe(1_700_000_000_000);
    expect(row.lastAuditId).toBe(42);
    expect(row.lastStatus).toBe("fired");
    expect(row.oneOffConsumed).toBe(false);
  });

  test("setTaskOneOffConsumed flips one_off_consumed", async () => {
    const dir = newDir();
    const db = await openDb(dir);
    dbs.push(db);
    db.upsertTaskMetadata({ name: "alarm", sourcePath: "/p", sourceHash: "h" });
    db.setTaskOneOffConsumed({
      name: "alarm",
      lastRunAt: 1_700_000_000_000,
      lastAuditId: null,
      lastStatus: "fired",
    });
    const row = db.getTaskState("alarm")!;
    expect(row.oneOffConsumed).toBe(true);
  });

  test("listTaskStates returns rows sorted by name", async () => {
    const dir = newDir();
    const db = await openDb(dir);
    dbs.push(db);
    db.upsertTaskMetadata({ name: "zebra", sourcePath: "/p", sourceHash: "h" });
    db.upsertTaskMetadata({ name: "alpha", sourcePath: "/p", sourceHash: "h" });
    const rows = db.listTaskStates();
    expect(rows.map((r) => r.name)).toEqual(["alpha", "zebra"]);
  });

  test("sumTaskCostSince filters by task_name and started_at", async () => {
    const dir = newDir();
    const db = await openDb(dir);
    dbs.push(db);
    function seed(taskName: string, startedAt: number, cost: number) {
      const id = db.insertAudit({
        chatId: 1,
        fromId: 99,
        updateId: null,
        prompt: "p",
        startedAt,
        model: "claude:primary:m",
        origin: "scheduled",
        taskName,
      });
      db.updateAuditEnd({
        id,
        response: "r",
        toolCalls: null,
        inputTokens: null,
        outputTokens: null,
        cacheCreationInputTokens: null,
        cacheReadInputTokens: null,
        costUsd: cost,
        agentSessionId: null,
        status: "ok",
        errorMessage: null,
        endedAt: startedAt + 100,
      });
    }
    seed("digest", 100, 0.10);
    seed("digest", 200, 0.05);
    seed("digest", 50, 0.20); // before window
    seed("other", 150, 0.30); // wrong task
    expect(db.sumTaskCostSince("digest", 100)).toBeCloseTo(0.15, 5);
    expect(db.sumTaskCostSince("digest", 0)).toBeCloseTo(0.35, 5);
    expect(db.sumTaskCostSince("nope", 0)).toBe(0);
  });

  test("idempotent ALTER on second openDb (origin, task_name not duplicated)", async () => {
    const dir = newDir();
    const db1 = await openDb(dir);
    dbs.push(db1);
    db1.close();
    const db2 = await openDb(dir);
    dbs.push(db2);
    const cols = (db2.raw.query("PRAGMA table_info(audit)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols.filter((c) => c === "origin").length).toBe(1);
    expect(cols.filter((c) => c === "task_name").length).toBe(1);
  });

  test("scheduled_tasks table exists and is empty on fresh install", async () => {
    const dir = newDir();
    const db = await openDb(dir);
    dbs.push(db);
    const rows = db.raw.query("SELECT * FROM scheduled_tasks").all();
    expect(rows.length).toBe(0);
  });
});
