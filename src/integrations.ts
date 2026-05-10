/**
 * @fileoverview Operator-authored + blessed integrations loaded from disk at boot.
 * @purpose Let an operator add Claude-tier tools without touching solrac's
 *          source. An "integration" is a TypeScript module under one of two
 *          dirs (blessed: `src/integrations-builtin/<name>/index.ts`; operator:
 *          `$SOLRAC_INTEGRATIONS_DIR/<name>/index.ts`) that default-exports a
 *          `setup(ctx)` function returning `{ apiVersion, tools, meta? }`. The
 *          loader discovers them at boot only — there is no hot-reload (matches
 *          Solrac's "boot once, never reload" config story; see config.ts).
 *
 * Why filesystem and not DB: integrations are operator-authored code,
 * version-controlled per-deployment. Two dirs (blessed first, operator second)
 * give a clean separation: the runtime ships the *mechanism*, the operator
 * owns the *content*. First-dir-wins on tool-name collisions so a future
 * blessed addition can't be silently shadowed by a stale operator copy.
 *
 * Why pass `ctx` instead of letting integrations import zod / the SDK:
 * Bun's dynamic `import()` resolves bare specifiers from the imported file's
 * location — an integration at `/foo/integrations/linear/index.ts` cannot
 * reach solrac's `node_modules`. By passing `ctx.z` and `ctx.tool`,
 * integrations get the same instances solrac uses without per-integration
 * `npm install zod`. Integrations that need other deps (e.g., `@linear/sdk`)
 * still install them adjacent to their own `index.ts`.
 *
 * The setup function may be async — useful for blessed integrations that
 * dynamic-import optional heavy deps (e.g., gmail's `googleapis`).
 *
 * Position in the dependency graph:
 *   log → integrations → consumed by main
 *
 * Exports:
 *   - `IntegrationContext` — what every setup function receives.
 *   - `IntegrationModule` — what setup returns.
 *   - `IntegrationLoadError` — non-fatal per-integration error.
 *   - `IntegrationLoadResult` — aggregated load output (tools, tiers, errors).
 *   - `IntegrationSource` — one loaded integration's metadata for logging.
 *   - `loadIntegrations(dirs, ctx)` — discovers + invokes setup + collects.
 *   - `EMPTY_INTEGRATION_RESULT` — sentinel used when integrations are off.
 *   - `INTEGRATION_API_VERSION` — `1` (current contract version).
 *
 * Key invariants:
 *   - The loader is fail-soft: a malformed integration adds an error to the
 *     result but does not throw. Boot continues. Only valid tools are
 *     included in `result.tools`.
 *   - Tool names must match `/^[a-z][a-z0-9_]{0,63}$/` — Anthropic's MCP tool
 *     name convention. Integrations naming a tool that fails validation are
 *     rejected entirely; one bad tool poisons its whole module.
 *   - Tool-name collisions: FIRST occurrence wins. The collision is logged
 *     with both source paths so the operator can resolve it deliberately.
 *     This means callers should pass the blessed dir BEFORE the operator dir
 *     so blessed always wins.
 *   - `apiVersion` MUST equal `INTEGRATION_API_VERSION` (currently `1`).
 *     Modules declaring an unknown version are skipped with a clear log line
 *     instead of failing the type system silently.
 *   - Per-tool tier overrides come from `meta.toolTiers`. A tool absent from
 *     that map falls back to `meta.tier` (default for all tools in the
 *     module), and absent there falls back to `"confirm"` (the default for
 *     unknown `mcp__solrac__*` tools applied by `policy.ts::classifyTool`).
 *   - Subdirectories whose name starts with `_` are skipped (reserved for
 *     templates / examples that operators may keep alongside).
 *
 * Gotchas:
 *   - Dynamic `import()` of a `.ts` file works because Bun transpiles on the
 *     fly. Under Node this would fail; solrac is Bun-only.
 *   - The loader walks ONE level deep: `<dir>/<name>/index.ts`. A flat layout
 *     (`<dir>/<name>.ts`) is NOT supported — the per-integration subdirectory
 *     is reserved for companion files (client.ts, formatters.ts, package.json
 *     for integration-local deps).
 *   - `ctx.fetch` is `globalThis.fetch` by default. Tests inject a fake.
 *   - `ctx.env` is `process.env` (full read access). Integrations are
 *     operator-authored trusted code; we do NOT scrub secrets here. The
 *     subprocess env scrub in `agent.ts::sanitizedSubprocessEnv` is for the
 *     SDK's spawned `claude` subprocess, NOT for in-process integrations.
 *
 * Cross-references:
 *   - PLAN.md (solrac-dev) — Phase 1 spec
 *   - docs/USAGE.md#integrations — operator-facing docs (Phase 4)
 *   - src/skills.ts — sister loader for markdown prompt-template skills
 *   - src/policy.ts::classifyTool — `mcp__solrac__*` policy branch (Phase 3)
 */

