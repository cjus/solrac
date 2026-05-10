/**
 * @fileoverview Unit tests for the operator-authored integrations loader.
 * @proves Discovery, contract validation, fail-soft error handling, dir
 *         ordering / first-wins collision semantics, per-tool tier
 *         resolution, apiVersion gating.
 *
 * Integrations are loaded once at boot via dynamic `import()` of TS files
 * the operator drops on disk. A regression that silently drops a valid
 * integration — or accepts a malformed one — is hard to notice without
 * these tests. The integration is just "missing" until someone tries to
 * use the tool.
 *
 * The tests write real `.ts` files to a temp directory and import them
 * through the loader; this is the actual code path used at boot. No
 * mocking of `import()`. Bun transpiles the on-disk `.ts` at import time.
 *
 * Scenarios covered:
 *
 *   discovery:
 *     - Missing directory → no errors, zero loaded.
 *     - Empty directory → zero loaded.
 *     - Subdirectory without `index.ts` is silently skipped.
 *     - Subdirectory starting with `_` (template) is skipped.
 *
 *   contract validation (fail-soft, captured in `result.errors`):
 *     - Module without default export.
 *     - Default export is not a function.
 *     - setup(ctx) throws.
 *     - setup(ctx) returns non-object.
 *     - Wrong apiVersion.
 *     - tools is not an array.
 *     - Tool name fails the `[a-z][a-z0-9_]*` regex.
 *     - Tool missing description.
 *     - Tool missing handler.
 *     - meta.tier invalid value.
 *     - meta.toolTiers values invalid.
 *
 *   composition:
 *     - Multiple integrations in one dir → tools merged.
 *     - Multiple dirs → tools merged in order.
 *     - Tool-name collision: FIRST occurrence wins; second is dropped with
 *       a warn (not an error).
 *     - Per-tool tier override beats meta.tier.
 *     - meta.tier missing → defaults to "confirm".
 *     - async setup awaited.
 *
 * Not covered (intentional):
 *   - The actual SDK `tool()` execution — the loader doesn't run handlers.
 *   - Policy classifier behavior — that's `policy.test.ts` (Phase 3).
 *   - Cross-process re-import semantics — solrac is single-process.
 *
 * Cross-references:
 *   - integrations.ts — implementation
 *   - skills.test.ts — sister test file with the same temp-dir pattern
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { log } from "./log.ts";
import {
  BUILTIN_INTEGRATION_NAMES,
  EMPTY_INTEGRATION_RESULT,
  INTEGRATION_API_VERSION,
  loadBuiltinIntegrations,
  loadIntegrations,
  mergeIntegrationResults,
  type IntegrationContext,
} from "./integrations.ts";

const dirs: string[] = [];

beforeEach(() => {
  dirs.length = 0;
});

afterEach(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix = "solrac-integrations-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function writeIntegration(root: string, name: string, content: string): string {
  const sub = join(root, name);
  mkdirSync(sub, { recursive: true });
  const path = join(sub, "index.ts");
  writeFileSync(path, content);
  return path;
}

function makeCtx(): IntegrationContext {
  return Object.freeze({
    z,
    tool,
    fetch: globalThis.fetch,
    log,
    env: process.env as Readonly<Record<string, string | undefined>>,
  });
}

// Reusable integration source snippets. Bun imports these from disk and
// transpiles them, so they must be valid TS that produces a setup function.
//
// The integration imports zod / tool from the modules visible at the file's
// location — but since these temp files are outside the integrations'
// expected directory layout, we use `ctx.z` and `ctx.tool` instead. That
// is the operator's normal path anyway and is what the design is built for.

const VALID_ECHO = `
export default function setup(ctx) {
  return {
    apiVersion: 1,
    tools: [
      ctx.tool(
        "echo_say",
        "Echo input back",
        { msg: ctx.z.string() },
        async (args) => ({ content: [{ type: "text", text: args.msg }] }),
      ),
    ],
    meta: { tier: "auto" },
  };
}
`;

const VALID_TIME = `
export default function setup(ctx) {
  return {
    apiVersion: 1,
    tools: [
      ctx.tool(
        "time_now",
        "Current ISO timestamp",
        {},
        async () => ({ content: [{ type: "text", text: new Date().toISOString() }] }),
      ),
    ],
  };
}
`;

const ASYNC_SETUP = `
export default async function setup(ctx) {
  await Promise.resolve();
  return {
    apiVersion: 1,
    tools: [
      ctx.tool(
        "async_one",
        "Async tool",
        {},
        async () => ({ content: [{ type: "text", text: "ok" }] }),
      ),
    ],
  };
}
`;

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

describe("loadIntegrations — discovery", () => {
  test("missing directory → no errors, zero loaded", async () => {
    const result = await loadIntegrations(["/nonexistent/path"], makeCtx());
    expect(result.loadedCount).toBe(0);
    expect(result.tools.length).toBe(0);
    expect(result.errors.length).toBe(0);
  });

  test("empty directory → zero loaded, no errors", async () => {
    const dir = tempDir();
    const result = await loadIntegrations([dir], makeCtx());
    expect(result.loadedCount).toBe(0);
    expect(result.errors.length).toBe(0);
  });

  test("subdirectory without index.ts is silently skipped", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "noindex"), { recursive: true });
    writeFileSync(join(dir, "noindex", "README.md"), "no index here");
    const result = await loadIntegrations([dir], makeCtx());
    expect(result.loadedCount).toBe(0);
    expect(result.errors.length).toBe(0);
  });

  test("subdirectory starting with _ is skipped (template convention)", async () => {
    const dir = tempDir();
    writeIntegration(dir, "_template", VALID_ECHO);
    writeIntegration(dir, "real", VALID_ECHO.replace("echo_say", "real_echo"));
    const result = await loadIntegrations([dir], makeCtx());
    expect(result.loadedCount).toBe(1);
    expect(result.sources[0]?.name).toBe("real");
  });

  test("EMPTY_INTEGRATION_RESULT sentinel matches expected shape", () => {
    expect(EMPTY_INTEGRATION_RESULT.loadedCount).toBe(0);
    expect(EMPTY_INTEGRATION_RESULT.tools.length).toBe(0);
    expect(EMPTY_INTEGRATION_RESULT.errors.length).toBe(0);
    expect(EMPTY_INTEGRATION_RESULT.toolTiers.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Contract validation (fail-soft)
// ---------------------------------------------------------------------------

describe("loadIntegrations — contract validation", () => {
  test("module without default export → error", async () => {
    const dir = tempDir();
    writeIntegration(dir, "bad", `export const named = 1;`);
    const result = await loadIntegrations([dir], makeCtx());
    expect(result.loadedCount).toBe(0);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]?.message).toMatch(/setup\(ctx\) function/);
  });

  test("default export is not a function → error", async () => {
    const dir = tempDir();
    writeIntegration(dir, "bad", `export default { not: "a function" };`);
    const result = await loadIntegrations([dir], makeCtx());
    expect(result.errors[0]?.message).toMatch(/setup\(ctx\) function/);
  });

  test("setup throws → error captured", async () => {
    const dir = tempDir();
    writeIntegration(
      dir,
      "throws",
      `export default function () { throw new Error("kaboom"); };`,
    );
    const result = await loadIntegrations([dir], makeCtx());
    expect(result.errors[0]?.message).toMatch(/setup\(ctx\) threw: kaboom/);
  });

  test("setup returns non-object → error", async () => {
    const dir = tempDir();
    writeIntegration(dir, "bad", `export default function () { return 42; };`);
    const result = await loadIntegrations([dir], makeCtx());
    expect(result.errors[0]?.message).toMatch(/did not return an object/);
  });

  test("wrong apiVersion → error", async () => {
    const dir = tempDir();
    writeIntegration(
      dir,
      "old",
      `export default function () { return { apiVersion: 99, tools: [] }; };`,
    );
    const result = await loadIntegrations([dir], makeCtx());
    expect(result.errors[0]?.message).toMatch(/unsupported apiVersion: 99/);
  });

  test("tools is not an array → error", async () => {
    const dir = tempDir();
    writeIntegration(
      dir,
      "bad",
      `export default function () { return { apiVersion: 1, tools: "nope" }; };`,
    );
    const result = await loadIntegrations([dir], makeCtx());
    expect(result.errors[0]?.message).toMatch(/tools must be an array/);
  });

  test("invalid tool name (uppercase, hyphen, leading digit) → error", async () => {
    const dir = tempDir();
    writeIntegration(
      dir,
      "bad",
      `export default function (ctx) {
        return {
          apiVersion: 1,
          tools: [ctx.tool("Bad-Name", "x", {}, async () => ({ content: [] }))],
        };
      };`,
    );
    const result = await loadIntegrations([dir], makeCtx());
    expect(result.errors[0]?.message).toMatch(/invalid tool name/);
  });

  test("meta.tier with bogus value → error", async () => {
    const dir = tempDir();
    writeIntegration(
      dir,
      "bad",
      `export default function (ctx) {
        return {
          apiVersion: 1,
          tools: [ctx.tool("good_name", "x", {}, async () => ({ content: [] }))],
          meta: { tier: "bogus" },
        };
      };`,
    );
    const result = await loadIntegrations([dir], makeCtx());
    expect(result.errors[0]?.message).toMatch(/meta.tier must be/);
  });

  test("meta.toolTiers with bogus value → error", async () => {
    const dir = tempDir();
    writeIntegration(
      dir,
      "bad",
      `export default function (ctx) {
        return {
          apiVersion: 1,
          tools: [ctx.tool("good_name", "x", {}, async () => ({ content: [] }))],
          meta: { toolTiers: { good_name: "weird" } },
        };
      };`,
    );
    const result = await loadIntegrations([dir], makeCtx());
    expect(result.errors[0]?.message).toMatch(/meta.toolTiers/);
  });

  test("meta.confirmFormatters with non-function value → error", async () => {
    const dir = tempDir();
    writeIntegration(
      dir,
      "bad",
      `export default function (ctx) {
        return {
          apiVersion: 1,
          tools: [ctx.tool("good_name", "x", {}, async () => ({ content: [] }))],
          meta: { confirmFormatters: { good_name: "not a function" } },
        };
      };`,
    );
    const result = await loadIntegrations([dir], makeCtx());
    expect(result.errors[0]?.message).toMatch(/meta.confirmFormatters/);
  });

  test("meta.confirmFormatters with valid function aggregates into result", async () => {
    const dir = tempDir();
    writeIntegration(
      dir,
      "good",
      `export default function (ctx) {
        return {
          apiVersion: 1,
          tools: [ctx.tool("good_name", "x", {}, async () => ({ content: [] }))],
          meta: {
            tier: "confirm",
            confirmFormatters: {
              good_name: (input) => "rendered: " + JSON.stringify(input),
            },
          },
        };
      };`,
    );
    const result = await loadIntegrations([dir], makeCtx());
    expect(result.errors.length).toBe(0);
    expect(result.confirmFormatters.size).toBe(1);
    const formatter = result.confirmFormatters.get("good_name");
    expect(typeof formatter).toBe("function");
    const out = await formatter!({ a: 1 });
    expect(out).toBe('rendered: {"a":1}');
  });

  test("one bad integration does not stop the others", async () => {
    const dir = tempDir();
    writeIntegration(dir, "bad", `export default function () { return 42; };`);
    writeIntegration(dir, "good", VALID_ECHO);
    const result = await loadIntegrations([dir], makeCtx());
    expect(result.loadedCount).toBe(1);
    expect(result.errors.length).toBe(1);
    expect(result.tools.length).toBe(1);
    expect(result.tools[0]?.name).toBe("echo_say");
  });
});

// ---------------------------------------------------------------------------
// Composition + ordering + tiers
// ---------------------------------------------------------------------------

describe("loadIntegrations — composition", () => {
  test("multiple integrations in one dir → tools merged", async () => {
    const dir = tempDir();
    writeIntegration(dir, "echo", VALID_ECHO);
    writeIntegration(dir, "time", VALID_TIME);
    const result = await loadIntegrations([dir], makeCtx());
    expect(result.loadedCount).toBe(2);
    expect(result.tools.length).toBe(2);
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual(["echo_say", "time_now"]);
  });

  test("multiple dirs merged in order", async () => {
    const blessed = tempDir("solrac-blessed-");
    const operator = tempDir("solrac-operator-");
    writeIntegration(blessed, "time", VALID_TIME);
    writeIntegration(operator, "echo", VALID_ECHO);
    const result = await loadIntegrations([blessed, operator], makeCtx());
    expect(result.loadedCount).toBe(2);
    // Source order reflects load order: blessed first.
    expect(result.sources.map((s) => s.name)).toEqual(["time", "echo"]);
  });

  test("tool-name collision: first dir wins, second dropped (no error)", async () => {
    const blessed = tempDir("solrac-blessed-");
    const operator = tempDir("solrac-operator-");
    // Both define `echo_say`. Blessed (first) keeps it.
    writeIntegration(blessed, "echo", VALID_ECHO);
    writeIntegration(operator, "echo", VALID_ECHO);
    const result = await loadIntegrations([blessed, operator], makeCtx());
    // Both integrations register as sources; only one tool survives.
    expect(result.loadedCount).toBe(2);
    expect(result.tools.length).toBe(1);
    expect(result.errors.length).toBe(0); // collision is a warn, not an error
    // Second source's toolCount is 0 because its tool was dropped.
    expect(result.sources[0]?.toolCount).toBe(1);
    expect(result.sources[1]?.toolCount).toBe(0);
  });

  test("per-tool tier override beats meta.tier", async () => {
    const dir = tempDir();
    writeIntegration(
      dir,
      "mixed",
      `export default function (ctx) {
        return {
          apiVersion: 1,
          tools: [
            ctx.tool("read_op", "r", {}, async () => ({ content: [] })),
            ctx.tool("write_op", "w", {}, async () => ({ content: [] })),
          ],
          meta: { tier: "auto", toolTiers: { write_op: "confirm" } },
        };
      };`,
    );
    const result = await loadIntegrations([dir], makeCtx());
    expect(result.toolTiers.get("read_op")).toBe("auto");
    expect(result.toolTiers.get("write_op")).toBe("confirm");
  });

  test("missing meta.tier defaults to confirm", async () => {
    const dir = tempDir();
    writeIntegration(dir, "plain", VALID_TIME);
    const result = await loadIntegrations([dir], makeCtx());
    expect(result.toolTiers.get("time_now")).toBe("confirm");
  });

  test("async setup is awaited", async () => {
    const dir = tempDir();
    writeIntegration(dir, "async", ASYNC_SETUP);
    const result = await loadIntegrations([dir], makeCtx());
    expect(result.loadedCount).toBe(1);
    expect(result.tools[0]?.name).toBe("async_one");
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("INTEGRATION_API_VERSION", () => {
  test("is 1 (current contract version)", () => {
    expect(INTEGRATION_API_VERSION).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Builtin static-import registry (PNX-168 Bun packaging)
// ---------------------------------------------------------------------------

// Builtin tests temporarily clear NOTION_API_KEY so the notion setup's probe
// doesn't fire against whatever token the dev has in their shell (avoids a
// 3s network timeout per test, plus avoids real API calls). Gmail self-gates
// on credentials.json existence, not env, so no env scrub needed there.
function makeBuiltinCtx(): IntegrationContext {
  return Object.freeze({
    z,
    tool,
    fetch: globalThis.fetch,
    log,
    env: process.env as Readonly<Record<string, string | undefined>>,
  });
}

describe("loadBuiltinIntegrations", () => {
  let savedNotionKey: string | undefined;
  beforeEach(() => {
    savedNotionKey = process.env.NOTION_API_KEY;
    delete process.env.NOTION_API_KEY;
  });
  afterEach(() => {
    if (savedNotionKey === undefined) delete process.env.NOTION_API_KEY;
    else process.env.NOTION_API_KEY = savedNotionKey;
  });

  test("loads all three blessed builtins (notion, gmail, time)", async () => {
    const result = await loadBuiltinIntegrations(makeBuiltinCtx());
    expect(result.loadedCount).toBe(3);
    expect(result.errors).toEqual([]);
    expect(result.sources.map((s) => s.name).sort()).toEqual(["gmail", "notion", "time"]);
  });

  test("each source path uses the synthetic <builtin>:<name> label", async () => {
    const result = await loadBuiltinIntegrations(makeBuiltinCtx());
    for (const s of result.sources) {
      expect(s.path).toBe(`<builtin>:${s.name}`);
    }
  });

  test("time_now is registered (notion + gmail self-gate without credentials so may register zero tools)", async () => {
    const result = await loadBuiltinIntegrations(makeBuiltinCtx());
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("time_now");
  });

  test("toolSources maps each registered tool to its <builtin>:<name> label", async () => {
    const result = await loadBuiltinIntegrations(makeBuiltinCtx());
    for (const t of result.tools) {
      const src = result.toolSources.get(t.name);
      expect(src).toMatch(/^<builtin>:/);
    }
  });
});

describe("BUILTIN_INTEGRATION_NAMES", () => {
  test("matches the blessed registry contents in declaration order", () => {
    expect(BUILTIN_INTEGRATION_NAMES).toEqual(["notion", "gmail", "time"]);
  });
});

// ---------------------------------------------------------------------------
// mergeIntegrationResults
// ---------------------------------------------------------------------------

describe("mergeIntegrationResults", () => {
  test("merges two non-overlapping results", async () => {
    const dirA = tempDir();
    writeIntegration(dirA, "echo", VALID_ECHO);
    const dirB = tempDir();
    writeIntegration(dirB, "time", VALID_TIME);
    const a = await loadIntegrations([dirA], makeCtx());
    const b = await loadIntegrations([dirB], makeCtx());
    const merged = mergeIntegrationResults(a, b);
    expect(merged.loadedCount).toBe(2);
    expect(merged.tools.map((t) => t.name).sort()).toEqual(["echo_say", "time_now"]);
    expect(merged.errors).toEqual([]);
  });

  test("first-wins on cross-result tool-name collisions", async () => {
    // Both results register "echo_say" — the second's copy is dropped on merge.
    const dirA = tempDir();
    writeIntegration(dirA, "first", VALID_ECHO);
    const dirB = tempDir();
    writeIntegration(dirB, "second", VALID_ECHO);
    const first = await loadIntegrations([dirA], makeCtx());
    const second = await loadIntegrations([dirB], makeCtx());
    const merged = mergeIntegrationResults(first, second);
    expect(merged.tools.length).toBe(1);
    // The kept tool comes from the first result.
    expect(merged.toolSources.get("echo_say")).toBe(first.toolSources.get("echo_say"));
  });

  test("concatenates errors and sources from each result", async () => {
    const dirA = tempDir();
    writeIntegration(dirA, "good", VALID_TIME);
    writeIntegration(dirA, "bad", `export const x = 1;`); // no default export
    const a = await loadIntegrations([dirA], makeCtx());
    const b = EMPTY_INTEGRATION_RESULT;
    const merged = mergeIntegrationResults(a, b);
    expect(merged.errors.length).toBe(1);
    expect(merged.sources.length).toBe(1);
  });

  test("merging zero arguments returns an empty result", () => {
    const merged = mergeIntegrationResults();
    expect(merged.loadedCount).toBe(0);
    expect(merged.tools.length).toBe(0);
    expect(merged.errors.length).toBe(0);
  });
});
