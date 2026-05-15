/**
 * @fileoverview Local-engine runner for Telegram messages routed to the
 *               `local` engine (default no-prefix path).
 * @purpose Stream a chat completion from a `LocalDriver` (Ollama or LMStudio)
 *          into the same Telegram throttled-edit UX that `agent.ts` uses for
 *          the Anthropic SDK path.
 *
 * One call to `runLocalTurn` = one turn against the local model. The function:
 *   1. inserts the in-progress audit row tagged `model='local:<backend>:<name>'`;
 *   2. assembles a chat-style messages array — system prompt + capability note,
 *      optional SOLRAC.md overlay, prior history reconstructed from `audit`,
 *      current user prompt;
 *   3. iterates the driver's normalized `LocalChatEvent` stream — `text`,
 *      `tool_call` (single-shot path ignores them), `done`, `error`;
 *   4. throttle-edits the 💻 stub with rendered partial text;
 *   5. finalizes the audit row with token counts, `cost_usd = 0`,
 *      `agent_session_id = null`, `tool_calls = null`;
 *   6. on error, renders a clear failure (`❌ local unreachable`, etc.) and
 *      writes `status='error'` with the diagnostic in `error_message`.
 *
 * Why a sibling module (not a branch in `agent.ts`):
 *   - The Anthropic SDK runner depends on `@anthropic-ai/claude-agent-sdk`,
 *     `policy.ts` hooks, the per-chat `SessionStore`, the SDK preset prompt,
 *     the SDK env scrub. The local path needs none of that.
 *   - Pure inference (single-shot): no `canUseTool`, no `PreToolUse` hook,
 *     no `disallowedTools`. The cost cap is unaffected because local writes
 *     `cost_usd = 0`; the global cap query sums every row regardless.
 *
 * Stateful history: conversation continuity within a chat, across every engine
 * boundary. `db.recentChatTurns(chatId, limit)` returns the last N successful
 * turns in chronological order regardless of which engine produced them. Each
 * contributes a user/assistant pair before the current turn. Default limit is
 * `LOCAL_HISTORY_LIMIT=6` (three round-trips). Cross-engine means a local
 * follow-up to a prior Claude exchange sees the Claude response.
 *
 * Position in the dependency graph:
 *   db + policy + telegram + log + local-driver → local → consumed by main
 *
 * Exports:
 *   - `runLocalTurn(deps, input)` — runs one local turn end-to-end.
 *   - `LocalRunDeps` — runtime deps (tg, db, driver, model, timeout, history).
 *   - `LocalRunInput` — per-turn input (chatId, fromId, updateId, prompt).
 *   - `buildLocalCapabilityNote` — engine-specific clause appended to SOUL.md
 *     before it ships as the first `system` message.
 *   - `buildToolCapabilityNote` — convenience for the tools-on path.
 *
 * Key invariants:
 *   - Audit row is inserted BEFORE the driver call (`status='in_progress'`)
 *     and updated to `'ok'`/`'error'` after; lifecycle drain prevents
 *     orphaned in-progress rows on graceful shutdown.
 *   - `cost_usd` is always `0` and `agent_session_id` is always `null`.
 *   - The streaming editor reuses the `lastEditedContent` no-op-edit guard
 *     and 1.5s throttle so the UX matches the Claude path.
 *   - The footer (`<i>✅ local:<backend>:<model> · Ns</i>`) is load-bearing —
 *     guarantees the final edit differs from any streaming render so Telegram
 *     doesn't 400 on a no-op.
 *
 * Cross-references:
 *   - docs/ARCHITECTURE.md#local-routing — design discussion
 *   - policy.ts::parseEnginePrefix — engine prefix detection (called from main.ts)
 *   - main.ts::makeRunTurn — dispatcher between runAgent and runLocalTurn
 *   - local-driver.ts — wire-format abstraction (Ollama NDJSON / LMStudio SSE)
 */

