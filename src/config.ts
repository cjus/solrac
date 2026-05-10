/**
 * @fileoverview Environment-variable validation and frozen config object.
 * @purpose Parse env once at boot, fail loud with the FULL list of missing
 *          required vars (not just the first), and freeze the result so no
 *          downstream code can mutate it.
 *
 * Solrac's config story is "boot once, never reload" — see
 * docs/CONFIG.md#reload-behavior for why hot-reloading config is intentionally
 * unimplemented. Every consumer reads from the frozen `Config` object and
 * trusts its types; runtime drift between processes is a worse failure than
 * a 2-second restart.
 *
 * The two non-env constants exported here (`MAX_AUDIT_PROMPT_LEN`,
 * `MAX_CHAT_QUEUE_DEPTH`) are defensive policy values, NOT operator knobs.
 * They live in this file because they're read by multiple modules and need a
 * single source of truth; they aren't env-tunable in v1 because changing them
 * needs threat-model context (see docs/ARCHITECTURE.md#db-pollution-defenses).
 *
 * Position in the dependency graph:
 *   (no internal deps) → config → consumed by main, agent, queue, policy
 *
 * Exports:
 *   - `Config` — frozen typed shape returned by loadConfig.
 *   - `loadConfig(env?)` — parse env, validate, freeze, return.
 *   - `MAX_AUDIT_PROMPT_LEN` — 256-char cap on `audit.prompt`.
 *   - `MAX_CHAT_QUEUE_DEPTH` — 10-deep cap on per-chat KeyedMutex chain.
 *
 * Key invariants:
 *   - Required vars (`ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`,
 *     `ALLOWLIST_BOOTSTRAP`) must be present and non-blank or boot throws.
 *   - When `SOLRAC_TRANSPORT=webhook`, `TG_WEBHOOK_SECRET` must be ≥32 chars.
 *   - The returned object is `Object.freeze`d; `allowlistBootstrap` is also
 *     frozen — there is no runtime mutation path.
 *   - Missing vars are reported as a single `Missing required env vars: A, B, C`
 *     error (full list, not first-fail). Operators fixing dev envs save time.
 *
 * Gotchas:
 *   - `loadConfig(env)` defaults to `process.env` but accepts an override —
 *     useful for tests; do NOT use to "patch" config at runtime in production.
 *   - Numeric coercion is strict: `parsePositiveInt("PORT", "8443.5", 8443)`
 *     throws because non-integer floats fail the int check.
 *
 * Cross-references:
 *   - docs/CONFIG.md — full env reference with defaults and validation rules
 *   - .env.example — template
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

type Transport = "poll" | "webhook";

// Engine selected when a user message has no `@` or `!` prefix. Mirrors
// `policy.Engine` minus the wire-prefix coupling: kept as its own string-set
// here so config.ts has zero internal deps. Default `"ollama"` since PR-B —
// Anthropic burn happens only on a deliberate `@` (Sonnet) or `!` (Opus).
export type DefaultEngine = "ollama" | "primary" | "secondary";

// Cap on prompt text persisted to the audit table. A single user can flood
// strings of arbitrary length; truncating before insert bounds per-row size.
// Not env-tunable in v1 — the value is a defensive constant, not policy.
export const MAX_AUDIT_PROMPT_LEN = 256;

// Max waiting tasks per chat in the turn queue. Beyond this the update is
// dropped (with an audit row) so a single allowed user can't pin the queue
// by pasting hundreds of lines that each spawn a turn.
export const MAX_CHAT_QUEUE_DEPTH = 10;

export interface Config {
  readonly anthropicApiKey: string;
  readonly telegramBotToken: string;
  readonly allowlistBootstrap: readonly number[];
  readonly transport: Transport;
  readonly port: number;
  // Absolute path to the solrac "home" directory — where SOUL.md, SOLRAC.md,
  // the SQLite data dir, and operator subdirectories (skills/tasks/integrations)
  // live by default. Resolution order: explicit `SOLRAC_HOME` env > cwd if it
  // contains a SOUL.md (the dev workflow: a clean clone has it checked-in) >
  // `~/.solrac/` (packaged-binary default). All other path-like configs below
  // resolve relative paths against this dir.
  readonly solracHome: string;
  readonly dataDir: string;
  readonly hourlyCostCapUsd: number;
  readonly globalHourlyCostCapUsd: number;
  readonly maxConcurrentTurns: number;
  // PLAN Step 12: two-tier Claude routing. Primary = the cheap default tier
  // (no prefix or `!`), secondary = the heavyweight tier (`@`). Each must be
  // a valid Anthropic model id; the SDK rejects unknown ids at query time.
  // No fallback: replaces the pre-Step-12 single `SOLRAC_MODEL` env var.
  readonly primaryModel: string;
  readonly secondaryModel: string;
  readonly statsBearerToken: string | null;
  readonly tgWebhookSecret: string | null;
  // PR-B — engine routing inversion. Picks the engine for messages with no
  // `@` or `!` prefix. Default `"ollama"` shifts cost to $0 by default;
  // operators on hosts that can't run Ollama set `"primary"` (or
  // `"secondary"`). Boot validates: `"ollama"` requires `ollamaEnabled`;
  // anything else with `ollamaToolsEnabled=true` is rejected (Ollama is
  // unreachable when it's not the default since PR-B removed the `>` prefix).
  readonly defaultEngine: DefaultEngine;
  // True when the operator set `SOLRAC_DEFAULT_ENGINE` explicitly. Lets
  // main.ts emit a one-release-cycle silent-flip warning so upgrades can't
  // silently route messages to a different engine. Removed in the next minor.
  readonly defaultEngineExplicit: boolean;
  // PLAN Step 11: local-model routing. Off by default. When true,
  // `ollamaModel` MUST be set (validated at boot). PR-B removed the `>`
  // prefix; with `ollamaEnabled=true`, Ollama is reached via `defaultEngine`.
  readonly ollamaEnabled: boolean;
  readonly ollamaUrl: string;
  readonly ollamaModel: string | null;
  readonly ollamaTimeoutMs: number;
  readonly ollamaHistoryLimit: number;
  // PR-A — Ollama tool-calling. When true (and `integrationsEnabled` is also
  // true), the `>` engine path runs through `runToolLoop` instead of single-
  // shot streaming, exposing the same `mcp__solrac__*` integration tools that
  // Claude tiers see. Default false — tools-on is opt-in for v1. Boot fails
  // loud if `ollamaToolsEnabled && !integrationsEnabled` (no tools to expose).
  readonly ollamaToolsEnabled: boolean;
  // Hard ceiling on tool-loop rounds per turn. 8 is enough for "fetch X then
  // process it then format the answer" multi-step tool use without giving an
  // infinite-loop bug too much rope. Loop detector bites earlier on duplicate
  // calls.
  readonly ollamaMaxToolIterations: number;
  // PNX-167.1 — operator-defined skills loaded from the filesystem at boot.
  // `skillsEnabled` is the master switch; `skillsDir` is resolved from cwd
  // so the same Solrac binary can ship to multiple operators each with their
  // own skills directory layout. Default `./skills` matches the convention
  // for `./data` (dataDir).
  readonly skillsEnabled: boolean;
  readonly skillsDir: string;
  // Scheduled tasks (PLAN). Off by default. When on, the scheduler loads
  // `<tasksDir>/<name>/TASK.md` files at boot and fires them on a per-task
  // schedule (`every <duration>`, `daily_at HH:MM`, `at <ISO8601>`). Same
  // cwd-relative convention as skills/integrations. Tasks fire as synthetic
  // updates through the same turn queue, so cost caps + allowlist gate +
  // policy hooks all apply automatically.
  readonly tasksEnabled: boolean;
  readonly tasksDir: string;
  // Operator-authored integrations (Phase 1). `integrationsEnabled` is the
  // master switch; when off, neither blessed (`src/integrations-builtin/`)
  // nor operator integrations (`integrationsDir`) load — solrac runs with
  // the same SDK preset tool surface as before. When on, both sources are
  // discovered. Default `./integrations` matches the `./skills` convention
  // for cwd-relative operator dirs. Effective for Claude tiers (`@`, `!`)
  // only — Ollama path ignores integrations.
  readonly integrationsEnabled: boolean;
  readonly integrationsDir: string;
  // Web UI transport — second Bun.serve instance on a separate port. When
  // off (default), Solrac is Telegram-only. When on, `webToken` is required
  // even on loopback (a co-tenant on a shared host could otherwise reach the
  // unauthenticated UI). `webPort` must differ from `port` (the ops server).
  // `webChatId` is the synthetic chat id all web traffic shares — kept
  // negative to avoid collision with real Telegram chat ids (always positive
  // for users, negative for groups, but groups are not in the allowlist
  // surface). Default −1000 is far from realistic group ids.
  readonly webEnabled: boolean;
  readonly webHost: string;
  readonly webPort: number;
  readonly webToken: string | null;
  readonly webChatId: number;
}

function parseAllowlist(raw: string): number[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const n = Number(s);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`ALLOWLIST_BOOTSTRAP entry is not a positive integer: "${s}"`);
      }
      return n;
    });
}

function parseTransport(raw: string | undefined): Transport {
  if (raw === undefined || raw === "poll") return "poll";
  if (raw === "webhook") return "webhook";
  throw new Error(`SOLRAC_TRANSPORT must be "poll" or "webhook", got "${raw}"`);
}

function parsePositiveNumber(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive number, got "${raw}"`);
  }
  return n;
}

function parsePositiveInt(name: string, raw: string | undefined, fallback: number): number {
  const n = parsePositiveNumber(name, raw, fallback);
  if (!Number.isInteger(n)) {
    throw new Error(`${name} must be an integer, got "${raw}"`);
  }
  return n;
}

function parseBoolean(name: string, raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  throw new Error(`${name} must be true/false (or 1/0), got "${raw}"`);
}

function parseDefaultEngine(raw: string | undefined): DefaultEngine {
  if (raw === undefined || raw.trim() === "") return "ollama";
  const v = raw.trim().toLowerCase();
  if (v === "ollama" || v === "primary" || v === "secondary") return v;
  throw new Error(
    `SOLRAC_DEFAULT_ENGINE must be "ollama", "primary", or "secondary", got "${raw}"`,
  );
}

/**
 * Resolve `SOLRAC_HOME` to an absolute path. Order:
 *
 *   1. `$SOLRAC_HOME` if set — operator-explicit; resolved against cwd if relative.
 *   2. `process.cwd()` if `SOUL.md` is checked in there — the dev workflow.
 *      A fresh git clone of solrac has SOUL.md at the repo root; running
 *      `bun src/main.ts` or `npm run dev` from there should "just work" with
 *      data + persona files staying inside the checkout.
 *   3. `~/.solrac/` — the packaged-binary default. install.sh creates this
 *      dir; the binary's bootstrap writes embedded SOUL.md/SOLRAC.md here on
 *      first run.
 *
 * The detection is intentionally local-state-aware (existsSync, not a build
 * flag) so the same binary behaves correctly whether it's `bun src/main.ts`
 * in a checkout or `solrac` from `/usr/local/bin/`.
 */
