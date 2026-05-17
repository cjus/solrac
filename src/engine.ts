/**
 * @fileoverview Engine-slot runner for Telegram messages routed to the
 *               `local` engine slot (default no-prefix path). Despite the slot
 *               name, the runner is mode-polymorphic: both on-host backends
 *               (Ollama, LMStudio — `driver.mode === "local"`) and hosted
 *               providers (OpenRouter — `driver.mode === "remote"`) reach
 *               Telegram through this path.
 * @purpose Stream a chat completion from an `EngineDriver` into the same
 *          Telegram throttled-edit UX that `agent.ts` uses for the Anthropic
 *          SDK path.
 *
 * One call to `runEngineTurn` = one turn against the driver. The function:
 *   1. inserts the in-progress audit row tagged
 *      `model='<driver.mode>:<backend>:<name>'`;
 *   2. assembles a chat-style messages array — system prompt + capability note,
 *      optional SOLRAC.md overlay, prior history reconstructed from `audit`,
 *      current user prompt;
 *   3. iterates the driver's normalized `EngineChatEvent` stream — `text`,
 *      `tool_call` (single-shot path ignores them), `done`, `error`;
 *   4. throttle-edits the 💻 stub with rendered partial text;
 *   5. finalizes the audit row with token counts, `cost_usd`,
 *      `agent_session_id = null`, `tool_calls = null`;
 *   6. on error, renders a clear failure (`❌ <backend> unreachable`, etc.) and
 *      writes `status='error'` with the diagnostic in `error_message`.
 *
 * Why a sibling module (not a branch in `agent.ts`):
 *   - The Anthropic SDK runner depends on `@anthropic-ai/claude-agent-sdk`,
 *     `policy.ts` hooks, the per-chat `SessionStore`, the SDK preset prompt,
 *     the SDK env scrub. The engine-slot path needs none of that.
 *   - Pure inference (single-shot): no `canUseTool`, no `PreToolUse` hook,
 *     no `disallowedTools`. For `mode === "local"`, `cost_usd` is always 0
 *     and the global cap query sums every row regardless. For
 *     `mode === "remote"`, the driver-reported cost is summed too.
 *
 * Stateful history: conversation continuity within a chat, across every engine
 * boundary. `db.recentChatTurns(chatId, limit)` returns the last N successful
 * turns in chronological order regardless of which engine produced them. Each
 * contributes a user/assistant pair before the current turn. Default limit is
 * `LOCAL_HISTORY_LIMIT=6` (three round-trips). Cross-engine means an engine-slot
 * follow-up to a prior Claude exchange sees the Claude response.
 *
 * Position in the dependency graph:
 *   db + policy + telegram + log + engine-driver + local-driver + remote-driver
 *     → engine → consumed by main
 *
 * Exports:
 *   - `runEngineTurn(deps, input)` — runs one engine-slot turn end-to-end.
 *   - `EngineRunDeps` — runtime deps (tg, db, driver, model, timeout, history).
 *   - `EngineRunInput` — per-turn input (chatId, fromId, updateId, prompt).
 *   - `buildToolCapabilityNote` — back-compat dispatcher that picks the
 *     mode-specific tool-capability note (local/remote driver files own the
 *     actual builders). Deletes when commands.ts migrates in Phase 5.
 *
 * Key invariants:
 *   - Audit row is inserted BEFORE the driver call (`status='in_progress'`)
 *     and updated to `'ok'`/`'error'` after; lifecycle drain prevents
 *     orphaned in-progress rows on graceful shutdown.
 *   - For `mode === "local"`, `cost_usd` is always `0`; `agent_session_id`
 *     is always `null`.
 *   - The streaming editor reuses the `lastEditedContent` no-op-edit guard
 *     and 1.5s throttle so the UX matches the Claude path.
 *   - The footer (`<i>✅ <mode>:<backend>:<model> · Ns</i>`) is load-bearing —
 *     guarantees the final edit differs from any streaming render so Telegram
 *     doesn't 400 on a no-op.
 *
 * Cross-references:
 *   - docs/ARCHITECTURE.md#local-routing — design discussion
 *   - policy.ts::parseEnginePrefix — engine prefix detection (called from main.ts)
 *   - main.ts::makeRunTurn — dispatcher between runAgent and runEngineTurn
 *   - engine-driver.ts — shared wire-format-agnostic contract
 *   - local-driver.ts — Ollama NDJSON / LMStudio SSE
 *   - remote-driver.ts — OpenRouter SSE
 */

