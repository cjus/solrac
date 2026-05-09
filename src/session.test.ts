/**
 * @fileoverview Unit tests for the per-chat per-tier session id store.
 * @proves `getSessionId` and `setSessionId` keep primary/secondary tier ids
 *         independent and survive `db.close()` + reopen.
 *
 * `session.ts` is small but the regression cost is high — a refactor that
 * accidentally writes both tier ids into one column would silently merge two
 * SDK conversations and the user would only notice when prompt caching gets
 * worse and turn-by-turn context drifts. These tests pin the contract.
 *
 * Scenarios covered:
 *
 *   getSessionId / setSessionId:
 *     - Independent ids per tier (primary write doesn't touch secondary).
 *     - Survive db close + reopen (the persistence path is what matters).
 *     - Returns null for an unknown chat.
 *     - Returns null for an unset tier on an existing chat row.
 *     - Overwrites the per-tier id on a second `setSessionId` call.
 *
 *   getSession (diagnostic accessor):
 *     - Returns null for an unknown chat.
 *     - Returns both tier ids when both have been set.
 *
 * Not covered (intentional):
 *   - The pre-Step-12 `agent_session_id` column — intentionally read-only;
 *     v1 doesn't surface it through the new API.
 *   - SQL injection on the tier parameter — TS-checked enum, not user input.
 *
 * Cross-references:
 *   - session.ts — implementation
 *   - db.ts — schema migration adding the per-tier columns
 *   - agent.ts::runAgent — sole production consumer
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type SolracDb } from "./db.ts";
import { createSessionStore } from "./session.ts";

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

async function newDb(dirPath?: string): Promise<{ dir: string; db: SolracDb }> {
  const dir = dirPath ?? mkdtempSync(join(tmpdir(), "solrac-session-"));
  if (!dirPath) dirs.push(dir);
  const db = await openDb(dir);
  dbs.push(db);
  return { dir, db };
}

describe("createSessionStore", () => {
  test("primary and secondary ids are independent", async () => {
    const { db } = await newDb();
    const sessions = createSessionStore(db);

    sessions.setSessionId(100, "primary", "primary-uuid");
    expect(sessions.getSessionId(100, "primary")).toBe("primary-uuid");
    expect(sessions.getSessionId(100, "secondary")).toBeNull();

    sessions.setSessionId(100, "secondary", "secondary-uuid");
    expect(sessions.getSessionId(100, "primary")).toBe("primary-uuid");
    expect(sessions.getSessionId(100, "secondary")).toBe("secondary-uuid");
  });

  test("session ids survive close and reopen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "solrac-session-"));
    dirs.push(dir);

    {
      const db = await openDb(dir);
      const sessions = createSessionStore(db);
      sessions.setSessionId(100, "primary", "primary-uuid");
      sessions.setSessionId(100, "secondary", "secondary-uuid");
      sessions.setSessionId(200, "primary", "other-chat-primary");
      db.close();
    }

    const db2 = await openDb(dir);
    dbs.push(db2);
    const sessions2 = createSessionStore(db2);
    expect(sessions2.getSessionId(100, "primary")).toBe("primary-uuid");
    expect(sessions2.getSessionId(100, "secondary")).toBe("secondary-uuid");
    expect(sessions2.getSessionId(200, "primary")).toBe("other-chat-primary");
    expect(sessions2.getSessionId(200, "secondary")).toBeNull();
  });

  test("unknown chat returns null for both tiers", async () => {
    const { db } = await newDb();
    const sessions = createSessionStore(db);
    expect(sessions.getSessionId(999, "primary")).toBeNull();
    expect(sessions.getSessionId(999, "secondary")).toBeNull();
  });

  test("setSessionId overwrites the same tier", async () => {
    const { db } = await newDb();
    const sessions = createSessionStore(db);
    sessions.setSessionId(100, "primary", "first");
    sessions.setSessionId(100, "primary", "second");
    expect(sessions.getSessionId(100, "primary")).toBe("second");
  });

  test("getSession returns both tier ids on the same row", async () => {
    const { db } = await newDb();
    const sessions = createSessionStore(db);
    sessions.setSessionId(100, "primary", "p");
    sessions.setSessionId(100, "secondary", "s");
    const row = sessions.getSession(100);
    expect(row).not.toBeNull();
    expect(row).toMatchObject({
      chatId: 100,
      primarySessionId: "p",
      secondarySessionId: "s",
    });
  });

  test("getSession returns null for an unknown chat", async () => {
    const { db } = await newDb();
    const sessions = createSessionStore(db);
    expect(sessions.getSession(999)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PNX-167 — summary CRUD + clearSessionId/clearAll
// ---------------------------------------------------------------------------

describe("createSessionStore (PNX-167 summary + clear paths)", () => {
  test("setSummary then getSummary round-trips", async () => {
    const { db } = await newDb();
    const sessions = createSessionStore(db);
    sessions.setSummary(100, "primary", "primary summary text", 1700);
    expect(sessions.getSummary(100, "primary")).toEqual({
      text: "primary summary text",
      at: 1700,
    });
    // Secondary tier independent.
    expect(sessions.getSummary(100, "secondary")).toBeNull();
  });

  test("primary and secondary summaries are independent", async () => {
    const { db } = await newDb();
    const sessions = createSessionStore(db);
    sessions.setSummary(100, "primary", "p-sum", 100);
    sessions.setSummary(100, "secondary", "s-sum", 200);
    expect(sessions.getSummary(100, "primary")).toEqual({ text: "p-sum", at: 100 });
    expect(sessions.getSummary(100, "secondary")).toEqual({ text: "s-sum", at: 200 });
  });

  test("setSummary overwrites existing tier summary", async () => {
    const { db } = await newDb();
    const sessions = createSessionStore(db);
    sessions.setSummary(100, "primary", "first", 100);
    sessions.setSummary(100, "primary", "second", 200);
    expect(sessions.getSummary(100, "primary")).toEqual({ text: "second", at: 200 });
  });

  test("clearSummary removes only the tier summary, leaves session id intact", async () => {
    const { db } = await newDb();
    const sessions = createSessionStore(db);
    sessions.setSessionId(100, "primary", "p-uuid");
    sessions.setSummary(100, "primary", "summary-text", 100);
    sessions.clearSummary(100, "primary");
    expect(sessions.getSummary(100, "primary")).toBeNull();
    expect(sessions.getSessionId(100, "primary")).toBe("p-uuid");
  });

  test("clearSummary on a fresh chat is a no-op (no row inserted)", async () => {
    const { db } = await newDb();
    const sessions = createSessionStore(db);
    sessions.clearSummary(999, "primary");
    expect(sessions.getSession(999)).toBeNull();
  });

  test("clearSessionId removes id but leaves the summary", async () => {
    const { db } = await newDb();
    const sessions = createSessionStore(db);
    sessions.setSessionId(100, "primary", "p-uuid");
    sessions.setSummary(100, "primary", "kept", 100);
    sessions.clearSessionId(100, "primary");
    expect(sessions.getSessionId(100, "primary")).toBeNull();
    expect(sessions.getSummary(100, "primary")).toEqual({ text: "kept", at: 100 });
  });

  test("clearAll wipes both id and summary for one tier, leaves the other tier alone", async () => {
    const { db } = await newDb();
    const sessions = createSessionStore(db);
    sessions.setSessionId(100, "primary", "p-uuid");
    sessions.setSessionId(100, "secondary", "s-uuid");
    sessions.setSummary(100, "primary", "p-sum", 100);
    sessions.setSummary(100, "secondary", "s-sum", 200);

    sessions.clearAll(100, "primary");
    expect(sessions.getSessionId(100, "primary")).toBeNull();
    expect(sessions.getSummary(100, "primary")).toBeNull();
    expect(sessions.getSessionId(100, "secondary")).toBe("s-uuid");
    expect(sessions.getSummary(100, "secondary")).toEqual({ text: "s-sum", at: 200 });
  });

  test("getSession returns the new summary fields", async () => {
    const { db } = await newDb();
    const sessions = createSessionStore(db);
    sessions.setSummary(100, "primary", "ptext", 1700);
    sessions.setSummary(100, "secondary", "stext", 1800);
    const row = sessions.getSession(100);
    expect(row).toMatchObject({
      primarySummary: "ptext",
      primarySummaryAt: 1700,
      secondarySummary: "stext",
      secondarySummaryAt: 1800,
    });
  });

  test("ollama cutoff: get returns null when unset, set then get round-trips", async () => {
    const { db } = await newDb();
    const sessions = createSessionStore(db);
    expect(sessions.getOllamaCutoff(100)).toBeNull();
    sessions.setOllamaCutoff(100, 12345);
    expect(sessions.getOllamaCutoff(100)).toBe(12345);
  });

  test("ollama cutoff: setOllamaCutoff upserts on a chat with no prior sessions row", async () => {
    const { db } = await newDb();
    const sessions = createSessionStore(db);
    sessions.setOllamaCutoff(200, 555);
    const row = sessions.getSession(200);
    expect(row).not.toBeNull();
    expect(row!.ollamaCutoffMs).toBe(555);
    expect(row!.primarySessionId).toBeNull();
    expect(row!.secondarySessionId).toBeNull();
  });

  test("ollama cutoff: setOllamaCutoff preserves existing tier columns", async () => {
    const { db } = await newDb();
    const sessions = createSessionStore(db);
    sessions.setSessionId(300, "primary", "p-uuid");
    sessions.setSummary(300, "secondary", "s-sum", 999);
    sessions.setOllamaCutoff(300, 12345);
    const row = sessions.getSession(300);
    expect(row!.primarySessionId).toBe("p-uuid");
    expect(row!.secondarySummary).toBe("s-sum");
    expect(row!.secondarySummaryAt).toBe(999);
    expect(row!.ollamaCutoffMs).toBe(12345);
  });

  test("ollama cutoff: getSession includes ollamaCutoffMs", async () => {
    const { db } = await newDb();
    const sessions = createSessionStore(db);
    sessions.setOllamaCutoff(400, 7777);
    expect(sessions.getSession(400)).toMatchObject({ ollamaCutoffMs: 7777 });
  });
});
