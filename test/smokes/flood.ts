// db-pollution defense smoke. Run with:
//
//   npm run smoke:flood
//   bun test/smokes/flood.ts
//
// What this proves:
//
//   1. 50-msg burst from a non-allowlisted from.id writes exactly 1 audit row
//      (the throttle records the first denial; subsequent denials within the
//      window are skipped).
//   2. After the throttle window elapses, the next denial records again.
//   3. Distinct from.ids do not throttle each other.
//   4. An allowlisted user passes the gate (no spurious audit row from gating).
//
// Drives the real `gateUpdate` + `DenialThrottle` + `db.insertAudit` path
// against a fresh sqlite at `data/test/flood-smoke/`. The unit tests stub
// sqlite; this exercises the schema, prepared statements, and INSERT/UPDATE
// flow end-to-end.

import { Database } from "bun:sqlite";
import { createAllowlist, type Allowlist } from "../../src/allowlist.ts";
import type { SolracDb } from "../../src/db.ts";
import {
  createDenialThrottle,
  gateUpdate,
  truncateAuditPrompt,
  type DenialThrottle,
} from "../../src/policy.ts";
import type { Update } from "@grammyjs/types";
import { mkUpdate, openTestDb, reportAndExit, type Phase } from "./harness.ts";

const ALLOWED_ID = 1001;
const FLOODER_ID = 9999;
const WINDOW_MS = 60_000;
const FLOOD_SIZE = 50;

type GateOutcome = "passed" | "throttled" | "audited" | "no_from";

// Mirrors src/main.ts::gateAndAuditDenied but accepts an explicit
// `now` so the throttle's clock-advance behavior can be exercised without
// real sleeping. If main.ts diverges materially, update this to match —
// the smoke is intentionally close to that production code path.
function processUpdate(args: {
  update: Update;
  allowlist: Allowlist;
  db: SolracDb;
  throttle: DenialThrottle;
  now: number;
}): GateOutcome {
  const { update, allowlist, db, throttle, now } = args;
  const gate = gateUpdate(update, allowlist.isAllowed);
  if (gate.kind === "ok") return "passed";
  if (gate.kind === "no_from") return "no_from";
  if (throttle.check(gate.fromId, now) === "skip") return "throttled";
  const promptText = truncateAuditPrompt(update.message?.text ?? "");
  const auditId = db.insertAudit({
    chatId: gate.chatId ?? 0,
    fromId: gate.fromId,
    updateId: update.update_id,
    prompt: promptText,
    startedAt: now,
    model: "system",
  });
  db.updateAuditEnd({
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
    errorMessage: "from_id not in allowlist",
    endedAt: now,
  });
  return "audited";
}

function countDeniedRowsFor(raw: Database, fromId: number): number {
  const row = raw
    .prepare("SELECT COUNT(*) AS n FROM audit WHERE from_id = ? AND status = 'denied'")
    .get(fromId) as { n: number };
  return row.n;
}

function countDeniedRowsBetween(raw: Database, lo: number, hi: number): number {
  const row = raw
    .prepare(
      "SELECT COUNT(*) AS n FROM audit WHERE from_id BETWEEN ? AND ? AND status = 'denied'",
    )
    .get(lo, hi) as { n: number };
  return row.n;
}

async function main(): Promise<void> {
  const { db } = await openTestDb("flood-smoke");
  const allowlist = createAllowlist(db);
  allowlist.bootstrap([ALLOWED_ID]);
  const throttle = createDenialThrottle({ windowMs: WINDOW_MS });

  const phases: Phase[] = [];

  // Phase 1: 50-msg burst from same flooder → exactly 1 audit row.
  let now = 1_000_000;
  let audited = 0;
  let throttled = 0;
  for (let i = 0; i < FLOOD_SIZE; i++) {
    const r = processUpdate({
      update: mkUpdate({ updateId: i, fromId: FLOODER_ID }),
      allowlist,
      db,
      throttle,
      now: now + i * 100, // 100 ms apart — all inside the 60 s window
    });
    if (r === "audited") audited++;
    else if (r === "throttled") throttled++;
  }
  const phase1Rows = countDeniedRowsFor(db.raw, FLOODER_ID);
  phases.push({
    name: `${FLOOD_SIZE}-msg burst writes 1 audit row, throttles ${FLOOD_SIZE - 1}`,
    expected: `audited=1, throttled=${FLOOD_SIZE - 1}, db_rows=1`,
    actual: `audited=${audited}, throttled=${throttled}, db_rows=${phase1Rows}`,
    pass: audited === 1 && throttled === FLOOD_SIZE - 1 && phase1Rows === 1,
  });

  // Phase 2: advance clock past windowMs → next denial records again.
  now += WINDOW_MS + 5_000;
  const r2 = processUpdate({
    update: mkUpdate({ updateId: 100, fromId: FLOODER_ID }),
    allowlist,
    db,
    throttle,
    now,
  });
  const phase2Rows = countDeniedRowsFor(db.raw, FLOODER_ID);
  phases.push({
    name: "after window elapses, next denial writes a 2nd audit row",
    expected: "result=audited, db_rows=2",
    actual: `result=${r2}, db_rows=${phase2Rows}`,
    pass: r2 === "audited" && phase2Rows === 2,
  });

  // Phase 3: 5 distinct flooders within the window → 5 rows (independence).
  now += 1_000;
  for (let id = 2000; id < 2005; id++) {
    processUpdate({
      update: mkUpdate({ updateId: 200 + id, fromId: id }),
      allowlist,
      db,
      throttle,
      now,
    });
  }
  const phase3Rows = countDeniedRowsBetween(db.raw, 2000, 2004);
  phases.push({
    name: "5 distinct flooders are independent",
    expected: "db_rows=5",
    actual: `db_rows=${phase3Rows}`,
    pass: phase3Rows === 5,
  });

  // Phase 4: allowlisted user passes the gate.
  const r4 = processUpdate({
    update: mkUpdate({ updateId: 999, fromId: ALLOWED_ID }),
    allowlist,
    db,
    throttle,
    now,
  });
  const phase4Rows = countDeniedRowsFor(db.raw, ALLOWED_ID);
  phases.push({
    name: "allowlisted user passes the gate (no audit row from the gate path)",
    expected: "result=passed, db_rows_for_allowed=0",
    actual: `result=${r4}, db_rows_for_allowed=${phase4Rows}`,
    pass: r4 === "passed" && phase4Rows === 0,
  });

  db.close();
  reportAndExit("flood-smoke", phases);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("flood-smoke crashed:", err);
  process.exit(1);
});
