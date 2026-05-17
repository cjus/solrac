/**
 * @fileoverview Unit tests for skill-as-tool dispatcher.
 * @proves Tool definition shape, naming, registry filtering, audit-row tag.
 *
 * Wire-format edge cases live in `local-driver.test.ts` /
 * `remote-driver.test.ts`. Tool-loop logic lives in `engine-tools.test.ts`.
 * This file scopes to skill-tools shape + filtering invariants that survive
 * the driver abstraction.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineSkillDeps } from "./commands.ts";
import { openDb, type SolracDb } from "./db.ts";
import {
  type EngineChatEvent,
  type EngineDriver,
  type EngineStreamChatOpts,
} from "./engine-driver.ts";
import {
  buildSkillErrorPayload,
  buildSkillTools,
  SKILL_TOOL_PREFIX,
} from "./skill-tools.ts";
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

function noopDriver(): EngineDriver {
  return {
    backend: "ollama",
    mode: "local",
    async probe() {
      return { ok: true };
    },
    async *streamChat(_opts: EngineStreamChatOpts): AsyncIterable<EngineChatEvent> {
      yield { kind: "done", inputTokens: null, outputTokens: null , costUsd: null };
    },
  };
}

function makeDeps(): EngineSkillDeps {
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

describe("buildSkillErrorPayload", () => {
  // Regression coverage for v0.7.0 dogfooding: weak local models (gpt-oss-20b
  // under LMStudio) treated bare `{success:false, error:"iteration_cap"}`
  // envelopes as transient and retried 3-4× before the loop detector tripped.
  // The hardened payload makes the non-retryability explicit so the parent
  // model abandons the skill on the FIRST failure and produces a final answer.
  test("returns valid MCP content shape with success:false JSON body", () => {
    const payload = buildSkillErrorPayload("tldr", "iteration_cap");
    expect(payload.content).toHaveLength(1);
    expect(payload.content[0]!.type).toBe("text");
    const parsed = JSON.parse(payload.content[0]!.text) as Record<string, unknown>;
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe("iteration_cap");
  });

  test("marks retryable:false and surfaces explicit don't-retry hint", () => {
    const payload = buildSkillErrorPayload("tldr", "iteration_cap");
    const parsed = JSON.parse(payload.content[0]!.text) as Record<string, unknown>;
    expect(parsed.retryable).toBe(false);
    expect(parsed.hint).toContain("Do not call 'skills__tldr' again");
    expect(parsed.hint).toContain("same input produces the same result");
  });

  test("hint references the specific skill name (so multi-skill turns disambiguate)", () => {
    const a = buildSkillErrorPayload("tldr", "x");
    const b = buildSkillErrorPayload("summarize", "x");
    const ha = (JSON.parse(a.content[0]!.text) as { hint: string }).hint;
    const hb = (JSON.parse(b.content[0]!.text) as { hint: string }).hint;
    expect(ha).toContain("skills__tldr");
    expect(ha).not.toContain("skills__summarize");
    expect(hb).toContain("skills__summarize");
    expect(hb).not.toContain("skills__tldr");
  });

  test("preserves arbitrary error strings verbatim (not just iteration_cap)", () => {
    const payload = buildSkillErrorPayload(
      "tldr",
      "chat_cost_cap: $1.0001 ≥ $1.00/hr for this chat",
    );
    const parsed = JSON.parse(payload.content[0]!.text) as { error: string };
    expect(parsed.error).toBe("chat_cost_cap: $1.0001 ≥ $1.00/hr for this chat");
  });
});