import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import type { SolracDb } from "./db.ts";
import type { SessionStore } from "./session.ts";
import { readInstanceMd, wrapInstanceMd } from "./instance.ts";
import type { IntegrationTier } from "./integrations.ts";
import {
  type EngineChatMessage,
  type EngineDriver,
  EngineDriverError,
} from "./engine-driver.ts";
import {
  buildLocalCapabilityNote,
  buildLocalToolCapabilityNote,
} from "./local-driver.ts";
import {
  buildRemoteCapabilityNote,
  buildRemoteToolCapabilityNote,
} from "./remote-driver.ts";
import { log } from "./log.ts";
import {
  createLoopDetector,
  truncateAuditPrompt,
  type ConfirmationBroker,
} from "./policy.ts";
import { mdToTelegramHtml } from "./markdown.ts";
import {
  mcpToEngineTools,
  runToolLoop,
  type RunToolLoopRenderer,
} from "./engine-tools.ts";
import { skillToolCtx } from "./skill-tools.ts";
import { htmlEscapeText, type TelegramClient } from "./telegram.ts";

const TELEGRAM_TEXT_MAX = 3800;
const EDIT_THROTTLE_MS = 1500;
const THINKING_STUB = "💻 thinking…";

export interface EngineRunDeps {
  tg: TelegramClient;
  db: SolracDb;
  // `/clear local` cutoff store. Reads `getLocalCutoff(chatId)` once per
  // turn before assembling history. Optional for back-compat with tests that
  // construct deps inline; production wiring in main.ts always provides it.
  sessions?: SessionStore;
  // The driver is the single source of truth for engine mode — each impl
  // sets `mode` (`createOllamaDriver`/`createLmstudioDriver` → "local";
  // `createOpenrouterDriver` → "remote"). The runner reads `driver.mode`
  // wherever it needs to branch: audit tag prefix, capability-note framing,
  // cost-write decision.
  driver: EngineDriver;
  model: string;
  timeoutMs: number;
  historyLimit: number;
  // SOUL.md text (read once at boot) — appended with a capability note and
  // shipped as the first `system` message. `instanceMdPath` is re-read per
  // turn so live SOLRAC.md edits take effect on the next message.
  soul: string;
  instanceMdPath: string;
  // Set to `true` when `config.defaultEngine === "local"`. Drives the
  // capability note's tone (default chat engine vs. tools-less escape hatch).
  isDefaultEngine?: boolean;
  // Tools surface. When `toolEnabled === true && tools.length > 0`,
  // `runEngineTurn` dispatches through `runToolLoop` so the model can
  // call the same `mcp__solrac__*` integrations Claude tiers see.
  toolEnabled?: boolean;
  tools?: ReadonlyArray<SdkMcpToolDefinition<any>>;
  toolTiers?: ReadonlyMap<string, IntegrationTier>;
  broker?: Pick<ConfirmationBroker, "request">;
  // `LOCAL_MAX_TOOL_ITERATIONS` / `REMOTE_MAX_TOOL_ITERATIONS`. Defaults to
  // 8; only consulted when tools are enabled.
  maxToolIterations?: number;
}

export interface EngineRunInput {
  chatId: number;
  fromId: number;
  // Nullable for synthesized scheduler updates — they don't ride the poll
  // offset so there's no real Telegram update_id to record.
  updateId: number | null;
  prompt: string;
  // Scheduler — set when this turn fired from a scheduled task. The audit
  // row gets origin='scheduled' + task_name; runtime behavior is otherwise
  // identical to a user turn.
  scheduledTaskName?: string | null;
}

