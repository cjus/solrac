/**
 * @fileoverview Engine-slot tool-calling support — schema converter,
 *               per-call executor, and multi-round loop driver.
 * @purpose Bridge solrac integrations (`SdkMcpToolDefinition`, designed for
 *          the Anthropic-hosted Claude Agent SDK) into the OpenAI-compatible
 *          tool format every non-Anthropic backend accepts — local (Ollama,
 *          LMStudio) and remote (OpenRouter) alike — and run a single tool
 *          call through the same safety layers (loop detector, classifier,
 *          broker) the SDK path uses on Claude tiers. One source of truth
 *          for the tool surface — the same operator-authored integrations
 *          reach Claude tiers AND every engine-slot backend.
 *
 * Why a converter at all:
 *   `SdkMcpToolDefinition.inputSchema` is a raw `ZodRawShape` (object of zod
 *   field defs), NOT a wrapped `z.object(...)`. The SDK applies the wrap
 *   internally; for the engine-slot path we wrap before producing JSON Schema.
 *
 * Why `z.toJSONSchema` and not a hand-rolled walker:
 *   Verified empirically that zod 4.4.3's output is already OpenAI-compatible
 *   — `additionalProperties:false`, correct `required` array, preserved
 *   `description` annotations. The only post-processing needed is stripping
 *   the top-level `$schema` JSON-Schema-version marker (some strict models
 *   reject unrecognized fields). Pin or vendor zod if churn becomes an issue.
 *
 * Why a separate executor for the engine-slot path (vs reusing the SDK's path):
 *   The Anthropic SDK drives the tool-call loop internally — every classified
 *   `mcp__solrac__*` call lands at the integration's handler without solrac
 *   needing to invoke it. Engine-slot backends return one assistant message;
 *   if it contains `tool_calls`, WE execute them and feed results back. So
 *   we re-implement the per-call gate path (loop → classify → broker → invoke)
 *   that `agent.ts` gets for free from the SDK. The same `policy.ts` building
 *   blocks are reused — no policy duplication, just a different driver.
 *
 * Order of checks (mirrors `createPreToolUseHook` + `createPolicyHook`):
 *   1. loop detector — runs first so a runaway model is cut off before any
 *      classifier work or broker dispatch, including for fabricated names.
 *   2. tool-exists check — fail fast on a hallucinated name.
 *   3. classifier — `auto` allows, `deny` denies, `confirm` proceeds.
 *   4. broker — Telegram inline-keyboard, 60s timeout, fail-closed.
 *   5. zod parse — validate model-emitted args before invoking.
 *   6. handler invoke — the integration's own code.
 *
 * Cost cap is intentionally NOT checked here. Anthropic per-chat + global
 * caps gate Anthropic burn only. The loop detector and the iteration cap
 * are the runaway-loop defenses.
 *
 * Position in the dependency graph:
 *   integrations + policy + telegram + log + zod + engine-driver
 *     → engine-tools → engine
 *
 * Cross-references:
 *   - src/integrations.ts — the producer side
 *   - src/policy.ts — `classifyToolWithIntegrations`, `LoopDetector`,
 *     `ConfirmationBroker` (all reused as-is)
 *   - src/engine-driver.ts — shared backend abstraction this loop consumes
 */

import { z } from "zod";
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import {
  type EngineChatMessage,
  type EngineDriver,
  EngineDriverError,
  type EngineToolCallRef,
  type EngineToolDef,
} from "./engine-driver.ts";
import {
  classifyToolWithIntegrations,
  type ConfirmationBroker,
  type ConfirmHandle,
  type LoopDetector,
} from "./policy.ts";
import type { IntegrationTier } from "./integrations.ts";
import { log } from "./log.ts";

/**
 * Re-export the wire-shape tool def under the engine-tools-flavored name so
 * downstream callers can import everything tool-related from one module.
 */
export type { EngineToolDef } from "./engine-driver.ts";

