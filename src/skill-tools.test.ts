/**
 * @fileoverview Unit tests for skill-as-tool dispatcher.
 * @proves Tool definition shape, naming, registry filtering, ALS context
 *         propagation, audit row content, AND the load-bearing recursion-
 *         safety invariant: the skill handler's outgoing fetch body has no
 *         `tools` field. If a future change adds tool surface to skill
 *         execution, an Ollama agent calling skills__foo could trigger foo
 *         calling skills__foo → infinite loop. This test catches that
 *         regression at CI time.
 *
 * Cross-references:
 *   - src/skill-tools.ts — implementation
 *   - src/commands.ts::runSkillBare — pure-execution helper invoked by handler
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OllamaSkillDeps } from "./commands.ts";
import { openDb, type SolracDb } from "./db.ts";
import {
  buildSkillTools,
  SKILL_TOOL_PREFIX,
  skillToolCtx,
  skillToolName,
  type SkillToolContext,
} from "./skill-tools.ts";
import type { Skill, SkillRegistry } from "./skills.ts";

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

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
    tier: "ollama",
    body: "Summarize: {{args}}",
    sourcePath: "/test/SKILL.md",
    tool: true,
    ...overrides,
  });
}

function makeRegistry(skills: ReadonlyArray<Skill>): SkillRegistry {
  const byName = new Map(skills.map((s) => [s.name, s]));
  return Object.freeze({
    all: Object.freeze([...skills]),
    get: (name: string) => byName.get(name.toLowerCase()),
    size: () => byName.size,
  });
}

const TEST_CTX: SkillToolContext = Object.freeze({
  chatId: 12345,
  fromId: 67890,
  updateId: 1,
  parentAuditId: 1,
});

// ---------------------------------------------------------------------------
// Naming + prefix
// ---------------------------------------------------------------------------

describe("skillToolName / SKILL_TOOL_PREFIX", () => {
  test("prefixes skill name with skills__", () => {
    expect(skillToolName("tldr")).toBe("skills__tldr");
    expect(skillToolName("foo_bar")).toBe("skills__foo_bar");
  });

  test("prefix constant matches", () => {
    expect(SKILL_TOOL_PREFIX).toBe("skills__");
    expect(skillToolName("x").startsWith(SKILL_TOOL_PREFIX)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildSkillTools — registry filtering
// ---------------------------------------------------------------------------

describe("buildSkillTools — filtering", () => {
  test("includes only tool:true tier:ollama skills", async () => {
    const db = await tempDb();
    const ollamaSkillDeps: OllamaSkillDeps = {
      url: "http://test",
      model: "test-model",
      timeoutMs: 1000,
      soul: "you are a test bot",
    };
    const registry = makeRegistry([
      fakeSkill({ name: "tool_ollama", tier: "ollama", tool: true }),
      fakeSkill({ name: "slash_only", tier: "ollama", tool: false }),
      fakeSkill({ name: "primary_tool", tier: "primary", tool: true as const }),
      fakeSkill({ name: "primary_slash", tier: "primary", tool: false }),
    ]);
    const tools = buildSkillTools(registry, { db, ollamaSkillDeps });
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("skills__tool_ollama");
  });

  test("returns empty when registry has no eligible skills", async () => {
    const db = await tempDb();
    const ollamaSkillDeps: OllamaSkillDeps = {
      url: "http://test",
      model: "test-model",
      timeoutMs: 1000,
      soul: "x",
    };
    const registry = makeRegistry([
      fakeSkill({ name: "slash", tier: "ollama", tool: false }),
    ]);
    const tools = buildSkillTools(registry, { db, ollamaSkillDeps });
    expect(tools).toHaveLength(0);
  });

  test("returns empty when ollamaSkillDeps is null even with eligible skills", async () => {
    const db = await tempDb();
    const registry = makeRegistry([
      fakeSkill({ name: "x", tier: "ollama", tool: true }),
    ]);
    const tools = buildSkillTools(registry, { db, ollamaSkillDeps: null });
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
    const ollamaSkillDeps: OllamaSkillDeps = {
      url: "http://test",
      model: "m",
      timeoutMs: 1000,
      soul: "x",
    };
    const tools = buildSkillTools(makeRegistry([skill]), {
      db,
      ollamaSkillDeps,
    });
    expect(tools[0]!.name).toBe("skills__summarize");
    expect(tools[0]!.description).toBe("Summarize text.");
    // inputSchema is a ZodRawShape; the `args` key must be present.
    expect(Object.keys(tools[0]!.inputSchema)).toContain("args");
  });
});

// ---------------------------------------------------------------------------
// RECURSION SAFETY INVARIANT — outgoing fetch body has no `tools` field
// ---------------------------------------------------------------------------

describe("RECURSION SAFETY — handler fetch body", () => {
  // Capture every outgoing fetch the handler makes so we can assert its body.
  // If a future change accidentally adds `tools` to the request body (e.g.
  // a "smart skills" refactor), this test fails — and it MUST fail, because
  // a tool-enabled skill could call itself or another tool-callable skill,
  // creating infinite recursion. This is the parser-level guard the design
  // depends on.
  test("outgoing /api/chat body has no `tools` key", async () => {
    const db = await tempDb();
    let captured: { url: string; body: any } | null = null;
    const fakeFetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      captured = {
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      };
      // Return a successful Ollama response so the handler completes.
      return new Response(
        JSON.stringify({
          message: { content: "summary" },
          prompt_eval_count: 10,
          eval_count: 5,
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as unknown as typeof fetch;
    const ollamaSkillDeps: OllamaSkillDeps = {
      url: "http://test",
      model: "m",
      timeoutMs: 5000,
      soul: "you are a test bot",
      fetch: fakeFetch,
    };
    const skill = fakeSkill();
    const tools = buildSkillTools(makeRegistry([skill]), {
      db,
      ollamaSkillDeps,
    });
    // Invoke the handler under the ALS context (matches what
    // runOllamaTurnWithTools does). Without this, the handler errors.
    await skillToolCtx.run(TEST_CTX, async () => {
      await tools[0]!.handler({ args: "hello world" }, undefined);
    });
    expect(captured).not.toBeNull();
    expect(captured!.url).toBe("http://test/api/chat");
    expect(captured!.body).not.toBeNull();
    // THE invariant.
    expect(captured!.body).not.toHaveProperty("tools");
    // Sanity check: the body has the expected fields.
    expect(captured!.body.stream).toBe(false);
    expect(Array.isArray(captured!.body.messages)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Audit row written with origin='tool_call'
// ---------------------------------------------------------------------------

describe("handler writes audit row with origin='tool_call'", () => {
  test("successful invocation produces ok-status audit row", async () => {
    const db = await tempDb();
    const fakeFetch = (async (): Promise<Response> => {
      return new Response(
        JSON.stringify({
          message: { content: "the summary" },
          prompt_eval_count: 100,
          eval_count: 50,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const ollamaSkillDeps: OllamaSkillDeps = {
      url: "http://test",
      model: "test-m",
      timeoutMs: 5000,
      soul: "soul",
      fetch: fakeFetch,
    };
    const skill = fakeSkill({ name: "tldr" });
    const tools = buildSkillTools(makeRegistry([skill]), {
      db,
      ollamaSkillDeps,
    });

    await skillToolCtx.run(TEST_CTX, async () => {
      await tools[0]!.handler({ args: "input text" }, undefined);
    });

    // Audit row exists tagged origin='tool_call' and model includes the
    // skill name. We query with prepared statement via a helper since the
    // direct sqlite handle isn't exposed; use the existing `recentChatTurns`
    // → no, that filters by status; let's use a raw query through the
    // bun:sqlite handle.
    // Workaround: cast to any to access the underlying sqlite handle.
    const rawDb = db.raw;
    const rows = rawDb
      .query<
        { origin: string; model: string; status: string; cost_usd: number },
        [number]
      >(
        "SELECT origin, model, status, cost_usd FROM audit WHERE chat_id = ? ORDER BY started_at DESC LIMIT 1",
      )
      .all(TEST_CTX.chatId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.origin).toBe("tool_call");
    expect(rows[0]!.model).toBe("ollama:test-m:skill:tldr");
    expect(rows[0]!.status).toBe("ok");
    expect(rows[0]!.cost_usd).toBe(0);
  });

  test("error from Ollama produces error-status audit row + error tool result", async () => {
    const db = await tempDb();
    const fakeFetch = (async (): Promise<Response> => {
      return new Response(JSON.stringify({ error: "model not loaded" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const ollamaSkillDeps: OllamaSkillDeps = {
      url: "http://test",
      model: "test-m",
      timeoutMs: 5000,
      soul: "soul",
      fetch: fakeFetch,
    };
    const skill = fakeSkill({ name: "tldr" });
    const tools = buildSkillTools(makeRegistry([skill]), {
      db,
      ollamaSkillDeps,
    });

    let toolResult;
    await skillToolCtx.run(TEST_CTX, async () => {
      toolResult = await tools[0]!.handler({ args: "x" }, undefined);
    });

    expect(toolResult).toBeDefined();
    const text = (toolResult! as any).content[0].text as string;
    const parsed = JSON.parse(text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/model not loaded/);

    const rawDb = db.raw;
    const rows = rawDb
      .query<{ status: string; error_message: string | null }, [number]>(
        "SELECT status, error_message FROM audit WHERE chat_id = ? ORDER BY started_at DESC LIMIT 1",
      )
      .all(TEST_CTX.chatId);
    expect(rows[0]!.status).toBe("error");
    expect(rows[0]!.error_message).toMatch(/model not loaded/);
  });
});

// ---------------------------------------------------------------------------
// ALS context — handler errors when called outside skillToolCtx.run(...)
// ---------------------------------------------------------------------------

describe("handler outside skillToolCtx", () => {
  test("returns structured error when no ALS store is set", async () => {
    const db = await tempDb();
    const ollamaSkillDeps: OllamaSkillDeps = {
      url: "http://test",
      model: "m",
      timeoutMs: 1000,
      soul: "x",
    };
    const skill = fakeSkill();
    const tools = buildSkillTools(makeRegistry([skill]), {
      db,
      ollamaSkillDeps,
    });
    // NOT wrapped in skillToolCtx.run — the handler should fail-loud.
    const result = await tools[0]!.handler({ args: "x" }, undefined);
    const text = (result as any).content[0].text as string;
    const parsed = JSON.parse(text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/outside skillToolCtx/);
  });
});
