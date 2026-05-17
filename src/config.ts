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
// here so config.ts has zero internal deps. Default `"local"` — Anthropic
// burn happens only on a deliberate `@` (Sonnet) or `!` (Opus).
export type DefaultEngine = "local" | "primary" | "secondary";

// Backend driver behind the `local` engine. Required when `LOCAL_ENABLED=true`.
// `null` when local is disabled — downstream code that depends on the backend
// (driver factory, UI label) only runs in the enabled path.
export type LocalBackend = "ollama" | "lmstudio";

// Backend driver behind the `remote` engine slot. Mutually exclusive with
// `LocalBackend` at the operator-config level — only one of LOCAL_ENABLED /
// REMOTE_ENABLED may be true per boot. Today `openrouter` is the only value;
// the type is kept open for future remote providers (vLLM/Anyscale/Together/
// Groq), which all share the OpenAI-compatible wire shape.
export type RemoteBackend = "openrouter";

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
  // Picks the engine for messages with no `@` or `!` prefix. Default
  // `"local"` shifts cost to $0 by default; operators on hosts that can't run
  // a local LLM set `"primary"` (or `"secondary"`). Boot validates: `"local"`
  // requires `localEnabled`; anything else with `localToolsEnabled=true` is
  // rejected (the local engine is unreachable when it's not the default).
  readonly defaultEngine: DefaultEngine;
  // True when the operator set `SOLRAC_DEFAULT_ENGINE` explicitly. Lets
  // main.ts emit a one-release-cycle silent-flip warning so upgrades can't
  // silently route messages to a different engine. Removed in the next minor.
  readonly defaultEngineExplicit: boolean;
  // Local-model routing. Off by default. When true, `localBackend` AND
  // `localModel` MUST be set (validated at boot). The local engine is
  // reached via `defaultEngine="local"`.
  readonly localEnabled: boolean;
  // Backend driver — `null` when local is disabled.
  readonly localBackend: LocalBackend | null;
  readonly localUrl: string;
  readonly localModel: string | null;
  readonly localTimeoutMs: number;
  readonly localHistoryLimit: number;
  // Local tool-calling. When true (and `integrationsEnabled` is also true),
  // the local engine path runs through `runToolLoop` instead of single-shot
  // streaming, exposing the same `mcp__solrac__*` integration tools that
  // Claude tiers see. Default false — tools-on is opt-in. Boot fails loud
  // if `localToolsEnabled && !integrationsEnabled` (no tools to expose).
  readonly localToolsEnabled: boolean;
  // Hard ceiling on tool-loop rounds per turn. 8 is enough for "fetch X then
  // process it then format the answer" multi-step tool use without giving an
  // infinite-loop bug too much rope. Loop detector bites earlier on duplicate
  // calls.
  readonly localMaxToolIterations: number;
  // Remote-engine routing — mutually exclusive with `localEnabled`. When true,
  // the `local` Engine slot dispatches to a hosted provider (OpenRouter) via
  // the same runner + history + cost-cap path that backs Ollama/LMStudio.
  // Boot validation rejects `localEnabled && remoteEnabled`. The runner
  // distinguishes the two via a `mode: "local" | "remote"` flag — the audit
  // tag becomes `remote:<backend>:<model>` and per-turn cost is captured from
  // the backend's usage chunk so the existing per-chat + global hourly caps
  // gate it without additional plumbing.
  readonly remoteEnabled: boolean;
  // Provider — `null` when remote is disabled.
  readonly remoteBackend: RemoteBackend | null;
  // OpenRouter's base URL already contains `/api/v1`; trailing slash stripped
  // by the parser so endpoint composition (`${url}/chat/completions`) is
  // unambiguous.
  readonly remoteBaseUrl: string;
  readonly remoteModel: string | null;
  // `null` when remote is disabled. Subprocess scrub (`agent.ts::
  // sanitizedSubprocessEnv`) removes `REMOTE_*` keys from the Claude SDK's
  // env so the per-token API key never leaks to the SDK subprocess.
  readonly remoteApiKey: string | null;
  readonly remoteTimeoutMs: number;
  readonly remoteHistoryLimit: number;
  readonly remoteMaxToolIterations: number;
  // OpenRouter attribution headers. Defaults send the public solrac repo URL
  // and "solrac" title so usage shows up correctly on OpenRouter's per-model
  // leaderboard; operators with branded forks override.
  readonly remoteHttpReferer: string;
  readonly remoteXTitle: string;
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
  // unconditionally; the local engine exposes them only when
  // `localToolsEnabled=true`.
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
  if (raw === undefined || raw.trim() === "") return "local";
  const v = raw.trim().toLowerCase();
  if (v === "local" || v === "primary" || v === "secondary") return v;
  // Hard-reject the legacy value with an actionable hint. The boot-time
  // OLLAMA_* env-var scan catches the env-var case; this catches operators
  // who only updated some of the rename.
  if (v === "ollama") {
    throw new Error(
      "SOLRAC_DEFAULT_ENGINE=ollama is no longer accepted — " +
        "set SOLRAC_DEFAULT_ENGINE=local and LOCAL_BACKEND=ollama",
    );
  }
  throw new Error(
    `SOLRAC_DEFAULT_ENGINE must be "local", "primary", or "secondary", got "${raw}"`,
  );
}

