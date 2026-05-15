/**
 * @fileoverview The Claude Agent SDK runner: per-turn agent execution.
 * @purpose Wire `query()` from `@anthropic-ai/claude-agent-sdk@0.2.119` into
 *          Solrac's primitives — workspace, audit row, session resume,
 *          policy hooks, streaming Telegram UX.
 *
 * One call to `runAgent` = one agent turn. The function:
 *   1. ensures the per-chat workspace at `<dataDir>/workspaces/<chatId>/`;
 *   2. inserts the in-progress `audit` row;
 *   3. sends the 🤔 stub message that becomes the streaming render target;
 *   4. builds per-turn `loopDetector`, `canUseTool`, and `PreToolUse` hook;
 *   5. iterates the SDK's async stream, editing the stub as content arrives;
 *   6. captures policy denials separately so the user-facing render shows
 *      our deny reason instead of the SDK's cryptic `[ede_diagnostic]`;
 *   7. on completion: persists the SDK session id and finalizes the audit row.
 *
 * The persona text comes from `SOUL.md` (read at boot via
 * `instance.ts::loadSoul`) and is layered onto the SDK's `claude_code` preset
 * (NOT replaced) so the SDK's tool guidance stays intact while the Solrac
 * voice + safety clauses ride on top. The Claude-engine capability sentence
 * (`buildClaudeCapabilityNote`) lives here next to the cost-cap wiring, so the
 * factual statement about tool-call gating travels with the code that
 * enforces it. See docs/ARCHITECTURE.md#system-prompt-preset-append for the
 * rationale.
 *
 * The `sanitizedSubprocessEnv` scrub is critical: the SDK spawns a `claude`
 * subprocess that inherits parent env. A user-level Telegram plugin in the
 * inherited env would race our own poller. See docs/ARCHITECTURE.md#subprocess-env-scrubbing.
 *
 * Position in the dependency graph:
 *   session + policy + telegram + log + db + config → agent → consumed by main
 *
 * Exports:
 *   - `runAgent(deps, input)` — runs one turn end-to-end.
 *   - `AgentRunDeps` — runtime deps (tg, db, sessions, dataDir, soul,
 *     instanceMdPath, model, optional hooks).
 *   - `AgentRunInput` — per-turn input (chatId, fromId, updateId, prompt).
 *   - `buildClaudeCapabilityNote` — the engine-specific clause appended to SOUL
 *     before it ships as `systemPrompt.append`.
 *
 * Key invariants:
 *   - Audit row is written BEFORE the SDK call starts (`status='in_progress'`)
 *     and updated to `'ok'`/`'error'`/`'denied'` after. A SIGKILL between
 *     them leaves the row at `in_progress`; lifecycle drain prevents this on
 *     graceful shutdown.
 *   - `Options.resume` is set ONLY when there's a previous session id for
 *     this chat. Fresh chats start without resume; the SDK creates a new
 *     session and we record it on completion.
 *   - The streaming editor tracks `lastEditedContent` to skip no-op edits —
 *     Telegram returns 400 for `editMessageText` when the new text matches
 *     current.
 *   - Edit throttle is 1.5s minimum between edits. The first edit fires
 *     after the throttle window, NOT immediately, to coalesce assistant-text
 *     bursts.
 *   - `sanitizedSubprocessEnv()` strips Telegram + operator-only secrets so
 *     the SDK subprocess can't attach to our bot or read our stats token.
 *   - `disallowedTools: ["Agent", "Task"]` is belt-and-suspenders; the
 *     classifier in policy.ts also denies these. Both layers must agree.
 *
 * Gotchas:
 *   - The "no-op edit guard" affects the final-render: if the streamed state
 *     happened to match the final answer text exactly, only the footer
 *     (`<i>✅ N turns · $X.XXXX</i>`) makes the last edit non-empty. The
 *     footer is therefore load-bearing — DON'T omit it on success.
 *   - `policyDeny` is captured via callback into a wrapper object so TS
 *     doesn't narrow the closure binding to `null` after mutation. The
 *     wrapper is intentional; replacing with a bare `let` will break.
 *   - The SDK error subtype `[ede_diagnostic] result_type=...` surfaces when
 *     a hook denies. We override `errorMessage` with our deny `message` for
 *     the user render but ALSO record `policy_deny: <reason>` in the audit
 *     row regardless of SDK status — observability shouldn't depend on
 *     whether the agent recovered after the deny.
 *   - `resultText || assistantText` — the SDK's final `result.result` is the
 *     authoritative answer; the streamed `assistantText` is the fallback when
 *     the SDK's terminal state didn't include a string result.
 *
 * Cross-references:
 *   - docs/ARCHITECTURE.md#sdk-integration — full discussion
 *   - docs/SDK_NOTES.md — verified Options keys, line numbers in sdk.d.ts
 *   - policy.ts — classifier, broker, hooks
 *   - session.ts — session id persistence
 */

