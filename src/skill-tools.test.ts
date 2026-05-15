/**
 * @fileoverview Unit tests for skill-as-tool dispatcher.
 * @proves Tool definition shape, naming, registry filtering, audit-row tag.
 *
 * Wire-format edge cases live in `local-driver.test.ts`. Tool-loop logic
 * lives in `local-tools.test.ts`. This file scopes to skill-tools shape
 * + filtering invariants that survive the driver abstraction.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LocalSkillDeps } from "./commands.ts";
import { openDb, type SolracDb } from "./db.ts";
import {
  type LocalChatEvent,
  type LocalDriver,
  type LocalStreamChatOpts,
} from "./local-driver.ts";
import { buildSkillTools, SKILL_TOOL_PREFIX } from "./skill-tools.ts";
import type { Skill, SkillRegistry } from "./skills.ts";

const dirs: string[] = [];
let openedDbs: SolracDb[] = [];

beforeEach(() => {
  dirs.length = 0;
  openedDbs = [];
});

afterEach(() => {
  for (const db of openedDbs) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function tempDb(): Promise<SolracDb> {
  const dir = mkdtempSync(join(tmpdir(), "solrac-skilltools-"));
  dirs.push(dir);
  const db = await openDb(dir);
  openedDbs.push(db);
  return db;
}

function fakeSkill(overrides: Partial<Skill> = {}): Skill {
  return Object.freeze({
    name: "tldr",
    description: "Summarize the supplied text in 2-3 sentences.",
    tier: "local" as const,
    body: "Summarize: {{args}}",
    sourcePath: "/test/SKILL.md",
    tool: true,
    maxTurns: 1,
    requires: [] as ReadonlyArray<string>,
    autoAllow: false,
    ...overrides,
  }) as unknown as Skill;
}

function makeRegistry(skills: ReadonlyArray<Skill>): SkillRegistry {
  const byName = new Map(skills.map((s) => [s.name, s]));
  return Object.freeze({
    all: Object.freeze([...skills]),
    get: (name: string) => byName.get(name.toLowerCase()),
    size: () => byName.size,
  }) as unknown as SkillRegistry;
}

function noopDriver(): LocalDriver {
  return {
    backend: "ollama",
    async probe() {
      return { ok: true };
    },
    async *streamChat(_opts: LocalStreamChatOpts): AsyncIterable<LocalChatEvent> {
      yield { kind: "done", inputTokens: null, outputTokens: null };
    },
  };
}

function makeDeps(): LocalSkillDeps {
  return {
    driver: noopDriver(),
    model: "test-m",
    timeoutMs: 1000,
    soul: "you are a test bot",
  };
}

// ---------------------------------------------------------------------------
// buildSkillTools — registry filtering
// ---------------------------------------------------------------------------

describe("buildSkillTools — filtering", () => {
  test("includes only tool:true tier:local skills", async () => {
    const db = await tempDb();
    const localSkillDeps = makeDeps();
    const registry = makeRegistry([
      fakeSkill({ name: "tool_local", tier: "local", tool: true }),
      fakeSkill({ name: "slash_only", tier: "local", tool: false }),
      fakeSkill({ name: "primary_tool", tier: "primary", tool: true }),
      fakeSkill({ name: "primary_slash", tier: "primary", tool: false }),
    ]);
    const tools = buildSkillTools(registry, { db, localSkillDeps });
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe(`${SKILL_TOOL_PREFIX}tool_local`);
  });

  test("returns empty when registry has no eligible skills", async () => {
    const db = await tempDb();
    const localSkillDeps = makeDeps();
    const registry = makeRegistry([fakeSkill({ name: "slash", tier: "local", tool: false })]);
    const tools = buildSkillTools(registry, { db, localSkillDeps });
    expect(tools).toHaveLength(0);
  });

  test("returns empty when localSkillDeps is null even with eligible skills", async () => {
    const db = await tempDb();
    const registry = makeRegistry([fakeSkill({ name: "x", tier: "local", tool: true })]);
    const tools = buildSkillTools(registry, { db, localSkillDeps: null });
    expect(tools).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tool definition shape
// ---------------------------------------------------------------------------

describe("buildSkillTools — tool definition shape", () => {
  test("name, description, schema match skill metadata", async () => {
    const db = await tempDb();
    const skill = fakeSkill({ name: "summarize", description: "Summarize text." });
    const tools = buildSkillTools(makeRegistry([skill]), { db, localSkillDeps: makeDeps() });
    expect(tools[0]!.name).toBe(`${SKILL_TOOL_PREFIX}summarize`);
    expect(tools[0]!.description).toBe("Summarize text.");
    expect(Object.keys(tools[0]!.inputSchema)).toContain("args");
  });
});