export async function runEngineTurn(
  deps: EngineRunDeps,
  input: EngineRunInput,
): Promise<void> {
  const backend = deps.driver.backend;
  const mode = deps.driver.mode;
  // Audit-tag prefix tracks `mode` (not backend) so cross-engine queries
  // (`/clear local`, the bridge in `outOfBandForEngine`, `/status` counters)
  // can pattern-match the engine SLOT, not the wire protocol. `remote:%`
  // rows also carry real costs in `cost_usd` so the existing hourly caps
  // gate them — `local:%` rows are always free (cost_usd = 0).
  const modelTag = `${mode}:${backend}:${deps.model}`;
  const auditId = deps.db.insertAudit({
    chatId: input.chatId,
    fromId: input.fromId,
    updateId: input.updateId,
    prompt: truncateAuditPrompt(input.prompt),
    startedAt: Date.now(),
    model: modelTag,
    origin: input.scheduledTaskName ? "scheduled" : "user",
    taskName: input.scheduledTaskName ?? null,
  });

  const stub = await deps.tg.sendMessage(input.chatId, THINKING_STUB).catch((err) => {
    log.warn("engine.stub_send_failed", { auditId, error: (err as Error).message });
    return null;
  });
  const stubId = stub && typeof stub === "object" ? stub.message_id : null;

  // Tools-on path: dispatch through the loop driver. Requires all four
  // tools-related fields; if `tools` is empty, fall through to single-shot —
  // nothing for the model to call, and the loop driver would just add overhead.
  if (
    deps.toolEnabled === true &&
    deps.tools !== undefined &&
    deps.tools.length > 0 &&
    deps.toolTiers !== undefined &&
    deps.broker !== undefined
  ) {
    return runEngineTurnWithTools(deps, input, auditId, stubId);
  }

  const noteOpts = {
    toolsEnabled: false,
    isDefaultEngine: deps.isDefaultEngine === true,
    toolNames: [],
  };
  const capabilityNote =
    mode === "remote"
      ? buildRemoteCapabilityNote(noteOpts)
      : buildLocalCapabilityNote(noteOpts);
  const messages: EngineChatMessage[] = [
    { role: "system", content: `${deps.soul}\n\n${capabilityNote}` },
  ];
  // Re-read SOLRAC.md per turn so operator edits land on the next message.
  // When present, send it as a separate `system` message — local models lack
  // RLHF on instruction hierarchy, so a distinct system turn is safer than
  // concatenation into the first one.
  const instanceMd = readInstanceMd(deps.instanceMdPath);
  if (instanceMd !== null) {
    messages.push({ role: "system", content: wrapInstanceMd(instanceMd) });
  }
  // History reconstruction: stateful chat context per chat. Pulls every
  // successful turn for the chat regardless of engine — primary Claude,
  // secondary Claude, prior local. Each row's `model` field tags origin but
  // the role mapping is identical: (user, prompt) + (assistant, response).
  //
  // `/clear local` cutoff hides every turn at or before the cutoff. The
  // cutoff is per-chat (not per-engine) because the audit log is the only
  // history the local path has — clearing means clearing.
  const cutoff = deps.sessions?.getLocalCutoff(input.chatId) ?? 0;
  const history = deps.db.recentChatTurns(input.chatId, deps.historyLimit, cutoff);
  for (const h of history) {
    messages.push({ role: "user", content: h.prompt });
    messages.push({ role: "assistant", content: h.response });
  }
  messages.push({ role: "user", content: input.prompt });

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), deps.timeoutMs);
  const startedAt = Date.now();

  let assistantText = "";
  let lastEditAt = 0;
  let lastEditedContent = THINKING_STUB;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  // Captured from the driver's done event. Distinct from the value written to
  // `audit.cost_usd` — local mode writes 0 regardless of what the driver
  // reported (always null in practice for on-host backends); remote mode
  // writes this value, or null + a `remote.cost_missing` warn if the driver
  // didn't report one. See the audit-write site below for the matrix.
  let driverCostUsd: number | null = null;
  let isError = false;
  let errorMessage: string | null = null;

  try {
    for await (const evt of deps.driver.streamChat({
      model: deps.model,
      messages,
      signal: ac.signal,
    })) {
      if (evt.kind === "text") {
        assistantText += evt.delta;
        if (stubId !== null && !isError) {
          const now = Date.now();
          if (now - lastEditAt >= EDIT_THROTTLE_MS) {
            const next = renderStreamingStub(assistantText);
            if (next.html !== lastEditedContent) {
              lastEditAt = now;
              lastEditedContent = next.html;
              await tryEdit(deps.tg, input.chatId, stubId, next.html, next.markdown);
            }
          }
        }
      } else if (evt.kind === "done") {
        inputTokens = evt.inputTokens;
        outputTokens = evt.outputTokens;
        driverCostUsd = evt.costUsd;
      } else if (evt.kind === "error") {
        errorMessage = `local error: ${evt.message}`;
        isError = true;
        break;
      }
      // `tool_call` events in single-shot path: the model called a tool we
      // didn't offer. Surface to logs but don't break — the model will likely
      // also produce text we can show.
      else if (evt.kind === "tool_call") {
        log.warn("engine.unexpected_tool_call_single_shot", {
          auditId,
          tool: evt.call.function.name,
        });
      }
    }
  } catch (err) {
    isError = true;
    if (err instanceof EngineDriverError) {
      errorMessage = formatDriverError(err, deps.timeoutMs);
      log.error("engine.driver_failed", {
        auditId,
        backend,
        code: err.code,
        status: err.status,
        error: err.message,
      });
    } else {
      const e = err as Error;
      errorMessage = `engine unexpected error: ${e.message}`;
      log.error("engine.unexpected_error", {
        auditId,
        backend,
        error: e.message,
        name: e.name,
      });
    }
  } finally {
    clearTimeout(timer);
    // Cancel the underlying response stream on every exit path. The driver's
    // generator releases the reader on `return`, but the AbortController is a
    // belt-and-suspenders signal for any in-flight fetch.
    ac.abort();
  }

  const elapsedSec = (Date.now() - startedAt) / 1000;
  const finalRender: Rendered = isError
    ? renderError(errorMessage ?? "unknown")
    : renderFinal(assistantText, mode, backend, deps.model, elapsedSec);

  if (stubId !== null) {
    if (finalRender.html !== lastEditedContent) {
      await tryEdit(
        deps.tg,
        input.chatId,
        stubId,
        finalRender.html,
        finalRender.markdown,
        "engine.edit_final_failed",
      );
    }
  } else if (!isError && assistantText.trim()) {
    await deps.tg
      .sendMessage(input.chatId, finalRender.html, {
        parse_mode: "HTML",
        markdownSource: finalRender.markdown,
      })
      .catch((err) => log.warn("engine.final_send_failed", { error: (err as Error).message }));
  }

  // Cost-write matrix:
  //   mode=local  → 0 (on-host backends are free; driverCostUsd ignored).
  //   mode=remote && driverCostUsd != null → driverCostUsd (real billed cost).
  //   mode=remote && driverCostUsd == null → null + remote.cost_missing warn.
  // The third row writes `null` (NOT 0) because COALESCE(SUM(cost_usd), 0)
  // in the cap query would treat 0 as "free" and silently bypass the cap.
  // Writing null preserves the audit row but excludes it from the cap sum;
  // operators see the warn and can react (capture from /generation lookup if
  // OpenRouter ever stops including cost in the streaming chunk).
  const costForAudit = resolveAuditCost(mode, driverCostUsd, auditId, backend);

  deps.db.updateAuditEnd({
    id: auditId,
    response: assistantText || null,
    toolCalls: null,
    inputTokens,
    outputTokens,
    // Local engine doesn't expose cache telemetry — the API is stateless per call.
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
    costUsd: costForAudit,
    agentSessionId: null,
    status: isError ? "error" : "ok",
    errorMessage,
    endedAt: Date.now(),
  });

  log.info("engine.done", {
    auditId,
    chatId: input.chatId,
    backend,
    mode,
    model: deps.model,
    elapsedSec,
    inputTokens,
    outputTokens,
    costUsd: costForAudit,
    isError,
  });
}