import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import type { SolracDb } from "./db.ts";
import type { SessionStore } from "./session.ts";
import { readInstanceMd, wrapInstanceMd } from "./instance.ts";
import type { IntegrationTier } from "./integrations.ts";
import {
  type LocalChatMessage,
  type LocalDriver,
  LocalDriverError,
} from "./local-driver.ts";
import { log } from "./log.ts";
import {
  createLoopDetector,
  truncateAuditPrompt,
  type ConfirmationBroker,
} from "./policy.ts";
import { mdToTelegramHtml } from "./markdown.ts";
import {
  mcpToLocalTools,
  runToolLoop,
  type RunToolLoopRenderer,
} from "./local-tools.ts";
import { skillToolCtx } from "./skill-tools.ts";
import { htmlEscapeText, type TelegramClient } from "./telegram.ts";

const TELEGRAM_TEXT_MAX = 3800;
const EDIT_THROTTLE_MS = 1500;
const THINKING_STUB = "💻 thinking…";

/**
 * Engine-specific capability statement appended to SOUL.md before it ships
 * as the first `system` message. The appropriate cell is picked at boot from
 * `(toolsEnabled, isDefaultEngine)`. SOUL.md ships engine-agnostic so the
 * same file serves every engine path; this builder is where engine-specific
 * facts (tools surface, escalation prefixes) get layered in.
 *
 * Matrix:
 *   tools=off, default=local    → "you are the default; for tool-driven work prefix @ or !"
 *   tools=off, default=Claude   → "you do not have tools; redirect tool requests to @ or !"
 *   tools=on,  default=local    → "you are the default; you have these tools: <list>; escalate via @ / !"
 *   tools=on,  default=Claude   → unreachable (boot validation in config.ts rejects this combo);
 *                                 falls through to the tools-on default-engine cell defensively.
 */
export interface LocalCapabilityNoteOpts {
  toolsEnabled: boolean;
  isDefaultEngine: boolean;
  toolNames: ReadonlyArray<string>;
}

export function buildLocalCapabilityNote(opts: LocalCapabilityNoteOpts): string {
  const { toolsEnabled, isDefaultEngine, toolNames } = opts;
  if (toolsEnabled) {
    const list = toolNames.join(", ");
    return (
      "You are the default chat engine; your replies cost the operator nothing. " +
      `You have these tools available: ${list}. ` +
      "Call them when the user's request needs information or actions you " +
      "can't deliver from your training alone (current data, external APIs, " +
      "operator-authored integrations). Tool results return into your " +
      "context — never tell the user 'I cannot do that' if a listed tool can. " +
      "If a request is too complex for these tools or for local reasoning, " +
      "suggest the user re-send with `@` (Sonnet) or `!` (Opus) for heavier reasoning."
    );
  }
  if (isDefaultEngine) {
    return (
      "You are the default chat engine; your replies cost the operator nothing. " +
      "You do not have tools — answer from what you know. " +
      "If the user asks for something that needs tools (file edits, API calls, " +
      "web fetches), tell them to re-send the message prefixed with `@` (Sonnet) " +
      "or `!` (Opus) to escalate to a Claude tier."
    );
  }
  return (
    "You do not have tools; answer from what you know. " +
    "If the user asks for something that needs tools (file edits, API calls, " +
    "web fetches), tell them to re-send the message prefixed with `@` (Sonnet) " +
    "or `!` (Opus)."
  );
}

/**
 * Convenience for the tools-on path. Defers to `buildLocalCapabilityNote` so
 * the matrix has a single source of truth. Exported so the skill tool-loop
 * runner in commands.ts can build the same capability note for skill bodies
 * without duplicating the matrix.
 */
export function buildToolCapabilityNote(
  toolNames: ReadonlyArray<string>,
  isDefaultEngine: boolean,
): string {
  return buildLocalCapabilityNote({ toolsEnabled: true, isDefaultEngine, toolNames });
}