import {
  query,
  type CanUseTool,
  type McpSdkServerConfigWithInstance,
  type Options,
} from "@anthropic-ai/claude-agent-sdk";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { SolracDb } from "./db.ts";
import { readInstanceMd, wrapInstanceMd } from "./instance.ts";
import { log } from "./log.ts";
import {
  createLoopDetector,
  createPostToolUseHook,
  createPreToolUseHook,
  truncateAuditPrompt,
  type ConfirmHandle,
  type CostCapGuard,
  type GlobalCostCapGuard,
  type PolicyDenyEvent,
} from "./policy.ts";
import type { SessionStore, SessionTier } from "./session.ts";
import { mdToTelegramHtml } from "./markdown.ts";
import { htmlEscapeText, type TelegramClient } from "./telegram.ts";

// Exported so the skill runner in commands.ts uses the same threshold as
// runAgent — diverging values would make loop-detection behavior depend on
// invocation surface, which is surprising.
export const LOOP_THRESHOLD = 3;

const TELEGRAM_TEXT_MAX = 3800;
const EDIT_THROTTLE_MS = 1500;
// PLAN Step 12 — per-tier thinking-stub emoji so the operator can eyeball
// which tier handled a turn without checking logs. Ollama uses 🦙 in `ollama.ts`;
// Claude tiers split here so primary (cheap default) is visually distinct
// from secondary (heavyweight). Same "thinking…" suffix everywhere.
const THINKING_STUB_BY_ENGINE: Record<SessionTier, string> = {
  primary: "🙂 thinking…",
  secondary: "🤔 thinking…",
};

// Cap on out-of-band turns from OTHER engines injected into this tier's
// prompt. 6 = three round-trips. At 256-char truncated prompts × 6 turns ≈
// ~3k tokens — bounded per-turn cost for the cross-engine bridge. The window
// naturally narrows after this tier consumes it (the next turn for this
// engine's cutoff has advanced past these rows), so this cap only matters
// when a user interleaves more than 6 cross-engine turns between two turns
// of the same tier. PLAN Step 12 — generalized from the Step 11 Ollama-only
// version.
//
// NOT the same as `config.ollamaHistoryLimit` (env-tunable
// OLLAMA_HISTORY_LIMIT, default 6). That limit caps the FULL history Ollama
// reconstructs into its messages array (sessionless — every turn rebuilds
// from scratch). This limit caps only the BRIDGE between engines on top of
// the SDK's own session resume. Same default value, different scopes; see
// docs/ARCHITECTURE.md#engine-routing.
const OUT_OF_BAND_LIMIT = 6;

// Engine-specific capability statement appended to SOUL.md before it ships as
// `systemPrompt.append`. Stays in code (Option B from the externalization
// design) because it's a fact about THIS runtime — gated tool calls, cost
// cap — not a personality trait. SOUL.md ships engine-agnostic so the same
// file can serve every engine path.
//
// PR-B inversion: when Claude isn't the default engine, the note acknowledges
// the user explicitly escalated via `@`/`!` so the model leans into heavier
// reasoning instead of treating itself as the casual default.
export interface ClaudeCapabilityNoteOpts {
  isDefaultEngine: boolean;
  tier: "primary" | "secondary";
}