/**
 * Convert solrac integration tools to the wire-shape every engine-slot
 * backend uses.
 *
 * Names pass through unchanged — integrations register short names like
 * `time_now`; the `mcp__solrac__` prefix is added at the SDK boundary in
 * `agent.ts` and is NOT used over the engine-slot wire (every backend uses
 * a flat tool registry).
 *
 * The `<any>` schema generic mirrors the SDK's own `tools?: Array<…<any>>`
 * field (`sdk.d.ts:426`) — heterogeneous tool arrays can't share a single
 * concrete schema type.
 */
export function mcpToEngineTools(
  tools: ReadonlyArray<SdkMcpToolDefinition<any>>,
): EngineToolDef[] {
  return tools.map((t) => {
    const objectSchema = z.object(t.inputSchema as z.ZodRawShape);
    const parameters = z.toJSONSchema(objectSchema) as Record<string, unknown>;
    delete parameters.$schema;
    return {
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Single tool-call executor
// ---------------------------------------------------------------------------

// Mirrors the SDK's MCP namespace (`policy.ts::SOLRAC_MCP_PREFIX`). Not
// imported because it's not exported; duplicating the literal is a one-line
// cost vs. widening policy.ts's surface for a private convention.
const SOLRAC_MCP_PREFIX = "mcp__solrac__";

/**
 * Cap on the string length of the tool result fed back to the model as
 * `role:"tool"` content. 16 KB ≈ 4k tokens.
 */
export const TOOL_RESULT_MAX_LEN = 16384;

/**
 * One tool call as parsed from a local backend's response. `arguments` is
 * `unknown` because some models emit a JSON-stringified object instead of
 * a real object; the executor coerces.
 */
export interface LocalToolCall {
  readonly name: string;
  readonly arguments: unknown;
  /**
   * Backend-supplied call id (LMStudio sets it; Ollama emits no ids).
   * When set, the tool-result message uses `tool_call_id` to associate;
   * when unset, the consumer falls back to `tool_name` (Ollama).
   */
  readonly id?: string;
}

export type ToolCallDisposition =
  | "ok"
  | "denied_loop"
  | "denied_policy"
  | "denied_user"
  | "denied_timeout"
  | "denied_send_failed"
  | "error_unknown_tool"
  | "error_invalid_args"
  | "error_handler_threw";

export interface ToolCallResult {
  readonly content: string;
  readonly disposition: ToolCallDisposition;
  readonly reason?: string;
  readonly truncated?: boolean;
}

export interface ExecuteToolCallDeps {
  readonly chatId: number;
  readonly auditId: number;
  readonly tools: ReadonlyMap<string, SdkMcpToolDefinition<any>>;
  readonly toolTiers: ReadonlyMap<string, IntegrationTier>;
  readonly broker: Pick<ConfirmationBroker, "request">;
  readonly loopDetector: LoopDetector;
  /**
   * `ENGINE_DENY_TOOLS` belt-and-suspenders set. Names in this set bypass the
   * classifier and broker; any call whose name appears here is denied
   * immediately with `denied_policy`. Mirrors `disallowedTools: ["Agent","Task"]`
   * for the SDK path.
   */
  readonly deniedTools?: ReadonlySet<string>;
  /**
   * Single-confirm-per-round cap. When set, the executor decrements
   * `confirmsRemaining` on each `confirm`-tier classification; once it hits
   * 0, subsequent confirm-tier calls in the same round are denied with
   * `"only one confirmable tool per round"`. Owned (created/reset) by the
   * loop driver — one fresh instance per round.
   */
  readonly roundState?: { confirmsRemaining: number };
  /**
   * When true, `confirm`-tier classifications fall through to invocation
   * without dispatching the broker. Set per-skill via SKILL.md `auto_allow:
   * true`. Loop detector and `deny`-tier still gate as normal.
   */
  readonly autoAllow?: boolean;
}

/**
 * Run one tool call through the safety layers and return the string the
 * model should see as the tool result. Never throws.
 */
export async function executeToolCall(
  deps: ExecuteToolCallDeps,
  call: LocalToolCall,
): Promise<ToolCallResult> {
  const shortName = call.name;
  const fullName = SOLRAC_MCP_PREFIX + shortName;
  const args = normalizeToolArgs(call.arguments);

  let confirmHandle: ConfirmHandle | null = null;

  if (deps.loopDetector.check(fullName, args) === "loop") {
    const reason = `loop_detected: ${shortName} called ${deps.loopDetector.threshold}× with same input`;
    log.warn("engine.tool_loop_detected", {
      auditId: deps.auditId,
      chatId: deps.chatId,
      tool: shortName,
      threshold: deps.loopDetector.threshold,
    });
    return { content: `denied: ${reason}`, disposition: "denied_loop", reason };
  }

  const tool = deps.tools.get(shortName);
  if (!tool) {
    const reason = `unknown tool: ${shortName}`;
    log.warn("engine.tool_unknown", {
      auditId: deps.auditId,
      chatId: deps.chatId,
      tool: shortName,
    });
    return {
      content: `error: ${reason}`,
      disposition: "error_unknown_tool",
      reason,
    };
  }

  if (deps.deniedTools?.has(shortName)) {
    const reason = `tool ${shortName} is in ENGINE_DENY_TOOLS`;
    log.warn("engine.tool_denied_hard", {
      auditId: deps.auditId,
      chatId: deps.chatId,
      tool: shortName,
    });
    return { content: `denied: ${reason}`, disposition: "denied_policy", reason };
  }

  const decision = classifyToolWithIntegrations(fullName, args, deps.toolTiers);
  if (decision.kind === "deny") {
    log.warn("engine.tool_denied_policy", {
      auditId: deps.auditId,
      chatId: deps.chatId,
      tool: shortName,
      reason: decision.message,
    });
    return {
      content: `denied: ${decision.message}`,
      disposition: "denied_policy",
      reason: decision.message,
    };
  }

  if (decision.kind === "confirm" && deps.autoAllow) {
    log.info("engine.tool_auto_allow", {
      auditId: deps.auditId,
      chatId: deps.chatId,
      tool: shortName,
    });
  } else if (decision.kind === "confirm") {
    if (deps.roundState && deps.roundState.confirmsRemaining <= 0) {
      const reason = "only one confirmable tool per round; retry one at a time";
      log.warn("engine.tool_confirm_round_cap", {
        auditId: deps.auditId,
        chatId: deps.chatId,
        tool: shortName,
      });
      return { content: `denied: ${reason}`, disposition: "denied_policy", reason };
    }
    if (deps.roundState) deps.roundState.confirmsRemaining -= 1;
    log.info("engine.tool_confirm_request", {
      auditId: deps.auditId,
      chatId: deps.chatId,
      tool: shortName,
    });
    let handle: ConfirmHandle;
    try {
      handle = await deps.broker.request({
        chatId: deps.chatId,
        toolName: fullName,
        toolInput: args,
      });
    } catch (err) {
      const msg = (err as Error).message;
      log.warn("engine.tool_confirm_send_failed", {
        auditId: deps.auditId,
        chatId: deps.chatId,
        tool: shortName,
        error: msg,
      });
      return {
        content: `denied: confirmation send failed: ${msg}`,
        disposition: "denied_send_failed",
        reason: msg,
      };
    }
    log.info("engine.tool_confirm_resolved", {
      auditId: deps.auditId,
      chatId: deps.chatId,
      tool: shortName,
      verdict: handle.decision,
    });
    if (handle.decision === "deny") {
      return {
        content: "denied: user declined the confirmation",
        disposition: "denied_user",
        reason: "user declined",
      };
    }
    if (handle.decision === "timeout") {
      return {
        content: "denied: confirmation timed out",
        disposition: "denied_timeout",
        reason: "broker timeout",
      };
    }
    confirmHandle = handle;
  }

  const parsed = z.object(tool.inputSchema as z.ZodRawShape).safeParse(args);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    log.warn("engine.tool_invalid_args", {
      auditId: deps.auditId,
      chatId: deps.chatId,
      tool: shortName,
      issues,
    });
    await confirmHandle?.finalize({ ok: false, message: `invalid args: ${issues}` });
    return {
      content: `error: invalid arguments — ${issues}`,
      disposition: "error_invalid_args",
      reason: issues,
    };
  }

  let result;
  try {
    result = await tool.handler(parsed.data, {});
  } catch (err) {
    const msg = (err as Error).message;
    log.warn("engine.tool_handler_threw", {
      auditId: deps.auditId,
      chatId: deps.chatId,
      tool: shortName,
      error: msg,
    });
    await confirmHandle?.finalize({ ok: false, message: msg });
    return {
      content: `error: handler threw — ${msg}`,
      disposition: "error_handler_threw",
      reason: msg,
    };
  }

  const { content, truncated } = coalesceResultContent(result);
  log.debug("engine.tool_call_ok", {
    auditId: deps.auditId,
    chatId: deps.chatId,
    tool: shortName,
    contentLen: content.length,
    truncated,
  });
  const outcome = inferConfirmOutcome(result, content);
  await confirmHandle?.finalize(outcome);
  return { content, disposition: "ok", truncated };
}

const OUTCOME_HINT_KEYS = [
  "modified",
  "trashed",
  "archived",
  "deleted",
  "labelsApplied",
  "labelsRemoved",
  "messageId",
  "count",
];

function inferConfirmOutcome(
  result: unknown,
  textContent: string,
): { ok: boolean; message?: string } {
  if (result && typeof result === "object") {
    const r = result as { content?: unknown };
    if (Array.isArray(r.content) && r.content.length > 0) {
      const first = r.content[0] as Record<string, unknown> | undefined;
      if (first && typeof first === "object" && typeof first.text === "string") {
        try {
          const parsed = JSON.parse(first.text);
          if (parsed && typeof parsed === "object") {
            const obj = parsed as Record<string, unknown>;
            if (obj.success === false) {
              const msg = typeof obj.error === "string" ? obj.error : undefined;
              return { ok: false, message: msg };
            }
            for (const k of OUTCOME_HINT_KEYS) {
              if (k in obj) {
                return { ok: true, message: `${k}: ${String(obj[k])}` };
              }
            }
            return { ok: true };
          }
        } catch {
          // Not JSON — fall through to plain-text preview.
        }
      }
    }
  }
  const trimmed = textContent.trim();
  if (trimmed === "" || trimmed.length > 120) return { ok: true };
  return { ok: true, message: trimmed };
}

// Some local models emit `arguments` as a JSON-encoded string instead of an
// object. Coerce when possible; on parse failure, pass the original through
// so the zod step produces a useful error.
function normalizeToolArgs(raw: unknown): unknown {
  if (raw === null || raw === undefined) return {};
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed === "") return {};
    try {
      return JSON.parse(trimmed);
    } catch {
      return raw;
    }
  }
  return raw;
}

interface CoalescedContent {
  readonly content: string;
  readonly truncated: boolean;
}

function coalesceResultContent(result: unknown): CoalescedContent {
  if (!result || typeof result !== "object") {
    return finalize(safeJson(result));
  }
  const r = result as { content?: unknown };
  if (!Array.isArray(r.content) || r.content.length === 0) {
    return finalize(safeJson(result));
  }
  const parts: string[] = [];
  for (const block of r.content) {
    if (block && typeof block === "object") {
      const b = block as { type?: unknown; text?: unknown };
      if (b.type === "text" && typeof b.text === "string") {
        parts.push(b.text);
        continue;
      }
    }
    parts.push(safeJson(block));
  }
  return finalize(parts.join("\n"));
}

function finalize(s: string): CoalescedContent {
  if (s.length <= TOOL_RESULT_MAX_LEN) {
    return { content: s, truncated: false };
  }
  const marker = ` …[truncated: ${TOOL_RESULT_MAX_LEN}/${s.length} bytes shown]`;
  return {
    content: s.slice(0, TOOL_RESULT_MAX_LEN - marker.length) + marker,
    truncated: true,
  };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

// ---------------------------------------------------------------------------
// Thought-fence stripping (gemma4)
// ---------------------------------------------------------------------------

const THINK_FENCES: ReadonlyArray<RegExp> = [
  /<think\b[^>]*>[\s\S]*?<\/think>/gi,
  /<\|think\|>[\s\S]*?<\/\|think\|>/gi,
  /<\|think\|>[\s\S]*?<\|\/think\|>/gi,
];

export function stripThoughts(text: string): string {
  if (text === "") return "";
  let out = text;
  for (const re of THINK_FENCES) {
    out = out.replace(re, "");
  }
  return out;
}

// ---------------------------------------------------------------------------
// Multi-round tool loop driver
// ---------------------------------------------------------------------------

const EDIT_THROTTLE_MS = 1500;

/**
 * Belt-and-suspenders deny set, mirroring `agent.ts`'s
 * `disallowedTools: ["Agent","Task"]`. Any tool name in this set is rejected
 * before the executor is called.
 */
export const ENGINE_DENY_TOOLS: ReadonlySet<string> = Object.freeze(new Set<string>());

export interface ToolLoopResult {
  readonly assistantText: string;
  readonly toolCallSummaries: ReadonlyArray<{ name: string; input: unknown }>;
  /** `inputTokens` from round 0 only (true input — avoids N×-overcount across rounds). */
  readonly inputTokens: number | null;
  /** Sum of `outputTokens` across all rounds (true total generated). */
  readonly outputTokens: number | null;
  /**
   * Sum of `costUsd` across every round (including cap-finalize). `null` only
   * if NO round reported a cost — for local backends this is always null;
   * for the openrouter backend a null here is the `remote.cost_missing` signal.
   * Per-round sums (vs round-0-only) match how the tool-loop actually bills
   * on a remote backend: each round is a separate API call with its own cost.
   */
  readonly costUsd: number | null;
  readonly rounds: number;
  readonly toolsFired: number;
  readonly iterationCapHit: boolean;
  /** Non-null on any failure path. */
  readonly errorMessage: string | null;
  /** `signal.aborted` was observed — distinct from a clean error. */
  readonly aborted: boolean;
}

/**
 * Throttled stream-edit hook. Called at most once per `EDIT_THROTTLE_MS`
 * (1500ms) with current accumulated text + active tool-call names. The driver
 * de-dupes — won't re-invoke with identical content. Errors are caught and
 * logged; they do NOT abort the round.
 */
export interface RunToolLoopRenderer {
  onProgress(
    text: string,
    toolNames: ReadonlyArray<string>,
  ): void | Promise<void>;
}

export interface RunToolLoopDeps {
  readonly driver: EngineDriver;
  readonly model: string;
  /**
   * Single shared `AbortSignal` for every fetch this turn — model rounds AND
   * the cap-finalize round. Caller owns the controller; one `signal.abort()`
   * cleanly terminates the whole loop.
   */
  readonly signal: AbortSignal;
  readonly tools: ReadonlyMap<string, SdkMcpToolDefinition<any>>;
  readonly toolTiers: ReadonlyMap<string, IntegrationTier>;
  readonly toolDefs: ReadonlyArray<EngineToolDef>;
  readonly broker: Pick<ConfirmationBroker, "request">;
  readonly loopDetector: LoopDetector;
  readonly maxIterations: number;
  readonly auditId: number;
  readonly chatId: number;
  readonly denyTools?: ReadonlySet<string>;
  readonly renderer?: RunToolLoopRenderer;
  readonly autoAllow?: boolean;
}

export interface RunToolLoopInput {
  readonly initialMessages: ReadonlyArray<EngineChatMessage>;
}

/**
 * Drive the multi-round tool-call loop.
 *
 * For each round (up to `maxIterations`):
 *   1. Stream a completion via `driver.streamChat`.
 *   2. Accumulate text + `tool_calls` from the event stream.
 *   3. Throttle-call `renderer.onProgress` mid-stream.
 *   4. If no tool calls — break (final answer).
 *   5. Otherwise append `assistant` (thoughts stripped) + `tool_calls` to
 *      messages, execute each call sequentially via `executeToolCall`,
 *      append a `tool` message with the result. Single-confirm-per-round
 *      cap denies the 2nd+ confirmable call with a retry hint.
 *
 * On cap-hit: append a system "finalize" nudge and one more streaming round
 * (consumed fully into text) to extract a closing message.
 *
 * Always resolves — `signal.abort()` produces a `ToolLoopResult` with
 * `aborted:true`.
 */
export async function runToolLoop(
  deps: RunToolLoopDeps,
  input: RunToolLoopInput,
): Promise<ToolLoopResult> {
  const denyTools = deps.denyTools ?? ENGINE_DENY_TOOLS;
  const messages: EngineChatMessage[] = input.initialMessages.map((m) => ({ ...m }));

  let inputTokens: number | null = null;
  let outputTokens = 0;
  let outputTokensSeen = false;
  // Remote-backend cost accumulator. Each round writes its own usage chunk
  // with its own per-round cost; the tool-loop is a series of independent API
  // calls so the summed cost is the real billed total. `costUsdSeen` tracks
  // whether ANY round reported a cost — a tool-loop where every round skips
  // the field must return `costUsd: null` (not 0) so `resolveAuditCost` in
  // `engine.ts` writes null + emits `remote.cost_missing`.
  let costUsd = 0;
  let costUsdSeen = false;
  const toolCallSummaries: Array<{ name: string; input: unknown }> = [];
  let assistantText = "";
  let errorMessage: string | null = null;
  let iterationCapHit = false;
  let toolsFired = 0;
  let lastEditAt = 0;
  let lastEditedKey = "";
  let round = 0;

  log.info("engine.tool_loop_start", {
    auditId: deps.auditId,
    chatId: deps.chatId,
    backend: deps.driver.backend,
    model: deps.model,
    tools: deps.toolDefs.length,
    maxIterations: deps.maxIterations,
  });

  const isAborted = (): boolean => deps.signal.aborted;

  // -----------------------------------------------------------------------
  // Inner: one streaming round.
  // -----------------------------------------------------------------------
  async function runStreamingRound(): Promise<{
    text: string;
    toolCalls: LocalToolCall[];
    inputTokens: number | null;
    outputTokens: number | null;
    costUsd: number | null;
    error: string | null;
  }> {
    const result = {
      text: "",
      toolCalls: [] as LocalToolCall[],
      inputTokens: null as number | null,
      outputTokens: null as number | null,
      costUsd: null as number | null,
      error: null as string | null,
    };

    try {
      for await (const evt of deps.driver.streamChat({
        model: deps.model,
        messages,
        tools: deps.toolDefs,
        signal: deps.signal,
      })) {
        if (evt.kind === "text") {
          result.text += evt.delta;
          // Throttled progress render.
          if (deps.renderer) {
            const now = Date.now();
            if (now - lastEditAt >= EDIT_THROTTLE_MS) {
              const toolNames = result.toolCalls.map((c) => c.name);
              const key = `${result.text}${toolNames.join(",")}`;
              if (key !== lastEditedKey) {
                lastEditAt = now;
                lastEditedKey = key;
                try {
                  await deps.renderer.onProgress(result.text, toolNames);
                } catch (renderErr) {
                  log.debug("engine.progress_failed", {
                    auditId: deps.auditId,
                    error: (renderErr as Error).message,
                  });
                }
              }
            }
          }
        } else if (evt.kind === "tool_call") {
          result.toolCalls.push({
            name: evt.call.function.name,
            arguments: evt.call.function.arguments ?? {},
            id: evt.call.id,
          });
        } else if (evt.kind === "done") {
          result.inputTokens = evt.inputTokens;
          result.outputTokens = evt.outputTokens;
          result.costUsd = evt.costUsd;
        } else if (evt.kind === "error") {
          result.error = `local error: ${evt.message}`;
          break;
        }
      }
    } catch (err) {
      if (err instanceof EngineDriverError) {
        result.error = formatDriverErrorForLoop(err);
      } else {
        const e = err as Error;
        if (e.name !== "AbortError") {
          result.error = `local unexpected error: ${e.message}`;
        }
      }
    }
    return result;
  }

  try {
    while (round < deps.maxIterations) {
      round++;
      const r = await runStreamingRound();

      // Capture text + token counts FIRST so partial-stream output and tokens
      // generated before an error event are still surfaced.
      if (round === 1) inputTokens = r.inputTokens;
      if (r.outputTokens !== null) {
        outputTokens += r.outputTokens;
        outputTokensSeen = true;
      }
      if (r.costUsd !== null) {
        costUsd += r.costUsd;
        costUsdSeen = true;
      }
      assistantText = r.text;

      if (r.error !== null) {
        errorMessage = r.error;
        break;
      }

      if (r.toolCalls.length === 0) {
        // No tools requested — final answer.
        break;
      }

      // Append assistant turn with thoughts stripped (gemma4 model card
      // requirement) plus its tool_calls so the model can pair on next round.
      messages.push({
        role: "assistant",
        content: stripThoughts(r.text),
        tool_calls: r.toolCalls.map((tc) => ({
          id: tc.id,
          function: { name: tc.name, arguments: tc.arguments ?? {} },
        })),
      });

      // Execute tools sequentially — one confirm per round.
      let confirmsUsedThisRound = 0;
      for (const call of r.toolCalls) {
        toolCallSummaries.push({ name: call.name, input: call.arguments });
        toolsFired++;

        if (denyTools.has(call.name)) {
          const denyMsg = `denied: ${call.name} is hard-disabled in this build`;
          log.warn("engine.tool_hard_denied", {
            auditId: deps.auditId,
            chatId: deps.chatId,
            tool: call.name,
          });
          messages.push({
            role: "tool",
            tool_name: call.name,
            tool_call_id: call.id,
            content: denyMsg,
          });
          continue;
        }

        // Single-confirm-per-round: pre-classify confirm-tier; deny 2nd+.
        // `autoAllow` skills bypass the broker, so the cap (which exists to
        // avoid stacking 60s prompts) doesn't apply to them.
        const tier = deps.toolTiers.get(call.name) ?? "confirm";
        const wouldConfirm = tier !== "auto" && !deps.autoAllow;
        if (wouldConfirm && confirmsUsedThisRound > 0) {
          const msg = "denied: only one confirmable tool per round; retry separately";
          log.info("engine.tool_confirm_skipped_round_cap", {
            auditId: deps.auditId,
            chatId: deps.chatId,
            tool: call.name,
          });
          messages.push({
            role: "tool",
            tool_name: call.name,
            tool_call_id: call.id,
            content: msg,
          });
          continue;
        }

        const exec = await executeToolCall(
          {
            chatId: deps.chatId,
            auditId: deps.auditId,
            tools: deps.tools,
            toolTiers: deps.toolTiers,
            broker: deps.broker,
            loopDetector: deps.loopDetector,
            autoAllow: deps.autoAllow,
          },
          call,
        );

        // The confirm budget is consumed whether the broker allowed or denied —
        // what matters is that the operator was already prompted.
        if (
          wouldConfirm &&
          (exec.disposition === "ok" ||
            exec.disposition === "denied_user" ||
            exec.disposition === "denied_timeout" ||
            exec.disposition === "denied_send_failed")
        ) {
          confirmsUsedThisRound++;
        }

        messages.push({
          role: "tool",
          tool_name: call.name,
          tool_call_id: call.id,
          content: exec.content,
        });
      }
    }

    // Iteration cap — coax a closing message rather than show a half-finished
    // tool stream as the final UX state.
    if (round >= deps.maxIterations && errorMessage === null && !isAborted()) {
      iterationCapHit = true;
      log.warn("engine.tool_iteration_cap", {
        auditId: deps.auditId,
        chatId: deps.chatId,
        cap: deps.maxIterations,
        toolsFired,
      });
      messages.push({
        role: "system",
        content:
          "Tool iteration cap reached. Finalize an answer now without calling any more tools.",
      });
      // Stream one final round and collect the full text. No tools attached —
      // the system nudge plus the absence of `tools[]` keeps the model from
      // trying again.
      const finalRound = await collectFinalText({
        driver: deps.driver,
        model: deps.model,
        messages,
        signal: deps.signal,
      });
      if (finalRound.text.length > 0) {
        assistantText = finalRound.text;
      }
      if (finalRound.outputTokens !== null) {
        outputTokens += finalRound.outputTokens;
        outputTokensSeen = true;
      }
      if (finalRound.costUsd !== null) {
        costUsd += finalRound.costUsd;
        costUsdSeen = true;
      }
    }
  } catch (err) {
    const e = err as Error;
    if (e.name === "AbortError" || isAborted()) {
      // Caller aborted (timeout / shutdown). Distinct from a fetch failure.
    } else {
      errorMessage = `local unexpected error: ${e.message}`;
      log.error("engine.tool_loop_failed", {
        auditId: deps.auditId,
        backend: deps.driver.backend,
        error: e.message,
        name: e.name,
      });
    }
  }

  const aborted = isAborted();
  const result: ToolLoopResult = {
    assistantText,
    toolCallSummaries,
    inputTokens,
    outputTokens: outputTokensSeen ? outputTokens : null,
    costUsd: costUsdSeen ? costUsd : null,
    rounds: round + (iterationCapHit ? 1 : 0),
    toolsFired,
    iterationCapHit,
    errorMessage:
      errorMessage ??
      (aborted ? "aborted" : iterationCapHit ? "iteration_cap" : null),
    aborted,
  };

  log.info("engine.tool_loop_done", {
    auditId: deps.auditId,
    chatId: deps.chatId,
    backend: deps.driver.backend,
    model: deps.model,
    rounds: result.rounds,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    costUsd: result.costUsd,
    toolsFired,
    iterationCapHit,
    aborted,
    errorMessage: result.errorMessage,
  });

  return result;
}

// Format a driver error into a loop-level message. Mirrors the formatting in
// engine.ts but kept local so the loop driver doesn't depend back on the runner.
function formatDriverErrorForLoop(err: EngineDriverError): string {
  if (err.code === "model_missing") return err.message;
  return `local ${err.backend} ${err.code}: ${err.message}`;
}

// Drive one streaming round and concatenate every text delta into one string.
// Used by the cap-finalize path where we want a closing message but no tools
// surface and no UI throttling.
async function collectFinalText(opts: {
  driver: EngineDriver;
  model: string;
  messages: ReadonlyArray<EngineChatMessage>;
  signal: AbortSignal;
}): Promise<{ text: string; outputTokens: number | null; costUsd: number | null }> {
  let text = "";
  let outputTokens: number | null = null;
  let costUsd: number | null = null;
  try {
    for await (const evt of opts.driver.streamChat({
      model: opts.model,
      messages: opts.messages,
      signal: opts.signal,
    })) {
      if (evt.kind === "text") text += evt.delta;
      else if (evt.kind === "done") {
        outputTokens = evt.outputTokens;
        costUsd = evt.costUsd;
      } else if (evt.kind === "error") break;
    }
  } catch (err) {
    log.warn("engine.cap_finalize_failed", {
      error: (err as Error).message,
    });
  }
  return { text, outputTokens, costUsd };
}

/**
 * Re-export `EngineToolCallRef` so consumers don't need a second import.
 */
export type { EngineToolCallRef };
