/**
 * @fileoverview Solrac's safety layer: gate, classifier, cost cap, broker,
 *               loop detector, untrusted-content wrapper, and SDK hooks.
 * @purpose Centralize every defense-in-depth control in one file with one
 *          dependency direction. Everything that says "no" to a tool call
 *          lives here — there is no second policy layer hidden elsewhere.
 *
 * This is the largest module in Solrac (~550 lines) for a reason: defense in
 * depth means many controls, and they need to compose with each other and
 * with the SDK's internal classifier. Splitting this would introduce
 * cross-file invariants that are hard to maintain. Read top-to-bottom; each
 * section is fenced with a comment banner.
 *
 * Sections:
 *   1. Gate (extractFromId / extractChatId / gateUpdate) — runs before queue.
 *   2. Loop detector — per-turn, denies the Nth identical (toolName, input).
 *   3. Three-tier classifier — auto-allow / auto-deny / telegram-confirm.
 *   4. Cost cap guard — sliding-hour spend ceiling per chat.
 *   5. Confirmation broker — Telegram inline-keyboard with 60s timeout,
 *      fail-closed on send failure.
 *   6. dispatchCallbackQuery — routes user taps to broker.resolve.
 *   7. DB-pollution defenses — truncateAuditPrompt + denial throttle.
 *   8. Untrusted-content wrapper — for future inbound attachments.
 *   9. createPolicyHook — composes 2–5 into a SDK `CanUseTool`.
 *  10. createPreToolUseHook — the always-fires PreToolUse SDK hook (cost cap
 *      + loop detector). Closes the `canUseTool` bypass for SDK-auto-approved
 *      tools (Bash(date), Read, etc.) — see docs/ARCHITECTURE.md#1-cost-cap-and-loop-detector-bypass.
 *
 * Why two SDK hooks:
 *   - `canUseTool`: SDK calls only for tools its internal classifier considers
 *     "non-trivial" under permissionMode:'default'. Solrac uses this for
 *     interactive Telegram-confirm UX.
 *   - `PreToolUse`: SDK fires for EVERY tool call, including auto-approved
 *     ones. Solrac uses this for cost cap + loop detector — defenses that
 *     must apply uniformly.
 *
 * Position in the dependency graph:
 *   db + telegram + log + config → policy → consumed by agent, main
 *
 * Exports (grouped by section):
 *   - Gate: `extractFromId`, `extractChatId`, `gateUpdate`, `GateResult`.
 *   - Loop detector: `createLoopDetector`, `LoopDetectedError`,
 *     `LoopDetector`, `LoopDetectorOpts`.
 *   - Classifier: `classifyTool`, `ToolDecision`.
 *   - Cost cap: `createCostCapGuard`, `CostCapGuard`, `CostCapSnapshot`,
 *     `createGlobalCostCapGuard`, `GlobalCostCapGuard`. Per-chat cap is
 *     fairness; global cap is absolute safety. Both coexist.
 *   - Broker: `createConfirmationBroker`, `ConfirmationBroker`,
 *     `ConfirmRequest`, `ConfirmDecision`, `ConfirmationBrokerOpts`.
 *   - Dispatch: `dispatchCallbackQuery`, `CallbackDispatchResult`.
 *   - DB-pollution: `truncateAuditPrompt`, `createDenialThrottle`,
 *     `DenialThrottle`, `DenialThrottleOpts`.
 *   - Untrusted content: `wrapUntrustedContent`.
 *   - SDK hooks: `createPolicyHook`, `createPreToolUseHook`,
 *     `PolicyHookDeps`, `PreToolUseHookDeps`, `PolicyDenyEvent`.
 *
 * Concurrency:
 *   - All factories produce closures that may be invoked concurrently by the
 *     SDK's parallel tool-call fan-out. Specifically:
 *       * `loopDetector.check` is re-entrant safe (read-modify-write on a
 *         Map happens in a single sync expression).
 *       * `costGuard.check` is a single sync SQL read.
 *       * `broker.request` mutates `pending` Map atomically per id; multiple
 *         concurrent requests are independent.
 *       * `denialThrottle.check` writes a single key; no compound mutations.
 *
 * Key invariants:
 *   - `gateUpdate` returns `kind: "no_from"` only when the update has no
 *     `from` (channel posts, service messages). Code that calls it must
 *     handle this case.
 *   - `classifyTool` is PURE — same input always gives same output. No
 *     access to db or telegram. Tests rely on this.
 *   - The broker fails CLOSED: `tg.sendMessage` throws → resolve as `"deny"`.
 *     Never let a network failure hang an SDK turn.
 *   - `truncateAuditPrompt` is UTF-16 surrogate-pair safe: cutting on a high
 *     surrogate steps back one code unit so we don't write an orphaned high
 *     surrogate that round-trips as U+FFFD.
 *   - `createDenialThrottle.check` updates `lastRecordedAt` ONLY on `record`,
 *     not on `skip`. Skips extending the window would let a sustained flood
 *     keep its own throttle indefinitely.
 *   - `wrapUntrustedContent` sanitizes `source` to `[a-zA-Z0-9_-]` so a
 *     hostile attachment label can't break out of the attribute.
 *
 * Gotchas:
 *   - `BASH_DANGEROUS_PATTERNS` use `(\s|$)` not `\b` after non-word chars
 *     like `/` or `~`. `\b` requires a word/non-word transition; between
 *     two non-word chars there is no boundary, so `rm -rf /\b` would not
 *     match. See classifier section for the full list.
 *   - `createCostCapGuard` rejects non-positive caps at construction. Don't
 *     call with `0` to "disable" — pass a sentinel via the agent runner's
 *     `costGuard?` (omit it).
 *   - The PreToolUse hook returns `{ continue: true }` on ALL hook events
 *     other than PreToolUse (defensive — the SDK could expand the union).
 *
 * Cross-references:
 *   - docs/ARCHITECTURE.md#three-tier-permission-policy — full policy doc
 *   - docs/ARCHITECTURE.md#tricky-seams — bypass closure rationale
 *   - docs/USAGE.md#permission-ux — user-facing semantics
 *   - agent.ts::runAgent — primary consumer (canUseTool + PreToolUse hook)
 *   - main.ts::gateAndAuditDenied — gate consumer
 */