export function buildClaudeCapabilityNote(opts: ClaudeCapabilityNoteOpts): string {
  const base =
    "Tool calls are gated by a per-chat policy and a per-hour cost cap; " +
    "assume each tool call must justify itself.";
  if (opts.isDefaultEngine) return base;
  const tierLabel = opts.tier === "primary" ? "Sonnet (primary)" : "Opus (secondary)";
  return (
    base +
    ` The operator chose ${opts.tier === "primary" ? "`@`" : "`!`"} to escalate to ` +
    `${tierLabel}; lean into heavier reasoning rather than deferring back to a cheaper engine.`
  );
}

export interface AgentRunDeps {
  tg: TelegramClient;
  db: SolracDb;
  sessions: SessionStore;
  dataDir: string;
  // PNX-167 (system-prompt externalization). `soul` is the SOUL.md text read
  // once at boot via `instance.ts::loadSoul`; this runner appends a Claude
  // capability note (built from §3c matrix) and ships the join as
  // `systemPrompt.append`. `instanceMdPath` is re-read per turn so live edits
  // take effect on the next message; null/empty content injects nothing.
  soul: string;
  instanceMdPath: string;
  // PR-B — `true` when `config.defaultEngine === "primary" || "secondary"`.
  // Drives the capability-note tone (heavyweight escalation acknowledgment
  // when Claude isn't the default). Optional; defaults to `true` so existing
  // tests (and Claude-only deployments) keep the established Claude-as-default
  // behaviour.
  isDefaultEngine?: boolean;
  // PLAN Step 12: two-tier Claude routing. The runner picks one of these
  // based on `input.engine`; both are passed in so the deps object stays
  // stable across turns instead of being rebuilt with a different `model`
  // string per dispatch.
  primaryModel: string;
  secondaryModel: string;
  maxTurns?: number;
  // Always-fires gate (cost cap + loop detector). The PreToolUse hook fires
  // for every tool call, including SDK-auto-approved tools like Bash(date)
  // that bypass `canUseTool`. Optional only for tests/dev — production wires
  // both `costGuard` and `createCanUseTool`.
  costGuard?: CostCapGuard;
  // Cross-chat global cap (absolute safety). When wired, evaluated BEFORE
  // per-chat in createPreToolUseHook so over-budget hosts deny uniformly.
  // Optional for tests; production wires it from main.ts.
  globalCostGuard?: GlobalCostCapGuard;
  // Per-turn factory for the interactive permission UX. Closures over chatId,
  // auditId, and the per-turn `pendingHandles` map (used to bridge canUseTool
  // → PostToolUse so the confirm prompt's footer reflects the tool outcome).
  // The SDK only invokes the returned callback for tools its internal
  // classifier considers non-trivial. If omitted, every tool that reaches
  // canUseTool is allowed.
  createCanUseTool?: (args: {
    chatId: number;
    auditId: number;
    pendingHandles: Map<string, ConfirmHandle>;
  }) => CanUseTool;
  // Optional in-process MCP server hosting operator + blessed integrations
  // (Phase 2). When non-null, registered as `mcpServers: { solrac }` so the
  // model sees integration tools as `mcp__solrac__<name>`. `null` when
  // integrations are disabled or when the loader produced zero tools — in
  // that case we omit `mcpServers` entirely rather than registering an empty
  // server.
  mcpServer?: McpSdkServerConfigWithInstance | null;
}

export interface AgentRunInput {
  chatId: number;
  fromId: number;
  // Nullable for synthesized scheduler updates — they don't ride the poll
  // offset so there's no real Telegram update_id to record.
  updateId: number | null;
  prompt: string;
  // PLAN Step 12: which Claude tier handles this turn. `'primary'` = cheap
  // default tier (Sonnet), `'secondary'` = heavyweight tier (Opus). Selected
  // by `parseEnginePrefix` in main.ts.
  engine: SessionTier;
  // Scheduler — set when this turn fired from a scheduled task. The audit
  // row gets origin='scheduled' + task_name; runtime behavior is otherwise
  // identical to a user turn.
  scheduledTaskName?: string | null;
}

