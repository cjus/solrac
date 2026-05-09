/**
 * @fileoverview Local-Ollama runner for `>` -prefixed Telegram messages.
 * @purpose Stream a chat completion from a locally-running Ollama instance
 *          (`/api/chat`, NDJSON stream) into the same Telegram throttled-edit
 *          UX that `agent.ts` uses for the Anthropic SDK path.
 *
 * One call to `runOllamaTurn` = one turn against the local model. The function:
 *   1. inserts the in-progress audit row tagged `model='ollama:<name>'`;
 *   2. assembles a chat-style messages array — system prompt, prior Ollama
 *      history reconstructed from the `audit` table, current user prompt;
 *   3. streams `/api/chat` with `stream: true`, parsing newline-delimited JSON;
 *   4. throttle-edits the 🦙 stub message with rendered partial text
 *      (the llama emoji distinguishes the Ollama path from agent.ts's 🤔);
 *   5. finalizes the audit row with token counts, `cost_usd = 0`,
 *      `agent_session_id = null`, `tool_calls = null`;
 *   6. on error, renders a clear failure (`❌ ollama unreachable`, etc.)
 *      and writes `status='error'` with the diagnostic in `error_message`.
 *
 * Why a sibling module (not a branch in `agent.ts`):
 *   - The Anthropic SDK runner depends on `@anthropic-ai/claude-agent-sdk`,
 *     `policy.ts` hooks, the per-chat `SessionStore`, the SDK preset prompt,
 *     the SDK env scrub. Ollama needs none of that. Forking the file would
 *     leave dead code on every branch.
 *   - Pure inference: no `canUseTool`, no `PreToolUse` hook, no
 *     `disallowedTools`. The cost cap is unaffected because Ollama writes
 *     `cost_usd = 0`; the global cap query sums every row regardless.
 *
 * Stateful history: Step 11 ships with conversation continuity within a chat,
 * across every engine boundary. `db.recentChatTurns(chatId, limit)` returns
 * the last N successful turns in chronological order regardless of which
 * engine produced them (PLAN Step 12 dropped the model filter — both Claude
 * tiers + Ollama all flow through). Each contributes a user/assistant pair
 * before the current turn. v1 caps by COUNT (`OLLAMA_HISTORY_LIMIT=6` by
 * default — three round-trips). At 256-char truncated prompts × 6 turns,
 * worst-case context is ~3k tokens, fine for any modern Ollama default.
 * Cross-engine means an Ollama follow-up to a prior Claude exchange (either
 * tier) sees the Claude response — the user's mental model is "single chat
 * thread" not "three siloed histories." See docs/ARCHITECTURE.md#ollama-routing.
 *
 * Why NOT use `<untrusted-content>` on the user's own prompt: same trust
 * model as the Claude path — allowlisted users are trusted as-is. The system
 * prompt still carries the untrusted-content clause so future attachment
 * intake (forwarded docs etc.) can wrap inbound third-party text without
 * needing a system-prompt change.
 *
 * Position in the dependency graph:
 *   db + policy + telegram + log → ollama → consumed by main
 *
 * Exports:
 *   - `runOllamaTurn(deps, input)` — runs one Ollama turn end-to-end.
 *   - `OllamaRunDeps` — runtime deps (tg, db, fetch, model, url, history limit,
 *     timeout). `fetch` is injectable for tests; production uses the global.
 *   - `OllamaRunInput` — per-turn input (chatId, fromId, updateId, prompt).
 *   - `OLLAMA_CAPABILITY_NOTE` — engine-specific clause appended to SOUL.md
 *     before it ships as the first `system` message.
 *
 * Key invariants:
 *   - Audit row is inserted BEFORE the fetch starts (`status='in_progress'`)
 *     and updated to `'ok'`/`'error'` after; lifecycle drain prevents
 *     orphaned in-progress rows on graceful shutdown.
 *   - `cost_usd` is always `0` and `agent_session_id` is always `null` —
 *     downstream cost-cap queries treat Ollama as zero-cost, sessions are
 *     session-less.
 *   - The streaming editor reuses the `lastEditedContent` no-op-edit guard
 *     and 1.5s throttle from `agent.ts` so the UX matches the Claude path.
 *   - `AbortController` honors `OLLAMA_TIMEOUT_MS`. A timed-out fetch throws
 *     an `AbortError` which the catch turns into an `❌ ollama timed out`
 *     render. The same controller is also `abort()`ed unconditionally in
 *     `finally` so the response body is released on every exit path —
 *     including the `frame.error` / `isError` early-break paths where the
 *     reader has unread bytes pending. ReadableStream consumers that break
 *     early without cancelling leak the connection until GC.
 *   - The footer (`<i>✅ ollama:<model> · Ns</i>`) is load-bearing — same
 *     reason as `agent.ts::buildFooter`. Guarantees the final edit differs
 *     from any streaming render so Telegram doesn't 400 on a no-op.
 *
 * Gotchas:
 *   - Ollama's NDJSON stream is one JSON object per line. Lines can split
 *     across chunk boundaries; the consumer accumulates a string buffer and
 *     splits on `\n`. Don't try to JSON.parse partial lines.
 *   - `prompt_eval_count` and `eval_count` are integers in the final
 *     `done: true` line; intermediate frames don't have them.
 *   - On HTTP 404 the response body is JSON like `{"error": "model 'x' not found"}`.
 *     We surface that text plus a `pull` hint.
 *   - `fetch` rejection vs. abort: a fetch that's aborted via signal throws
 *     a `DOMException`/`AbortError` named "AbortError"; an unreachable host
 *     throws a `TypeError` with `cause` set to a Bun connection error. We
 *     differentiate by error name, not message text.
 *
 * Cross-references:
 *   - docs/ARCHITECTURE.md#ollama-routing — design discussion
 *   - policy.ts::parseEnginePrefix — engine prefix detection (called from main.ts)
 *   - main.ts::makeRunTurn — dispatcher between runAgent and runOllamaTurn
 */