import type {
  CanUseTool,
  HookCallback,
  HookJSONOutput,
  PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import type { Update } from "@grammyjs/types";
import { MAX_AUDIT_PROMPT_LEN } from "./config.ts";
import type { SolracDb } from "./db.ts";
import { log } from "./log.ts";
import { htmlEscapeText, type TelegramClient } from "./telegram.ts";

// Allowlist gates on the user (from.id), not the chat — group chats and
// forwarded messages have a different chat.id than the user who actually typed.
export function extractFromId(update: Update): number | undefined {
  return (
    update.message?.from?.id ??
    update.callback_query?.from.id ??
    update.edited_message?.from?.id
  );
}

export function extractChatId(update: Update): number | undefined {
  return (
    update.message?.chat.id ??
    update.callback_query?.message?.chat.id ??
    update.edited_message?.chat.id
  );
}

export type GateResult =
  | { kind: "ok"; fromId: number; chatId: number | undefined }
  | { kind: "denied"; fromId: number; chatId: number | undefined }
  | { kind: "no_from" };

export function gateUpdate(
  update: Update,
  isAllowed: (id: number) => boolean,
): GateResult {
  const fromId = extractFromId(update);
  if (fromId === undefined) return { kind: "no_from" };
  const chatId = extractChatId(update);
  if (!isAllowed(fromId)) return { kind: "denied", fromId, chatId };
  return { kind: "ok", fromId, chatId };
}

// PLAN Step 12: tier-aware prefix routing.
// Engines:
//   primary   = default Claude tier (cheap path; SOLRAC_PRIMARY_MODEL).
//               Triggered by `@` OR no prefix at all.
//   secondary = heavyweight Claude tier (SOLRAC_SECONDARY_MODEL).
//               Triggered by `!` (think "important / escalate").
//   ollama    = local-model routing (Step 11; OLLAMA_MODEL).
//               Triggered by `>`.
//
// The parser strips one leading `!`/`@`/`>` plus one optional space. Leading
// whitespace before the prefix is tolerated so mobile autocorrect doesn't
// silently misroute. `explicit: false` is reserved for the no-prefix path so
// `main.ts` can decide whether an empty payload should render a usage hint
// (only for explicit prefixes) or be ignored.
//
//   "hello"        → { engine: "primary",   explicit: false, prompt: "hello" }
//   "@hello"       → { engine: "primary",   explicit: true,  prompt: "hello" }
//   "@ hello"      → { engine: "primary",   explicit: true,  prompt: "hello" }
//   "!hello"       → { engine: "secondary", explicit: true,  prompt: "hello" }
//   "! hello"      → { engine: "secondary", explicit: true,  prompt: "hello" }
//   "> hello"      → { engine: "ollama",    explicit: true,  prompt: "hello" }
//   "  ! hello"    → { engine: "secondary", explicit: true,  prompt: "hello" }
//   "@"            → { engine: "primary",   explicit: true,  prompt: "" }
//   "!"            → { engine: "secondary", explicit: true,  prompt: "" }
//   ">"            → { engine: "ollama",    explicit: true,  prompt: "" }
//   "@@literal"    → { engine: "primary",   explicit: true,  prompt: "@literal" }
//   "!!literal"    → { engine: "secondary", explicit: true,  prompt: "!literal" }
//   ">>literal"    → { engine: "ollama",    explicit: true,  prompt: ">literal" }
//   "@!mixed"      → { engine: "primary",   explicit: true,  prompt: "!mixed" }
//   ""             → { engine: "primary",   explicit: false, prompt: "" }
//
// No-prefix `prompt` is returned untrimmed so the caller observes the user's
// exact text (matches today's runAgent path that passes `msg.text` straight
// through). Explicit-prefix `prompt` is `.trim()`'d on the residue because
// the prefix character is structural punctuation — surrounding whitespace is
// not the user's intent.
export type Engine = "primary" | "secondary" | "ollama";

export interface EnginePrefixResult {
  engine: Engine;
  explicit: boolean;
  prompt: string;
}

export function parseEnginePrefix(text: string): EnginePrefixResult {
  let i = 0;
  while (i < text.length && (text[i] === " " || text[i] === "\t")) i++;
  const c = text[i];
  let engine: Engine | null = null;
  if (c === "@") engine = "primary";
  else if (c === "!") engine = "secondary";
  else if (c === ">") engine = "ollama";
  if (engine === null) {
    return { engine: "primary", explicit: false, prompt: text };
  }
  i++;
  if (text[i] === " ") i++;
  return { engine, explicit: true, prompt: text.slice(i).trim() };
}

export class LoopDetectedError extends Error {
  readonly toolName: string;
  readonly count: number;
  readonly input: unknown;
  constructor(toolName: string, input: unknown, count: number) {
    super(`loop_detected: ${toolName} called ${count}× with same input`);
    this.name = "LoopDetectedError";
    this.toolName = toolName;
    this.count = count;
    this.input = input;
  }
}

export interface LoopDetector {
  check: (toolName: string, input: unknown) => "ok" | "loop";
  readonly threshold: number;
}

export interface LoopDetectorOpts {
  threshold?: number;
}

// Per-turn loop guard. Returns "loop" when the same (toolName, input) pair has
// been observed `threshold` times in this turn. Re-entrant safe: read-modify-
// write on the Map happens in a single sync expression, so concurrent
// `canUseTool` invocations within one assistant message can't lose increments.
export function createLoopDetector(opts: LoopDetectorOpts = {}): LoopDetector {
  const threshold = opts.threshold ?? 3;
  if (!Number.isInteger(threshold) || threshold < 2) {
    throw new Error(`createLoopDetector: threshold must be an integer >=2 (got ${threshold})`);
  }
  const counts = new Map<string, number>();
  return {
    threshold,
    check(toolName, input) {
      const key = `${toolName}::${stableStringify(input)}`;
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return next >= threshold ? "loop" : "ok";
    },
  };
}

// Order-insensitive JSON stringify so {a:1,b:2} and {b:2,a:1} hash to the same
// loop-detector key. Handles primitives, arrays, and nested plain objects.
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

// ---------------------------------------------------------------------------
// Three-tier tool policy
// ---------------------------------------------------------------------------

export type ToolDecision =
  | { kind: "allow" }
  | { kind: "deny"; message: string }
  | { kind: "confirm" };

// Read-only / observation-only tools — boring enough to never prompt.
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "Read",
  "Glob",
  "Grep",
  "LS",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "BashOutput",
  "NotebookRead",
]);