import { readdirSync, statSync } from "node:fs";
import { join, isAbsolute, resolve } from "node:path";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { log } from "./log.ts";

// ---------------------------------------------------------------------------
// Public types + constants
// ---------------------------------------------------------------------------

export const INTEGRATION_API_VERSION = 1 as const;

export type IntegrationTier = "auto" | "confirm";

/**
 * Per-tool renderer for the confirm-prompt body. Returns **markdown**: the
 * broker converts it to Telegram's HTML subset for the chat client and
 * passes the raw markdown through `markdownSource` so the web UI can render
 * it via `marked.parse` (proper `<ul><li>` list rendering). Integrations
 * are responsible for escaping any user-controlled fields that contain
 * markdown-special characters (backticks, asterisks, brackets) before
 * interpolating. Throwing or returning an empty string falls back to a
 * JSON code block so a formatter bug never blocks the confirm UX.
 */
export type ConfirmFormatter = (input: unknown) => string | Promise<string>;

export interface IntegrationContext {
  /** Zod instance solrac was built against. Use to declare tool input schemas. */
  readonly z: typeof z;
  /** SDK `tool()` factory. Returns a `SdkMcpToolDefinition` for the model. */
  readonly tool: typeof tool;
  /** `globalThis.fetch` by default; tests may inject a stub. */
  readonly fetch: typeof globalThis.fetch;
  /** Solrac's structured logger. Integrations should use namespaced events. */
  readonly log: typeof log;
  /**
   * Process env (read-only view). Integrations may read secrets they own
   * (e.g. `LINEAR_API_KEY`). They MUST NOT log values back through
   * `ctx.log`. Solrac does not scrub secrets here — integrations run as
   * trusted operator code.
   */
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface IntegrationModule {
  readonly apiVersion: typeof INTEGRATION_API_VERSION;
  readonly tools: ReadonlyArray<SdkMcpToolDefinition<any>>;
  readonly meta?: {
    /** Default tier for all tools in this module. Defaults to `"confirm"`. */
    readonly tier?: IntegrationTier;
    /** Per-tool tier override. Wins over `meta.tier`. */
    readonly toolTiers?: Readonly<Record<string, IntegrationTier>>;
    /**
     * Per-tool confirm-prompt formatters. Keys are the short tool name (the
     * same name passed to `ctx.tool()`); the broker strips the
     * `mcp__solrac__` prefix before lookup. When absent for a given tool, the
     * broker falls back to a generic JSON dump of `toolInput`.
     */
    readonly confirmFormatters?: Readonly<Record<string, ConfirmFormatter>>;
  };
}

export type IntegrationSetup = (
  ctx: IntegrationContext,
) => IntegrationModule | Promise<IntegrationModule>;

export interface IntegrationLoadError {
  readonly path: string;
  readonly message: string;
}

export interface IntegrationSource {
  /** Subdirectory name (e.g. `"linear"`). */
  readonly name: string;
  /** Absolute path to the integration's `index.ts`. */
  readonly path: string;
  /** Number of tools this integration contributed (may be 0 if self-gated). */
  readonly toolCount: number;
}

export interface IntegrationLoadResult {
  readonly tools: ReadonlyArray<SdkMcpToolDefinition<any>>;
  /** Map of tool name → effective tier (used by `policy.ts`). */
  readonly toolTiers: ReadonlyMap<string, IntegrationTier>;
  /** Map of short tool name → confirm-prompt formatter (used by the broker). */
  readonly confirmFormatters: ReadonlyMap<string, ConfirmFormatter>;
  readonly errors: ReadonlyArray<IntegrationLoadError>;
  readonly sources: ReadonlyArray<IntegrationSource>;
  readonly loadedCount: number;
}

export const EMPTY_INTEGRATION_RESULT: IntegrationLoadResult = Object.freeze({
  tools: Object.freeze([] as ReadonlyArray<SdkMcpToolDefinition<any>>),
  toolTiers: new Map<string, IntegrationTier>(),
  confirmFormatters: new Map<string, ConfirmFormatter>(),
  errors: Object.freeze([] as ReadonlyArray<IntegrationLoadError>),
  sources: Object.freeze([] as ReadonlyArray<IntegrationSource>),
  loadedCount: 0,
});

// ---------------------------------------------------------------------------
// Naming validation
// ---------------------------------------------------------------------------

// Anthropic's MCP tool-name convention: lowercase, digits, underscore, leading
// alpha. Length cap matches their stated 64-char ceiling for tool names.
// Solrac wraps these in `mcp__solrac__<name>` so the model sees a longer
// string, but we validate the operator-authored portion.
const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

function isValidToolName(name: string): boolean {
  return TOOL_NAME_RE.test(name);
}

// ---------------------------------------------------------------------------
// Module-shape validation
// ---------------------------------------------------------------------------

interface ValidationResult {
  readonly module: IntegrationModule | null;
  readonly error: string | null;
}

function validateModule(raw: unknown): ValidationResult {
  if (raw === null || typeof raw !== "object") {
    return { module: null, error: "setup() did not return an object" };
  }
  const m = raw as Record<string, unknown>;
  if (m.apiVersion !== INTEGRATION_API_VERSION) {
    return {
      module: null,
      error: `unsupported apiVersion: ${String(m.apiVersion)} (expected ${INTEGRATION_API_VERSION})`,
    };
  }
  if (!Array.isArray(m.tools)) {
    return { module: null, error: "module.tools must be an array" };
  }
  for (const t of m.tools) {
    if (!t || typeof t !== "object") {
      return { module: null, error: "every entry in module.tools must be an object" };
    }
    const tt = t as Record<string, unknown>;
    if (typeof tt.name !== "string" || !isValidToolName(tt.name)) {
      return {
        module: null,
        error: `invalid tool name: ${JSON.stringify(tt.name)} (must match ${TOOL_NAME_RE.source})`,
      };
    }
    if (typeof tt.description !== "string" || tt.description.trim() === "") {
      return {
        module: null,
        error: `tool "${tt.name}" must have a non-empty description`,
      };
    }
    if (typeof tt.handler !== "function") {
      return {
        module: null,
        error: `tool "${tt.name}" must have a handler function`,
      };
    }
  }
  // meta is optional; if present, validate shape
  if (m.meta !== undefined) {
    if (typeof m.meta !== "object" || m.meta === null) {
      return { module: null, error: "module.meta must be an object" };
    }
    const meta = m.meta as Record<string, unknown>;
    if (meta.tier !== undefined && meta.tier !== "auto" && meta.tier !== "confirm") {
      return {
        module: null,
        error: `meta.tier must be "auto" or "confirm" (got ${JSON.stringify(meta.tier)})`,
      };
    }
    if (meta.toolTiers !== undefined) {
      if (typeof meta.toolTiers !== "object" || meta.toolTiers === null) {
        return { module: null, error: "meta.toolTiers must be an object" };
      }
      for (const [k, v] of Object.entries(meta.toolTiers)) {
        if (v !== "auto" && v !== "confirm") {
          return {
            module: null,
            error: `meta.toolTiers["${k}"] must be "auto" or "confirm" (got ${JSON.stringify(v)})`,
          };
        }
      }
    }
    if (meta.confirmFormatters !== undefined) {
      if (typeof meta.confirmFormatters !== "object" || meta.confirmFormatters === null) {
        return { module: null, error: "meta.confirmFormatters must be an object" };
      }
      for (const [k, v] of Object.entries(meta.confirmFormatters)) {
        if (typeof v !== "function") {
          return {
            module: null,
            error: `meta.confirmFormatters["${k}"] must be a function`,
          };
        }
      }
    }
  }
  return { module: raw as IntegrationModule, error: null };
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

interface SubdirEntry {
  readonly name: string;
  readonly indexPath: string;
}

function listIntegrationSubdirs(dir: string): SubdirEntry[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: SubdirEntry[] = [];
  for (const name of entries.sort()) {
    if (name.startsWith("_") || name.startsWith(".")) continue;
    const subdir = join(dir, name);
    let isDir: boolean;
    try {
      isDir = statSync(subdir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    const indexPath = join(subdir, "index.ts");
    try {
      statSync(indexPath);
    } catch {
      // No index.ts — skip silently. Operator may keep README.md etc.
      continue;
    }
    out.push({ name, indexPath });
  }
  return out;
}

function resolveAbs(p: string): string {
  return isAbsolute(p) ? p : resolve(p);
}

/**
 * Load integrations from one or more directories.
 *
 * Caller supplies an ordered list of directories. The first dir's tools win
 * on name collisions — pass blessed first, operator second so the runtime's
 * shipped behavior cannot be silently overridden by a stale operator copy.
 *
 * Missing directories are non-fatal: they contribute zero integrations
 * without raising an error. A typo in `SOLRAC_INTEGRATIONS_DIR` is logged
 * by the caller (we don't know the env-var name here).
 *
 * Each integration's setup is awaited individually; setup errors are
 * captured per-integration and reported in `result.errors` rather than
 * aborting the whole load.
 */
export async function loadIntegrations(
  dirs: ReadonlyArray<string>,
  ctx: IntegrationContext,
): Promise<IntegrationLoadResult> {
  const tools: SdkMcpToolDefinition<any>[] = [];
  const toolTiers = new Map<string, IntegrationTier>();
  const confirmFormatters = new Map<string, ConfirmFormatter>();
  const errors: IntegrationLoadError[] = [];
  const sources: IntegrationSource[] = [];
  // Tracks which integration registered each tool name, for collision logging.
  const toolOwners = new Map<string, string>();
  let loadedCount = 0;

  for (const rawDir of dirs) {
    const dir = resolveAbs(rawDir);
    const subdirs = listIntegrationSubdirs(dir);
    for (const sub of subdirs) {
      let mod: { default?: unknown };
      try {
        mod = (await import(sub.indexPath)) as { default?: unknown };
      } catch (err) {
        errors.push({
          path: sub.indexPath,
          message: `import failed: ${(err as Error).message}`,
        });
        continue;
      }
      if (typeof mod.default !== "function") {
        errors.push({
          path: sub.indexPath,
          message: "module must default-export a setup(ctx) function",
        });
        continue;
      }
      let raw: unknown;
      try {
        raw = await (mod.default as IntegrationSetup)(ctx);
      } catch (err) {
        errors.push({
          path: sub.indexPath,
          message: `setup(ctx) threw: ${(err as Error).message}`,
        });
        continue;
      }
      const { module, error } = validateModule(raw);
      if (error !== null || module === null) {
        errors.push({ path: sub.indexPath, message: error ?? "invalid module" });
        continue;
      }

      const defaultTier: IntegrationTier = module.meta?.tier ?? "confirm";
      const overrides = module.meta?.toolTiers ?? {};
      const formatterOverrides = module.meta?.confirmFormatters ?? {};
      let added = 0;
      for (const t of module.tools) {
        const existingOwner = toolOwners.get(t.name);
        if (existingOwner !== undefined) {
          // First wins. Log so the operator can resolve deliberately.
          log.warn("integrations.tool_name_collision", {
            tool: t.name,
            kept: existingOwner,
            dropped: sub.indexPath,
          });
          continue;
        }
        toolOwners.set(t.name, sub.indexPath);
        tools.push(t);
        const tier = overrides[t.name] ?? defaultTier;
        toolTiers.set(t.name, tier);
        const formatter = formatterOverrides[t.name];
        if (formatter !== undefined) {
          confirmFormatters.set(t.name, formatter);
        }
        added++;
      }
      sources.push({
        name: sub.name,
        path: sub.indexPath,
        toolCount: added,
      });
      loadedCount++;
    }
  }

  return {
    tools: Object.freeze(tools),
    toolTiers,
    confirmFormatters,
    errors: Object.freeze(errors),
    sources: Object.freeze(sources),
    loadedCount,
  };
}

// Convenience: emit a one-line boot summary plus per-error warns. Mirrors
// `skills.ts::logSkillLoadResult`.
export function logIntegrationLoadResult(
  dirs: ReadonlyArray<string>,
  result: IntegrationLoadResult,
): void {
  log.info("integrations.loaded", {
    dirs,
    integrations: result.loadedCount,
    tools: result.tools.length,
    errors: result.errors.length,
    names: result.sources.map((s) => s.name),
  });
  for (const e of result.errors) {
    log.warn("integrations.load_error", { path: e.path, message: e.message });
  }
}

// Build a fresh `IntegrationContext` for production use. Tests construct
// their own (typically with a stub `fetch`).
export function createIntegrationContext(): IntegrationContext {
  return Object.freeze({
    z,
    tool,
    fetch: globalThis.fetch,
    log,
    env: process.env as Readonly<Record<string, string | undefined>>,
  });
}