interface ToolCallSummary {
  name: string;
  input: unknown;
}

export async function runAgent(deps: AgentRunDeps, input: AgentRunInput): Promise<void> {
  const cwd = join(deps.dataDir, "workspaces", String(input.chatId));
  await mkdir(cwd, { recursive: true });

  const modelId = input.engine === "primary" ? deps.primaryModel : deps.secondaryModel;
  // Engine-tagged model string. Three-segment format keeps tier identity
  // stable across model-id bumps (e.g. sonnet-4-7 → sonnet-4-8 doesn't
  // fragment primary's history) and lets cross-tier OOB queries match by
  // prefix. See db.ts::AuditInsert JSDoc.
  const engineModelTag = `claude:${input.engine}:${modelId}`;
  const enginePrefix = `claude:${input.engine}:%`;

  const auditId = deps.db.insertAudit({
    chatId: input.chatId,
    fromId: input.fromId,
    updateId: input.updateId,
    prompt: truncateAuditPrompt(input.prompt),
    startedAt: Date.now(),
    model: engineModelTag,
    origin: input.scheduledTaskName ? "scheduled" : "user",
    taskName: input.scheduledTaskName ?? null,
  });

  const thinkingStub = THINKING_STUB_BY_ENGINE[input.engine];
  const stub = await deps.tg.sendMessage(input.chatId, thinkingStub).catch((err) => {
    log.warn("agent.stub_send_failed", { auditId, error: (err as Error).message });
    return null;
  });
  const stubId = stub && typeof stub === "object" ? stub.message_id : null;

  const prevSessionId = deps.sessions.getSessionId(input.chatId, input.engine);
  const loopDetector = createLoopDetector({ threshold: LOOP_THRESHOLD });
  // Per-turn ConfirmHandle map. Populated by `canUseTool` when the user
  // approves a confirm-tier tool; consumed by the PostToolUse hook so the
  // confirm prompt gets a final outcome footer ("succeeded" / "failed: ...").
  // Lifetime is exactly this turn; the map gets discarded when runAgent
  // returns. Keyed by tool_name + JSON.stringify(input) — see
  // `policy.ts::pendingHandleKey`.
  const pendingHandles = new Map<string, ConfirmHandle>();
  const canUseTool: CanUseTool =
    deps.createCanUseTool?.({
      chatId: input.chatId,
      auditId,
      pendingHandles,
    }) ?? defaultAllowAll;

  // Captured by the PreToolUse hook on cost-cap or loop-detector deny. Surfaced
  // into the audit row's `error_message` even when the SDK reports the turn as
  // success (the agent often recovers gracefully from a hook deny), and used to
  // override the cryptic SDK error string for the user-facing render. Wrapped
  // in an object so TS doesn't narrow it to `null` after the closure mutation.
  const policyDeny: { event: PolicyDenyEvent | null } = { event: null };
  const preToolUseHook = deps.costGuard
    ? createPreToolUseHook({
        chatId: input.chatId,
        getAuditId: () => auditId,
        costGuard: deps.costGuard,
        globalCostGuard: deps.globalCostGuard,
        loopDetector,
        onPolicyDeny: (event) => {
          policyDeny.event = event;
        },
      })
    : null;
  // PostToolUse + PostToolUseFailure: finalize the confirm prompt's footer
  // with the tool outcome ("succeeded"/"failed: ..."). Only fires when a
  // confirm-tier tool was approved; auto-tier tools never reach the broker
  // and have no handle to find. Best-effort — a missing handle is a no-op.
  const postToolUseHook = createPostToolUseHook({ pendingHandles });

  const options: Options = {
    cwd,
    model: modelId,
    maxTurns: deps.maxTurns ?? 25,
    permissionMode: "default",
    tools: { type: "preset", preset: "claude_code" },
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: `${deps.soul}\n\n${buildClaudeCapabilityNote({
        isDefaultEngine: deps.isDefaultEngine !== false,
        tier: input.engine,
      })}`,
    },
    // Belt-and-suspenders: classifyTool also denies "Agent"/"Task", but the
    // SDK-level disallow keeps the tool out of the model's context entirely.
    disallowedTools: ["Agent", "Task"],
    canUseTool,
    env: sanitizedSubprocessEnv(),
    // In-process MCP server hosting operator + blessed integrations (Phase 2).
    // Only attached when at least one tool was loaded — registering an empty
    // server would put `mcp__solrac__*` in the model's tool list with no
    // callable handlers, which is wasted prompt budget.
    ...(deps.mcpServer && {
      mcpServers: { solrac: deps.mcpServer },
    }),
    // PreToolUse fires for every tool call, including SDK-auto-approved ones
    // (Bash(date), Read, etc.) that bypass `canUseTool` under
    // permissionMode:'default'. Cost cap + loop detector live here so the gate
    // is uniform across every tool.
    ...(preToolUseHook && {
      hooks: {
        PreToolUse: [{ hooks: [preToolUseHook] }],
        PostToolUse: [{ hooks: [postToolUseHook] }],
        PostToolUseFailure: [{ hooks: [postToolUseHook] }],
      },
    }),
  };
  if (prevSessionId) options.resume = prevSessionId;

  // Cross-engine context bridge + /compact summary injection.
  //
  // Two synthetic context blocks may apply on a single turn:
  //
  // 1. **Compaction summary** (PNX-167): if the user `/compact`ed this tier
  //    and the next turn (this one) hasn't consumed it yet, prepend the
  //    summary so the fresh SDK session has the condensed history.
  //    INVARIANT: summary injection only fires when `prevSessionId === null`.
  //    A resumed session already carries the full conversation history; the
  //    summary would duplicate that context and confuse the model. By
  //    enforcing this at the read site (here), the system stays robust to a
  //    future write-side bug that sets a summary without clearing the
  //    session id (e.g., a hypothetical `/remember` command). `/compact`
  //    today writes both atomically (`setSummary` + `clearSessionId`).
  //
  // 2. **Out-of-band turns**: if the user had exchanges with OTHER engines
  //    (the other Claude tier or Ollama) after the most recent successful
  //    turn for THIS engine, prepend those turns. The window naturally
  //    narrows after this turn finishes. OOB applies regardless of whether
  //    the SDK session is resumed — the resumed session is THIS engine's
  //    history, but OOB carries OTHER engines' turns the SDK can't see.
  //
  // The audit row records the *original* user prompt (input.prompt), not the
  // augmented one, so operator dumps show what the user actually typed.
  const summary =
    prevSessionId === null
      ? deps.sessions.getSummary(input.chatId, input.engine)
      : null;
  // Decision B for `/clear ollama`: the cutoff hides Ollama turns from
  // Claude's cross-engine bridge too, not just from Ollama's own history.
  // Without this, /clear would feel half-broken — the operator would clear
  // Ollama, then `@ ...` and watch Sonnet recite the freshly-cleared turns.
  const ollamaCutoff = deps.sessions.getOllamaCutoff(input.chatId) ?? 0;
  const oobTurns = deps.db.outOfBandForEngine(
    input.chatId,
    enginePrefix,
    OUT_OF_BAND_LIMIT,
    ollamaCutoff,
  );
  // PNX-167 (system-prompt externalization). Re-read SOLRAC.md per turn so
  // operator edits take effect on the next message without a restart.
  // Returns null if the file is missing OR carries the unedited-template
  // marker; either way we skip the wrapper block.
  const instanceMd = readInstanceMd(deps.instanceMdPath);
  const promptToSend =
    summary !== null || oobTurns.length > 0 || instanceMd !== null
      ? buildAugmentedPrompt({ instanceMd, summary, oobTurns, currentPrompt: input.prompt })
      : input.prompt;
  if (summary !== null) {
    log.info("agent.summary_injected", {
      auditId,
      chatId: input.chatId,
      engine: input.engine,
      summaryAt: summary.at,
      summaryLength: summary.text.length,
    });
  }
  if (oobTurns.length > 0) {
    log.info("agent.oob_injected", {
      auditId,
      chatId: input.chatId,
      engine: input.engine,
      count: oobTurns.length,
    });
  }

  let assistantText = "";
  const toolCalls: ToolCallSummary[] = [];
  let lastEditAt = 0;
  let lastEditedContent = thinkingStub;
  let resultSessionId: string | null = null;
  let resultText = "";
  let costUsd: number | null = null;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  // PNX-167 — cache telemetry. The "real" input on the wire is
  // inputTokens + cacheCreationInputTokens + cacheReadInputTokens; the SDK's
  // `usage.input_tokens` reports only the post-cache fresh portion.
  let cacheCreationInputTokens: number | null = null;
  let cacheReadInputTokens: number | null = null;
  let numTurns: number | null = null;
  let isError = false;
  let errorMessage: string | null = null;

  try {
    for await (const msg of query({ prompt: promptToSend, options })) {
      if (msg.type === "assistant") {
        for (const block of msg.message.content) {
          if (block.type === "text" && block.text) {
            assistantText += block.text;
          } else if (block.type === "tool_use") {
            toolCalls.push({ name: block.name, input: block.input });
            log.info("agent.tool_use", { auditId, name: block.name });
          }
        }
        if (stubId !== null) {
          const now = Date.now();
          if (now - lastEditAt >= EDIT_THROTTLE_MS) {
            const next = renderStub(assistantText, toolCalls, null, thinkingStub);
            if (next.html !== lastEditedContent) {
              lastEditAt = now;
              lastEditedContent = next.html;
              await tryEdit(deps.tg, input.chatId, stubId, next.html, next.markdown);
            }
          }
        }
      } else if (msg.type === "result") {
        resultSessionId = msg.session_id;
        numTurns = msg.num_turns;
        if (msg.subtype === "success") {
          resultText = msg.result ?? assistantText;
          costUsd = msg.total_cost_usd;
          inputTokens = msg.usage.input_tokens;
          outputTokens = msg.usage.output_tokens;
          cacheCreationInputTokens = msg.usage.cache_creation_input_tokens;
          cacheReadInputTokens = msg.usage.cache_read_input_tokens;
        } else {
          isError = true;
          errorMessage = `result_error: ${msg.subtype}`;
        }
      }
    }
  } catch (err) {
    isError = true;
    errorMessage = (err as Error).message;
    log.error("agent.error", { auditId, chatId: input.chatId, error: errorMessage });
  }

  // If the policy hook denied a tool call, our deny reason is the actual
  // cause — the SDK's `result_error` (e.g. `[ede_diagnostic] result_type=...`)
  // is just downstream noise. Override the user-facing message; record the
  // policy event in the audit row regardless of SDK status so observability
  // doesn't depend on whether the agent recovered after the deny.
  const denyEvent = policyDeny.event;
  if (denyEvent && isError) {
    errorMessage = denyEvent.message;
  }
  const auditErrorMessage = denyEvent
    ? isError
      ? denyEvent.message
      : `policy_deny: ${denyEvent.message}`
    : errorMessage;

  const finalText = resultText || assistantText;
  const footer = buildFooter({ numTurns, costUsd, isError });
  const finalRender: RenderedStub = isError
    ? {
        html: `❌ <b>error</b>: ${htmlEscapeText(errorMessage ?? "unknown")}${footer ? `\n\n${footer.html}` : ""}`,
        markdown: `❌ **error**: ${errorMessage ?? "unknown"}${footer ? `\n\n${footer.markdown}` : ""}`,
      }
    : renderStub(finalText, toolCalls, footer, thinkingStub);

  if (stubId !== null) {
    if (finalRender.html !== lastEditedContent) {
      await tryEdit(
        deps.tg,
        input.chatId,
        stubId,
        finalRender.html,
        finalRender.markdown,
        "agent.edit_final_failed",
      );
    }
  } else if (!isError && finalText.trim()) {
    // Stub creation failed earlier — send the answer as a fresh message instead.
    await deps.tg
      .sendMessage(input.chatId, finalRender.html, {
        parse_mode: "HTML",
        markdownSource: finalRender.markdown,
      })
      .catch((err) => log.warn("agent.final_send_failed", { error: (err as Error).message }));
  }

  // PNX-170 — only persist the SDK session id on a clean turn. Errored
  // sessions retain partial state (interrupted tool_use, stuck loops) that
  // confuses the model on resume; dropping the id forces the next turn to
  // open a fresh session. Mirrors the `!isError` gate on summary clearing
  // below. See ARCHITECTURE.md#tricky-seams.
  if (resultSessionId && !isError) {
    deps.sessions.setSessionId(input.chatId, input.engine, resultSessionId);
  }
  // PNX-167 — consume the /compact summary on a successful turn. The summary
  // is now baked into the new SDK session's history (it was prepended to
  // `promptToSend`). Subsequent turns resume from `resultSessionId` and
  // inherit the summary via the session itself; we don't need to re-inject.
  // On error we leave the summary alone so the retry can reuse it.
  if (summary !== null && !isError) {
    deps.sessions.clearSummary(input.chatId, input.engine);
  }

  deps.db.updateAuditEnd({
    id: auditId,
    response: resultText || assistantText || null,
    toolCalls: toolCalls.length > 0 ? JSON.stringify(toolCalls) : null,
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    costUsd,
    agentSessionId: resultSessionId,
    status: isError ? "error" : "ok",
    errorMessage: auditErrorMessage,
    endedAt: Date.now(),
  });

  log.info("agent.done", {
    auditId,
    chatId: input.chatId,
    engine: input.engine,
    model: modelId,
    sessionId: resultSessionId,
    costUsd,
    numTurns,
    isError,
  });
}