function resolveSolracHome(raw: string | undefined): string {
  if (raw && raw.trim() !== "") return resolve(raw.trim());
  if (existsSync(resolve(process.cwd(), "SOUL.md"))) return process.cwd();
  return resolve(homedir(), ".solrac");
}

/** Resolve `raw` against `home` if relative, return as-is if absolute. */
function resolveAgainstHome(home: string, raw: string): string {
  return isAbsolute(raw) ? raw : resolve(home, raw);
}

function parseNegativeInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n >= 0) {
    throw new Error(`${name} must be a negative integer, got "${raw}"`);
  }
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const required = ["ANTHROPIC_API_KEY", "TELEGRAM_BOT_TOKEN", "ALLOWLIST_BOOTSTRAP"] as const;
  const missing = required.filter((k) => !env[k] || env[k]!.trim() === "");
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }

  const transport = parseTransport(env.SOLRAC_TRANSPORT);
  if (transport === "webhook" && (!env.TG_WEBHOOK_SECRET || env.TG_WEBHOOK_SECRET.length < 32)) {
    throw new Error("TG_WEBHOOK_SECRET must be ≥32 chars when SOLRAC_TRANSPORT=webhook");
  }

  const hourlyCostCapUsd = parsePositiveNumber(
    "HOURLY_COST_CAP_USD",
    env.HOURLY_COST_CAP_USD,
    1.0,
  );
  const maxConcurrentTurns = parsePositiveInt(
    "MAX_CONCURRENT_TURNS",
    env.MAX_CONCURRENT_TURNS,
    4,
  );
  // Default = per-chat cap × concurrency. Per-chat cap is fairness; global is
  // absolute safety. With 4 concurrent chats each at $1/hr cap, hourly burn
  // can hit $4/hr — the global cap intercepts before that becomes $40 if a
  // future bump to MAX_CONCURRENT_TURNS isn't matched here. Operator can
  // override via env to anything stricter or laxer. See docs/CONFIG.md and
  // docs/ARCHITECTURE.md#cost-caps.
  const globalHourlyCostCapUsd = parsePositiveNumber(
    "GLOBAL_HOURLY_COST_CAP_USD",
    env.GLOBAL_HOURLY_COST_CAP_USD,
    hourlyCostCapUsd * maxConcurrentTurns,
  );

  // PLAN Step 11. `OLLAMA_MODEL` is required only when `OLLAMA_ENABLED=true` —
  // the operator has to make an explicit choice (no surprise default model on
  // first run). `OLLAMA_URL` keeps a sensible default so a typical localhost
  // setup works without extra env wiring.
  const ollamaEnabled = parseBoolean("OLLAMA_ENABLED", env.OLLAMA_ENABLED, false);
  const ollamaModel =
    env.OLLAMA_MODEL && env.OLLAMA_MODEL.trim() !== "" ? env.OLLAMA_MODEL.trim() : null;
  if (ollamaEnabled && !ollamaModel) {
    throw new Error("OLLAMA_MODEL is required when OLLAMA_ENABLED=true");
  }
  const ollamaUrl =
    env.OLLAMA_URL && env.OLLAMA_URL.trim() !== ""
      ? env.OLLAMA_URL.trim().replace(/\/$/, "")
      : "http://localhost:11434";
  // Fail-loud at boot if the URL is malformed or uses a non-HTTP scheme.
  // Without this, `OLLAMA_URL=localhost:11434` (missing scheme) or
  // `OLLAMA_URL=ftp://nope` boots happily and only fails at the first `>`
  // turn with a confusing "ollama unreachable" message. URL validation here
  // gives operators an actionable error at startup.
  let ollamaProtocol: string;
  try {
    ollamaProtocol = new URL(ollamaUrl).protocol;
  } catch {
    throw new Error(`OLLAMA_URL is not a valid URL: "${ollamaUrl}"`);
  }
  if (ollamaProtocol !== "http:" && ollamaProtocol !== "https:") {
    throw new Error(`OLLAMA_URL must use http:// or https://, got "${ollamaProtocol}//" in "${ollamaUrl}"`);
  }
  // PR-A: tools-on adds tool-loop rounds (model + tool execution) on top of
  // a single inference. A 60s ceiling that's fine for single-shot can be
  // tight when one mid-loop confirm prompt eats up to 60s on its own —
  // bump the default to 120s when tools are enabled. Operator override
  // (any explicit `OLLAMA_TIMEOUT_MS`) wins regardless.
  const ollamaToolsEnabled = parseBoolean(
    "OLLAMA_TOOLS_ENABLED",
    env.OLLAMA_TOOLS_ENABLED,
    false,
  );
  const ollamaTimeoutDefault = ollamaToolsEnabled ? 120_000 : 60_000;
  const ollamaTimeoutMs = parsePositiveInt(
    "OLLAMA_TIMEOUT_MS",
    env.OLLAMA_TIMEOUT_MS,
    ollamaTimeoutDefault,
  );
  const ollamaHistoryLimit = parsePositiveInt(
    "OLLAMA_HISTORY_LIMIT",
    env.OLLAMA_HISTORY_LIMIT,
    6,
  );
  const ollamaMaxToolIterations = parsePositiveInt(
    "OLLAMA_MAX_TOOL_ITERATIONS",
    env.OLLAMA_MAX_TOOL_ITERATIONS,
    8,
  );
  // Boot guard: tools-on with no integration source = nothing for the model
  // to call. Fail loud at boot rather than silently shipping an empty
  // `tools[]` to /api/chat (which would also work but waste tokens listing
  // nothing).
  const integrationsEnabled = parseBoolean(
    "SOLRAC_INTEGRATIONS_ENABLED",
    env.SOLRAC_INTEGRATIONS_ENABLED,
    false,
  );
  if (ollamaToolsEnabled && !integrationsEnabled) {
    throw new Error(
      "OLLAMA_TOOLS_ENABLED=true requires SOLRAC_INTEGRATIONS_ENABLED=true; " +
        "set SOLRAC_INTEGRATIONS_ENABLED=true to load tools, or " +
        "OLLAMA_TOOLS_ENABLED=false to keep the single-shot Ollama path",
    );
  }

  // PR-B — default-engine validation. Two cells of the §3c capability matrix
  // are unreachable; refuse them at boot rather than letting them run with
  // confusing UX (Ollama unreachable, or a default engine that errors every
  // turn).
  const defaultEngine = parseDefaultEngine(env.SOLRAC_DEFAULT_ENGINE);
  const defaultEngineExplicit =
    env.SOLRAC_DEFAULT_ENGINE !== undefined && env.SOLRAC_DEFAULT_ENGINE.trim() !== "";
  if (defaultEngine === "ollama" && !ollamaEnabled) {
    throw new Error(
      "SOLRAC_DEFAULT_ENGINE=ollama requires OLLAMA_ENABLED=true; " +
        "set OLLAMA_ENABLED=true (and OLLAMA_MODEL=<model>) to run Ollama as the default, or " +
        "SOLRAC_DEFAULT_ENGINE=primary to make Anthropic Sonnet the default",
    );
  }
  if (defaultEngine !== "ollama" && ollamaToolsEnabled) {
    throw new Error(
      `SOLRAC_DEFAULT_ENGINE=${defaultEngine} with OLLAMA_TOOLS_ENABLED=true is unreachable: ` +
        "the `>` prefix was removed in PR-B, so Ollama only runs when it's the default. " +
        "Set OLLAMA_TOOLS_ENABLED=false or SOLRAC_DEFAULT_ENGINE=ollama",
    );
  }

  const webEnabled = parseBoolean("SOLRAC_WEB_ENABLED", env.SOLRAC_WEB_ENABLED, false);
  const webPort = parsePositiveInt("SOLRAC_WEB_PORT", env.SOLRAC_WEB_PORT, 8080);
  const webHost =
    env.SOLRAC_WEB_HOST && env.SOLRAC_WEB_HOST.trim() !== ""
      ? env.SOLRAC_WEB_HOST.trim()
      : "127.0.0.1";
  const webToken =
    env.SOLRAC_WEB_TOKEN && env.SOLRAC_WEB_TOKEN.trim() !== ""
      ? env.SOLRAC_WEB_TOKEN.trim()
      : null;
  const webChatId = parseNegativeInt("SOLRAC_WEB_CHAT_ID", env.SOLRAC_WEB_CHAT_ID, -1000);
  const port = parsePositiveInt("PORT", env.PORT, 8443);
  if (webEnabled) {
    if (!webToken) {
      throw new Error(
        "SOLRAC_WEB_TOKEN is required when SOLRAC_WEB_ENABLED=true (use `openssl rand -hex 32` to generate one)",
      );
    }
    if (webPort === port) {
      throw new Error(
        `SOLRAC_WEB_PORT (${webPort}) must differ from PORT (${port}); the ops server and the web UI cannot share a port`,
      );
    }
  }

  const solracHome = resolveSolracHome(env.SOLRAC_HOME);
  const dataDirRaw =
    env.DATA_DIR && env.DATA_DIR.trim() !== "" ? env.DATA_DIR.trim() : "./data";
  const skillsDirRaw =
    env.SOLRAC_SKILLS_DIR && env.SOLRAC_SKILLS_DIR.trim() !== ""
      ? env.SOLRAC_SKILLS_DIR.trim()
      : "./skills";
  const tasksDirRaw =
    env.SOLRAC_TASKS_DIR && env.SOLRAC_TASKS_DIR.trim() !== ""
      ? env.SOLRAC_TASKS_DIR.trim()
      : "./tasks";
  const integrationsDirRaw =
    env.SOLRAC_INTEGRATIONS_DIR && env.SOLRAC_INTEGRATIONS_DIR.trim() !== ""
      ? env.SOLRAC_INTEGRATIONS_DIR.trim()
      : "./integrations";

  return Object.freeze({
    anthropicApiKey: env.ANTHROPIC_API_KEY!,
    telegramBotToken: env.TELEGRAM_BOT_TOKEN!,
    allowlistBootstrap: Object.freeze(parseAllowlist(env.ALLOWLIST_BOOTSTRAP!)),
    transport,
    port,
    solracHome,
    dataDir: resolveAgainstHome(solracHome, dataDirRaw),
    hourlyCostCapUsd,
    globalHourlyCostCapUsd,
    maxConcurrentTurns,
    primaryModel:
      env.SOLRAC_PRIMARY_MODEL && env.SOLRAC_PRIMARY_MODEL.trim() !== ""
        ? env.SOLRAC_PRIMARY_MODEL.trim()
        : "claude-sonnet-4-6",
    secondaryModel:
      env.SOLRAC_SECONDARY_MODEL && env.SOLRAC_SECONDARY_MODEL.trim() !== ""
        ? env.SOLRAC_SECONDARY_MODEL.trim()
        : "claude-opus-4-7",
    statsBearerToken: env.STATS_BEARER_TOKEN && env.STATS_BEARER_TOKEN.trim() !== "" ? env.STATS_BEARER_TOKEN : null,
    tgWebhookSecret: env.TG_WEBHOOK_SECRET && env.TG_WEBHOOK_SECRET.trim() !== "" ? env.TG_WEBHOOK_SECRET : null,
    defaultEngine,
    defaultEngineExplicit,
    ollamaEnabled,
    ollamaUrl,
    ollamaModel,
    ollamaTimeoutMs,
    ollamaHistoryLimit,
    ollamaToolsEnabled,
    ollamaMaxToolIterations,
    skillsEnabled: parseBoolean("SOLRAC_SKILLS_ENABLED", env.SOLRAC_SKILLS_ENABLED, false),
    skillsDir: resolveAgainstHome(solracHome, skillsDirRaw),
    tasksEnabled: parseBoolean("SOLRAC_TASKS_ENABLED", env.SOLRAC_TASKS_ENABLED, false),
    tasksDir: resolveAgainstHome(solracHome, tasksDirRaw),
    integrationsEnabled,
    integrationsDir: resolveAgainstHome(solracHome, integrationsDirRaw),
    webEnabled,
    webHost,
    webPort,
    webToken,
    webChatId,
  });
}
