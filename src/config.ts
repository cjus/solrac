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

type Transport = "poll" | "webhook";

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
  // PLAN Step 11: local-model routing via `>` prefix. Off by default — when
  // false, `>`-prefixed messages get a "disabled" reply instead of being
  // routed. When true, `ollamaModel` MUST be set (validated at boot).
  readonly ollamaEnabled: boolean;
  readonly ollamaUrl: string;
  readonly ollamaModel: string | null;
  readonly ollamaTimeoutMs: number;
  readonly ollamaHistoryLimit: number;
  // PNX-167.1 — operator-defined skills loaded from the filesystem at boot.
  // `skillsEnabled` is the master switch; `skillsDir` is resolved from cwd
  // so the same Solrac binary can ship to multiple operators each with their
  // own skills directory layout. Default `./skills` matches the convention
  // for `./data` (dataDir).
  readonly skillsEnabled: boolean;
  readonly skillsDir: string;
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
  const ollamaTimeoutMs = parsePositiveInt("OLLAMA_TIMEOUT_MS", env.OLLAMA_TIMEOUT_MS, 60_000);
  const ollamaHistoryLimit = parsePositiveInt(
    "OLLAMA_HISTORY_LIMIT",
    env.OLLAMA_HISTORY_LIMIT,
    6,
  );

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

  return Object.freeze({
    anthropicApiKey: env.ANTHROPIC_API_KEY!,
    telegramBotToken: env.TELEGRAM_BOT_TOKEN!,
    allowlistBootstrap: Object.freeze(parseAllowlist(env.ALLOWLIST_BOOTSTRAP!)),
    transport,
    port,
    dataDir: env.DATA_DIR && env.DATA_DIR.trim() !== "" ? env.DATA_DIR : "./data",
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
    ollamaEnabled,
    ollamaUrl,
    ollamaModel,
    ollamaTimeoutMs,
    ollamaHistoryLimit,
    skillsEnabled: parseBoolean("SOLRAC_SKILLS_ENABLED", env.SOLRAC_SKILLS_ENABLED, false),
    skillsDir:
      env.SOLRAC_SKILLS_DIR && env.SOLRAC_SKILLS_DIR.trim() !== ""
        ? env.SOLRAC_SKILLS_DIR.trim()
        : "./skills",
    webEnabled,
    webHost,
    webPort,
    webToken,
    webChatId,
  });
}
