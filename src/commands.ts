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

import {
  query,
  type CanUseTool,
  type McpSdkServerConfigWithInstance,
  type Options,
  type SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import type { Message } from "@grammyjs/types";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { LOOP_THRESHOLD, sanitizedSubprocessEnv } from "./agent.ts";
import type { Allowlist } from "./allowlist.ts";
import type { ChatHistoryRow, SolracDb } from "./db.ts";
import type { IntegrationTier } from "./integrations.ts";
import { log } from "./log.ts";
import { mdToTelegramHtml } from "./markdown.ts";
import { buildToolCapabilityNote } from "./ollama.ts";
import { mcpToOllamaTools, runToolLoop } from "./ollama-tools.ts";
import {
  createLoopDetector,
  createPostToolUseHook,
  createPreToolUseHook,
  truncateAuditPrompt,
  type ConfirmationBroker,
  type ConfirmHandle,
  type CostCapGuard,
  type GlobalCostCapGuard,
  type PolicyDenyEvent,
} from "./policy.ts";
import type { SessionStore, SessionTier } from "./session.ts";
import { skillToolCtx } from "./skill-tools.ts";
import {
  renderSkillTemplate,
  type Skill,
  type SkillRegistry,
} from "./skills.ts";

// Mirror of `skill-tools.ts::SKILL_TOOL_PREFIX` — duplicated rather than
// imported to keep the cyclic surface between commands.ts and skill-tools.ts
// minimal. `skillToolCtx` (the AsyncLocalStorage instance) is imported above;
// it's safe because the import is only dereferenced inside functions, never
// at module load time. If you rename `SKILL_TOOL_PREFIX` in skill-tools.ts,
// rename it here too; `skill-tools.test.ts` covers the prefix invariant.
const SKILL_TOOL_PREFIX = "skills__";
import {
  nextRunAt,
  type SchedulerHandle,
  type Task as ScheduledTask,
  type TaskRegistry,
  type TriggerNowResult,
} from "./scheduler.ts";
import { htmlEscapeText, type BotCommand, type TelegramClient } from "./telegram.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TierArg = "primary" | "secondary" | "ollama" | "all";
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
  | { kind: "skill"; skill: Skill; args: string }
  // Scheduled-tasks operator surface (Phase 2).
  // - `/tasks` lists every loaded task with last/next fire info.
  // - `/tasks run <name>` fires a task on demand (bypasses the schedule
  //   clock; honors enabled / one_off_consumed / max_cost_usd / queue-full).
  | { kind: "tasks_list" }
  | { kind: "tasks_run"; name: string };

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
  { command: "tasks", description: "List scheduled tasks (or run <name>)" },
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
// `[\s\S]+?` (not `.+?`) so args with embedded newlines match — e.g. a skill
// invocation pasted with multi-line input (`/tldr <line1>\n<line2>`). Without
// this, `.` doesn't span `\n` and the whole regex fails, returning kind:unknown.
const COMMAND_RE = /^\s*([\/:])([A-Za-z0-9_]{0,32})(?:@([A-Za-z0-9_]{1,32}))?(?:\s+([\s\S]+?))?\s*$/;

const KNOWN_COMMANDS = new Set([
  "clear",
  "compact",
  "status",
  "context",
  "help",
  "tasks",
]);

const TIER_ARG_MAP: Record<string, TierArg> = {
  primary: "primary",
  p: "primary",
  "@": "primary",
  secondary: "secondary",
  s: "secondary",
  "!": "secondary",
  ollama: "ollama",
  o: "ollama",
  ">": "ollama",
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
    // PR-B: no-arg → reject. Pre-PR-B defaulted to primary because Claude was
    // the default engine; post-inversion most users haven't used a Claude
    // session, so a silent `tier: "primary"` would render "context: empty"
    // and look broken. Make the contract explicit; Ollama has no SDK session
    // to inspect.
    if (argRaw === "") {
      return {
        kind: "run",
        cmd: {
          kind: "unknown",
          raw: `${prefix}context (specify @|! — Ollama has no SDK session)`,
        },
      };
    }
    const tierC = TIER_ARG_MAP[argRaw.toLowerCase()];
    // `/context` and `/compact` are SDK-session affordances; `ollama` and
    // `all` aren't valid — Ollama has no SDK session, and the dispatcher's
    // SolracCommand carries a single tier.
    if (tierC === undefined || tierC === "all" || tierC === "ollama") {
      return { kind: "run", cmd: { kind: "unknown", raw: `${prefix}context ${argRaw}` } };
    }
    return { kind: "run", cmd: { kind: "context", tier: tierC } };
  }

  if (name === "tasks") {
    if (argRaw === "") return { kind: "run", cmd: { kind: "tasks_list" } };
    const m = /^run\s+([A-Za-z0-9_]{1,32})$/.exec(argRaw);
    if (m) return { kind: "run", cmd: { kind: "tasks_run", name: m[1]!.toLowerCase() } };
    return { kind: "run", cmd: { kind: "unknown", raw: `${prefix}tasks ${argRaw}` } };
  }

  // /compact — `all` is invalid (compacting both tiers in one command is two
  // real Claude calls and surprising). PR-B: no-arg → reject for the same
  // reason as /context above (silent `primary` default would summarize an
  // empty session post-inversion). Operators must specify `@` or `!`.
  if (argRaw === "") {
    return {
      kind: "run",
      cmd: {
        kind: "unknown",
        raw: `${prefix}compact (specify @|! — Ollama has no SDK session to summarize)`,
      },
    };
  }
  const tier = TIER_ARG_MAP[argRaw.toLowerCase()];
  if (tier === undefined || tier === "all" || tier === "ollama") {
    return { kind: "run", cmd: { kind: "unknown", raw: `${prefix}compact ${argRaw}` } };
  }
  return { kind: "run", cmd: { kind: "compact", tier } };
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

// Subset of OllamaRunDeps the skill path needs. Skills don't reuse runOllamaTurn
// because they don't carry history or SOLRAC.md overlays and have no streaming
// stub — but with PR-skills-tools they DO route through the same tool loop
// (`runToolLoop`) when tool deps are wired, so the skill body can call
// `mcp__solrac__*` / `skills__*` tools end-to-end. When tool deps are absent
// or `tools` is empty, `runSkillBare` falls through to the single-shot
// /api/chat path (preserving back-compat for pure text-transform skills
// like `tldr`).
export interface OllamaSkillDeps {
  url: string;
  model: string;
  timeoutMs: number;
  // SOUL.md text loaded once at boot. Sent as the system message so Ollama
  // skills inherit the operator's voice the same way Claude skills do via
  // the SDK's `claude_code` preset append.
  soul: string;
  // Injectable for tests; production passes `globalThis.fetch`.
  fetch?: typeof fetch;
  // PR-skills-tools — when all three are wired, runSkillBare routes the
  // skill body through `runToolLoop` so the model can call MCP tools the
  // same way `runOllamaTurnWithTools` does. The skill's own MCP tool entry
  // (`skills__<self>`) is filtered out of the catalog at dispatch time to
  // prevent direct recursion; indirect recursion (skill A → skills__B →
  // skills__A) is bounded by `runToolLoop`'s `maxIterations`.
  tools?: ReadonlyArray<SdkMcpToolDefinition<any>>;
  toolTiers?: ReadonlyMap<string, IntegrationTier>;
  broker?: Pick<ConfirmationBroker, "request">;
}

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
  // Ollama-tier skills run a one-shot `/api/chat` against the local daemon
  // (no SDK, no tool loop, no streaming stub). `null` when Ollama isn't
  // configured for this deploy — a `tier: ollama` skill in that case fails
  // loud with a config error rather than silently routing to Claude.
  ollamaSkillDeps: OllamaSkillDeps | null;
  // PR-B — `/help` renders the engine section dynamically from these two
  // fields so the card matches the deploy. Static text would lie in three
  // of four config combinations (default-Ollama vs default-Claude × tools on/off).
  defaultEngine: "ollama" | "primary" | "secondary";
  ollamaToolsEnabled: boolean;
  // Phase 2 — scheduled tasks operator surface. Both optional so deploys
  // with `SOLRAC_TASKS_ENABLED=false` can build the deps object without
  // dummy values; `/tasks` surfaces a "scheduler disabled" reply when the
  // registry is empty or absent.
  taskRegistry?: TaskRegistry;
  triggerScheduledTask?: (name: string) => TriggerNowResult;
  // Skills-as-agents (PR-skills-tools). Optional so legacy callers / tests
  // that don't drive tool-using skills keep working — when omitted, skill
  // tool calls fall through to `defaultAllowAll` (no interactive UX, no
  // confirm prompts). Production wires both, mirroring `runAgent`.
  createCanUseTool?: (args: {
    chatId: number;
    auditId: number;
    pendingHandles: Map<string, ConfirmHandle>;
  }) => CanUseTool;
  // In-process MCP server hosting operator + blessed integrations. Skills
  // see the same `mcp__solrac__<name>` surface as a normal turn when this is
  // set; `null` means integrations are disabled and skills run without an
  // MCP catalog (built-in SDK tools like Read/Bash still apply).
  mcpServer?: McpSdkServerConfigWithInstance | null;
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
    case "tasks_list":
      return runTasksList(deps, msg, updateId);
    case "tasks_run":
      return runTasksRun(deps, msg, updateId, cmd.name);
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

// One label per tier-state we actually clear. Claude tiers are SessionTier;
// "ollama" lives outside that union (no SDK session). Using a string union
// keeps the dirty list ordered and self-describing for the reply text.
type ClearableTier = SessionTier | "ollama";

async function runClear(
  deps: RunCommandDeps,
  msg: Message,
  updateId: number,
  tier: TierArg,
): Promise<void> {
  const session = deps.sessions.getSession(msg.chat.id);
  const tiers: ClearableTier[] =
    tier === "all" ? ["primary", "secondary", "ollama"] : [tier];

  // Determine which tiers actually had anything to drop. A Claude tier is
  // "dirty" when its session id OR its summary is non-null. Ollama is
  // "dirty" when there's at least one successful audit row past the current
  // cutoff — set-cutoff-twice is reported honestly as "Already clean".
  const dirty: ClearableTier[] = [];
  for (const t of tiers) {
    if (t === "ollama") {
      const cutoff = session?.ollamaCutoffMs ?? 0;
      if (deps.db.hasOllamaTurnsSince(msg.chat.id, cutoff)) dirty.push(t);
      continue;
    }
    if (!session) continue;
    const id = t === "primary" ? session.primarySessionId : session.secondarySessionId;
    const summary = t === "primary" ? session.primarySummary : session.secondarySummary;
    if (id !== null || summary !== null) dirty.push(t);
  }

  if (dirty.length === 0) {
    const label = tierLabel(tier);
    const reply = `🧹 Already clean — no <b>${label}</b> session to drop.`;
    await sendOrLog(deps.tg, msg.chat.id, reply, "cmd.clear_reply_failed");
    writeSystemAudit(deps, msg, updateId, "already_clean", "ok");
    return;
  }

  for (const t of dirty) {
    if (t === "ollama") {
      deps.sessions.setOllamaCutoff(msg.chat.id, Date.now());
      continue;
    }
    deps.sessions.clearAll(msg.chat.id, t);
  }

  const cleared = dirty.map((t) => `<b>${t}</b>`).join(" + ");
  const reply = `🧹 Cleared ${cleared} session state. Next turn starts fresh.`;
  await sendOrLog(deps.tg, msg.chat.id, reply, "cmd.clear_reply_failed");
  writeSystemAudit(deps, msg, updateId, `cleared:${dirty.join(",")}`, "ok");
}

function tierLabel(tier: TierArg): string {
  if (tier === "all") return "primary + secondary + ollama";
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

  // PR-B — only render Claude session lines when a session actually exists.
  // Post-inversion most chats default to Ollama and have no Claude session;
  // showing "primary session: *none*" twice is a wall of nothing. Suppress
  // the line entirely when the session is null.
  const primaryLine = renderTierLineMarkdownIfPresent(deps, chatId, "primary", session, now);
  const secondaryLine = renderTierLineMarkdownIfPresent(deps, chatId, "secondary", session, now);
  const summaryLine = renderSummaryLineMarkdown(session);
  // PR-B — Ollama activity tally. Engine prefix `ollama:%` matches every
  // model variant the audit row tags it with (`ollama:gemma4:e4b`, etc).
  const ollamaTurns24h = deps.db.countChatTurnsForEngineSince(chatId, "ollama:%", oneDayAgo);

  const chatSpend1h = deps.db.sumChatCostSince(chatId, oneHourAgo);
  const chatSpend24h = deps.db.sumChatCostSince(chatId, oneDayAgo);
  const globalSpend1h = deps.db.sumCostSince(oneHourAgo);

  const snap = deps.getQueueSnapshot();
  const uptimeSec = (now - deps.startedAt) / 1000;

  const chatLines: string[] = [];
  if (primaryLine !== null) chatLines.push(`- primary session: ${primaryLine}`);
  if (secondaryLine !== null) chatLines.push(`- secondary session: ${secondaryLine}`);
  if (summaryLine !== null) chatLines.push(`- pending summary: ${summaryLine}`);
  if (ollamaTurns24h > 0) {
    chatLines.push(`- ollama turns (24h): ${ollamaTurns24h}`);
  }
  chatLines.push(`- spent (1h): $${chatSpend1h.toFixed(4)} / $${deps.hourlyCostCapUsd.toFixed(2)}`);
  chatLines.push(`- spent (24h): $${chatSpend24h.toFixed(4)}`);

  return [
    "## 📊 Solrac status",
    "",
    "**This chat**",
    "",
    ...chatLines,
    "",
    "**Global**",
    "",
    `- spent (1h): $${globalSpend1h.toFixed(4)} / $${deps.globalHourlyCostCapUsd.toFixed(2)}`,
    `- in-flight turns: ${snap.inFlight} · waiting: ${snap.waiting}`,
    `- uptime: ${formatUptime(uptimeSec)}`,
  ].join("\n");
}

// PR-B — null when the tier has no session id (post-inversion most chats
// fall here for both tiers). Caller suppresses the bullet entirely when null.
function renderTierLineMarkdownIfPresent(
  deps: Pick<RunCommandDeps, "db">,
  chatId: number,
  tier: SessionTier,
  session: ReturnType<SessionStore["getSession"]>,
  now: number,
): string | null {
  const sessionId = !session
    ? null
    : tier === "primary"
      ? session.primarySessionId
      : session.secondarySessionId;
  if (sessionId === null) return null;
  const enginePrefix = `claude:${tier}:%`;
  const count = deps.db.countChatTurnsForEngine(chatId, enginePrefix);
  const lastAt = deps.db.lastSuccessfulTurnAt(chatId, enginePrefix);
  const idShort = `${sessionId.slice(0, 4)}…${sessionId.slice(-4)}`;
  const ageStr = lastAt !== null ? ` · last ${formatAge(now - lastAt)} ago` : "";
  return `\`${idShort}\` (${count} turn${count === 1 ? "" : "s"}${ageStr})`;
}

// PR-B — null when no pending summary exists; caller suppresses the bullet.
function renderSummaryLineMarkdown(
  session: ReturnType<SessionStore["getSession"]>,
): string | null {
  if (!session) return null;
  const have: string[] = [];
  if (session.primarySummary) have.push("primary");
  if (session.secondarySummary) have.push("secondary");
  if (have.length === 0) return null;
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
  const md = renderHelpMarkdown(deps.skillRegistry, {
    defaultEngine: deps.defaultEngine,
    ollamaToolsEnabled: deps.ollamaToolsEnabled,
  });
  // Authored once in markdown, derived to Telegram-safe HTML for the bot
  // path. The web transport uses `markdownSource` directly so the browser
  // gets full headers/lists/links rendering.
  await sendOrLog(deps.tg, msg.chat.id, mdToTelegramHtml(md), "cmd.help_reply_failed", md);
  writeSystemAudit(deps, msg, updateId, "help_shown", "ok");
}

// PR-B — engine section reads `defaultEngine` + `ollamaToolsEnabled` and
// renders one of the §3c-matrix-shaped descriptions. Static text would lie
// in three of four deploys (default-Claude vs default-Ollama, tools on/off);
// the dynamic render is one config-read per `/help` call which is free.
function renderEngineSection(opts: {
  defaultEngine: "ollama" | "primary" | "secondary";
  ollamaToolsEnabled: boolean;
}): string[] {
  const lines: string[] = ["**Engines** (first character of your message):", ""];
  if (opts.defaultEngine === "ollama") {
    const ollamaDesc = opts.ollamaToolsEnabled
      ? "local Ollama (free, with operator-authored tools)"
      : "local Ollama (free, no tools)";
    lines.push(`- plain text → ${ollamaDesc} *(default)*`);
    lines.push("- `@` → primary Claude (Sonnet) — heavier reasoning");
    lines.push("- `!` → secondary Claude (Opus) — heaviest reasoning, costs more");
  } else {
    const cheapTier =
      opts.defaultEngine === "primary"
        ? "primary Claude (Sonnet)"
        : "secondary Claude (Opus)";
    lines.push(`- plain text → ${cheapTier} *(default)*`);
    lines.push("- `@` → primary Claude (Sonnet)");
    lines.push("- `!` → secondary Claude (Opus, costs more)");
  }
  return lines;
}

const HELP_COMMANDS_MD = [
  "**Commands** (type `/cmd` for autocomplete, or `:cmd`)",
  "",
  "- **clear** `[primary|secondary|ollama|all]` — drop session state (Claude tiers) or set the Ollama context cutoff. Default: all.",
  "- **compact** `@|!` — summarize and restart Claude session for that tier. Costs one Claude turn.",
  "- **context** `@|!` — show context-window size in bytes + tokens for that tier.",
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
// loaded. Engine section is dynamic per-deploy; commands and customization
// sections are stable. The Telegram path runs this through
// `mdToTelegramHtml`; the web transport renders it with `marked` in the
// browser.
export function renderHelpMarkdown(
  skills: SkillRegistry,
  opts: {
    defaultEngine: "ollama" | "primary" | "secondary";
    ollamaToolsEnabled: boolean;
  },
): string {
  const head = ["## 🤖 Solrac help", "", ...renderEngineSection(opts), "", HELP_COMMANDS_MD];
  if (skills.size() === 0) return head.join("\n");
  const lines = [head.join("\n"), "", "**Skills**", ""];
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

// Agentic skills can use the full Claude Code tool preset; sub-agents stay
// off at the SDK layer (belt-and-suspenders with policy.ts::SUBAGENT_DENY_TOOLS).
const SKILL_DISALLOWED_TOOLS = ["Agent", "Task"];

// Cap on the model's reply text we forward to Telegram. Telegram messages cap
// at 4096 chars; we leave headroom for formatting overhead. If the model
// produces more, the tail is dropped with a `…` marker.
const SKILL_REPLY_MAX = 3500;

// Fallback canUseTool when `deps.createCanUseTool` is absent (tests, dev
// harnesses). Mirrors `agent.ts::defaultAllowAll`; logged with a `skill`
// prefix so audit-log greps can tell the surfaces apart.
const skillDefaultAllowAll: CanUseTool = async (toolName) => {
  log.info("skill.tool_allow_all", { toolName });
  return { behavior: "allow" };
};

async function runSkill(
  deps: RunCommandDeps,
  msg: Message,
  updateId: number,
  skill: Skill,
  args: string,
): Promise<void> {
  if (skill.tier === "ollama") {
    return runOllamaSkill(deps, msg, updateId, skill, args);
  }
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

  // 2. Insert audit row up-front so the PreToolUse hook (which fires
  //    mid-turn for every tool call) has a real auditId to reference.
  //    Mirrors runAgent's ordering — same reason.
  const auditId = deps.db.insertAudit({
    chatId: msg.chat.id,
    fromId: msg.from!.id,
    updateId,
    prompt: truncateAuditPrompt(msg.text ?? ""),
    startedAt,
    model: engineModelTag,
  });

  // 3. Render the prompt template and run the skill turn with full tool
  //    surface (was tool-less in v1 — see docs/USAGE.md#skills).
  const prompt = renderSkillTemplate(skill.body, args);
  const cwd = join(deps.dataDir, "workspaces", String(msg.chat.id));
  await mkdir(cwd, { recursive: true });

  // Per-turn state for the hook trio. Same shape as runAgent (agent.ts:273-310).
  // `loopDetector` and `pendingHandles` are created fresh per skill invocation
  // so prior turns can't influence loop counts or stale confirm handles.
  const loopDetector = createLoopDetector({ threshold: LOOP_THRESHOLD });
  const pendingHandles = new Map<string, ConfirmHandle>();
  const policyDeny: { event: PolicyDenyEvent | null } = { event: null };

  // `auto_allow: true` skills bypass the interactive confirm UX entirely —
  // the PreToolUse hook (cost cap + loop detector) and SDK `disallowedTools`
  // still run, but every tool the SDK routes to `canUseTool` is allowed
  // without prompting the operator. Useful for skills whose entire purpose
  // IS a known write (e.g. /log → notion).
  const canUseTool: CanUseTool = skill.autoAllow
    ? skillDefaultAllowAll
    : (deps.createCanUseTool?.({
        chatId: msg.chat.id,
        auditId,
        pendingHandles,
      }) ?? skillDefaultAllowAll);

  const preToolUseHook = createPreToolUseHook({
    chatId: msg.chat.id,
    getAuditId: () => auditId,
    costGuard: deps.costGuard,
    globalCostGuard: deps.globalCostGuard,
    loopDetector,
    onPolicyDeny: (event) => {
      policyDeny.event = event;
    },
  });
  const postToolUseHook = createPostToolUseHook({ pendingHandles });

  const options: Options = {
    cwd,
    model: modelId,
    maxTurns: skill.maxTurns,
    permissionMode: "default",
    tools: { type: "preset", preset: "claude_code" },
    // Belt-and-suspenders: policy.ts also denies Agent/Task; the SDK-level
    // disallow keeps them out of the model's tool catalog entirely so the
    // model can't try and bounce off the policy layer.
    disallowedTools: SKILL_DISALLOWED_TOOLS,
    canUseTool,
    env: sanitizedSubprocessEnv(),
    ...(deps.mcpServer && {
      mcpServers: { solrac: deps.mcpServer },
    }),
    hooks: {
      PreToolUse: [{ hooks: [preToolUseHook] }],
      PostToolUse: [{ hooks: [postToolUseHook] }],
      PostToolUseFailure: [{ hooks: [postToolUseHook] }],
    },
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

  // PreToolUse-hook denies (cost cap, loop) surface as a SDK turn that often
  // looks successful (the agent recovers gracefully from a hook deny). Promote
  // the captured policy reason into errorMessage so the audit row + reply both
  // tell the operator what actually happened.
  if (policyDeny.event !== null && errorMessage === null) {
    errorMessage = `policy_deny:${policyDeny.event.reason}: ${policyDeny.event.message}`;
  }

  const trimmed = resultText.trim();
  if (errorMessage === null && trimmed === "") errorMessage = "empty_response";

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

// Pure-execution result for an Ollama-tier skill body: just the engine call,
// no audit, no Telegram side-effects. Both the slash-command path
// (`runOllamaSkill`) and the tool-call path (`skill-tools.ts::dispatch`) wrap
// this with their own audit + reply / return-string handling.
//
// **RECURSION SAFETY INVARIANT** — this function MUST NOT add a `tools` field
// to the outgoing `/api/chat` body. PR-skills-tools lifts the "tool-less"
// constraint: when `OllamaSkillDeps` is wired with `tools/toolTiers/broker`,
// the skill body sees the full MCP catalog MINUS its own `skills__<self>`
// entry (recursion guard). The regression test in `skill-tools.test.ts` now
// asserts that filter — keep both in sync.
export interface RunSkillBareResult {
  readonly text: string;
  readonly errorMessage: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  // PR-skills-tools — populated when the tool-loop path runs (else empty).
  // Mirrors `ToolLoopResult.toolCallSummaries` so callers can persist into
  // the audit `tool_calls` column.
  readonly toolCallSummaries: ReadonlyArray<{ name: string; input: unknown }>;
}

export async function runSkillBare(
  ollama: OllamaSkillDeps,
  skill: Skill,
  args: string,
): Promise<RunSkillBareResult> {
  // PR-skills-tools dispatch. Tool surface wired → route through the tool
  // loop so the body can call `mcp__solrac__*` / `skills__*` exactly like a
  // regular Ollama turn. Mirrors the same gate in `runOllamaTurn`.
  if (
    ollama.tools !== undefined &&
    ollama.tools.length > 0 &&
    ollama.toolTiers !== undefined &&
    ollama.broker !== undefined
  ) {
    return runSkillBareWithTools(ollama, skill, args);
  }

  const prompt = renderSkillTemplate(skill.body, args);
  const messages = [
    { role: "system", content: ollama.soul },
    { role: "user", content: prompt },
  ];

  const fetchImpl = ollama.fetch ?? globalThis.fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ollama.timeoutMs);

  let resultText = "";
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let errorMessage: string | null = null;

  try {
    const res = await fetchImpl(`${ollama.url}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: ollama.model, messages, stream: false }),
      signal: ac.signal,
    });
    if (!res.ok) {
      // Match runOllamaTurn's 404 vs. generic error shape so operators see the
      // same "pull this model" hint regardless of which path failed.
      const bodyText = await res.text().catch(() => "");
      let parsed: { error?: string } = {};
      try {
        parsed = JSON.parse(bodyText) as { error?: string };
      } catch {
        // not JSON; fall through with empty parsed
      }
      if (res.status === 404) {
        errorMessage = `ollama model not found: ${ollama.model} — pull with \`ollama pull ${ollama.model}\` on the host`;
      } else {
        const detail = parsed.error ?? (bodyText.slice(0, 200) || res.statusText);
        errorMessage = `ollama error: ${res.status} ${detail}`;
      }
    } else {
      const json = (await res.json()) as {
        message?: { content?: string };
        prompt_eval_count?: number;
        eval_count?: number;
        error?: string;
      };
      if (json.error) {
        errorMessage = `ollama error: ${json.error}`;
      } else {
        resultText = json.message?.content ?? "";
        inputTokens = json.prompt_eval_count ?? null;
        outputTokens = json.eval_count ?? null;
      }
    }
  } catch (err) {
    const e = err as Error;
    if (e.name === "AbortError") {
      errorMessage = `ollama timed out after ${(ollama.timeoutMs / 1000).toFixed(0)}s`;
    } else {
      errorMessage = `ollama unreachable: ${ollama.url}`;
    }
    log.error("skill.ollama_error", {
      skill: skill.name,
      url: ollama.url,
      error: e.message,
      name: e.name,
    });
  } finally {
    clearTimeout(timer);
    ac.abort();
  }

  const trimmed = resultText.trim();
  if (errorMessage === null && trimmed === "") errorMessage = "empty_response";

  return {
    text: trimmed,
    errorMessage,
    inputTokens,
    outputTokens,
    toolCallSummaries: [],
  };
}

// ---------------------------------------------------------------------------
// runSkillBareWithTools — PR-skills-tools tool-loop path
// ---------------------------------------------------------------------------
//
// Mirrors `runOllamaTurnWithTools` (ollama.ts) but skill-shaped:
//   - No history, no SOLRAC.md overlay, no streaming UX (skills already cap
//     their reply by template; live rendering would muddy the operator's
//     intent baked into the skill body).
//   - Recursion guard: this skill's own MCP entry (`skills__<self>`) is
//     filtered out of the catalog the body sees. Indirect recursion (A→B→A)
//     is bounded by `runToolLoop`'s `maxIterations`.
//   - `maxTurns` from the SKILL.md frontmatter doubles as `maxIterations`
//     so the operator controls the budget per skill.
//
// Caller (`runOllamaSkill` for /<skill> typing, `skill-tools.ts` for
// agent-driven invocations) is responsible for wrapping this in
// `skillToolCtx.run(...)` so any nested `skills__*` calls have ALS context.
async function runSkillBareWithTools(
  ollama: OllamaSkillDeps,
  skill: Skill,
  args: string,
): Promise<RunSkillBareResult> {
  // These are guaranteed non-undefined by the dispatch gate above.
  const allTools = ollama.tools!;
  const toolTiers = ollama.toolTiers!;
  const broker = ollama.broker!;

  // The broker uses `chatId` to send the Telegram inline-keyboard confirm
  // prompt; without the real id, sends fail-close to a denial and the
  // operator never sees a prompt. Both production callers (`runOllamaSkill`
  // and `skill-tools.ts` dispatch) wrap us in `skillToolCtx.run({chatId,
  // parentAuditId, ...})`, so we read context here. Missing context means
  // a misconfigured test harness — log loudly and fall through with 0 (the
  // broker's fail-closed path will surface the bug as a denied tool call).
  const cx = skillToolCtx.getStore();
  if (!cx) {
    log.warn("skill.no_context_in_bare_with_tools", { skill: skill.name });
  }
  const chatId = cx?.chatId ?? 0;
  const auditId = cx?.parentAuditId ?? 0;

  // Recursion guard. The skill's body must not see its own MCP entry. The
  // model can still call OTHER skills tools; cycles longer than 1 are bounded
  // by `maxIterations` and the loop detector.
  const selfToolName = `${SKILL_TOOL_PREFIX}${skill.name}`;
  const filteredTools = allTools.filter((t) => t.name !== selfToolName);
  const toolMap = new Map(filteredTools.map((t) => [t.name, t]));
  const toolDefs = mcpToOllamaTools(filteredTools);
  const toolNames = filteredTools.map((t) => t.name);

  const prompt = renderSkillTemplate(skill.body, args);
  // Skills are tier-stable (`tier: ollama` for tool-callable skills, per
  // skills.ts Phase 1 restriction). Build the capability note as the default-
  // engine variant — accurate when the skill body runs on the deploy's main
  // Ollama model, which is always the case today.
  const capabilityNote = buildToolCapabilityNote(toolNames, true);

  const initialMessages = [
    { role: "system" as const, content: `${ollama.soul}\n\n${capabilityNote}` },
    { role: "user" as const, content: prompt },
  ];

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ollama.timeoutMs);
  const loopDetector = createLoopDetector({ threshold: LOOP_THRESHOLD });

  try {
    const result = await runToolLoop(
      {
        fetch: ollama.fetch,
        url: ollama.url,
        model: ollama.model,
        signal: ac.signal,
        tools: toolMap,
        toolTiers,
        toolDefs,
        broker,
        loopDetector,
        maxIterations: skill.maxTurns,
        // chatId is required by the broker to address the Telegram confirm
        // prompt — sourced from the ALS context the caller set up. auditId
        // is best-effort log correlation; we forward the caller's audit row
        // so loop entries pin to the right turn.
        auditId,
        chatId,
        autoAllow: skill.autoAllow,
      },
      { initialMessages },
    );
    const text = result.assistantText.trim();
    let errorMessage = result.errorMessage;
    if (errorMessage === null && text === "") errorMessage = "empty_response";
    return {
      text,
      errorMessage,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      toolCallSummaries: result.toolCallSummaries,
    };
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
}

// Ollama-tier skill: one-shot `/api/chat` (stream:false), no history, no tool
// loop, no streaming stub. Mirrors Claude runSkill's audit + reply shape so
// operator-side observability is identical (`skill.done` log, audit row tagged
// `ollama:<model>:skill:<name>`). Cost is always 0 — the per-chat hourly cap
// pre-flight is skipped: a chat that's been throttled by Claude burn shouldn't
// also lose access to free local inference.
async function runOllamaSkill(
  deps: RunCommandDeps,
  msg: Message,
  updateId: number,
  skill: Skill,
  args: string,
): Promise<void> {
  const startedAt = Date.now();

  if (!deps.ollamaSkillDeps) {
    const errMsg = "ollama not configured for this deploy (set OLLAMA_ENABLED=true and OLLAMA_MODEL)";
    writeSkillAudit(
      deps,
      msg,
      updateId,
      `ollama:unconfigured:skill:${skill.name}`,
      startedAt,
      0,
      "error",
      errMsg,
    );
    await sendOrLog(
      deps.tg,
      msg.chat.id,
      `❌ skill <b>${htmlEscapeText(skill.name)}</b> failed: ${htmlEscapeText(errMsg)}`,
      "cmd.skill_reply_failed",
    );
    return;
  }

  const ollama = deps.ollamaSkillDeps;
  const engineModelTag = `ollama:${ollama.model}:skill:${skill.name}`;
  // Insert audit row BEFORE running so the ALS context can carry the real
  // parentAuditId — nested `skills__*` calls record it in their own
  // `origin='tool_call'` rows for the cross-skill audit story.
  const auditId = deps.db.insertAudit({
    chatId: msg.chat.id,
    fromId: msg.from!.id,
    updateId,
    prompt: truncateAuditPrompt(msg.text ?? ""),
    startedAt,
    model: engineModelTag,
  });

  // Wrap in `skillToolCtx.run(...)` so the body — when it reaches the
  // tool-loop path — can call `skills__other` and have those handlers
  // see (chatId, fromId, updateId, parentAuditId) via ALS. Cheap to wrap
  // unconditionally; no-op when the body never reaches a tool.
  const { text: trimmed, errorMessage, inputTokens, outputTokens, toolCallSummaries } =
    await skillToolCtx.run(
      {
        chatId: msg.chat.id,
        fromId: msg.from!.id,
        updateId,
        parentAuditId: auditId,
      },
      () => runSkillBare(ollama, skill, args),
    );

  const toolCallsJson =
    toolCallSummaries.length > 0 ? JSON.stringify(toolCallSummaries) : null;

  if (errorMessage !== null) {
    deps.db.updateAuditEnd({
      id: auditId,
      response: null,
      toolCalls: toolCallsJson,
      inputTokens,
      outputTokens,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
      costUsd: 0,
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
    toolCalls: toolCallsJson,
    inputTokens,
    outputTokens,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
    costUsd: 0,
    agentSessionId: null,
    status: "ok",
    errorMessage: null,
    endedAt: Date.now(),
  });

  log.info("skill.done", {
    chatId: msg.chat.id,
    skill: skill.name,
    tier: "ollama",
    inputTokens,
    outputTokens,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
    costUsd: 0,
    replyLength: trimmed.length,
  });

  const replyBody =
    trimmed.length > SKILL_REPLY_MAX
      ? trimmed.slice(0, SKILL_REPLY_MAX - 1) + "…"
      : trimmed;
  await sendOrLog(deps.tg, msg.chat.id, htmlEscapeText(replyBody), "cmd.skill_reply_failed");
}

// ---------------------------------------------------------------------------
// /tasks
// ---------------------------------------------------------------------------

async function runTasksList(
  deps: RunCommandDeps,
  msg: Message,
  updateId: number,
): Promise<void> {
  if (!deps.taskRegistry || deps.taskRegistry.size() === 0) {
    const md =
      "📅 **tasks**: scheduler disabled or no TASK.md files loaded.\n\n" +
      "Set `SOLRAC_TASKS_ENABLED=true` and drop TASK.md files into `$SOLRAC_TASKS_DIR`.";
    await sendOrLog(deps.tg, msg.chat.id, mdToTelegramHtml(md), "cmd.tasks_reply_failed", md);
    writeSystemAudit(deps, msg, updateId, "tasks_disabled", "ok");
    return;
  }
  const now = Date.now();
  // Author in markdown, derive Telegram HTML via `mdToTelegramHtml`. The web
  // transport receives the markdown source via `markdownSource` so the browser
  // gets `<ul>`-rendered list items with `<br>`-broken continuations — without
  // this dual-render path single `\n`s collapse and the whole listing renders
  // on one line.
  //
  // Markdown shape:
  //   - Top-line list item: `- **<name>** [(flags)]`
  //   - Continuation lines indented two spaces (CommonMark list-item content)
  //   - Trailing `  ` (two spaces) on each continuation forces `<br>` so the
  //     four sub-lines render as a stack, not a paragraph blob.
  //   - Cron expression wrapped in backticks — keeps literal `*` from being
  //     interpreted as emphasis, and renders as `<code>` on both transports.
  const mdLines: string[] = [
    `📅 **scheduled tasks** (${deps.taskRegistry.size()})`,
    "",
  ];
  for (const t of deps.taskRegistry.all) {
    const state = deps.db.getTaskState(t.name);
    const last = state?.lastRunAt
      ? formatAbsoluteUtc(state.lastRunAt)
      : "never";
    const lastStatus = state?.lastStatus ?? "—";
    const enabled = t.enabled ? "" : " (disabled)";
    const consumed = state?.oneOffConsumed ? " (consumed)" : "";
    const sched = formatScheduleSpec(t);
    const next = formatNextFire(t, state, now);
    mdLines.push(
      `- **${t.name}**${enabled}${consumed}  \n` +
        `  schedule: \`${sched}\` · engine: ${t.engine}  \n` +
        `  last: ${last} · ${lastStatus}  \n` +
        `  next: ${next}`,
    );
  }
  const md = mdLines.join("\n");
  await sendOrLog(deps.tg, msg.chat.id, mdToTelegramHtml(md), "cmd.tasks_reply_failed", md);
  writeSystemAudit(deps, msg, updateId, "tasks_listed", "ok");
}

async function runTasksRun(
  deps: RunCommandDeps,
  msg: Message,
  updateId: number,
  name: string,
): Promise<void> {
  if (!deps.triggerScheduledTask || !deps.taskRegistry) {
    const reply = "📅 <b>tasks</b>: scheduler disabled.";
    await sendOrLog(deps.tg, msg.chat.id, reply, "cmd.tasks_reply_failed");
    writeSystemAudit(deps, msg, updateId, "tasks_disabled", "ok");
    return;
  }
  const result = deps.triggerScheduledTask(name);
  let reply: string;
  let status: "ok" | "error" = "ok";
  switch (result.kind) {
    case "fired":
      reply = `🔥 fired task <b>${htmlEscapeText(result.name)}</b>`;
      break;
    case "unknown_task":
      reply = `❌ unknown task <b>${htmlEscapeText(result.name)}</b>`;
      status = "error";
      break;
    case "disabled":
      reply = `⏸ task <b>${htmlEscapeText(result.name)}</b> is disabled`;
      status = "error";
      break;
    case "one_off_consumed":
      reply = `✅ task <b>${htmlEscapeText(result.name)}</b> already consumed (one-off)`;
      status = "error";
      break;
  }
  await sendOrLog(deps.tg, msg.chat.id, reply, "cmd.tasks_reply_failed");
  writeSystemAudit(deps, msg, updateId, `tasks_run:${result.kind}`, status);
}

function formatScheduleSpec(t: ScheduledTask): string {
  const s = t.spec;
  if (s.kind === "cron") {
    return `cron: ${s.expr} (${t.tz})`;
  }
  return `at ${new Date(s.atMs).toISOString()}`;
}

/**
 * Render the next scheduled fire as `<absolute UTC> (in <duration>)`, or
 * `<absolute UTC> (<duration> late)` when the fire is overdue (the tick hasn't
 * caught up yet — usually a transient state, but operator-visible).
 *
 * Returns:
 *   - `"consumed"` when the task is one-off and already fired.
 *   - `"—"` when the task is disabled (no upcoming fire to report).
 *   - `"—"` when `nextRunAt` returns null (defensive; only happens for
 *     consumed one-off tasks, already covered above).
 */
function formatNextFire(
  task: ScheduledTask,
  state: { lastRunAt: number | null; oneOffConsumed: boolean } | null,
  now: number,
): string {
  if (state?.oneOffConsumed) return "consumed";
  if (!task.enabled) return "—";
  const due = nextRunAt(task, state?.lastRunAt ?? null, now);
  if (due === null) return "—";
  const delta = due - now;
  const abs = formatAbsoluteUtc(due);
  if (delta <= 0) {
    const lateMs = Math.abs(delta);
    if (lateMs < 1000) return `${abs} (now)`;
    return `${abs} (${formatRelativeDuration(lateMs)} late)`;
  }
  return `${abs} (in ${formatRelativeDuration(delta)})`;
}

function formatAbsoluteUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ") + "Z";
}

function formatRelativeDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
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