// Sub-agent fan-out is structurally disabled in v1 (see PLAN OQ#8). We also
// pass `disallowedTools: ["Agent"]` to the SDK as belt-and-suspenders.
const SUBAGENT_DENY_TOOLS: ReadonlySet<string> = new Set(["Agent", "Task"]);

// Bash commands that are pure observation. Match against the leading token of
// the command. Anything else falls through to "confirm" so Carlos sees it.
const BASH_SAFE_PREFIXES: readonly RegExp[] = [
  /^ls(\s|$)/,
  /^pwd(\s|$)/,
  /^cat\s/,
  /^head(\s|$)/,
  /^tail(\s|$)/,
  /^echo\s/,
  /^date(\s|$)/,
  /^whoami(\s|$)/,
  /^uname(\s|$)/,
  /^which\s/,
  /^find\s/,
  /^grep\s/,
  /^wc\s/,
  /^git\s+(status|log|diff|show|branch|remote|rev-parse|ls-files|config\s+--get|fetch)(\s|$)/,
  /^node\s+--version/,
  /^bun\s+--version/,
  /^npm\s+(list|outdated|view|info)(\s|$)/,
  /^pnpm\s+(list|outdated|why|view)(\s|$)/,
];

// Hard-deny patterns. Order matters: most specific first. Each entry pairs a
// regex with the human-readable reason surfaced back to the agent + audit log.
const BASH_DANGEROUS_PATTERNS: ReadonlyArray<{ re: RegExp; reason: string }> = [
  { re: /\brm\s+-[rRf]+\s+(\/|~|\$HOME)(\s|$)/, reason: "rm -rf on root or home" },
  { re: /\bsudo\b/, reason: "sudo elevation" },
  { re: /\bmkfs\b/, reason: "filesystem format" },
  { re: /\bdd\s+if=/, reason: "raw disk dd" },
  { re: /:\(\)\{\s*:\s*\|\s*:&\s*\};:/, reason: "fork bomb" },
  { re: /\bchmod\s+-R\s+777/, reason: "world-writable chmod -R" },
  { re: /\b(curl|wget)\b[^|]*\|\s*(bash|sh|zsh)\b/, reason: "pipe-to-shell remote execution" },
  { re: /\bgit\s+push\s+(\S+\s+)*-{1,2}f(orce)?\b/, reason: "force push" },
  // OQ#5: paid third-party CLIs would burn budget outside the Anthropic cap.
  { re: /\b(claude|openai|replicate|anthropic)\b/, reason: "paid third-party CLI invocation" },
];

