// Simulates a prod-like migration: builds a synthetic legacy db by opening a
// modern db, then "rolling back" the Phase-3 (local-engine) migration in place
// (rename column back, retag rows back). Then closes and reopens to exercise
// the migration on a populated db. Verifies row counts, column presence,
// value preservation, and idempotency on a second open.
//
// Run: bun test/smokes/migration-snapshot.ts
//
// Output: structured boot logs from the migration (look for
// `audit.ollama_retagged_to_local` with `rowsChanged` count, and
// `sessions.ollama_cutoff_ms_renamed_to_local`) plus assertions.

import { rmSync, mkdirSync } from "node:fs";
import { openDb } from "../../src/db.ts";

const TMP = "data/test/migration-snapshot";
const LEGACY_OLLAMA_ROWS = 84;
const CLAUDE_PRIMARY_ROWS = 83;
const CLAUDE_SECONDARY_ROWS = 83;
const TOTAL_ROWS = LEGACY_OLLAMA_ROWS + CLAUDE_PRIMARY_ROWS + CLAUDE_SECONDARY_ROWS;
const LEGACY_CHATS = [101, 202, 303];

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}
function pass(msg: string): void {
  console.log(`PASS: ${msg}`);
}

// Fresh dir.
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

// ---------------------------------------------------------------------------
// Step 1 — build a "legacy" db by opening a modern db then rolling Phase 3
// backward. This is exactly the technique src/db.test.ts uses (line 297-300):
// safer than hand-crafting the schema because it tracks whatever shape
// openDb() emits today, only diverging on the Phase-3 specific bits.
// ---------------------------------------------------------------------------
{
  const db = await openDb(TMP);
  // Roll Phase-3 backward.
  db.raw.run("ALTER TABLE sessions RENAME COLUMN local_cutoff_ms TO ollama_cutoff_ms");

  // Seed audit rows with a realistic mix.
  const insertAudit = db.raw.prepare(
    "INSERT INTO audit (tree_id, chat_id, from_id, prompt, response, status, started_at, model, cost_usd) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  db.raw.exec("BEGIN");
  let i = 0;
  for (let k = 0; k < LEGACY_OLLAMA_ROWS; k++, i++) {
    const chat = LEGACY_CHATS[k % LEGACY_CHATS.length]!;
    insertAudit.run(
      0, chat, chat, `prompt-${i}`, `response-${i}`, "ok", 1000 + i, "ollama:gemma4:e4b", 0,
    );
  }
  for (let k = 0; k < CLAUDE_PRIMARY_ROWS; k++, i++) {
    const chat = LEGACY_CHATS[k % LEGACY_CHATS.length]!;
    insertAudit.run(
      0, chat, chat, `prompt-${i}`, `response-${i}`, "ok", 1000 + i, "claude:primary:claude-sonnet-4-6", 0.01,
    );
  }
  for (let k = 0; k < CLAUDE_SECONDARY_ROWS; k++, i++) {
    const chat = LEGACY_CHATS[k % LEGACY_CHATS.length]!;
    insertAudit.run(
      0, chat, chat, `prompt-${i}`, `response-${i}`, "ok", 1000 + i, "claude:secondary:claude-opus-4-7", 0.02,
    );
  }
  db.raw.exec("COMMIT");

  // Seed two sessions rows on the legacy column to prove value preservation.
  db.raw.run(
    `INSERT INTO sessions (chat_id, primary_session_id, ollama_cutoff_ms, created_at, updated_at)
     VALUES (101, 'p-uuid-101', 1700000000000, 100, 100)`,
  );
  db.raw.run(
    `INSERT INTO sessions (chat_id, primary_session_id, ollama_cutoff_ms, created_at, updated_at)
     VALUES (202, 'p-uuid-202', 1700000005000, 100, 100)`,
  );

  // Pre-migration sanity.
  const counts = db.raw
    .query(
      "SELECT " +
        "(SELECT COUNT(*) FROM audit WHERE model LIKE 'ollama:%') AS legacy, " +
        "(SELECT COUNT(*) FROM audit WHERE model LIKE 'claude:%') AS claude",
    )
    .get() as { legacy: number; claude: number };
  if (counts.legacy !== LEGACY_OLLAMA_ROWS) fail(`fixture: legacy=${counts.legacy}`);
  if (counts.claude !== CLAUDE_PRIMARY_ROWS + CLAUDE_SECONDARY_ROWS)
    fail(`fixture: claude=${counts.claude}`);
  pass(
    `legacy fixture seeded: ${counts.legacy} ollama:% rows, ${counts.claude} claude:% rows (untouched), 2 sessions with ollama_cutoff_ms`,
  );
  db.close();
}

// ---------------------------------------------------------------------------
// Step 2 — first boot. Migration should fire.
// ---------------------------------------------------------------------------
console.log("\n--- first boot (migration should fire) ---\n");
const db1 = await openDb(TMP);

const auditPost = db1.raw
  .query(
    "SELECT " +
      "(SELECT COUNT(*) FROM audit WHERE model LIKE 'ollama:%') AS legacy, " +
      "(SELECT COUNT(*) FROM audit WHERE model LIKE 'local:ollama:%') AS retagged, " +
      "(SELECT COUNT(*) FROM audit WHERE model LIKE 'claude:%') AS claude",
  )
  .get() as { legacy: number; retagged: number; claude: number };
if (auditPost.legacy !== 0) fail(`legacy ollama:% rows remain: ${auditPost.legacy}`);
if (auditPost.retagged !== LEGACY_OLLAMA_ROWS)
  fail(`retagged: got ${auditPost.retagged}, want ${LEGACY_OLLAMA_ROWS}`);
if (auditPost.claude !== CLAUDE_PRIMARY_ROWS + CLAUDE_SECONDARY_ROWS)
  fail(`claude rows changed: got ${auditPost.claude}, want ${CLAUDE_PRIMARY_ROWS + CLAUDE_SECONDARY_ROWS}`);
pass(
  `audit retag: 0 legacy, ${auditPost.retagged} local:ollama:%, ${auditPost.claude} claude:% (untouched)`,
);

const sessionCols = db1.raw.query("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
const colNames = new Set(sessionCols.map((c) => c.name));
if (!colNames.has("local_cutoff_ms")) fail("local_cutoff_ms column missing");
if (colNames.has("ollama_cutoff_ms")) fail("ollama_cutoff_ms column should have been renamed");
pass("sessions schema: local_cutoff_ms present, ollama_cutoff_ms gone");

const session101 = db1.raw
  .query("SELECT local_cutoff_ms FROM sessions WHERE chat_id = 101")
  .get() as { local_cutoff_ms: number };
const session202 = db1.raw
  .query("SELECT local_cutoff_ms FROM sessions WHERE chat_id = 202")
  .get() as { local_cutoff_ms: number };
if (session101.local_cutoff_ms !== 1700000000000)
  fail(`chat 101 cutoff lost: ${session101.local_cutoff_ms}`);
if (session202.local_cutoff_ms !== 1700000005000)
  fail(`chat 202 cutoff lost: ${session202.local_cutoff_ms}`);
pass("sessions cutoff values preserved across rename (1700000000000, 1700000005000)");

// Sanity: total row count unchanged.
const totalPost = db1.raw.query("SELECT COUNT(*) AS n FROM audit").get() as { n: number };
if (totalPost.n !== TOTAL_ROWS)
  fail(`row count drifted: got ${totalPost.n}, want ${TOTAL_ROWS}`);
pass(`audit row count unchanged: ${totalPost.n}`);

db1.close();

// ---------------------------------------------------------------------------
// Step 3 — second boot. Migration should be no-op.
// ---------------------------------------------------------------------------
console.log("\n--- second boot (migration should be no-op) ---\n");
const db2 = await openDb(TMP);

const auditFinal = db2.raw
  .query("SELECT COUNT(*) AS n FROM audit WHERE model LIKE 'local:ollama:%'")
  .get() as { n: number };
if (auditFinal.n !== LEGACY_OLLAMA_ROWS)
  fail(`second-boot drift: ${auditFinal.n}`);
pass(`second-boot retagged count unchanged: ${auditFinal.n} (no spurious retag)`);
db2.close();

console.log("\nmigration-snapshot OK");