/**
 * Pick the value written to `audit.cost_usd` for an engine-slot turn.
 * See the matrix comment at the call site for the rationale; this helper is
 * extracted so the tools-on path reuses the same decision (and so a single
 * future bug fix lands in one place).
 */
function resolveAuditCost(
  mode: "local" | "remote",
  driverCostUsd: number | null,
  auditId: number,
  backend: string,
): number | null {
  if (mode === "local") return 0;
  if (driverCostUsd === null) {
    log.warn("remote.cost_missing", {
      auditId,
      backend,
      hint:
        "driver returned no cost in the usage chunk; audit.cost_usd written as NULL " +
        "to keep the row out of cap sums. Verify the backend still emits usage.cost.",
    });
    return null;
  }
  return driverCostUsd;
}

interface Rendered {
  html: string;
  markdown: string;
}

function formatDriverError(err: EngineDriverError, timeoutMs: number): string {
  switch (err.code) {
    case "timeout":
      return `local timed out after ${(timeoutMs / 1000).toFixed(0)}s`;
    case "unreachable":
      return `local ${err.backend} unreachable: ${err.message}`;
    case "model_missing":
      return `❌ ${err.message}`;
    case "http_error":
      return `local ${err.backend} error: ${err.message}`;
  }
}

// Strip harmony-style control-token leaks from local models (gpt-oss and
// similar variants surfaced via Ollama or LMStudio). Three passes:
//   1. Paired blocks `<|name>...<name|>` — drop the whole header (channel
//      name + markers).
//   2. Unclosed opener `<|name>` at end of buffer — suppress until the
//      closing marker arrives in a later streaming delta.
//   3. Stray symmetric tokens (`<|start|>`, `<|end|>`, `<|message|>`) and
//      orphan closers — drop the tokens themselves.
// Display-only: applied at render time. The raw model output is preserved
// in `audit.response` for forensics and in `recentChatTurns` history.
export function scrubLocalControlTokens(text: string): string {
  let out = text.replace(/<\|[^<>|]+>[\s\S]*?<[^<>|]+\|>/g, "");
  const openerIdx = out.search(/<\|[^<>|]+>/);
  if (openerIdx !== -1) out = out.slice(0, openerIdx);
  out = out.replace(/<\|[^<>|]+\|>|<[^<>|]+\|>/g, "");
  return out.replace(/^\s+/, "");
}

