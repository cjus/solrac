/**
 * @fileoverview Slash-command parser, dispatcher, and `/compact` runner.
 * @purpose Own the surface for `/clear`, `/compact`, `/status`, `/help` from
 *          parsing the raw `msg.text` to writing the audit row, persisting
 *          state changes, and rendering the Telegram reply.
 *
 * Commands are parsed BEFORE engine-prefix routing in `makeRunTurn` so a
 * leading `/` can never silently fall through to a Claude turn (which would
 * waste tokens summarizing why "/clear" was confusing). The parser is pure
 * (no I/O) and lives at the top of this file; the dispatcher and per-command
 * handlers do the side effects.
 *
 * `/compact` is the heavy hitter — it runs a real Claude `query()` call to
 * produce a conversation summary, then drops the SDK session id so the next
 * user turn for that tier starts fresh with the summary prepended as
 * out-of-band context (see agent.ts for the consumer side). All other
 * commands are read-only or pure-DB.
 *
 * Position in the dependency graph:
 *   db + session + policy + telegram + log + agent + config
 *     → commands → consumed by main
 *
 * Exports:
 *   - `parseCommand(text, deps)` — pure parser; returns a 3-way variant.
 *   - `runCommand(deps, msg, cmd)` — dispatcher; writes audit + reply.
 *   - `runCompactTurn(deps, input)` — the SDK-call helper for `/compact`.
 *   - Various types: `SolracCommand`, `TierArg`, `TierArgSingle`,
 *     `ParseCommandResult`, `RunCommandDeps`, `RunCompactDeps`,
 *     `RunCompactInput`, `CompactResult`.
 *   - `BOT_COMMAND_REGISTRY` — the four commands fed to `setMyCommands` at boot.
 *
 * Key invariants:
 *   - Every command path writes exactly ONE audit row. `/compact` happy-path
 *     uses the engine model tag (`claude:<tier>:<id>`) so the cost rolls up
 *     under per-chat hourly cap; all other paths use `model='system'` per the
 *     existing convention (see main.ts::auditQueueFull).
 *   - The parser is pure: same input always gives same output given the same
 *     `botUsername`. No DB, no clock.
 *   - `/compact` does NOT use `Options.resume` — the summarizer is a fresh,
 *     isolated turn so it doesn't inherit the conversation it's summarizing.
 *   - Group-chat targeting: `/cmd@<bot>` only runs when `<bot>` matches the
 *     cached `botUsername` (lowercased). A mismatch returns `kind: "ignore"`
 *     and main.ts drops the update without engaging engine routing — we don't
 *     spam another bot's chat with a Claude reply to a command meant for them.
 *
 * Gotchas:
 *   - Empty payload (`/`, `/ `, `/@solrac_dev_bot`) renders the `/help` body.
 *     This is intentional — bare `/` is a UX-friendly help shortcut.
 *   - `/compact all` is invalid (`all` only works with `/clear`). The parser
 *     returns `kind: "unknown"` for it; the dispatcher replies with a usage
 *     hint, NOT a silent compact-of-primary.
 *   - `truncateAuditPrompt` is reused for the audit `prompt` column so very
 *     long /compact-ed transcripts in the prompt field don't bloat the audit
 *     table. The reply text and SDK input are NOT truncated.
 *
 * Cross-references:
 *   - docs/SLASH_COMMANDS_DESIGN.md — design source
 *   - main.ts::makeRunTurn — wires the dispatcher
 *   - agent.ts::runAgent — consumes the stored summary on the next turn
 *   - policy.ts::createCostCapGuard — `/compact` pre-flight check
 */

import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import type { Message } from "@grammyjs/types";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { sanitizedSubprocessEnv } from "./agent.ts";
import type { Allowlist } from "./allowlist.ts";
import type { ChatHistoryRow, SolracDb } from "./db.ts";
import { log } from "./log.ts";
import { mdToTelegramHtml } from "./markdown.ts";
import {
  truncateAuditPrompt,
  type CostCapGuard,
  type GlobalCostCapGuard,
} from "./policy.ts";
import type { SessionStore, SessionTier } from "./session.ts";
import {
  renderSkillTemplate,
  type Skill,
  type SkillRegistry,
} from "./skills.ts";
import { htmlEscapeText, type BotCommand, type TelegramClient } from "./telegram.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TierArg = "primary" | "secondary" | "all";
export type TierArgSingle = "primary" | "secondary";

export type SolracCommand =
  | { kind: "clear"; tier: TierArg }
  | { kind: "compact"; tier: TierArgSingle }
  | { kind: "status" }
  | { kind: "context"; tier: TierArgSingle }
  | { kind: "help" }
  | { kind: "unknown"; raw: string }
  | { kind: "empty" }
  // PNX-167.1 — operator-defined skill loaded from the filesystem at boot.
  // The dispatcher renders `skill.body` with `args` substituted for `{{args}}`
  // and runs a one-shot Claude turn (no resume, tools disabled).
  | { kind: "skill"; skill: Skill; args: string };

export type ParseCommandResult =
  | { kind: "run"; cmd: SolracCommand }
  | { kind: "ignore" } // looked like a command but addressed to another bot
  | { kind: "passthrough" }; // not a command — engine routing takes over

export interface ParseCommandDeps {
  // Lowercased bot username from boot-time `getMe`. `null` when boot-time
  // lookup failed; the parser then accepts plain commands and rejects any
  // `@bot` suffix (fail-closed).
  botUsername: string | null;
  // PNX-167.1 — operator-defined skills resolved by name after the built-in
  // KNOWN_COMMANDS lookup misses. `EMPTY_SKILL_REGISTRY` when skills are
  // disabled or no skills loaded. The parser is otherwise pure (no I/O).
  skillRegistry?: SkillRegistry;
}