export interface LocalRunDeps {
  tg: TelegramClient;
  db: SolracDb;
  // `/clear local` cutoff store. Reads `getLocalCutoff(chatId)` once per
  // turn before assembling history. Optional for back-compat with tests that
  // construct deps inline; production wiring in main.ts always provides it.
  sessions?: SessionStore;
  driver: LocalDriver;
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
  // `runLocalTurn` dispatches through `runToolLoop` so the local model can
  // call the same `mcp__solrac__*` integrations Claude tiers see.
  toolEnabled?: boolean;
  tools?: ReadonlyArray<SdkMcpToolDefinition<any>>;
  toolTiers?: ReadonlyMap<string, IntegrationTier>;
  broker?: Pick<ConfirmationBroker, "request">;
  // `LOCAL_MAX_TOOL_ITERATIONS`. Defaults to 8; only consulted when tools
  // are enabled.
  maxToolIterations?: number;
}

export interface LocalRunInput {
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

export async function runLocalTurn(
  deps: LocalRunDeps,
  input: LocalRunInput,
): Promise<void> {
  const backend = deps.driver.backend;
  const auditId = deps.db.insertAudit({
    chatId: input.chatId,
    fromId: input.fromId,
    updateId: input.updateId,
    prompt: truncateAuditPrompt(input.prompt),
    startedAt: Date.now(),
    model: `local:${backend}:${deps.model}`,
    origin: input.scheduledTaskName ? "scheduled" : "user",
    taskName: input.scheduledTaskName ?? null,
  });

  const stub = await deps.tg.sendMessage(input.chatId, THINKING_STUB).catch((err) => {
    log.warn("local.stub_send_failed", { auditId, error: (err as Error).message });
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
    return runLocalTurnWithTools(deps, input, auditId, stubId);
  }

  const capabilityNote = buildLocalCapabilityNote({
    toolsEnabled: false,
    isDefaultEngine: deps.isDefaultEngine === true,
    toolNames: [],
  });
  const messages: LocalChatMessage[] = [
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
      } else if (evt.kind === "error") {
        errorMessage = `local error: ${evt.message}`;
        isError = true;
        break;
      }
      // `tool_call` events in single-shot path: the model called a tool we
      // didn't offer. Surface to logs but don't break — the model will likely
      // also produce text we can show.
      else if (evt.kind === "tool_call") {
        log.warn("local.unexpected_tool_call_single_shot", {
          auditId,
          tool: evt.call.function.name,
        });
      }
    }
  } catch (err) {
    isError = true;
    if (err instanceof LocalDriverError) {
      errorMessage = formatDriverError(err, deps.timeoutMs);
      log.error("local.driver_failed", {
        auditId,
        backend,
        code: err.code,
        status: err.status,
        error: err.message,
      });
    } else {
      const e = err as Error;
      errorMessage = `local unexpected error: ${e.message}`;
      log.error("local.unexpected_error", {
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
    : renderFinal(assistantText, backend, deps.model, elapsedSec);

  if (stubId !== null) {
    if (finalRender.html !== lastEditedContent) {
      await tryEdit(
        deps.tg,
        input.chatId,
        stubId,
        finalRender.html,
        finalRender.markdown,
        "local.edit_final_failed",
      );
    }
  } else if (!isError && assistantText.trim()) {
    await deps.tg
      .sendMessage(input.chatId, finalRender.html, {
        parse_mode: "HTML",
        markdownSource: finalRender.markdown,
      })
      .catch((err) => log.warn("local.final_send_failed", { error: (err as Error).message }));
  }

  deps.db.updateAuditEnd({
    id: auditId,
    response: assistantText || null,
    toolCalls: null,
    inputTokens,
    outputTokens,
    // Local engine doesn't expose cache telemetry — the API is stateless per call.
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
    costUsd: 0,
    agentSessionId: null,
    status: isError ? "error" : "ok",
    errorMessage,
    endedAt: Date.now(),
  });

  log.info("local.done", {
    auditId,
    chatId: input.chatId,
    backend,
    model: deps.model,
    elapsedSec,
    inputTokens,
    outputTokens,
    isError,
  });
}

interface Rendered {
  html: string;
  markdown: string;
}

function formatDriverError(err: LocalDriverError, timeoutMs: number): string {
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

function renderStreamingStub(text: string): Rendered {
  if (!text.trim()) return { html: THINKING_STUB, markdown: THINKING_STUB };
  return {
    html: truncate(mdToTelegramHtml(text), TELEGRAM_TEXT_MAX),
    markdown: text,
  };
}

function renderFinal(
  text: string,
  backend: string,
  model: string,
  elapsedSec: number,
): Rendered {
  const hasText = text.trim().length > 0;
  const htmlBody = hasText ? mdToTelegramHtml(text) : "(empty response)";
  const mdBody = hasText ? text : "(empty response)";
  const tag = `local:${backend}:${model}`;
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
  errEvent: string = "local.edit_throttled",
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

async function runLocalTurnWithTools(
  deps: LocalRunDeps,
  input: LocalRunInput,
  auditId: number,
  stubId: number | null,
): Promise<void> {
  const tools = deps.tools ?? [];
  const toolTiers = deps.toolTiers ?? new Map<string, IntegrationTier>();
  const broker = deps.broker!;
  const maxIterations = deps.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS;
  const backend = deps.driver.backend;

  const toolNames = tools.map((t) => t.name);
  const capabilityNote = buildToolCapabilityNote(toolNames, deps.isDefaultEngine === true);
  const toolDefs = mcpToLocalTools(tools);
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  // Build initial messages — same shape as the single-shot path, only the
  // capability note differs. Inlined rather than factored to keep the diff
  // for the tools-on path scoped.
  const initialMessages: LocalChatMessage[] = [
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
        "local.edit_final_failed",
      );
    }
  } else if (!isError && result.assistantText.trim()) {
    await deps.tg
      .sendMessage(input.chatId, finalRender.html, {
        parse_mode: "HTML",
        markdownSource: finalRender.markdown,
      })
      .catch((err) =>
        log.warn("local.final_send_failed", { error: (err as Error).message }),
      );
  }

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
    costUsd: 0,
    agentSessionId: null,
    status: isError ? "error" : "ok",
    errorMessage: result.errorMessage,
    endedAt: Date.now(),
  });

  log.info("local.done", {
    auditId,
    chatId: input.chatId,
    backend,
    model: deps.model,
    elapsedSec,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
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
  const htmlParts: string[] = [];
  const mdParts: string[] = [];
  if (toolNames.length > 0) {
    const names = [...new Set(toolNames)].join(", ");
    htmlParts.push(`⚙️ <i>${htmlEscapeText(names)}</i>`);
    mdParts.push(`*⚙️ ${names}*`);
  }
  if (text.trim()) {
    htmlParts.push(mdToTelegramHtml(text));
    mdParts.push(text);
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
  backend: string,
  model: string,
  elapsedSec: number,
  toolsFired: number,
  iterationCapHit: boolean,
): Rendered {
  const hasText = text.trim().length > 0;
  const htmlBody = hasText ? mdToTelegramHtml(text) : "(empty response)";
  const mdBody = hasText ? text : "(empty response)";
  const capChip = iterationCapHit
    ? `⚠️ stopped after ${toolsFired} tool iterations · `
    : "";
  const toolsChip = toolsFired > 0 ? `${toolsFired} tools · ` : "";
  const tag = `local:${backend}:${model}`;
  const htmlFooter = `<i>✅ ${htmlEscapeText(tag)} · ${capChip}${toolsChip}${elapsedSec.toFixed(1)}s</i>`;
  const mdFooter = `*✅ ${tag} · ${capChip}${toolsChip}${elapsedSec.toFixed(1)}s*`;
  return {
    html: truncate(`${htmlBody}\n\n${htmlFooter}`, TELEGRAM_TEXT_MAX),
    markdown: `${mdBody}\n\n${mdFooter}`,
  };
}