export function classifyTool(toolName: string, input: unknown): ToolDecision {
  if (SUBAGENT_DENY_TOOLS.has(toolName)) {
    return { kind: "deny", message: `${toolName} sub-agent calls are disabled in solrac v1` };
  }
  if (READ_ONLY_TOOLS.has(toolName)) return { kind: "allow" };
  if (toolName === "Bash") {
    const command = readBashCommand(input);
    if (command !== null) {
      for (const { re, reason } of BASH_DANGEROUS_PATTERNS) {
        if (re.test(command)) return { kind: "deny", message: `bash blocked: ${reason}` };
      }
      for (const re of BASH_SAFE_PREFIXES) {
        if (re.test(command)) return { kind: "allow" };
      }
    }
    return { kind: "confirm" };
  }
  // Write/Edit/NotebookEdit and any other mutating tool falls here.
  return { kind: "confirm" };
}

function readBashCommand(input: unknown): string | null {
  if (input && typeof input === "object" && "command" in input) {
    const c = (input as { command: unknown }).command;
    if (typeof c === "string") return c.trim();
  }
  return null;
}

// Integration-aware classifier. Stays a thin shim ON TOP of `classifyTool`
// so the pure-function contract of `classifyTool` is preserved (tests rely
// on it). `toolTiers` is the per-tool tier map produced by the integrations
// loader (`integrations.ts::loadIntegrations`); keys are the SHORT tool
// name as the integration declared it (e.g. `"echo_say"`), and the SDK
// surfaces them to the model as `mcp__solrac__echo_say`.
//
// Resolution order for an `mcp__solrac__*` tool name:
//   1. tier "auto" in toolTiers → allow without confirm.
//   2. tier "confirm" in toolTiers → fall through to default (confirm).
//   3. not in toolTiers → fall through to default (confirm).
// For any other tool name the call is a straight passthrough to
// `classifyTool` — the prefix branch can't shadow Bash, Write, etc.
//
// The SDK's MCP tool-name format `mcp__<server>__<name>` is documented at
// https://docs.anthropic.com/.../mcp — we register our server as `solrac`
// (see main.ts) so the prefix is fixed at `mcp__solrac__`.
const SOLRAC_MCP_PREFIX = "mcp__solrac__";