export const BOT_COMMAND_REGISTRY: ReadonlyArray<BotCommand> = [
  { command: "clear", description: "Drop session state for this chat" },
  { command: "compact", description: "Summarize and restart current session" },
  { command: "status", description: "Show session and spend snapshot" },
  { command: "context", description: "Show context window size in bytes + tokens" },
  { command: "help", description: "Show available commands" },
];

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

// Telegram allows `[a-z0-9_]{1,32}` for command names. We use `{0,32}` so the
// regex also matches the "bare slash" shape (`/`, `/ `, `/@bot`) without
// requiring a separate code path; the dispatcher then surfaces zero-length
// names as `kind: "empty"`. The leading `\s*` tolerates mobile autocorrect
// inserting a leading space; case-insensitivity is handled by `.toLowerCase()`
// after match.
//
// Both `/` and `:` are accepted as the prefix. `/` is the canonical Telegram
// bot-command prefix (autocomplete via `setMyCommands`, registered with
// Telegram). `:` is a display alias so the help card can render bold command
// names without Telegram's client auto-linkifying them (auto-link only
// triggers on `/word`). When `:` is used and the command isn't recognized
// we fall through to passthrough rather than returning "unknown" — `:foo` is
// far more likely natural text than a typo'd command, whereas `/foo` is
// almost certainly an attempted command.
const COMMAND_RE = /^\s*([\/:])([A-Za-z0-9_]{0,32})(?:@([A-Za-z0-9_]{1,32}))?(?:\s+(.+?))?\s*$/;

const KNOWN_COMMANDS = new Set(["clear", "compact", "status", "context", "help"]);

const TIER_ARG_MAP: Record<string, TierArg> = {
  primary: "primary",
  p: "primary",
  "@": "primary",
  secondary: "secondary",
  s: "secondary",
  "!": "secondary",
  all: "all",
  "*": "all",
};