function renderStreamingStub(text: string): Rendered {
  const scrubbed = scrubLocalControlTokens(text);
  if (!scrubbed.trim()) return { html: THINKING_STUB, markdown: THINKING_STUB };
  return {
    html: truncate(mdToTelegramHtml(scrubbed), TELEGRAM_TEXT_MAX),
    markdown: scrubbed,
  };
}

function renderFinal(
  text: string,
  mode: "local" | "remote",
  backend: string,
  model: string,
  elapsedSec: number,
): Rendered {
  const scrubbed = scrubLocalControlTokens(text);
  const hasText = scrubbed.trim().length > 0;
  const htmlBody = hasText ? mdToTelegramHtml(scrubbed) : "(empty response)";
  const mdBody = hasText ? scrubbed : "(empty response)";
  // Footer tag mirrors the audit-row tag so operators reading either source
  // see the same identifier — `remote:openrouter:anthropic/claude-3.5-sonnet`
  // or `local:ollama:gemma3:4b` — and can grep across both surfaces.
  const tag = `${mode}:${backend}:${model}`;
  const htmlFooter = `<i>✅ ${htmlEscapeText(tag)} · ${elapsedSec.toFixed(1)}s</i>`;
  const mdFooter = `*✅ ${tag} · ${elapsedSec.toFixed(1)}s*`;
  return {
    html: truncate(`${htmlBody}\n\n${htmlFooter}`, TELEGRAM_TEXT_MAX),
    markdown: `${mdBody}\n\n${mdFooter}`,
  };
}

function renderError(msg: string): Rendered {
  return {
    html: `❌ <b>error</b>: ${htmlEscapeText(msg)}`,
    markdown: `❌ **error**: ${msg}`,
  };
}