export function classifyToolWithIntegrations(
  toolName: string,
  input: unknown,
  toolTiers: ReadonlyMap<string, "auto" | "confirm">,
): ToolDecision {
  if (toolName.startsWith(SOLRAC_MCP_PREFIX)) {
    const shortName = toolName.slice(SOLRAC_MCP_PREFIX.length);
    if (toolTiers.get(shortName) === "auto") {
      return { kind: "allow" };
    }
    // Anything else — including unknown short names — falls through to
    // confirm via the catch-all in `classifyTool`. Don't `return` here:
    // letting `classifyTool` run gives operators a single source of truth
    // for what "no tier override" means.
  }
  return classifyTool(toolName, input);
}

// ---------------------------------------------------------------------------
// Cost cap (per-chat / sliding hour)
// ---------------------------------------------------------------------------

export interface CostCapSnapshot {
  exceeded: boolean;
  spentUsd: number;
  capUsd: number;
}

export interface CostCapGuard {
  check: (chatId: number, now?: number) => CostCapSnapshot;
}

export function createCostCapGuard(
  db: Pick<SolracDb, "sumChatCostSince">,
  capUsd: number,
  windowMs = 60 * 60 * 1000,
): CostCapGuard {
  if (!Number.isFinite(capUsd) || capUsd <= 0) {
    throw new Error(`createCostCapGuard: capUsd must be > 0 (got ${capUsd})`);
  }
  return {
    check(chatId, now = Date.now()) {
      const since = now - windowMs;
      const spentUsd = db.sumChatCostSince(chatId, since);
      return { exceeded: spentUsd >= capUsd, spentUsd, capUsd };
    },
  };
}

// Global (cross-chat) cost cap. Per-chat cap is fairness — each chat gets its
// own hourly budget. Global cap is absolute safety — total Anthropic burn
// across ALL chats can't exceed `capUsd` per window. Both coexist by design;
// see docs/ARCHITECTURE.md#cost-caps. With N concurrent chats each at the
// per-chat cap, hourly burn = N × per-chat-cap, which the global cap
// intercepts. Operator-tunable via GLOBAL_HOURLY_COST_CAP_USD env (default
// = MAX_CONCURRENT_TURNS × HOURLY_COST_CAP_USD).
export interface GlobalCostCapGuard {
  check: (now?: number) => CostCapSnapshot;
}

export function createGlobalCostCapGuard(
  db: Pick<SolracDb, "sumCostSince">,
  capUsd: number,
  windowMs = 60 * 60 * 1000,
): GlobalCostCapGuard {
  if (!Number.isFinite(capUsd) || capUsd <= 0) {
    throw new Error(`createGlobalCostCapGuard: capUsd must be > 0 (got ${capUsd})`);
  }
  return {
    check(now = Date.now()) {
      const since = now - windowMs;
      const spentUsd = db.sumCostSince(since);
      return { exceeded: spentUsd >= capUsd, spentUsd, capUsd };
    },
  };
}

// ---------------------------------------------------------------------------
// Telegram inline-keyboard confirmation broker
// ---------------------------------------------------------------------------

export type ConfirmDecision = "allow" | "deny" | "timeout";

const CALLBACK_PREFIX = "cb";
const CALLBACK_RE = /^cb:([0-9a-f-]{36}):(a|d)$/;

export interface ConfirmRequest {
  chatId: number;
  toolName: string;
  toolInput: unknown;
}