import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import type { SolracDb } from "./db.ts";
import { readInstanceMd, wrapInstanceMd } from "./instance.ts";
import type { IntegrationTier } from "./integrations.ts";
import { log } from "./log.ts";
import {
  createLoopDetector,
  truncateAuditPrompt,
  type ConfirmationBroker,
} from "./policy.ts";
import { mdToTelegramHtml } from "./markdown.ts";
import {
  mcpToOllamaTools,
  runToolLoop,
  type OllamaMessage as ToolOllamaMessage,
  type RunToolLoopRenderer,
} from "./ollama-tools.ts";
import { htmlEscapeText, type TelegramClient } from "./telegram.ts";

const TELEGRAM_TEXT_MAX = 3800;
const EDIT_THROTTLE_MS = 1500;
const THINKING_STUB = "🦙 thinking…";

// Engine-specific capability statement appended to SOUL.md before it ships as
// the first `system` message. Stays in code (Option B from the externalization
// design) because it's a fact about THIS engine — Ollama is tools-disabled —
// not a personality trait. SOUL.md ships engine-agnostic so the same file
// serves both the Claude and Ollama paths.
//
// The routing nudge is here because the OPERATOR may have integrations
// enabled on the Claude tiers; if a user prefixes a tool-shaped request with
// `>` they'll get a hallucination or refusal. Naming the right prefix in the
// system prompt lets the local model itself redirect without the user having
// to learn the convention from docs.
export const OLLAMA_CAPABILITY_NOTE =
  "You do not have tools; answer from what you know. If the user asks for something that needs tools (file edits, API calls, web fetches), tell them to re-send the message with `@` (default tier) or `!` (heavyweight tier) instead of `>`.";

/**
 * Build the system-prompt capability statement when the tools-on path is
 * active. The §3c matrix's full four-cell logic lands in PR-B alongside the
 * default-engine inversion; PR-A only needs the binary tools-on/tools-off
 * split: tools-off keeps the existing redirect-to-`@`/`!` note, tools-on
 * lists the available tools and tells the model when to escalate.
 */
function buildToolCapabilityNote(toolNames: ReadonlyArray<string>): string {
  const list = toolNames.join(", ");
  return (
    `You have these tools available: ${list}. ` +
    "Call them when the user's request needs information or actions you " +
    "can't deliver from your training alone (current data, external APIs, " +
    "operator-authored integrations). Tool results return into your " +
    "context — never tell the user 'I cannot do that' if a listed tool can. " +
    "If a request is too complex for these tools, suggest the user re-send " +
    "with `@` (Sonnet) or `!` (Opus) for heavier reasoning."
  );
}