const defaultAllowAll: CanUseTool = async (toolName) => {
  log.info("agent.tool_allow_all", { toolName });
  return { behavior: "allow" };
};

// Strip Telegram/solrac-specific secrets so the spawned `claude` subprocess
// cannot attach to our bot via a user-level plugin (e.g. the official
// `telegram@claude-plugins-official` plugin reads TELEGRAM_BOT_TOKEN from env
// and calls getUpdates, racing our own poller).
//
// Integration tokens (NOTION_API_KEY, …) are scrubbed for a different reason:
// the integration handler runs in solrac's main process — the SDK subprocess
// never needs the token. Without scrubbing, an auto-allowed `Bash(echo …)`
// call (per policy.ts BASH_SAFE_PREFIXES) lets a compromised model exfiltrate
// the token in plaintext.
//
// Exported (PNX-167) so the `/compact` runner in commands.ts can reuse the
// same sanitize without duplicating the deny-list. If you add a new var that
// must NOT leak to the SDK subprocess, add it here — both call sites pick it
// up automatically.
export function sanitizedSubprocessEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("TELEGRAM_")) continue;
    if (key.startsWith("TG_")) continue;
    if (key === "STATS_BEARER_TOKEN") continue;
    if (key === "ALLOWLIST_BOOTSTRAP") continue;
    if (key === "NOTION_API_KEY") continue;
    env[key] = value;
  }
  return env;
}