export interface ConfirmationBroker {
  request: (req: ConfirmRequest) => Promise<ConfirmDecision>;
  resolve: (id: string, decision: "allow" | "deny") => boolean;
  size: () => number;
}

export interface ConfirmationBrokerOpts {
  tg: Pick<TelegramClient, "sendMessage" | "call">;
  timeoutMs?: number;
  // Override id source for deterministic tests.
  idGen?: () => string;
}

interface PendingEntry {
  resolve: (decision: ConfirmDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function createConfirmationBroker(opts: ConfirmationBrokerOpts): ConfirmationBroker {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const idGen = opts.idGen ?? randomUUID;
  const pending = new Map<string, PendingEntry>();

  return {
    async request({ chatId, toolName, toolInput }) {
      const id = idGen();
      const text = renderConfirmPrompt(toolName, toolInput);
      try {
        await opts.tg.sendMessage(chatId, text, {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "✅ Allow", callback_data: `${CALLBACK_PREFIX}:${id}:a` },
                { text: "❌ Deny", callback_data: `${CALLBACK_PREFIX}:${id}:d` },
              ],
            ],
          },
        });
      } catch (err) {
        log.warn("policy.confirm_send_failed", {
          chatId,
          toolName,
          error: (err as Error).message,
        });
        // Fail closed: if we can't reach Telegram to ask, we deny.
        return "deny";
      }
      return new Promise<ConfirmDecision>((resolve) => {
        const timer = setTimeout(() => {
          if (pending.delete(id)) {
            log.warn("policy.confirm_timeout", { chatId, toolName, id });
            resolve("timeout");
          }
        }, timeoutMs);
        pending.set(id, {
          timer,
          resolve: (decision) => {
            clearTimeout(timer);
            resolve(decision);
          },
        });
      });
    },
    resolve(id, decision) {
      const entry = pending.get(id);
      if (!entry) return false;
      pending.delete(id);
      entry.resolve(decision);
      return true;
    },
    size() {
      return pending.size;
    },
  };
}

function renderConfirmPrompt(toolName: string, toolInput: unknown): string {
  const json = JSON.stringify(toolInput, null, 2) ?? "";
  const truncated = json.length > 1500 ? `${json.slice(0, 1500)}…` : json;
  return [
    `🔐 <b>Confirm tool:</b> <code>${htmlEscapeText(toolName)}</code>`,
    `<pre>${htmlEscapeText(truncated)}</pre>`,
  ].join("\n");
}

// Used by the transport's update dispatcher. Returns true if the update was a
// callback we owned (so the caller can stop further routing for this update).
export interface CallbackDispatchResult {
  handled: boolean;
  decision?: "allow" | "deny";
  expired?: boolean;
  callbackQueryId?: string;
}

export function dispatchCallbackQuery(
  broker: Pick<ConfirmationBroker, "resolve">,
  update: Update,
): CallbackDispatchResult {
  const cq = update.callback_query;
  if (!cq) return { handled: false };
  const data = cq.data ?? "";
  const m = CALLBACK_RE.exec(data);
  if (!m) return { handled: false };
  const id = m[1]!;
  const decision = m[2] === "a" ? "allow" : "deny";
  const found = broker.resolve(id, decision);
  return { handled: true, decision, expired: !found, callbackQueryId: cq.id };
}

// ---------------------------------------------------------------------------
// DB-pollution defenses (PLAN Step 6.6)
// ---------------------------------------------------------------------------

// Truncate prompt text persisted to the audit table. Last char is replaced
// with "…" so truncation is visible in dumps. Steps back one code unit if the
// boundary would split a UTF-16 surrogate pair (emoji etc.) — sqlite stores
// UTF-8 and an orphaned surrogate would round-trip as U+FFFD.
export function truncateAuditPrompt(s: string, max: number = MAX_AUDIT_PROMPT_LEN): string {
  if (s.length <= max) return s;
  const cut = max - 1;
  const lead = s.charCodeAt(cut - 1);
  const safeCut = lead >= 0xd800 && lead <= 0xdbff ? cut - 1 : cut;
  return s.slice(0, safeCut) + "…";
}

export interface DenialThrottle {
  // Returns "record" if the first denial for this fromId in the window;
  // "skip" otherwise. State only updates on "record" so a sustained flood
  // can't extend its own throttle window indefinitely.
  check: (fromId: number, now?: number) => "record" | "skip";
  size: () => number;
}