export interface OllamaRunDeps {
  tg: TelegramClient;
  db: SolracDb;
  url: string; // base, no trailing slash
  model: string;
  timeoutMs: number;
  historyLimit: number;
  // PNX-167 (system-prompt externalization). `soul` is the SOUL.md text read
  // once at boot; this runner appends `OLLAMA_CAPABILITY_NOTE` and ships the
  // join as the first `system` message. `instanceMdPath` is re-read per turn
  // so live SOLRAC.md edits take effect on the next message; null/empty
  // content injects nothing.
  soul: string;
  instanceMdPath: string;
  // Injectable for tests. Production passes the global fetch.
  fetch?: typeof fetch;
  // Tools surface (PR-A). When `toolEnabled === true && tools.length > 0`,
  // `runOllamaTurn` dispatches the turn through `runToolLoop` (Phase 3) so
  // the local model can call the same `mcp__solrac__*` integrations Claude
  // tiers see. All four fields below are required together for the tools-on
  // path; absent (or `toolEnabled === false`) → existing single-shot path.
  toolEnabled?: boolean;
  tools?: ReadonlyArray<SdkMcpToolDefinition<any>>;
  toolTiers?: ReadonlyMap<string, IntegrationTier>;
  broker?: Pick<ConfirmationBroker, "request">;
  // `OLLAMA_MAX_TOOL_ITERATIONS`. Defaults to 8; only consulted when tools
  // are enabled.
  maxToolIterations?: number;
}

export interface OllamaRunInput {
  chatId: number;
  fromId: number;
  updateId: number;
  prompt: string;
}