async function tryEdit(
  tg: TelegramClient,
  chatId: number,
  messageId: number,
  text: string,
  markdownSource: string | undefined,
  errEvent: string = "engine.edit_throttled",
): Promise<void> {
  await tg
    .editMessageText(chatId, messageId, text, { parse_mode: "HTML", markdownSource })
    .catch((err) => log.debug(errEvent, { error: (err as Error).message }));
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

// ---------------------------------------------------------------------------
// Tools-on path — dispatches through `runToolLoop`
// ---------------------------------------------------------------------------

const DEFAULT_MAX_TOOL_ITERATIONS = 8;

async function runEngineTurnWithTools(
  deps: EngineRunDeps,
  input: EngineRunInput,
  auditId: number,
  stubId: number | null,
): Promise<void> {
  const tools = deps.tools ?? [];
  const toolTiers = deps.toolTiers ?? new Map<string, IntegrationTier>();
  const broker = deps.broker!;
  const maxIterations = deps.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS;
  const backend = deps.driver.backend;
  const mode = deps.driver.mode;

  const toolNames = tools.map((t) => t.name);
  const isDefault = deps.isDefaultEngine === true;
  const capabilityNote =
    mode === "remote"
      ? buildRemoteToolCapabilityNote(toolNames, isDefault)
      : buildLocalToolCapabilityNote(toolNames, isDefault);
  const toolDefs = mcpToEngineTools(tools);
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  // Build initial messages — same shape as the single-shot path, only the
  // capability note differs. Inlined rather than factored to keep the diff
  // for the tools-on path scoped.
  const initialMessages: EngineChatMessage[] = [
    { role: "system", content: `${deps.soul}\n\n${capabilityNote}` },
  ];
  const instanceMd = readInstanceMd(deps.instanceMdPath);
  if (instanceMd !== null) {
    initialMessages.push({ role: "system", content: wrapInstanceMd(instanceMd) });
  }
  // Same cutoff treatment as the single-shot path; the tool-loop variant
  // must agree so `/clear local` is consistent across both modes.
  const cutoff = deps.sessions?.getLocalCutoff(input.chatId) ?? 0;
  const history = deps.db.recentChatTurns(input.chatId, deps.historyLimit, cutoff);
  for (const h of history) {
    initialMessages.push({ role: "user", content: h.prompt });
    initialMessages.push({ role: "assistant", content: h.response });
  }
  initialMessages.push({ role: "user", content: input.prompt });

  // Single shared `AbortController` covers every fetch this turn.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), deps.timeoutMs);
  const startedAt = Date.now();

  let lastEditedKey = "";
  const renderer: RunToolLoopRenderer = {
    async onProgress(text, toolNames) {
      if (stubId === null) return;
      const next = renderToolLoopStub(text, toolNames);
      if (next.key === lastEditedKey) return;
      lastEditedKey = next.key;
      await tryEdit(deps.tg, input.chatId, stubId, next.html, next.markdown);
    },
  };

  const loopDetector = createLoopDetector();

  let result;
  try {
    // Wrap the loop in `skillToolCtx.run(...)` so any `skills__*` tool the
    // model calls mid-loop can read per-turn context via `AsyncLocalStorage.
    // getStore()` from its handler.
    result = await skillToolCtx.run(
      {
        chatId: input.chatId,
        fromId: input.fromId,
        updateId: input.updateId,
        parentAuditId: auditId,
      },
      () =>
        runToolLoop(
          {
            driver: deps.driver,
            model: deps.model,
            signal: ac.signal,
            tools: toolMap,
            toolTiers,
            toolDefs,
            broker,
            loopDetector,
            maxIterations,
            auditId,
            chatId: input.chatId,
            renderer,
          },
          { initialMessages },
        ),
    );
  } finally {
    clearTimeout(timer);
    ac.abort();
  }

  const elapsedSec = (Date.now() - startedAt) / 1000;
  const isError = result.errorMessage !== null && !result.iterationCapHit;
  const finalRender: Rendered = isError
    ? renderError(result.errorMessage ?? "unknown")
    : renderToolLoopFinal(
        result.assistantText,
        mode,
        backend,
        deps.model,
        elapsedSec,
        result.toolsFired,
        result.iterationCapHit,
      );

  if (stubId !== null) {
    if (finalRender.html !== lastEditedKey) {
      await tryEdit(
        deps.tg,
        input.chatId,
        stubId,
        finalRender.html,
        finalRender.markdown,
        "engine.edit_final_failed",
      );
    }
  } else if (!isError && result.assistantText.trim()) {
    await deps.tg
      .sendMessage(input.chatId, finalRender.html, {
        parse_mode: "HTML",
        markdownSource: finalRender.markdown,
      })
      .catch((err) =>
        log.warn("engine.final_send_failed", { error: (err as Error).message }),
      );
  }

  // Tool-loop cost: under remote mode, each round writes its own usage chunk
  // with its own per-round cost. `runToolLoop` only surfaces the FINAL round's
  // costUsd (via `result.costUsd`), which would undercount multi-round remote
  // turns. The fix lives in `local-tools.ts` (sum costs across rounds);
  // here we pass the summed value through the same `resolveAuditCost` matrix
  // as the single-shot path.
  const costForAudit = resolveAuditCost(mode, result.costUsd, auditId, backend);

  deps.db.updateAuditEnd({
    id: auditId,
    response: result.assistantText || null,
    toolCalls:
      result.toolCallSummaries.length > 0
        ? JSON.stringify(result.toolCallSummaries)
        : null,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
    costUsd: costForAudit,
    agentSessionId: null,
    status: isError ? "error" : "ok",
    errorMessage: result.errorMessage,
    endedAt: Date.now(),
  });

  log.info("engine.done", {
    auditId,
    chatId: input.chatId,
    backend,
    mode,
    model: deps.model,
    elapsedSec,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    costUsd: costForAudit,
    toolsFired: result.toolsFired,
    iterationCapHit: result.iterationCapHit,
    isError,
  });
}

// Render variants for the tools-on path. Mirror the single-shot
// `renderStreamingStub` / `renderFinal` but include the `⚙️ <names>` chip and
// the `K tools` footer segment. Inlined here rather than factored because
// the single-shot variants are ~5 lines each — a shared helper would cost
// more in conditional branches than it saves.

function renderToolLoopStub(
  text: string,
  toolNames: ReadonlyArray<string>,
): Rendered & { key: string } {
  const scrubbed = scrubLocalControlTokens(text);
  const htmlParts: string[] = [];
  const mdParts: string[] = [];
  if (toolNames.length > 0) {
    const names = [...new Set(toolNames)].join(", ");
    htmlParts.push(`⚙️ <i>${htmlEscapeText(names)}</i>`);
    mdParts.push(`*⚙️ ${names}*`);
  }
  if (scrubbed.trim()) {
    htmlParts.push(mdToTelegramHtml(scrubbed));
    mdParts.push(scrubbed);
  } else {
    htmlParts.push(THINKING_STUB);
    mdParts.push(THINKING_STUB);
  }
  const html = truncate(htmlParts.join("\n\n"), TELEGRAM_TEXT_MAX);
  const markdown = mdParts.join("\n\n");
  return { html, markdown, key: html };
}

function renderToolLoopFinal(
  text: string,
  mode: "local" | "remote",
  backend: string,
  model: string,
  elapsedSec: number,
  toolsFired: number,
  iterationCapHit: boolean,
): Rendered {
  const scrubbed = scrubLocalControlTokens(text);
  const hasText = scrubbed.trim().length > 0;
  const htmlBody = hasText ? mdToTelegramHtml(scrubbed) : "(empty response)";
  const mdBody = hasText ? scrubbed : "(empty response)";
  const capChip = iterationCapHit
    ? `⚠️ stopped after ${toolsFired} tool iterations · `
    : "";
  const toolsChip = toolsFired > 0 ? `${toolsFired} tools · ` : "";
  const tag = `${mode}:${backend}:${model}`;
  const htmlFooter = `<i>✅ ${htmlEscapeText(tag)} · ${capChip}${toolsChip}${elapsedSec.toFixed(1)}s</i>`;
  const mdFooter = `*✅ ${tag} · ${capChip}${toolsChip}${elapsedSec.toFixed(1)}s*`;
  return {
    html: truncate(`${htmlBody}\n\n${htmlFooter}`, TELEGRAM_TEXT_MAX),
    markdown: `${mdBody}\n\n${mdFooter}`,
  };
}