export interface DenialThrottleOpts {
  windowMs?: number;
  // When the map exceeds this, entries older than 2× window are pruned.
  // Bounds memory under sustained flood from many distinct fromIds.
  maxEntries?: number;
}

export function createDenialThrottle(opts: DenialThrottleOpts = {}): DenialThrottle {
  const windowMs = opts.windowMs ?? 60_000;
  const maxEntries = opts.maxEntries ?? 1024;
  const lastRecordedAt = new Map<number, number>();
  return {
    check(fromId, now = Date.now()) {
      const last = lastRecordedAt.get(fromId);
      if (last !== undefined && now - last < windowMs) return "skip";
      lastRecordedAt.set(fromId, now);
      if (lastRecordedAt.size > maxEntries) {
        const expiry = now - windowMs * 2;
        for (const [k, v] of lastRecordedAt) {
          if (v < expiry) lastRecordedAt.delete(k);
        }
      }
      return "record";
    },
    size: () => lastRecordedAt.size,
  };
}

// ---------------------------------------------------------------------------
// Untrusted-content wrapper (PLAN Step 6 / OQ#10)
// ---------------------------------------------------------------------------

// Inbound attachments (forwarded docs, photos with extracted OCR text, etc.)
// must not be treated as instructions by the agent. Wrapping them in a tagged
// envelope plus a corresponding system-prompt clause is the v1 mitigation; an
// adversarial regression suite is tracked in OQ#10.
export function wrapUntrustedContent(text: string, source: string): string {
  const safeSource = source.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `<untrusted-content source="${safeSource}">\n${text}\n</untrusted-content>`;
}

// ---------------------------------------------------------------------------
// canUseTool composition
// ---------------------------------------------------------------------------

export interface PolicyHookDeps {
  chatId: number;
  auditId: number;
  costGuard: CostCapGuard;
  broker: ConfirmationBroker;
  // Whether to consult the broker. Tests inject a stub broker; production
  // wiring always passes one through.
  classify?: (toolName: string, input: unknown) => ToolDecision;
  // Per-tool tier overrides for `mcp__solrac__*` integration tools. Empty
  // map (or absent) means every integration tool falls through to the
  // confirm tier — the safe default. Captured at boot from the integrations
  // loader and reused across all turns. Tests pass an explicit map.
  integrationToolTiers?: ReadonlyMap<string, "auto" | "confirm">;
}

// Build the per-turn `canUseTool` hook. The SDK may call this concurrently
// for parallel tool calls inside a single assistant message; everything here
// is either pure (classify), atomic (cost-cap query is a single SQL read), or
// uses the broker's own Map (single-key writes).
export function createPolicyHook(deps: PolicyHookDeps): CanUseTool {
  // Resolve the classifier ONCE at factory time, not per-call. If the caller
  // supplied a custom `classify` that takes precedence (test injection); else
  // we wrap `classifyTool` with the integration-aware shim that consults
  // `integrationToolTiers` for `mcp__solrac__*` lookups. Empty map is fine —
  // shim falls through to confirm on cache miss.
  const integrationToolTiers = deps.integrationToolTiers ?? new Map();
  const classify =
    deps.classify ??
    ((toolName: string, input: unknown) =>
      classifyToolWithIntegrations(toolName, input, integrationToolTiers));
  return async (toolName, input): Promise<PermissionResult> => {
    const cap = deps.costGuard.check(deps.chatId);
    if (cap.exceeded) {
      log.warn("policy.cost_cap_exceeded", {
        auditId: deps.auditId,
        chatId: deps.chatId,
        spentUsd: cap.spentUsd,
        capUsd: cap.capUsd,
        toolName,
      });
      return {
        behavior: "deny",
        message: `cost cap reached: $${cap.spentUsd.toFixed(4)} ≥ $${cap.capUsd.toFixed(2)}/hr for this chat`,
        interrupt: true,
      };
    }
    const decision = classify(toolName, input);
    if (decision.kind === "allow") {
      log.debug("policy.auto_allow", { auditId: deps.auditId, toolName });
      return { behavior: "allow" };
    }
    if (decision.kind === "deny") {
      log.warn("policy.auto_deny", {
        auditId: deps.auditId,
        toolName,
        reason: decision.message,
      });
      return { behavior: "deny", message: decision.message };
    }
    log.info("policy.confirm_request", { auditId: deps.auditId, toolName });
    const verdict = await deps.broker.request({
      chatId: deps.chatId,
      toolName,
      toolInput: input,
    });
    log.info("policy.confirm_resolved", { auditId: deps.auditId, toolName, verdict });
    if (verdict === "allow") return { behavior: "allow" };
    const reason =
      verdict === "timeout"
        ? "user did not respond to confirmation within timeout"
        : "user denied tool call";
    return { behavior: "deny", message: reason };
  };
}