function parseLocalBackend(raw: string | undefined): LocalBackend | null {
  if (raw === undefined || raw.trim() === "") return null;
  const v = raw.trim().toLowerCase();
  if (v === "ollama" || v === "lmstudio") return v;
  throw new Error(`LOCAL_BACKEND must be "ollama" or "lmstudio", got "${raw}"`);
}

function parseRemoteBackend(raw: string | undefined): RemoteBackend | null {
  if (raw === undefined || raw.trim() === "") return null;
  const v = raw.trim().toLowerCase();
  if (v === "openrouter") return v;
  throw new Error(`REMOTE_BACKEND must be "openrouter", got "${raw}"`);
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
export function resolveSolracHome(raw: string | undefined): string {
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

  // Hard cutover from the Ollama-specific path to the generic local-engine
  // abstraction. Any operator who still has `OLLAMA_*` env vars set has not
  // updated their deploy — fail loud at boot with an actionable hint rather
  // than silently ignoring half their config.
  const legacyOllamaKeys = Object.keys(env)
    .filter((k) => k.startsWith("OLLAMA_"))
    .sort();
  if (legacyOllamaKeys.length > 0) {
    throw new Error(
      `Legacy OLLAMA_* env vars are no longer supported (got: ${legacyOllamaKeys.join(", ")}). ` +
        "Rename to LOCAL_* (e.g. OLLAMA_ENABLED → LOCAL_ENABLED, OLLAMA_MODEL → LOCAL_MODEL) " +
        "and add LOCAL_BACKEND=ollama (or LOCAL_BACKEND=lmstudio).",
    );
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

  // `LOCAL_MODEL` and `LOCAL_BACKEND` are required only when `LOCAL_ENABLED=
  // true` — the operator has to make an explicit choice (no surprise default
  // model or backend on first run). `LOCAL_URL` keeps a backend-aware default
  // so a typical localhost setup works without extra env wiring.
  const localEnabled = parseBoolean("LOCAL_ENABLED", env.LOCAL_ENABLED, false);
  const localBackend = parseLocalBackend(env.LOCAL_BACKEND);
  if (localEnabled && localBackend === null) {
    throw new Error(
      'LOCAL_BACKEND is required when LOCAL_ENABLED=true (set to "ollama" or "lmstudio")',
    );
  }
  const localModel =
    env.LOCAL_MODEL && env.LOCAL_MODEL.trim() !== "" ? env.LOCAL_MODEL.trim() : null;
  if (localEnabled && !localModel) {
    throw new Error("LOCAL_MODEL is required when LOCAL_ENABLED=true");
  }
  // Backend-aware URL default. LMStudio's OpenAI-compat server defaults to
  // :1234; Ollama defaults to :11434. Operator-set `LOCAL_URL` always wins.
  const localUrlDefault =
    localBackend === "lmstudio" ? "http://localhost:1234" : "http://localhost:11434";
  const localUrl =
    env.LOCAL_URL && env.LOCAL_URL.trim() !== ""
      ? env.LOCAL_URL.trim().replace(/\/$/, "")
      : localUrlDefault;
  // Fail-loud at boot if the URL is malformed or uses a non-HTTP scheme.
  // Without this, `LOCAL_URL=localhost:11434` (missing scheme) or
  // `LOCAL_URL=ftp://nope` boots happily and only fails at the first turn
  // with a confusing "local unreachable" message. URL validation here gives
  // operators an actionable error at startup.
  let localProtocol: string;
  try {
    localProtocol = new URL(localUrl).protocol;
  } catch {
    throw new Error(`LOCAL_URL is not a valid URL: "${localUrl}"`);
  }
  if (localProtocol !== "http:" && localProtocol !== "https:") {
    throw new Error(`LOCAL_URL must use http:// or https://, got "${localProtocol}//" in "${localUrl}"`);
  }
  // Tools-on adds tool-loop rounds (model + tool execution) on top of a
  // single inference. A 60s ceiling that's fine for single-shot can be
  // tight when one mid-loop confirm prompt eats up to 60s on its own —
  // bump the default to 120s when tools are enabled. Operator override
  // (any explicit `LOCAL_TIMEOUT_MS`) wins regardless.
  const localToolsEnabled = parseBoolean(
    "LOCAL_TOOLS_ENABLED",
    env.LOCAL_TOOLS_ENABLED,
    false,
  );
  const localTimeoutDefault = localToolsEnabled ? 120_000 : 60_000;
  const localTimeoutMs = parsePositiveInt(
    "LOCAL_TIMEOUT_MS",
    env.LOCAL_TIMEOUT_MS,
    localTimeoutDefault,
  );
  const localHistoryLimit = parsePositiveInt(
    "LOCAL_HISTORY_LIMIT",
    env.LOCAL_HISTORY_LIMIT,
    6,
  );
  const localMaxToolIterations = parsePositiveInt(
    "LOCAL_MAX_TOOL_ITERATIONS",
    env.LOCAL_MAX_TOOL_ITERATIONS,
    8,
  );
  // Boot guard: tools-on with no integration source = nothing for the model
  // to call. Fail loud at boot rather than silently shipping an empty
  // `tools[]` to the backend (which would also work but waste tokens listing
  // nothing).
  const integrationsEnabled = parseBoolean(
    "SOLRAC_INTEGRATIONS_ENABLED",
    env.SOLRAC_INTEGRATIONS_ENABLED,
    false,
  );
  if (localToolsEnabled && !integrationsEnabled) {
    throw new Error(
      "LOCAL_TOOLS_ENABLED=true requires SOLRAC_INTEGRATIONS_ENABLED=true; " +
        "set SOLRAC_INTEGRATIONS_ENABLED=true to load tools, or " +
        "LOCAL_TOOLS_ENABLED=false to keep the single-shot local path",
    );
  }

  // Remote-engine parsing — read alongside local so the cross-mode validations
  // (mutex, default-engine requires one) have both values in scope. The
  // `REMOTE_*` namespace is provider-neutral; today only OpenRouter is
  // supported behind `REMOTE_BACKEND=openrouter`.
  const remoteEnabled = parseBoolean("REMOTE_ENABLED", env.REMOTE_ENABLED, false);
  const remoteBackend = parseRemoteBackend(env.REMOTE_BACKEND);
  if (remoteEnabled && remoteBackend === null) {
    throw new Error(
      'REMOTE_BACKEND is required when REMOTE_ENABLED=true (set to "openrouter")',
    );
  }
  const remoteModel =
    env.REMOTE_MODEL && env.REMOTE_MODEL.trim() !== "" ? env.REMOTE_MODEL.trim() : null;
  if (remoteEnabled && !remoteModel) {
    throw new Error(
      "REMOTE_MODEL is required when REMOTE_ENABLED=true " +
        "(OpenRouter slug, e.g. anthropic/claude-3.5-sonnet, openai/gpt-4o-mini)",
    );
  }
  const remoteApiKey =
    env.REMOTE_API_KEY && env.REMOTE_API_KEY.trim() !== "" ? env.REMOTE_API_KEY.trim() : null;
  if (remoteEnabled && !remoteApiKey) {
    throw new Error(
      "REMOTE_API_KEY is required when REMOTE_ENABLED=true " +
        "(get one at https://openrouter.ai/keys)",
    );
  }
  // Backend-aware base-URL default. OpenRouter's `/api/v1` is the canonical
  // root; operator-set `REMOTE_BASE_URL` always wins (e.g. for an internal
  // proxy or a staging environment).
  const remoteBaseUrlDefault =
    remoteBackend === "openrouter" ? "https://openrouter.ai/api/v1" : "";
  const remoteBaseUrl =
    env.REMOTE_BASE_URL && env.REMOTE_BASE_URL.trim() !== ""
      ? env.REMOTE_BASE_URL.trim().replace(/\/$/, "")
      : remoteBaseUrlDefault;
  if (remoteEnabled) {
    let remoteProtocol: string;
    try {
      remoteProtocol = new URL(remoteBaseUrl).protocol;
    } catch {
      throw new Error(`REMOTE_BASE_URL is not a valid URL: "${remoteBaseUrl}"`);
    }
    if (remoteProtocol !== "http:" && remoteProtocol !== "https:") {
      throw new Error(
        `REMOTE_BASE_URL must use http:// or https://, got "${remoteProtocol}//" in "${remoteBaseUrl}"`,
      );
    }
  }
  // Mutual exclusion — the operator must pick exactly one BYO model source.
  // Boot-time enforcement is structural: the `local` engine slot has one
  // driver per boot. Allowing both would force a per-message backend-pick
  // surface (a new prefix? a config key?) that this PR explicitly avoided.
  if (localEnabled && remoteEnabled) {
    throw new Error(
      "LOCAL_ENABLED and REMOTE_ENABLED are mutually exclusive — set exactly one. " +
        "Local mode runs an on-host LLM (Ollama/LMStudio); " +
        "remote mode dispatches to OpenRouter.",
    );
  }
  const remoteTimeoutDefault = localToolsEnabled ? 120_000 : 60_000;
  const remoteTimeoutMs = parsePositiveInt(
    "REMOTE_TIMEOUT_MS",
    env.REMOTE_TIMEOUT_MS,
    remoteTimeoutDefault,
  );
  const remoteHistoryLimit = parsePositiveInt(
    "REMOTE_HISTORY_LIMIT",
    env.REMOTE_HISTORY_LIMIT,
    6,
  );
  const remoteMaxToolIterations = parsePositiveInt(
    "REMOTE_MAX_TOOL_ITERATIONS",
    env.REMOTE_MAX_TOOL_ITERATIONS,
    8,
  );
  const remoteHttpReferer =
    env.REMOTE_HTTP_REFERER && env.REMOTE_HTTP_REFERER.trim() !== ""
      ? env.REMOTE_HTTP_REFERER.trim()
      : "https://github.com/cjus/solrac";
  const remoteXTitle =
    env.REMOTE_X_TITLE && env.REMOTE_X_TITLE.trim() !== ""
      ? env.REMOTE_X_TITLE.trim()
      : "solrac";

  // Default-engine validation. Two cells of the capability matrix are
  // unreachable; refuse them at boot rather than letting them run with
  // confusing UX (engine slot unreachable, or a default engine that errors
  // every turn).
  const defaultEngine = parseDefaultEngine(env.SOLRAC_DEFAULT_ENGINE);
  const defaultEngineExplicit =
    env.SOLRAC_DEFAULT_ENGINE !== undefined && env.SOLRAC_DEFAULT_ENGINE.trim() !== "";
  if (defaultEngine === "local" && !localEnabled && !remoteEnabled) {
    throw new Error(
      "SOLRAC_DEFAULT_ENGINE=local requires LOCAL_ENABLED=true (on-host) " +
        "or REMOTE_ENABLED=true (OpenRouter); " +
        "set LOCAL_ENABLED=true (with LOCAL_BACKEND + LOCAL_MODEL) for an on-host LLM, " +
        "REMOTE_ENABLED=true (with REMOTE_BACKEND + REMOTE_MODEL + REMOTE_API_KEY) for OpenRouter, " +
        "or SOLRAC_DEFAULT_ENGINE=primary to make Anthropic Sonnet the default",
    );
  }
  if (defaultEngine !== "local" && localToolsEnabled) {
    throw new Error(
      `SOLRAC_DEFAULT_ENGINE=${defaultEngine} with LOCAL_TOOLS_ENABLED=true is unreachable: ` +
        "the local engine slot only runs when it's the default. " +
        "Set LOCAL_TOOLS_ENABLED=false or SOLRAC_DEFAULT_ENGINE=local",
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
    localEnabled,
    localBackend,
    localUrl,
    localModel,
    localTimeoutMs,
    localHistoryLimit,
    localToolsEnabled,
    localMaxToolIterations,
    remoteEnabled,
    remoteBackend,
    remoteBaseUrl,
    remoteModel,
    remoteApiKey,
    remoteTimeoutMs,
    remoteHistoryLimit,
    remoteMaxToolIterations,
    remoteHttpReferer,
    remoteXTitle,
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