interface OllamaMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface OllamaStreamFrame {
  message?: { role?: string; content?: string };
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

export async function runOllamaTurn(
  deps: OllamaRunDeps,
  input: OllamaRunInput,
): Promise<void> {
  const auditId = deps.db.insertAudit({
    chatId: input.chatId,
    fromId: input.fromId,
    updateId: input.updateId,
    prompt: truncateAuditPrompt(input.prompt),
    startedAt: Date.now(),
    model: `ollama:${deps.model}`,
  });

  const stub = await deps.tg.sendMessage(input.chatId, THINKING_STUB).catch((err) => {
    log.warn("ollama.stub_send_failed", { auditId, error: (err as Error).message });
    return null;
  });
  const stubId = stub && typeof stub === "object" ? stub.message_id : null;

  // Tools-on path (PR-A): dispatch through the loop driver. Requires all four
  // tools-related fields on `OllamaRunDeps`; if `tools` is empty, fall through
  // to single-shot — there is nothing for the model to call, and the loop
  // driver would just add overhead for the same outcome.
  if (
    deps.toolEnabled === true &&
    deps.tools !== undefined &&
    deps.tools.length > 0 &&
    deps.toolTiers !== undefined &&
    deps.broker !== undefined
  ) {
    return runOllamaTurnWithTools(deps, input, auditId, stubId);
  }

  const messages: OllamaMessage[] = [
    { role: "system", content: `${deps.soul}\n\n${OLLAMA_CAPABILITY_NOTE}` },
  ];
  // PNX-167 (system-prompt externalization). Re-read SOLRAC.md per turn so
  // operator edits land on the next message. When present, send it as a
  // separate `system` message — local models lack RLHF on instruction
  // hierarchy, so a distinct system turn is safer than concatenation into
  // the first one.
  const instanceMd = readInstanceMd(deps.instanceMdPath);
  if (instanceMd !== null) {
    messages.push({ role: "system", content: wrapInstanceMd(instanceMd) });
  }
  // History reconstruction: stateful chat context per chat (PLAN 11.5,
  // generalized in Step 12). Pulls every successful turn for the chat
  // regardless of engine — primary Claude, secondary Claude, prior Ollama —
  // so a user who started in either Claude tier and follows up via `>`
  // doesn't lose context. Each row's `model` field tags origin but the role
  // mapping is identical: (user, prompt) + (assistant, response).
  const history = deps.db.recentChatTurns(input.chatId, deps.historyLimit);
  for (const h of history) {
    messages.push({ role: "user", content: h.prompt });
    messages.push({ role: "assistant", content: h.response });
  }
  messages.push({ role: "user", content: input.prompt });

  const fetchImpl = deps.fetch ?? globalThis.fetch;
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
    const res = await fetchImpl(`${deps.url}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: deps.model, messages, stream: true }),
      signal: ac.signal,
    });

    if (!res.ok) {
      // 404 with body `{"error": "model '<name>' not found, try pulling it first"}`
      // is the most common operator-facing failure. Surface the model name +
      // pull hint so it's actionable from Telegram.
      const bodyText = await res.text().catch(() => "");
      let parsed: { error?: string } = {};
      try {
        parsed = JSON.parse(bodyText) as { error?: string };
      } catch {
        // not JSON — fall through with empty parsed
      }
      if (res.status === 404) {
        errorMessage = `ollama model not found: ${deps.model} — pull with \`ollama pull ${deps.model}\` on the host`;
      } else {
        const detail = parsed.error ?? (bodyText.slice(0, 200) || res.statusText);
        errorMessage = `ollama error: ${res.status} ${detail}`;
      }
      isError = true;
    } else if (!res.body) {
      errorMessage = "ollama returned no body";
      isError = true;
    } else {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      // Read NDJSON: one JSON object per line, terminated by '\n'. Lines can
      // split across read() chunks; accumulate in `buffer` and flush every
      // newline boundary. The trailing `done: true` frame carries token counts.
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          let frame: OllamaStreamFrame;
          try {
            frame = JSON.parse(line) as OllamaStreamFrame;
          } catch (parseErr) {
            log.warn("ollama.bad_frame", {
              auditId,
              error: (parseErr as Error).message,
              line: line.slice(0, 120),
            });
            continue;
          }
          if (frame.error) {
            errorMessage = `ollama error: ${frame.error}`;
            isError = true;
            break;
          }
          const chunk = frame.message?.content;
          if (chunk) assistantText += chunk;
          if (frame.done) {
            inputTokens = frame.prompt_eval_count ?? null;
            outputTokens = frame.eval_count ?? null;
          }
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
        }
        if (isError) break;
      }
    }
  } catch (err) {
    isError = true;
    const e = err as Error;
    if (e.name === "AbortError") {
      errorMessage = `ollama timed out after ${(deps.timeoutMs / 1000).toFixed(0)}s`;
    } else {
      // ECONNREFUSED / DNS / TLS surface as TypeError("fetch failed") in Bun
      // and Node's undici. The cause carries the actual code; either way the
      // operator wants to know "the URL didn't connect".
      errorMessage = `ollama unreachable: ${deps.url}`;
    }
    log.error("ollama.fetch_failed", {
      auditId,
      url: deps.url,
      error: e.message,
      name: e.name,
    });
  } finally {
    clearTimeout(timer);
    // Cancel the underlying response stream on every exit path. ReadableStream
    // consumers that break early (frame.error / isError) leave the connection
    // held open — the GC eventually cleans it up but "eventually" can be tens
    // of seconds, long enough to exhaust connection budgets behind a remote
    // load balancer. ac.abort() is idempotent and a no-op on a fully-consumed
    // stream, so it's safe to fire unconditionally.
    ac.abort();
  }

  const elapsedSec = (Date.now() - startedAt) / 1000;
  const finalRender: Rendered = isError
    ? renderError(errorMessage ?? "unknown")
    : renderFinal(assistantText, deps.model, elapsedSec);

  if (stubId !== null) {
    if (finalRender.html !== lastEditedContent) {
      await tryEdit(
        deps.tg,
        input.chatId,
        stubId,
        finalRender.html,
        finalRender.markdown,
        "ollama.edit_final_failed",
      );
    }
  } else if (!isError && assistantText.trim()) {
    await deps.tg
      .sendMessage(input.chatId, finalRender.html, {
        parse_mode: "HTML",
        markdownSource: finalRender.markdown,
      })
      .catch((err) => log.warn("ollama.final_send_failed", { error: (err as Error).message }));
  }

  deps.db.updateAuditEnd({
    id: auditId,
    response: assistantText || null,
    toolCalls: null,
    inputTokens,
    outputTokens,
    // Ollama doesn't expose cache telemetry — its API is stateless per call.
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
    costUsd: 0,
    agentSessionId: null,
    status: isError ? "error" : "ok",
    errorMessage,
    endedAt: Date.now(),
  });

  log.info("ollama.done", {
    auditId,
    chatId: input.chatId,
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

function renderStreamingStub(text: string): Rendered {
  if (!text.trim()) return { html: THINKING_STUB, markdown: THINKING_STUB };
  return {
    html: truncate(mdToTelegramHtml(text), TELEGRAM_TEXT_MAX),
    markdown: text,
  };
}

function renderFinal(text: string, model: string, elapsedSec: number): Rendered {
  const hasText = text.trim().length > 0;
  const htmlBody = hasText ? mdToTelegramHtml(text) : "(empty response)";
  const mdBody = hasText ? text : "(empty response)";
  const htmlFooter = `<i>✅ ollama:${htmlEscapeText(model)} · ${elapsedSec.toFixed(1)}s</i>`;
  const mdFooter = `*✅ ollama:${model} · ${elapsedSec.toFixed(1)}s*`;
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
  errEvent: string = "ollama.edit_throttled",
): Promise<void> {
  await tg
    .editMessageText(chatId, messageId, text, { parse_mode: "HTML", markdownSource })
    .catch((err) => log.debug(errEvent, { error: (err as Error).message }));
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

// ---------------------------------------------------------------------------
// Tools-on path (PR-A) — dispatches through `runToolLoop`
// ---------------------------------------------------------------------------

const DEFAULT_MAX_TOOL_ITERATIONS = 8;

async function runOllamaTurnWithTools(
  deps: OllamaRunDeps,
  input: OllamaRunInput,
  auditId: number,
  stubId: number | null,
): Promise<void> {
  const tools = deps.tools ?? [];
  const toolTiers = deps.toolTiers ?? new Map<string, IntegrationTier>();
  const broker = deps.broker!;
  const maxIterations =
    deps.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS;

  const toolNames = tools.map((t) => t.name);
  const capabilityNote = buildToolCapabilityNote(toolNames);
  const toolDefs = mcpToOllamaTools(tools);
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  // Build initial messages — same shape as the single-shot path, only the
  // capability note differs. Inlined rather than factored to keep the
  // single-shot path's diff for PR-A at zero.
  const initialMessages: ToolOllamaMessage[] = [
    { role: "system", content: `${deps.soul}\n\n${capabilityNote}` },
  ];
  const instanceMd = readInstanceMd(deps.instanceMdPath);
  if (instanceMd !== null) {
    initialMessages.push({ role: "system", content: wrapInstanceMd(instanceMd) });
  }
  const history = deps.db.recentChatTurns(input.chatId, deps.historyLimit);
  for (const h of history) {
    initialMessages.push({ role: "user", content: h.prompt });
    initialMessages.push({ role: "assistant", content: h.response });
  }
  initialMessages.push({ role: "user", content: input.prompt });

  // Single shared `AbortController` covers every fetch this turn.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), deps.timeoutMs);
  const startedAt = Date.now();

  // Throttle-edit renderer for the live UX. Errors caught upstream by
  // `runToolLoop`; we still wrap `editMessageText` defensively so a
  // transient Telegram failure doesn't pollute the loop's progress events.
  let lastEditedKey = "";
  const renderer: RunToolLoopRenderer = {
    async onProgress(text, toolNames) {
      if (stubId === null) return;
      const next = renderToolLoopStub(text, toolNames);
      if (next.key === lastEditedKey) return;
      lastEditedKey = next.key;
      await tryEdit(
        deps.tg,
        input.chatId,
        stubId,
        next.html,
        next.markdown,
      );
    },
  };

  // Per-turn loop detector — same shape used by the SDK path
  // (`createLoopDetector` is shared between Claude and Ollama).
  const loopDetector = createLoopDetector();

  let result;
  try {
    result = await runToolLoop(
      {
        fetch: deps.fetch,
        url: deps.url,
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
    );
  } finally {
    clearTimeout(timer);
    // Idempotent — releases any held connection if the loop exited early.
    ac.abort();
  }

  const elapsedSec = (Date.now() - startedAt) / 1000;
  const isError = result.errorMessage !== null && !result.iterationCapHit;
  const finalRender: Rendered = isError
    ? renderError(result.errorMessage ?? "unknown")
    : renderToolLoopFinal(
        result.assistantText,
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
        "ollama.edit_final_failed",
      );
    }
  } else if (!isError && result.assistantText.trim()) {
    await deps.tg
      .sendMessage(input.chatId, finalRender.html, {
        parse_mode: "HTML",
        markdownSource: finalRender.markdown,
      })
      .catch((err) =>
        log.warn("ollama.final_send_failed", {
          error: (err as Error).message,
        }),
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

  log.info("ollama.done", {
    auditId,
    chatId: input.chatId,
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
// `renderStreamingStub` / `renderFinal` but include the `⚙️ <names>` chip
// and the `K tools` footer segment. Inlined here (rather than factored into
// a shared helper) because the single-shot variants are ~5 lines each — a
// shared helper would cost more in conditional branches than it saves.

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
  const htmlFooter = `<i>✅ ollama:${htmlEscapeText(model)} · ${capChip}${toolsChip}${elapsedSec.toFixed(1)}s</i>`;
  const mdFooter = `*✅ ollama:${model} · ${capChip}${toolsChip}${elapsedSec.toFixed(1)}s*`;
  return {
    html: truncate(`${htmlBody}\n\n${htmlFooter}`, TELEGRAM_TEXT_MAX),
    markdown: `${mdBody}\n\n${mdFooter}`,
  };
}