interface RenderedStub {
  html: string;
  markdown: string;
}

function renderStub(
  text: string,
  toolCalls: ToolCallSummary[],
  footer: Footer | null,
  thinkingStub: string,
): RenderedStub {
  const htmlParts: string[] = [];
  const mdParts: string[] = [];
  if (toolCalls.length > 0) {
    const names = [...new Set(toolCalls.map((t) => t.name))].join(", ");
    htmlParts.push(`⚙️ <i>${htmlEscapeText(names)}</i>`);
    mdParts.push(`*⚙️ ${names}*`);
  }
  if (text.trim()) {
    htmlParts.push(mdToTelegramHtml(text));
    mdParts.push(text);
  } else {
    htmlParts.push(thinkingStub);
    mdParts.push(thinkingStub);
  }
  if (footer) {
    htmlParts.push(footer.html);
    mdParts.push(footer.markdown);
  }
  return {
    html: truncate(htmlParts.join("\n\n"), TELEGRAM_TEXT_MAX),
    markdown: mdParts.join("\n\n"),
  };
}

interface Footer {
  html: string;
  markdown: string;
}

function buildFooter(args: {
  numTurns: number | null;
  costUsd: number | null;
  isError: boolean;
}): Footer | null {
  if (args.isError) return null;
  const bits: string[] = [];
  if (args.numTurns !== null) bits.push(`${args.numTurns} turn${args.numTurns === 1 ? "" : "s"}`);
  if (args.costUsd !== null) bits.push(`$${args.costUsd.toFixed(4)}`);
  if (bits.length === 0) return null;
  const inner = bits.join(" · ");
  return {
    html: `<i>✅ ${inner}</i>`,
    markdown: `*✅ ${inner}*`,
  };
}