// ---------------------------------------------------------------------------
// PreToolUse hook (always-fires safety gate)
// ---------------------------------------------------------------------------

// `canUseTool` is only invoked by the SDK for tools its internal classifier
// considers "non-safe" under permissionMode:'default' (e.g. Write, Bash with a
// non-trivial command). Trivial tools — Read/Glob/Grep, Bash(date), etc. —
// auto-approve without consulting `canUseTool`. That bypasses cost-cap and
// loop-detector enforcement for any tool the SDK pre-trusts.
//
// PreToolUse hooks fire for every tool call regardless of trust. We move
// cost-cap + loop-detector here so they're always enforced; `canUseTool` keeps
// the interactive confirm UX for tools that get past the hook.

export interface PolicyDenyEvent {
  reason: "cost_cap" | "global_cost_cap" | "loop_detected";
  toolName: string;
  message: string;
}

export interface PreToolUseHookDeps {
  chatId: number;
  // Read at hook-fire time so the hook can be built before `auditId` exists.
  getAuditId: () => number;
  costGuard: CostCapGuard;
  // Optional. Per-chat cap is fairness; global cap is absolute safety. Wire
  // both in production; tests can omit for narrow per-chat scenarios.
  globalCostGuard?: GlobalCostCapGuard;
  loopDetector: LoopDetector;
  onPolicyDeny?: (event: PolicyDenyEvent) => void;
}

export function createPreToolUseHook(deps: PreToolUseHookDeps): HookCallback {
  return async (input): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== "PreToolUse") return { continue: true };
    const auditId = deps.getAuditId();
    const toolName = input.tool_name;
    const toolInput = input.tool_input;

    // Check global cap FIRST. If the host is over its absolute-safety budget,
    // every chat is blocked; the per-chat check would mask it under "this
    // chat is under-cap" if checked first.
    if (deps.globalCostGuard) {
      const gCap = deps.globalCostGuard.check();
      if (gCap.exceeded) {
        const message = `global cost cap reached: $${gCap.spentUsd.toFixed(4)} ≥ $${gCap.capUsd.toFixed(2)}/hr across all chats`;
        log.warn("policy.global_cost_cap_exceeded", {
          auditId,
          chatId: deps.chatId,
          spentUsd: gCap.spentUsd,
          capUsd: gCap.capUsd,
          toolName,
        });
        deps.onPolicyDeny?.({ reason: "global_cost_cap", toolName, message });
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: message,
          },
        };
      }
    }

    const cap = deps.costGuard.check(deps.chatId);
    if (cap.exceeded) {
      const message = `cost cap reached: $${cap.spentUsd.toFixed(4)} ≥ $${cap.capUsd.toFixed(2)}/hr for this chat`;
      log.warn("policy.cost_cap_exceeded", {
        auditId,
        chatId: deps.chatId,
        spentUsd: cap.spentUsd,
        capUsd: cap.capUsd,
        toolName,
      });
      deps.onPolicyDeny?.({ reason: "cost_cap", toolName, message });
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: message,
        },
      };
    }

    if (deps.loopDetector.check(toolName, toolInput) === "loop") {
      const message = `loop_detected: ${toolName} called ${deps.loopDetector.threshold}× with same input`;
      log.warn("agent.loop_detected", { auditId, toolName, threshold: deps.loopDetector.threshold });
      deps.onPolicyDeny?.({ reason: "loop_detected", toolName, message });
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: message,
        },
      };
    }

    return { continue: true };
  };
}