export function parseCommand(text: string, deps: ParseCommandDeps): ParseCommandResult {
  const trimmedStart = text.trimStart();
  const leadChar = trimmedStart[0];
  if (leadChar !== "/" && leadChar !== ":") return { kind: "passthrough" };

  const m = COMMAND_RE.exec(text);
  if (!m) {
    // Started with a prefix char but didn't match the strict shape. For `/`
    // we treat as an unknown command (likely a typo); for `:` we pass through
    // since `:` reuses freely in natural text (e.g. emoticons, key-value).
    if (leadChar === "/") {
      return { kind: "run", cmd: { kind: "unknown", raw: trimmedStart } };
    }
    return { kind: "passthrough" };
  }
  const prefix = m[1]!;
  const name = m[2]!.toLowerCase();
  const targetBot = m[3];
  const argRaw = m[4]?.trim() ?? "";

  // Group-chat targeting. `botUsername` is null when boot-time getMe failed;
  // fail closed — accept plain (no-suffix) commands, reject any `@bot` suffix
  // because we can't verify it's us.
  if (targetBot !== undefined) {
    const botMatch =
      deps.botUsername !== null && targetBot.toLowerCase() === deps.botUsername;
    if (!botMatch) return { kind: "ignore" };
  }

  // Empty command shape: `/`, `/ `, `/@bot`, `:` — render help.
  if (name === "") return { kind: "run", cmd: { kind: "empty" } };

  if (!KNOWN_COMMANDS.has(name)) {
    // PNX-167.1 — try operator-defined skills before falling through to
    // unknown. Skill names are stored lowercased in the registry; the
    // incoming `name` is already lowercased above.
    const skill = deps.skillRegistry?.get(name);
    if (skill) {
      return { kind: "run", cmd: { kind: "skill", skill, args: argRaw } };
    }
    // For `:` an unknown name → passthrough (user is probably writing prose,
    // not invoking a command). For `/` → unknown (intent was clearly a
    // command).
    if (prefix === ":") return { kind: "passthrough" };
    return { kind: "run", cmd: { kind: "unknown", raw: `/${name}` } };
  }

  if (name === "help") return { kind: "run", cmd: { kind: "help" } };
  if (name === "status") return { kind: "run", cmd: { kind: "status" } };

  if (name === "clear") {
    if (argRaw === "") return { kind: "run", cmd: { kind: "clear", tier: "all" } };
    const tier = TIER_ARG_MAP[argRaw.toLowerCase()];
    if (tier === undefined) {
      return { kind: "run", cmd: { kind: "unknown", raw: `${prefix}clear ${argRaw}` } };
    }
    return { kind: "run", cmd: { kind: "clear", tier } };
  }

  if (name === "context") {
    // Same shape as /compact: single tier, no `all`. /context shows the
    // estimated context-window size for ONE tier at a time; rendering both
    // would be cluttered and most users default to primary anyway.
    if (argRaw === "") return { kind: "run", cmd: { kind: "context", tier: "primary" } };
    const tierC = TIER_ARG_MAP[argRaw.toLowerCase()];
    if (tierC === undefined || tierC === "all") {
      return { kind: "run", cmd: { kind: "unknown", raw: `${prefix}context ${argRaw}` } };
    }
    return { kind: "run", cmd: { kind: "context", tier: tierC } };
  }

  // /compact — `all` is invalid for compact (compacting both tiers in one
  // command is two real Claude calls and surprising; require explicit
  // `/compact !` for secondary).
  if (argRaw === "") return { kind: "run", cmd: { kind: "compact", tier: "primary" } };
  const tier = TIER_ARG_MAP[argRaw.toLowerCase()];
  if (tier === undefined || tier === "all") {
    return { kind: "run", cmd: { kind: "unknown", raw: `${prefix}compact ${argRaw}` } };
  }
  return { kind: "run", cmd: { kind: "compact", tier } };
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export interface RunCommandDeps {
  tg: TelegramClient;
  db: SolracDb;
  sessions: SessionStore;
  allowlist: Allowlist;
  dataDir: string;
  primaryModel: string;
  secondaryModel: string;
  costGuard: CostCapGuard;
  globalCostGuard: GlobalCostCapGuard;
  // Closure into the queue snapshot so /status can render in-flight + waiting
  // counts without the dispatcher holding the queue handle directly.
  getQueueSnapshot: () => { inFlight: number; waiting: number };
  // Boot timestamp for /status uptime line.
  startedAt: number;
  // Global cap for /status display.
  hourlyCostCapUsd: number;
  globalHourlyCostCapUsd: number;
  // PNX-167.1 — operator-defined skills. `EMPTY_SKILL_REGISTRY` when skills
  // are disabled. `/help` enumerates loaded skills; the parser dispatches to
  // them by name.
  skillRegistry: SkillRegistry;
}

const COMPACT_SOURCE_LIMIT = 50;

export async function runCommand(
  deps: RunCommandDeps,
  msg: Message,
  cmd: SolracCommand,
  updateId: number,
): Promise<void> {
  switch (cmd.kind) {
    case "clear":
      return runClear(deps, msg, updateId, cmd.tier);
    case "compact":
      return runCompact(deps, msg, updateId, cmd.tier);
    case "status":
      return runStatus(deps, msg, updateId);
    case "context":
      return runContext(deps, msg, updateId, cmd.tier);
    case "help":
      return runHelp(deps, msg, updateId);
    case "empty":
      // Bare `/` — render help.
      return runHelp(deps, msg, updateId);
    case "unknown":
      return runUnknown(deps, msg, updateId, cmd.raw);
    case "skill":
      return runSkill(deps, msg, updateId, cmd.skill, cmd.args);
  }
}

// Helper — write the in-progress + finalized audit row pair for a system-
// tagged command (everything except /compact). Mirrors the
// insertAudit/updateAuditEnd pattern in main.ts::auditQueueFull.
function writeSystemAudit(
  deps: RunCommandDeps,
  msg: Message,
  updateId: number,
  response: string,
  status: "ok" | "error",
  errorMessage: string | null = null,
): number {
  const now = Date.now();
  const auditId = deps.db.insertAudit({
    chatId: msg.chat.id,
    fromId: msg.from!.id,
    updateId,
    prompt: truncateAuditPrompt(msg.text ?? ""),
    startedAt: now,
    model: "system",
  });
  deps.db.updateAuditEnd({
    id: auditId,
    response,
    toolCalls: null,
    inputTokens: null,
    outputTokens: null,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
    costUsd: null,
    agentSessionId: null,
    status,
    errorMessage,
    endedAt: Date.now(),
  });
  return auditId;
}

// ---------------------------------------------------------------------------
// /clear
// ---------------------------------------------------------------------------

async function runClear(
  deps: RunCommandDeps,
  msg: Message,
  updateId: number,
  tier: TierArg,
): Promise<void> {
  const session = deps.sessions.getSession(msg.chat.id);
  const tiers: SessionTier[] = tier === "all" ? ["primary", "secondary"] : [tier];

  // Determine which tiers actually had anything to drop. A tier is "dirty"
  // when its session id OR its summary is non-null. Used to render the
  // "already clean" reply rather than pretending we did something.
  const dirty: SessionTier[] = [];
  if (session) {
    for (const t of tiers) {
      const id = t === "primary" ? session.primarySessionId : session.secondarySessionId;
      const summary = t === "primary" ? session.primarySummary : session.secondarySummary;
      if (id !== null || summary !== null) dirty.push(t);
    }
  }

  if (dirty.length === 0) {
    const label = tierLabel(tier);
    const reply = `🧹 Already clean — no <b>${label}</b> session to drop.`;
    await sendOrLog(deps.tg, msg.chat.id, reply, "cmd.clear_reply_failed");
    writeSystemAudit(deps, msg, updateId, "already_clean", "ok");
    return;
  }

  for (const t of dirty) deps.sessions.clearAll(msg.chat.id, t);

  const cleared = dirty.map((t) => `<b>${t}</b>`).join(" + ");
  const reply = `🧹 Cleared ${cleared} session state. Next turn starts fresh.`;
  await sendOrLog(deps.tg, msg.chat.id, reply, "cmd.clear_reply_failed");
  writeSystemAudit(deps, msg, updateId, `cleared:${dirty.join(",")}`, "ok");
}

function tierLabel(tier: TierArg): string {
  if (tier === "all") return "primary + secondary";
  return tier;
}

// ---------------------------------------------------------------------------
// /compact
// ---------------------------------------------------------------------------

async function runCompact(
  deps: RunCommandDeps,
  msg: Message,
  updateId: number,
  tier: TierArgSingle,
): Promise<void> {
  const result = await runCompactTurn(deps, {
    chatId: msg.chat.id,
    fromId: msg.from!.id,
    tier,
  });

  // Compact writes an audit row tagged with the engine model so the cost
  // rolls up under the per-chat hourly cap on subsequent turns. The row's
  // prompt is the literal user `/compact ...` text (truncated); response is
  // a 200-char snippet of the summary (or null on error).
  const modelId = tier === "primary" ? deps.primaryModel : deps.secondaryModel;
  const engineModelTag = `claude:${tier}:${modelId}`;
  const startedAt = result.startedAt ?? Date.now();
  const auditId = deps.db.insertAudit({
    chatId: msg.chat.id,
    fromId: msg.from!.id,
    updateId,
    prompt: truncateAuditPrompt(msg.text ?? ""),
    startedAt,
    model: engineModelTag,
  });

  if (!result.ok) {
    deps.db.updateAuditEnd({
      id: auditId,
      response: null,
      toolCalls: null,
      inputTokens: null,
      outputTokens: null,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
      costUsd: result.costUsd ?? null,
      agentSessionId: null,
      status: "error",
      errorMessage: result.errorMessage ?? "unknown",
      endedAt: Date.now(),
    });
    const md = renderCompactErrorMarkdown(tier, result.errorMessage ?? "unknown");
    await sendOrLog(
      deps.tg,
      msg.chat.id,
      mdToTelegramHtml(md),
      "cmd.compact_reply_failed",
      md,
    );
    return;
  }

  // Persist on success: store summary + drop session id atomically (two
  // statements; same chat row).
  deps.sessions.setSummary(msg.chat.id, tier, result.summary!, Date.now());
  deps.sessions.clearSessionId(msg.chat.id, tier);

  deps.db.updateAuditEnd({
    id: auditId,
    response: snippet(result.summary!, 200),
    toolCalls: null,
    inputTokens: result.inputTokens ?? null,
    outputTokens: result.outputTokens ?? null,
    cacheCreationInputTokens: result.cacheCreationInputTokens ?? null,
    cacheReadInputTokens: result.cacheReadInputTokens ?? null,
    costUsd: result.costUsd ?? null,
    agentSessionId: null,
    status: "ok",
    errorMessage: null,
    endedAt: Date.now(),
  });

  const cost = result.costUsd ?? 0;
  const tokens = result.outputTokens ?? 0;
  const md =
    `✅ **Compacted** ${result.numSourceTurns} turn${result.numSourceTurns === 1 ? "" : "s"} ` +
    `for **${tier}** · ~${tokens} tokens · $${cost.toFixed(4)}`;
  await sendOrLog(
    deps.tg,
    msg.chat.id,
    mdToTelegramHtml(md),
    "cmd.compact_reply_failed",
    md,
  );
}

function renderCompactErrorMarkdown(tier: TierArgSingle, errorMessage: string): string {
  if (errorMessage === "nothing_to_compact") {
    return `📭 nothing to compact for **${tier}**`;
  }
  if (errorMessage.startsWith("chat_cost_cap") || errorMessage.startsWith("global_cost_cap")) {
    return `❌ ${errorMessage} — try again later`;
  }
  return `❌ compact failed: ${errorMessage}`;
}

function snippet(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

// ---------------------------------------------------------------------------
// /compact — SDK runner
// ---------------------------------------------------------------------------

export interface RunCompactDeps {
  db: SolracDb;
  sessions: SessionStore;
  dataDir: string;
  primaryModel: string;
  secondaryModel: string;
  costGuard: CostCapGuard;
  globalCostGuard: GlobalCostCapGuard;
}

export interface RunCompactInput {
  chatId: number;
  fromId: number;
  tier: SessionTier;
}

export interface CompactResult {
  ok: boolean;
  summary?: string;
  numSourceTurns?: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
  // PNX-167 — cache telemetry, mirrors the audit columns. Captured for
  // /context completeness even though /compact runs without `resume` so the
  // cache_read portion will typically be 0.
  cacheCreationInputTokens?: number | null;
  cacheReadInputTokens?: number | null;
  costUsd?: number | null;
  errorMessage?: string;
  // The wall-clock at which the SDK call began. Surfaced to the dispatcher so
  // the audit row's `started_at` reflects "the actual start" rather than
  // "after the SDK returned." Useful when summarization takes >1s.
  startedAt?: number;
}

export async function runCompactTurn(
  deps: RunCompactDeps,
  input: RunCompactInput,
): Promise<CompactResult> {
  const startedAt = Date.now();

  // 1. Pre-flight cost cap (per-chat + global). Same checks as the
  // PreToolUse hook in agent.ts; running them up-front saves a network call
  // when the cap is already exceeded.
  const chatCap = deps.costGuard.check(input.chatId);
  if (chatCap.exceeded) {
    return {
      ok: false,
      startedAt,
      errorMessage: `chat_cost_cap: $${chatCap.spentUsd.toFixed(4)} ≥ $${chatCap.capUsd.toFixed(2)}/hr for this chat`,
    };
  }
  const globalCap = deps.globalCostGuard.check();
  if (globalCap.exceeded) {
    return {
      ok: false,
      startedAt,
      errorMessage: `global_cost_cap: $${globalCap.spentUsd.toFixed(4)} ≥ $${globalCap.capUsd.toFixed(2)}/hr across all chats`,
    };
  }

  // 2. Source turns — only those we haven't already condensed.
  const prevSummary = deps.sessions.getSummary(input.chatId, input.tier);
  const enginePrefix = `claude:${input.tier}:%`;
  const turns = deps.db.recentChatTurnsForEngine(
    input.chatId,
    enginePrefix,
    COMPACT_SOURCE_LIMIT,
    prevSummary?.at ?? 0,
  );
  if (turns.length === 0) {
    return { ok: false, startedAt, errorMessage: "nothing_to_compact" };
  }

  // Source-quality signal: every audit row's `prompt` is truncated to
  // MAX_AUDIT_PROMPT_LEN (256 chars) at insert by `truncateAuditPrompt`,
  // while `response` is unbounded. The asymmetry skews `/compact` summaries
  // toward Solrac's output and away from the user's intent — a long brief
  // pasted by the user gets summarized as ≤256 chars. Surface the truncation
  // count so the operator can see when summary quality may degrade. The
  // truncator stamps `…` on the last char, so length 256 with that suffix
  // is the truncation signature; we use `>= 250` as a safe heuristic.
  const truncatedSourceCount = turns.filter((t) => (t.prompt?.length ?? 0) >= 250).length;
  if (truncatedSourceCount > 0) {
    log.warn("compact.source_prompts_truncated", {
      chatId: input.chatId,
      tier: input.tier,
      truncatedSourceCount,
      totalSourceCount: turns.length,
    });
  }

  // 3. Build the prompt and run a one-shot, tool-less Claude turn. No
  // resume — the summarizer is fresh. `canUseTool` denies everything as
  // belt-and-suspenders against the SDK auto-allowing a trivial Read on its
  // own input (in practice it shouldn't try; the prompt is summarize-only).
  const prompt = buildSummaryPrompt(turns);
  const modelId = input.tier === "primary" ? deps.primaryModel : deps.secondaryModel;
  const cwd = join(deps.dataDir, "workspaces", String(input.chatId));
  await mkdir(cwd, { recursive: true });

  const options: Options = {
    cwd,
    model: modelId,
    maxTurns: 1,
    permissionMode: "default",
    tools: { type: "preset", preset: "claude_code" },
    systemPrompt:
      "You are a summarizer. Produce ONLY the requested summary as plain text. " +
      "Do not call tools. Do not explain or apologize. Do not include preamble.",
    // Belt-and-suspenders: the prompt asks for a summary, not tool use, but
    // the SDK's preset has tools available. Block the dangerous ones
    // explicitly so a model that misreads can't do harm.
    disallowedTools: [
      "Agent",
      "Task",
      "Bash",
      "Write",
      "Edit",
      "NotebookEdit",
      "WebFetch",
      "WebSearch",
    ],
    canUseTool: async () => ({
      behavior: "deny",
      message: "tools are disabled for /compact summarization",
    }),
    env: sanitizedSubprocessEnv(),
  };

  let resultText = "";
  let costUsd: number | null = null;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let cacheCreationInputTokens: number | null = null;
  let cacheReadInputTokens: number | null = null;
  let errorMessage: string | null = null;

  try {
    for await (const m of query({ prompt, options })) {
      if (m.type === "assistant") {
        for (const block of m.message.content) {
          if (block.type === "text" && block.text) resultText += block.text;
        }
      } else if (m.type === "result") {
        if (m.subtype === "success") {
          if (m.result) resultText = m.result;
          costUsd = m.total_cost_usd;
          inputTokens = m.usage.input_tokens;
          outputTokens = m.usage.output_tokens;
          cacheCreationInputTokens = m.usage.cache_creation_input_tokens;
          cacheReadInputTokens = m.usage.cache_read_input_tokens;
        } else {
          errorMessage = `result_error: ${m.subtype}`;
        }
      }
    }
  } catch (err) {
    errorMessage = (err as Error).message;
    log.error("compact.error", {
      chatId: input.chatId,
      tier: input.tier,
      error: errorMessage,
    });
  }

  if (errorMessage !== null) {
    return { ok: false, startedAt, errorMessage, costUsd };
  }
  const trimmed = resultText.trim();
  if (trimmed === "") {
    return { ok: false, startedAt, errorMessage: "empty_summary", costUsd };
  }

  log.info("compact.done", {
    chatId: input.chatId,
    tier: input.tier,
    numSourceTurns: turns.length,
    outputTokens,
    inputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    costUsd,
    summaryLength: trimmed.length,
  });

  return {
    ok: true,
    startedAt,
    summary: trimmed,
    numSourceTurns: turns.length,
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    costUsd,
  };
}

// Build the summarizer's prompt. The label is just `[User]` / `[Solrac]` —
// distinguishing primary vs secondary tier in the transcript confuses the
// summarizer more than it helps (it tries to summarize the routing instead of
// the content). The model field on each row is dropped.
export function buildSummaryPrompt(turns: ReadonlyArray<ChatHistoryRow>): string {
  const lines = [
    "You are summarizing a conversation between a user and Solrac, a Telegram-based agent. Below is the recent transcript. Produce a compact summary that preserves:",
    "",
    "1. The user's stated goals or projects in this thread.",
    "2. Open questions or in-flight tasks (mention status: started / blocked / done).",
    "3. Concrete decisions and named entities (file paths, ticket IDs, URLs, people).",
    "4. Anything the user asked you to remember.",
    "",
    "Compress everything else aggressively. Drop pleasantries, redundant phrasing, and step-by-step reasoning that's no longer relevant. Aim for under 500 tokens (≈2000 chars).",
    "",
    'Output ONLY the summary as a single block of prose with at most three short paragraphs or a bulleted list — no preamble, no apology, no header like "Summary:".',
    "",
    "Transcript:",
    "",
  ];
  for (const t of turns) {
    lines.push(`[User]: ${t.prompt}`);
    lines.push(`[Solrac]: ${t.response}`);
    lines.push("");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// /status
// ---------------------------------------------------------------------------

async function runStatus(
  deps: RunCommandDeps,
  msg: Message,
  updateId: number,
): Promise<void> {
  const md = renderStatusMarkdown(deps, msg.chat.id, Date.now());
  await sendOrLog(deps.tg, msg.chat.id, mdToTelegramHtml(md), "cmd.status_reply_failed", md);
  writeSystemAudit(deps, msg, updateId, "status_shown", "ok");
}

export function renderStatusMarkdown(
  deps: Pick<
    RunCommandDeps,
    | "db"
    | "sessions"
    | "getQueueSnapshot"
    | "startedAt"
    | "hourlyCostCapUsd"
    | "globalHourlyCostCapUsd"
  >,
  chatId: number,
  now: number,
): string {
  const session = deps.sessions.getSession(chatId);
  const oneHourAgo = now - 60 * 60 * 1000;
  const oneDayAgo = now - 24 * 60 * 60 * 1000;

  const primaryLine = renderTierLineMarkdown(deps, chatId, "primary", session, now);
  const secondaryLine = renderTierLineMarkdown(deps, chatId, "secondary", session, now);
  const summaryLine = renderSummaryLineMarkdown(session);

  const chatSpend1h = deps.db.sumChatCostSince(chatId, oneHourAgo);
  const chatSpend24h = deps.db.sumChatCostSince(chatId, oneDayAgo);
  const globalSpend1h = deps.db.sumCostSince(oneHourAgo);

  const snap = deps.getQueueSnapshot();
  const uptimeSec = (now - deps.startedAt) / 1000;

  return [
    "## 📊 Solrac status",
    "",
    "**This chat**",
    "",
    `- primary session: ${primaryLine}`,
    `- secondary session: ${secondaryLine}`,
    `- pending summary: ${summaryLine}`,
    `- spent (1h): $${chatSpend1h.toFixed(4)} / $${deps.hourlyCostCapUsd.toFixed(2)}`,
    `- spent (24h): $${chatSpend24h.toFixed(4)}`,
    "",
    "**Global**",
    "",
    `- spent (1h): $${globalSpend1h.toFixed(4)} / $${deps.globalHourlyCostCapUsd.toFixed(2)}`,
    `- in-flight turns: ${snap.inFlight} · waiting: ${snap.waiting}`,
    `- uptime: ${formatUptime(uptimeSec)}`,
  ].join("\n");
}

function renderTierLineMarkdown(
  deps: Pick<RunCommandDeps, "db">,
  chatId: number,
  tier: SessionTier,
  session: ReturnType<SessionStore["getSession"]>,
  now: number,
): string {
  const sessionId = !session
    ? null
    : tier === "primary"
      ? session.primarySessionId
      : session.secondarySessionId;
  if (sessionId === null) return "*none*";
  const enginePrefix = `claude:${tier}:%`;
  const count = deps.db.countChatTurnsForEngine(chatId, enginePrefix);
  const lastAt = deps.db.lastSuccessfulTurnAt(chatId, enginePrefix);
  const idShort = `${sessionId.slice(0, 4)}…${sessionId.slice(-4)}`;
  const ageStr = lastAt !== null ? ` · last ${formatAge(now - lastAt)} ago` : "";
  return `\`${idShort}\` (${count} turn${count === 1 ? "" : "s"}${ageStr})`;
}

function renderSummaryLineMarkdown(session: ReturnType<SessionStore["getSession"]>): string {
  if (!session) return "*none*";
  const have: string[] = [];
  if (session.primarySummary) have.push("primary");
  if (session.secondarySummary) have.push("secondary");
  if (have.length === 0) return "*none*";
  return have.join(", ");
}

function formatUptime(secs: number): string {
  const s = Math.floor(secs);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h >= 1) return `${h}h ${m}m`;
  if (m >= 1) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function formatAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

// ---------------------------------------------------------------------------
// /context — display context-window size in bytes + tokens
// ---------------------------------------------------------------------------

async function runContext(
  deps: RunCommandDeps,
  msg: Message,
  updateId: number,
  tier: TierArgSingle,
): Promise<void> {
  const md = renderContextMarkdown(deps, msg.chat.id, tier);
  await sendOrLog(deps.tg, msg.chat.id, mdToTelegramHtml(md), "cmd.context_reply_failed", md);
  writeSystemAudit(deps, msg, updateId, `context_shown:${tier}`, "ok");
}

export function renderContextMarkdown(
  deps: Pick<RunCommandDeps, "db" | "sessions">,
  chatId: number,
  tier: TierArgSingle,
): string {
  const enginePrefix = `claude:${tier}:%`;
  const session = deps.sessions.getSession(chatId);
  const sessionId =
    !session
      ? null
      : tier === "primary"
        ? session.primarySessionId
        : session.secondarySessionId;
  const summary =
    !session
      ? null
      : tier === "primary"
        ? session.primarySummary
        : session.secondarySummary;
  const turnCount = deps.db.countChatTurnsForEngine(chatId, enginePrefix);
  const bytes = deps.db.sumChatBytesForEngine(chatId, enginePrefix);
  const last = deps.db.lastTurnStatsForEngine(chatId, enginePrefix);

  const sessionLine =
    sessionId === null
      ? "*none — fresh next turn*"
      : `\`${sessionId.slice(0, 4)}…${sessionId.slice(-4)}\``;

  const lines: string[] = [
    `## 🪟 Context — **${tier}**`,
    "",
    `- session: ${sessionLine}`,
    `- turns (this chat+tier): ${turnCount}`,
    `- audit footprint: ${formatBytes(bytes)} (text on disk; \`prompt\` truncated at 256)`,
  ];
  if (summary !== null) {
    lines.push(`- pending summary: ${formatBytes(summary.length)} (will inject on next turn)`);
  }
  if (last === null) {
    lines.push("", "*No successful turn yet for this tier.*");
    return lines.join("\n");
  }
  // Real input on the wire = fresh + cache_read + cache_create. The SDK's
  // `usage.input_tokens` is JUST the fresh portion; on a resumed session
  // most of the actual context is in `cache_read_input_tokens`.
  const fresh = last.inputTokens ?? 0;
  const cacheRead = last.cacheReadInputTokens ?? 0;
  const cacheCreate = last.cacheCreationInputTokens ?? 0;
  const output = last.outputTokens ?? 0;
  const totalInput = fresh + cacheRead + cacheCreate;
  // Estimate of "what the next turn replays": this turn's total input plus
  // its output (which becomes part of the SDK session's history). Excludes
  // the next user message itself, which we can't predict.
  const replayEstimate = totalInput + output;

  lines.push(
    "",
    "**Last turn (Anthropic API)**",
    "",
    `- fresh input: ${formatNum(fresh)} tokens`,
    `- cache read: ${formatNum(cacheRead)} tokens`,
    `- cache create: ${formatNum(cacheCreate)} tokens`,
    `- output: ${formatNum(output)} tokens`,
    `- cost: $${(last.costUsd ?? 0).toFixed(4)}`,
    "",
    `**Estimated next-turn replay**: ~${formatNum(replayEstimate)} tokens`,
    "*(prior input + cache + last output, excluding new message)*",
  );
  return lines.join("\n");
}

function formatNum(n: number): string {
  return n.toLocaleString("en-US");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${formatNum(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// ---------------------------------------------------------------------------
// /help
// ---------------------------------------------------------------------------

async function runHelp(
  deps: RunCommandDeps,
  msg: Message,
  updateId: number,
): Promise<void> {
  const md = renderHelpMarkdown(deps.skillRegistry);
  // Authored once in markdown, derived to Telegram-safe HTML for the bot
  // path. The web transport uses `markdownSource` directly so the browser
  // gets full headers/lists/links rendering.
  await sendOrLog(deps.tg, msg.chat.id, mdToTelegramHtml(md), "cmd.help_reply_failed", md);
  writeSystemAudit(deps, msg, updateId, "help_shown", "ok");
}

const HELP_BASE_MD = [
  "## 🤖 Solrac help",
  "",
  "**Engines** (first character of your message):",
  "",
  "- plain text or `@` → primary Claude (Sonnet)",
  "- `!` → secondary Claude (Opus, costs more)",
  "- `>` → local Ollama (free, no tools)",
  "",
  "**Commands** (type `/cmd` for autocomplete, or `:cmd`)",
  "",
  "- **clear** `[primary|secondary|all]` — drop session state. Default: all.",
  "- **compact** `[primary|secondary]` — summarize and restart session. Costs one Claude turn. Default: primary.",
  "- **context** `[primary|secondary]` — show context-window size in bytes + tokens. Default: primary.",
  "- **help** — this card.",
  "- **status** — show session and spend snapshot for this chat.",
  "",
  "**Customize**",
  "",
  "- `SOUL.md` in the launch dir — voice, stance, safety. Restart to apply.",
  "- `SOLRAC.md` in the launch dir — operator overlay (who runs it, project context). Re-read every turn.",
  "",
  "Send `!!literal` to start a message with a literal `!`.",
].join("\n");

// Render `/help` in markdown including operator-defined skills if any are
// loaded. Static commands stay verbatim so the help card is grep-stable
// across deployments without skills; the skills section only appears when
// present. The Telegram path runs this through `mdToTelegramHtml`; the web
// transport renders it with `marked` in the browser.
export function renderHelpMarkdown(skills: SkillRegistry): string {
  if (skills.size() === 0) return HELP_BASE_MD;
  const lines = [HELP_BASE_MD, "", "**Skills**", ""];
  // Sort by name for stable output across runs (registry insertion order is
  // filesystem-dependent).
  const sorted = [...skills.all].sort((a, b) => a.name.localeCompare(b.name));
  for (const s of sorted) {
    lines.push(`- **${s.name}** — ${s.description}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// /unknown
// ---------------------------------------------------------------------------

async function runUnknown(
  deps: RunCommandDeps,
  msg: Message,
  updateId: number,
  raw: string,
): Promise<void> {
  const reply = `❓ Unknown command: <code>${htmlEscapeText(raw)}</code>. Try /help.`;
  await sendOrLog(deps.tg, msg.chat.id, reply, "cmd.unknown_reply_failed");
  writeSystemAudit(deps, msg, updateId, "unknown_command", "ok");
}

// ---------------------------------------------------------------------------
// /skill — operator-defined skill (PNX-167.1)
// ---------------------------------------------------------------------------
//
// Skills are one-shot Claude turns parameterized by an operator-authored
// SKILL.md file. The handler mirrors `runCompactTurn`'s structural pattern:
//   - Pre-flight cost caps (chat + global) before any SDK call.
//   - Audit row tagged with the engine model + skill name so cost rolls up
//     under the existing per-chat cap.
//   - One-shot `query()` with no `resume`, `maxTurns: 1`, tools disabled
//     (canUseTool deny-all + same `disallowedTools` belt-and-suspenders as
//     /compact). v1 skills are pure text-in / text-out — if a skill needs
//     tool use, that's a v1.1 conversation.
//   - Reply text is the model's output verbatim (HTML-escaped).
//
// Why duplicate ~120 LOC instead of factoring a shared helper: the result
// shape and post-processing differ from /compact (no summary persistence, no
// session-id drop), and the duplication is contained. A v1.1 refactor that
// extracts `runOneShotClaudeTurn` is fine when a third caller arrives.

const SKILL_DISALLOWED_TOOLS = [
  "Agent",
  "Task",
  "Bash",
  "Write",
  "Edit",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
];

// Cap on the model's reply text we forward to Telegram. Telegram messages cap
// at 4096 chars; we leave headroom for formatting overhead. If the model
// produces more, the tail is dropped with a `…` marker.
const SKILL_REPLY_MAX = 3500;

async function runSkill(
  deps: RunCommandDeps,
  msg: Message,
  updateId: number,
  skill: Skill,
  args: string,
): Promise<void> {
  const startedAt = Date.now();
  const modelId = skill.tier === "primary" ? deps.primaryModel : deps.secondaryModel;
  // Engine tag mirrors /compact's shape so `sumChatCostSince` rolls skill
  // cost under the chat's hourly cap. The `:skill:<name>` suffix lets
  // operators grep audit dumps for skill activity per skill.
  const engineModelTag = `claude:${skill.tier}:${modelId}:skill:${skill.name}`;

  // 1. Pre-flight cost caps. Same checks as runCompactTurn — running them
  //    up-front saves the network round-trip when caps are already exceeded.
  const chatCap = deps.costGuard.check(msg.chat.id);
  if (chatCap.exceeded) {
    const errMsg = `chat_cost_cap: $${chatCap.spentUsd.toFixed(4)} ≥ $${chatCap.capUsd.toFixed(2)}/hr for this chat`;
    writeSkillAudit(deps, msg, updateId, engineModelTag, startedAt, null, "error", errMsg);
    await sendOrLog(
      deps.tg,
      msg.chat.id,
      `❌ ${htmlEscapeText(errMsg)} — try again later`,
      "cmd.skill_reply_failed",
    );
    return;
  }
  const globalCap = deps.globalCostGuard.check();
  if (globalCap.exceeded) {
    const errMsg = `global_cost_cap: $${globalCap.spentUsd.toFixed(4)} ≥ $${globalCap.capUsd.toFixed(2)}/hr across all chats`;
    writeSkillAudit(deps, msg, updateId, engineModelTag, startedAt, null, "error", errMsg);
    await sendOrLog(
      deps.tg,
      msg.chat.id,
      `❌ ${htmlEscapeText(errMsg)} — try again later`,
      "cmd.skill_reply_failed",
    );
    return;
  }

  // 2. Render the prompt template and run a one-shot, tool-less turn.
  const prompt = renderSkillTemplate(skill.body, args);
  const cwd = join(deps.dataDir, "workspaces", String(msg.chat.id));
  await mkdir(cwd, { recursive: true });

  const options: Options = {
    cwd,
    model: modelId,
    maxTurns: 1,
    permissionMode: "default",
    tools: { type: "preset", preset: "claude_code" },
    disallowedTools: SKILL_DISALLOWED_TOOLS,
    canUseTool: async () => ({
      behavior: "deny",
      message: "tools are disabled for skills in v1",
    }),
    env: sanitizedSubprocessEnv(),
  };

  let resultText = "";
  let costUsd: number | null = null;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let cacheCreationInputTokens: number | null = null;
  let cacheReadInputTokens: number | null = null;
  let errorMessage: string | null = null;

  try {
    for await (const m of query({ prompt, options })) {
      if (m.type === "assistant") {
        for (const block of m.message.content) {
          if (block.type === "text" && block.text) resultText += block.text;
        }
      } else if (m.type === "result") {
        if (m.subtype === "success") {
          if (m.result) resultText = m.result;
          costUsd = m.total_cost_usd;
          inputTokens = m.usage.input_tokens;
          outputTokens = m.usage.output_tokens;
          cacheCreationInputTokens = m.usage.cache_creation_input_tokens;
          cacheReadInputTokens = m.usage.cache_read_input_tokens;
        } else {
          errorMessage = `result_error: ${m.subtype}`;
        }
      }
    }
  } catch (err) {
    errorMessage = (err as Error).message;
    log.error("skill.error", {
      chatId: msg.chat.id,
      skill: skill.name,
      tier: skill.tier,
      error: errorMessage,
    });
  }

  const trimmed = resultText.trim();
  if (errorMessage === null && trimmed === "") errorMessage = "empty_response";

  const auditId = deps.db.insertAudit({
    chatId: msg.chat.id,
    fromId: msg.from!.id,
    updateId,
    prompt: truncateAuditPrompt(msg.text ?? ""),
    startedAt,
    model: engineModelTag,
  });

  if (errorMessage !== null) {
    deps.db.updateAuditEnd({
      id: auditId,
      response: null,
      toolCalls: null,
      inputTokens,
      outputTokens,
      cacheCreationInputTokens,
      cacheReadInputTokens,
      costUsd,
      agentSessionId: null,
      status: "error",
      errorMessage,
      endedAt: Date.now(),
    });
    await sendOrLog(
      deps.tg,
      msg.chat.id,
      `❌ skill <b>${htmlEscapeText(skill.name)}</b> failed: ${htmlEscapeText(errorMessage)}`,
      "cmd.skill_reply_failed",
    );
    return;
  }

  deps.db.updateAuditEnd({
    id: auditId,
    response: snippet(trimmed, 200),
    toolCalls: null,
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    costUsd,
    agentSessionId: null,
    status: "ok",
    errorMessage: null,
    endedAt: Date.now(),
  });

  log.info("skill.done", {
    chatId: msg.chat.id,
    skill: skill.name,
    tier: skill.tier,
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    costUsd,
    replyLength: trimmed.length,
  });

  // Reply: HTML-escape the model output (the body may contain `<` etc.) and
  // truncate to keep under Telegram's per-message limit. We don't try to
  // preserve any markdown or formatting the skill produced — operators who
  // want HTML rendering can ask for it in their skill body and accept the
  // raw passthrough (in which case re-escape would mangle it; v1 keeps it
  // safe-by-default).
  const replyBody = trimmed.length > SKILL_REPLY_MAX
    ? trimmed.slice(0, SKILL_REPLY_MAX - 1) + "…"
    : trimmed;
  await sendOrLog(deps.tg, msg.chat.id, htmlEscapeText(replyBody), "cmd.skill_reply_failed");
}

function writeSkillAudit(
  deps: RunCommandDeps,
  msg: Message,
  updateId: number,
  engineModelTag: string,
  startedAt: number,
  costUsd: number | null,
  status: "ok" | "error",
  errorMessage: string | null,
): void {
  const auditId = deps.db.insertAudit({
    chatId: msg.chat.id,
    fromId: msg.from!.id,
    updateId,
    prompt: truncateAuditPrompt(msg.text ?? ""),
    startedAt,
    model: engineModelTag,
  });
  deps.db.updateAuditEnd({
    id: auditId,
    response: null,
    toolCalls: null,
    inputTokens: null,
    outputTokens: null,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
    costUsd,
    agentSessionId: null,
    status,
    errorMessage,
    endedAt: Date.now(),
  });
}

// ---------------------------------------------------------------------------
// Send helper — single point of try/catch for command replies. We never want
// a Telegram send failure to bubble out of `runCommand` (which would let the
// queue's catch-all log "turn.error" with a misleading message). Log the
// failure and move on.
// ---------------------------------------------------------------------------

async function sendOrLog(
  tg: TelegramClient,
  chatId: number,
  text: string,
  errEvent: string,
  markdownSource?: string,
): Promise<void> {
  await tg
    .sendMessage(chatId, text, { parse_mode: "HTML", markdownSource })
    .catch((err) => log.warn(errEvent, { chatId, error: (err as Error).message }));
}