async function tryEdit(
  tg: TelegramClient,
  chatId: number,
  messageId: number,
  text: string,
  markdownSource: string | undefined,
  errEvent: string = "agent.edit_throttled",
): Promise<void> {
  await tg
    .editMessageText(chatId, messageId, text, { parse_mode: "HTML", markdownSource })
    .catch((err) => log.debug(errEvent, { error: (err as Error).message }));
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

// Bridge text the user can't see — sent only to the SDK, not Telegram.
//
// Two layers may apply, both prepended to `currentPrompt`:
//
// 1. **Compaction summary** (PNX-167): a model-produced summary of this
//    tier's prior conversation, captured on `/compact` and consumed once at
//    the start of the next fresh turn. Recognizable to the model as
//    retrospective context (not instructions) via the labeled block.
//
// 2. **Out-of-band turns**: prior exchanges from OTHER engines that the SDK
//    session can't see. Each row is labeled with the engine that produced it
//    so the model can name the source when natural.
//
// Why NOT `wrapUntrustedContent` here: the two helpers serve different
// threat models. `wrapUntrustedContent` is for THIRD-PARTY text (forwarded
// docs, OCR'd images, etc.) where the source is potentially adversarial; it
// uses tags + a `source` attribute so the model treats the contents as data
// to never obey. The summary and OOB content carry the same allowlisted
// user's own prior turns + Solrac's own prior responses — already trusted by
// the allowlist gate. A plain-text labeled block is enough boundary; tagging
// it would over-signal "data not instructions" for content that's just
// earlier conversation. Future attachment intake will route through
// `wrapUntrustedContent` separately.
export function buildAugmentedPrompt(args: {
  // PNX-167: operator-authored SOLRAC.md content (with HTML comments stripped
  // and unedited-template detection already applied by `readInstanceMd`).
  // Wrapped in `<solrac-md>` so the model treats it as a labeled instruction
  // block distinguishable from user text. Sits at the very top of the
  // augmented prompt — before summary and OOB — so it frames the whole turn.
  instanceMd: string | null;
  summary: { text: string; at: number } | null;
  oobTurns: ReadonlyArray<{ prompt: string; response: string; model: string }>;
  currentPrompt: string;
}): string {
  const lines: string[] = [];
  if (args.instanceMd !== null) {
    lines.push(wrapInstanceMd(args.instanceMd), "");
  }
  if (args.summary !== null) {
    const ts = new Date(args.summary.at).toISOString();
    lines.push(
      `[Compaction summary: this thread was condensed at ${ts}. The points to remember:]`,
      "",
      args.summary.text,
      "",
      "[End of compaction summary.]",
      "",
    );
  }
  if (args.oobTurns.length > 0) {
    lines.push(
      "[Out-of-band context: the user had the following exchange(s) in this chat with another engine since I last spoke. The Anthropic SDK doesn't carry these in my session, but they're part of the conversation thread the user sees.]",
      "",
    );
    for (const t of args.oobTurns) {
      lines.push(`User: ${t.prompt}`);
      lines.push(`Other engine (${t.model}): ${t.response}`);
      lines.push("");
    }
    lines.push("[End of out-of-band context. The user's current message:]", "");
  } else if (args.summary !== null) {
    lines.push("[The user's current message:]", "");
  }
  lines.push(args.currentPrompt);
  return lines.join("\n");
}
