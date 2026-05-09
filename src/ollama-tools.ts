/**
 * @fileoverview Ollama tool-calling support — Phases 1–3: schema converter,
 *               per-call executor, and multi-round loop driver.
 * @purpose Bridge solrac integrations (`SdkMcpToolDefinition`, designed for
 *          the Anthropic-hosted Claude Agent SDK) into the OpenAI-compatible
 *          tool format Ollama's `/api/chat` accepts via the `tools[]` field,
 *          and run a single tool call through the same safety layers (loop
 *          detector, classifier, broker) the SDK path uses on Claude tiers.
 *          One source of truth for the tool surface — the same operator-
 *          authored modules under `src/integrations-builtin/` and
 *          `$SOLRAC_INTEGRATIONS_DIR/` reach both Claude tiers and Ollama.
 *
 * Why a converter at all:
 *   `SdkMcpToolDefinition.inputSchema` is a raw `ZodRawShape` (object of zod
 *   field defs), NOT a wrapped `z.object(...)`. The SDK applies the wrap
 *   internally; for Ollama we have to do it ourselves before producing JSON
 *   Schema. See `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:2885`.
 *
 * Why `z.toJSONSchema` and not a hand-rolled walker:
 *   Verified empirically against a representative schema (string/number/int/
 *   bool/array/enum/optional/describe) that zod 4.4.3's output is already
 *   OpenAI-compatible — `additionalProperties:false`, correct `required`
 *   array, preserved `description` annotations. The only post-processing
 *   needed is stripping the top-level `$schema` JSON-Schema-version marker
 *   (some strict models reject unrecognized fields). PLAN.md Phase 1 names a
 *   hand-rolled walker as a fallback if zod's output churns; not implemented
 *   yet — YAGNI. Pin or vendor zod if churn becomes an issue.
 *
 * Why a separate executor for Ollama (vs reusing the SDK's path):
 *   The Anthropic SDK drives the tool-call loop internally — every classified
 *   `mcp__solrac__*` call lands at the integration's handler without solrac
 *   needing to invoke it. Ollama's `/api/chat` returns one assistant message;
 *   if it contains `tool_calls`, WE execute them and feed results back. So
 *   we re-implement the per-call gate path (loop → classify → broker → invoke)
 *   that `agent.ts` gets for free from the SDK. The same `policy.ts` building
 *   blocks (`classifyToolWithIntegrations`, `LoopDetector`, `ConfirmationBroker`)
 *   are reused — no policy duplication, just a different driver.
 *
 * Order of checks (mirrors `createPreToolUseHook` + `createPolicyHook` in
 * policy.ts):
 *   1. loop detector — runs first so a runaway model is cut off before any
 *      classifier work or broker dispatch, including for fabricated names.
 *   2. tool-exists check — fail fast on a hallucinated name BEFORE prompting
 *      the user. Otherwise we'd ask the operator to confirm a tool we don't
 *      have, only to error out internally if they tap allow.
 *   3. classifier (`classifyToolWithIntegrations`) — `auto` allows
 *      immediately, `deny` returns a denial string, `confirm` proceeds.
 *   4. broker — Telegram inline-keyboard, 60s timeout, fail-closed.
 *   5. zod parse — model can hallucinate args; validate before invoking.
 *   6. handler invoke — the integration's own code.
 *
 * Cost cap is intentionally NOT checked here. Per PLAN.md Q1 / §3b, Anthropic
 * per-chat + global caps gate Anthropic burn only. Ollama is $0; the loop
 * detector and (Phase 3) iteration cap are the runaway-loop defenses.
 *
 * Result shaping:
 *   The model sees one string per tool call as the `role:"tool"` content.
 *   We coalesce all `text`-typed `CallToolResult.content[]` blocks, JSON-
 *   stringify other block types as a fallback, and truncate to
 *   `TOOL_RESULT_MAX_LEN` so a runaway 10 MB Read result can't blow the
 *   model's context budget. Truncation is marked with a trailing `…`.
 *
 * Scope (Phases 1–3, this file):
 *   - `mcpToOllamaTools(tools)` — pure converter, no IO.
 *   - `OllamaToolDef` — wire shape produced for `/api/chat` `tools[]`.
 *   - `executeToolCall(deps, call)` — run one tool call through the gate.
 *   - `OllamaToolCall`, `ToolCallResult`, `ToolCallDisposition` — shapes.
 *   - `TOOL_RESULT_MAX_LEN` — exported so the loop and tests share the constant.
 *   - `stripThoughts(text)` — gemma-thought-fence stripper for history append.
 *   - `runToolLoop(deps, input)` — multi-round driver wrapping `executeToolCall`.
 *   - `OllamaMessage`, `RunToolLoopDeps`, `RunToolLoopInput`, `ToolLoopResult`,
 *     `RunToolLoopRenderer` — driver shapes.
 *
 * Position in the dependency graph:
 *   integrations + policy + telegram + log + zod → ollama-tools → ollama (Phase 4)
 *
 * Cross-references:
 *   - PLAN.md (solrac-dev) §3b, Phases 1+2 — design + checklist
 *   - src/integrations.ts — the producer side
 *   - src/policy.ts — `classifyToolWithIntegrations`, `LoopDetector`,
 *     `ConfirmationBroker` (all reused as-is)
 *   - https://github.com/ollama/ollama/blob/main/docs/api.md — `tools[]` shape
 */

import { z } from "zod";
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import {
  classifyToolWithIntegrations,
  type ConfirmationBroker,
  type LoopDetector,
} from "./policy.ts";
import type { IntegrationTier } from "./integrations.ts";
import { log } from "./log.ts";
import type { TelegramClient } from "./telegram.ts";

/**
 * Wire shape for one entry in Ollama `/api/chat`'s `tools[]` array.
 * Mirrors OpenAI's function-calling format that Ollama adopted.
 */
export interface OllamaToolDef {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Readonly<Record<string, unknown>>;
  };
}

/**
 * Convert solrac integration tools to Ollama `/api/chat` `tools[]` entries.
 *
 * Names pass through unchanged — integrations register short names like
 * `time_now`; the `mcp__solrac__` prefix is added at the SDK boundary in
 * `agent.ts` and is NOT used over Ollama's wire (Ollama's tool registry is
 * flat, not namespaced).
 *
 * The `<any>` schema generic mirrors the SDK's own `tools?: Array<…<any>>`
 * field (`sdk.d.ts:426`) and `integrations.ts`'s `ReadonlyArray<…<any>>`
 * — heterogeneous tool arrays can't share a single concrete schema type.
 */
export function mcpToOllamaTools(
  tools: ReadonlyArray<SdkMcpToolDefinition<any>>,
): OllamaToolDef[] {
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
// Phase 2 — single tool-call executor
// ---------------------------------------------------------------------------

// Mirrors the SDK's MCP namespace (`policy.ts::SOLRAC_MCP_PREFIX`). We don't
// import that constant because it's not exported; duplicating the literal is
// a one-line cost vs. widening policy.ts's surface for a private convention.
const SOLRAC_MCP_PREFIX = "mcp__solrac__";

/**
 * Cap on the string length of the tool result fed back to the model as
 * `role:"tool"` content. 8 KB ≈ 2k tokens — enough for any reasonable
 * structured response (HTTP body, formatted listing) while keeping the
 * round-trip token budget bounded across multi-iteration loops.
 *
 * If a single tool result exceeds this, we keep the head and append a `…`
 * marker so the model knows it was truncated.
 */
export const TOOL_RESULT_MAX_LEN = 8192;

/**
 * One tool call as parsed from Ollama's response. `arguments` is `unknown`
 * because some tools-supported models emit a JSON-stringified object instead
 * of a real object; the executor coerces.
 */
export interface OllamaToolCall {
  readonly name: string;
  readonly arguments: unknown;
}

/**
 * Per-call disposition for telemetry / loop driver. The model only sees
 * `content`; this field is for log aggregation and Phase 3's iteration
 * accounting.
 */
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
  /**
   * The string fed back to the model as `role:"tool"` content. ALWAYS
   * non-empty so the model can adapt — even denials produce a content
   * string ("denied: <reason>") rather than a missing turn.
   */
  readonly content: string;
  /** Coarse outcome for logging / iteration accounting. */
  readonly disposition: ToolCallDisposition;
  /** Optional human-readable detail (matches `disposition` 1:1 for logs). */
  readonly reason?: string;
  /** Whether the result was truncated to TOOL_RESULT_MAX_LEN. */
  readonly truncated?: boolean;
}

export interface ExecuteToolCallDeps {
  readonly chatId: number;
  readonly auditId: number;
  /**
   * Map from SHORT tool name (`time_now`) to tool definition. Built once
   * at boot from `IntegrationLoadResult.tools`; same names the model sees
   * in the `tools[]` array on the wire.
   */
  readonly tools: ReadonlyMap<string, SdkMcpToolDefinition<any>>;
  /** Per-tool tier overrides — same map the SDK path consumes. */
  readonly toolTiers: ReadonlyMap<string, IntegrationTier>;
  /** Telegram-confirm broker for `confirm`-tier tools. */
  readonly broker: Pick<ConfirmationBroker, "request">;
  /**
   * Per-turn loop detector. SHARED across all tool calls in this user
   * turn (matches `agent.ts::createLoopDetector` lifecycle).
   */
  readonly loopDetector: LoopDetector;
  /**
   * PLAN §3 / Phase 3 — `OLLAMA_DENY_TOOLS` belt-and-suspenders. Set of
   * SHORT tool names that bypass classifier and broker; any call whose name
   * appears here is denied immediately with `denied_policy`. Mirrors
   * `agent.ts:269 disallowedTools: ["Agent","Task"]` for the SDK path. Empty
   * by default; the seam exists so the operator can pin a name out of
   * reach without restarting the whole policy classifier.
   */
  readonly deniedTools?: ReadonlySet<string>;
  /**
   * PLAN §3 Phase 3 — single-confirm-per-round cap. When set, the executor
   * decrements `confirmsRemaining` on each `confirm`-tier classification;
   * once it hits 0, subsequent confirm-tier calls in the same round are
   * denied with `"only one confirmable tool per round"` rather than queued
   * back-to-back through the 60s broker. Owned (created/reset) by the
   * loop driver — one fresh instance per round. Absent for single-call
   * tests so they exercise the unbounded path.
   */
  readonly roundState?: { confirmsRemaining: number };
}

/**
 * Run one Ollama tool call through the safety layers and return the
 * string the model should see as the tool result. Never throws; every
 * exception path produces a structured `ToolCallResult` so the loop
 * driver can append a `role:"tool"` message on every branch.
 */
export async function executeToolCall(
  deps: ExecuteToolCallDeps,
  call: OllamaToolCall,
): Promise<ToolCallResult> {
  const shortName = call.name;
  // Restore the SDK MCP prefix the classifier expects. The model sees flat
  // names (`time_now`) over the Ollama wire because Ollama's tool registry
  // is not namespaced; the policy layer keys on `mcp__solrac__time_now`.
  const fullName = SOLRAC_MCP_PREFIX + shortName;
  const args = normalizeToolArgs(call.arguments);

  // Step 1: loop detector (matches PreToolUse ordering — runs before classify
  // so a model spamming the same call is cut off before broker dispatch,
  // including a runaway on a fabricated name).
  if (deps.loopDetector.check(fullName, args) === "loop") {
    const reason = `loop_detected: ${shortName} called ${deps.loopDetector.threshold}× with same input`;
    log.warn("ollama.tool_loop_detected", {
      auditId: deps.auditId,
      chatId: deps.chatId,
      tool: shortName,
      threshold: deps.loopDetector.threshold,
    });
    return {
      content: `denied: ${reason}`,
      disposition: "denied_loop",
      reason,
    };
  }

  // Step 2: existence check. Fail fast on a hallucinated name before we
  // bother the operator with a confirm prompt for something we can't run.
  const tool = deps.tools.get(shortName);
  if (!tool) {
    const reason = `unknown tool: ${shortName}`;
    log.warn("ollama.tool_unknown", {
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

  // Step 2b: hard deny seam (`OLLAMA_DENY_TOOLS`). Runs after the existence
  // check so a hallucinated name produces `error_unknown_tool` (model can
  // self-correct) rather than `denied_policy` (suggests the tool exists but
  // the operator pinned it out of reach).
  if (deps.deniedTools?.has(shortName)) {
    const reason = `tool ${shortName} is in OLLAMA_DENY_TOOLS`;
    log.warn("ollama.tool_denied_hard", {
      auditId: deps.auditId,
      chatId: deps.chatId,
      tool: shortName,
    });
    return {
      content: `denied: ${reason}`,
      disposition: "denied_policy",
      reason,
    };
  }

  // Step 3: classify against the same tier map Claude sees.
  const decision = classifyToolWithIntegrations(fullName, args, deps.toolTiers);
  if (decision.kind === "deny") {
    log.warn("ollama.tool_denied_policy", {
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

  // Step 3: confirm UX for confirm-tier tools.
  if (decision.kind === "confirm") {
    // Per-round confirm-cap (PLAN §3 / Phase 3). When the model emits
    // multiple parallel `tool_calls` and ≥2 are confirm-tier, the FIRST
    // gets the broker; subsequent ones short-circuit to a deny that tells
    // the model to retry split across rounds. Avoids stacking 60s prompts.
    if (deps.roundState && deps.roundState.confirmsRemaining <= 0) {
      const reason = "only one confirmable tool per round; retry one at a time";
      log.warn("ollama.tool_confirm_round_cap", {
        auditId: deps.auditId,
        chatId: deps.chatId,
        tool: shortName,
      });
      return {
        content: `denied: ${reason}`,
        disposition: "denied_policy",
        reason,
      };
    }
    if (deps.roundState) deps.roundState.confirmsRemaining -= 1;
    log.info("ollama.tool_confirm_request", {
      auditId: deps.auditId,
      chatId: deps.chatId,
      tool: shortName,
    });
    let verdict;
    try {
      verdict = await deps.broker.request({
        chatId: deps.chatId,
        toolName: fullName,
        toolInput: args,
      });
    } catch (err) {
      // Defense-in-depth: the production broker fails closed internally
      // (returns "deny" on Telegram send failure), but a future broker or
      // a test stub might throw. Treat thrown as a denial too.
      const msg = (err as Error).message;
      log.warn("ollama.tool_confirm_send_failed", {
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
    log.info("ollama.tool_confirm_resolved", {
      auditId: deps.auditId,
      chatId: deps.chatId,
      tool: shortName,
      verdict,
    });
    if (verdict === "deny") {
      return {
        content: "denied: user declined the confirmation",
        disposition: "denied_user",
        reason: "user declined",
      };
    }
    if (verdict === "timeout") {
      return {
        content: "denied: confirmation timed out",
        disposition: "denied_timeout",
        reason: "broker timeout",
      };
    }
    // verdict === "allow" — fall through to invoke.
  }

  // Step 5: validate against the tool's own zod schema before invoking — the model
  // can hallucinate args (extra keys, wrong types). Fail with a model-readable
  // message so it can retry with corrections; the loop detector caps repeats.
  const parsed = z.object(tool.inputSchema as z.ZodRawShape).safeParse(args);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    log.warn("ollama.tool_invalid_args", {
      auditId: deps.auditId,
      chatId: deps.chatId,
      tool: shortName,
      issues,
    });
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
    log.warn("ollama.tool_handler_threw", {
      auditId: deps.auditId,
      chatId: deps.chatId,
      tool: shortName,
      error: msg,
    });
    return {
      content: `error: handler threw — ${msg}`,
      disposition: "error_handler_threw",
      reason: msg,
    };
  }

  const { content, truncated } = coalesceResultContent(result);
  log.debug("ollama.tool_call_ok", {
    auditId: deps.auditId,
    chatId: deps.chatId,
    tool: shortName,
    contentLen: content.length,
    truncated,
  });
  return { content, disposition: "ok", truncated };
}

// Some Ollama-tools-supported models emit `arguments` as a JSON-encoded string
// instead of an object (PLAN §6 / Q3). Coerce when possible; on parse failure,
// pass the original through so the zod step produces a useful error rather
// than silently substituting an empty object.
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

// Coalesce an MCP `CallToolResult.content[]` into one string. Concatenate
// `text`-typed blocks (the dominant shape in our integrations); JSON-stringify
// any other block types so non-text content is at least visible to the model.
// On total emptiness, return the JSON of the whole result for diagnosability.
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
  return {
    content: s.slice(0, TOOL_RESULT_MAX_LEN - 1) + "…",
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

// gemma4:e2b/e4b model card: "historical model output should only include the
// final response. Thoughts from previous model turns must not be added before
// the next user turn begins." Strip three fence forms before appending an
// assistant message to `messages[]`:
//   - canonical `<think>…</think>` (qwen, deepseek, gemma3-reasoning)
//   - gemma pipe form with leading-slash close `<|think|>…</|think|>`
//   - gemma pipe form with inside-slash close `<|think|>…<|/think|>`
// Lazy match across newlines; case-insensitive on the tag tokens. Unclosed
// fences are LEFT INTACT — emitting a partial thought is the model's bug,
// surfacing it in history makes the misbehavior debuggable.
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
// Phase 3 — multi-round tool loop driver
// ---------------------------------------------------------------------------

const EDIT_THROTTLE_MS = 1500;

/**
 * Belt-and-suspenders deny set, mirroring `agent.ts`'s
 * `disallowedTools: ["Agent","Task"]`. Any tool name in this set is rejected
 * before the executor is even called, regardless of policy classification.
 *
 * Initially empty: the integrations loader (`integrations.ts::TOOL_NAME_RE`)
 * already constrains tool names to lowercase and no built-in integration
 * ships anything resembling a sub-agent. The seam exists so a future
 * integration that turns out to be hazardous can be neutered with one line
 * — without modifying `policy.ts`.
 */
export const OLLAMA_DENY_TOOLS: ReadonlySet<string> = Object.freeze(new Set<string>());

/**
 * One chat message in the running `messages[]` array sent to `/api/chat`.
 * Mirrors Ollama's wire shape — `role` covers the four kinds we emit
 * (`system` / `user` / `assistant` / `tool`); `tool_calls` rides on
 * `assistant` turns; `tool_name` is required on `tool` turns so the model
 * can match results to its calls.
 */
export interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{
    function: { name: string; arguments: unknown };
  }>;
  tool_name?: string;
}

/**
 * Outcome of one `runToolLoop` invocation. The caller composes this with
 * audit + final-render — `runToolLoop` does NOT touch the audit row or
 * Telegram directly. That keeps the driver a pure function of
 * (initial messages, fetch impl, tools) → (final text, telemetry).
 *
 * Audit-finalization invariant (PLAN.md Phase 3) is satisfied by guarantee:
 * `runToolLoop` ALWAYS resolves with a `ToolLoopResult` (or rejects only
 * on programmer error — `signal.abort()` resolves with `aborted:true`).
 * Caller's `try/finally` then writes the audit row exactly once.
 */
export interface ToolLoopResult {
  /** Final assistant-visible text (last round's content; thoughts NOT stripped). */
  readonly assistantText: string;
  /** All tool calls observed across rounds. Audit `tool_calls` column is JSON of this. */
  readonly toolCallSummaries: ReadonlyArray<{ name: string; input: unknown }>;
  /** `prompt_eval_count` from round 0 only (true input — see PLAN §3 token accounting). */
  readonly inputTokens: number | null;
  /** Sum of `eval_count` across all rounds (true total generated). */
  readonly outputTokens: number | null;
  /** Number of streaming rounds executed (excludes the cap-finalize round). */
  readonly rounds: number;
  /** Tool calls actually executed (or hard-denied) — for footer + log telemetry. */
  readonly toolsFired: number;
  /** Iteration cap was reached; `assistantText` came from the cap-finalize round. */
  readonly iterationCapHit: boolean;
  /** Non-null on any failure path (HTTP 4xx/5xx, fetch reject, frame.error, abort). */
  readonly errorMessage: string | null;
  /** `signal.aborted` was observed — distinct from a clean error. */
  readonly aborted: boolean;
}

/**
 * Throttled stream-edit hook. Called at most once per `EDIT_THROTTLE_MS`
 * (1500ms) with the current accumulated text + active tool-call names for
 * this round. The driver de-dupes — it will not re-invoke with identical
 * `text` + `toolNames` content. Errors thrown from `onProgress` are caught
 * and logged; they do NOT abort the round.
 *
 * Telegram is the production renderer; tests pass a recording fake.
 */
export interface RunToolLoopRenderer {
  onProgress(
    text: string,
    toolNames: ReadonlyArray<string>,
  ): void | Promise<void>;
}

export interface RunToolLoopDeps {
  /** Injectable for tests; production passes `globalThis.fetch`. */
  readonly fetch?: typeof fetch;
  /** Ollama base URL (no trailing slash). */
  readonly url: string;
  /** Ollama model name, used in the request body. */
  readonly model: string;
  /**
   * Single shared `AbortSignal` for every fetch in this turn — model rounds
   * AND the cap-finalize round. Caller owns the controller; one
   * `signal.abort()` cleanly terminates the whole loop.
   */
  readonly signal: AbortSignal;
  /** Map from short tool name → `SdkMcpToolDefinition` for handler dispatch. */
  readonly tools: ReadonlyMap<string, SdkMcpToolDefinition<any>>;
  /** Per-tool tier map (auto/confirm) — same map the SDK path uses. */
  readonly toolTiers: ReadonlyMap<string, IntegrationTier>;
  /** Pre-converted Ollama wire defs (build once at boot via `mcpToOllamaTools`). */
  readonly toolDefs: ReadonlyArray<OllamaToolDef>;
  /** Telegram-confirm broker (or any caller-provided implementation). */
  readonly broker: Pick<ConfirmationBroker, "request">;
  /** Per-turn loop detector — shared across every tool call this turn. */
  readonly loopDetector: LoopDetector;
  /** `OLLAMA_MAX_TOOL_ITERATIONS` — hard ceiling on rounds. */
  readonly maxIterations: number;
  /** For correlating logs with the audit row. */
  readonly auditId: number;
  /** For correlating logs with the chat. */
  readonly chatId: number;
  /** Override of `OLLAMA_DENY_TOOLS`; defaults to the module constant. */
  readonly denyTools?: ReadonlySet<string>;
  /** Optional throttled progress hook for live UI. */
  readonly renderer?: RunToolLoopRenderer;
}

export interface RunToolLoopInput {
  /**
   * Pre-built messages array. Caller assembles
   * (system + capability note + SOLRAC.md + history + user) — all the
   * audit/persona concerns live in the caller. The driver mutates a copy
   * for round bookkeeping (assistant + tool turns).
   */
  readonly initialMessages: ReadonlyArray<OllamaMessage>;
}

interface OllamaStreamFrame {
  message?: {
    role?: string;
    content?: string;
    tool_calls?: ReadonlyArray<{
      function?: { name?: unknown; arguments?: unknown };
    }>;
  };
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

/**
 * Drive the multi-round tool-call loop.
 *
 * For each round (up to `maxIterations`):
 *   1. POST `/api/chat` streaming.
 *   2. Stream-parse NDJSON; accumulate text + `tool_calls` from the final
 *      `done:true` frame.
 *   3. Throttle-call `renderer.onProgress` with text + active tool names.
 *   4. If no tool calls — break (final answer).
 *   5. Otherwise append `assistant` (thoughts stripped) + `tool_calls` to
 *      messages, execute each call sequentially via `executeToolCall`,
 *      append a `tool` message with the result. Single-confirm-per-round
 *      cap denies the 2nd+ confirmable call with a model-readable retry hint.
 *
 * On cap-hit: append a system "finalize" nudge and one non-streaming
 * round to extract a closing message.
 *
 * Always resolves — `signal.abort()` produces a `ToolLoopResult` with
 * `aborted:true`. Never throws (modulo programmer errors).
 */
export async function runToolLoop(
  deps: RunToolLoopDeps,
  input: RunToolLoopInput,
): Promise<ToolLoopResult> {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const denyTools = deps.denyTools ?? OLLAMA_DENY_TOOLS;
  const messages: OllamaMessage[] = input.initialMessages.map((m) => ({ ...m }));

  let inputTokens: number | null = null;
  let outputTokens = 0;
  let outputTokensSeen = false;
  const toolCallSummaries: Array<{ name: string; input: unknown }> = [];
  let assistantText = "";
  let errorMessage: string | null = null;
  let iterationCapHit = false;
  let toolsFired = 0;
  let lastEditAt = 0;
  let lastEditedKey = "";
  let round = 0;

  log.info("ollama.tool_loop_start", {
    auditId: deps.auditId,
    chatId: deps.chatId,
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
    toolCalls: OllamaToolCall[];
    inputTokens: number | null;
    outputTokens: number | null;
    error: string | null;
  }> {
    const result = {
      text: "",
      toolCalls: [] as OllamaToolCall[],
      inputTokens: null as number | null,
      outputTokens: null as number | null,
      error: null as string | null,
    };

    const res = await fetchImpl(`${deps.url}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: deps.model,
        messages,
        tools: deps.toolDefs,
        stream: true,
      }),
      signal: deps.signal,
    });

    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      let parsedBody: { error?: string } = {};
      try {
        parsedBody = JSON.parse(bodyText) as { error?: string };
      } catch {
        // not JSON — fall through with empty
      }
      if (res.status === 404) {
        result.error = `ollama model not found: ${deps.model} — pull with \`ollama pull ${deps.model}\` on the host`;
      } else {
        const detail =
          parsedBody.error ?? (bodyText.slice(0, 200) || res.statusText);
        result.error = `ollama error: ${res.status} ${detail}`;
      }
      return result;
    }
    if (!res.body) {
      result.error = "ollama returned no body";
      return result;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    streamLoop: while (true) {
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
            auditId: deps.auditId,
            error: (parseErr as Error).message,
            line: line.slice(0, 120),
          });
          continue;
        }
        if (frame.error) {
          result.error = `ollama error: ${frame.error}`;
          break streamLoop;
        }
        const chunk = frame.message?.content;
        if (chunk) result.text += chunk;
        const tcs = frame.message?.tool_calls;
        if (Array.isArray(tcs)) {
          for (const tc of tcs) {
            const fn = tc?.function;
            if (fn && typeof fn === "object" && typeof fn.name === "string") {
              result.toolCalls.push({
                name: fn.name,
                arguments: fn.arguments ?? {},
              });
            }
          }
        }
        if (frame.done) {
          result.inputTokens = frame.prompt_eval_count ?? null;
          result.outputTokens = frame.eval_count ?? null;
        }
        // Throttled progress render.
        if (deps.renderer) {
          const now = Date.now();
          if (now - lastEditAt >= EDIT_THROTTLE_MS) {
            const toolNames = result.toolCalls.map((c) => c.name);
            const key = `${result.text}${toolNames.join(",")}`;
            if (key !== lastEditedKey) {
              lastEditAt = now;
              lastEditedKey = key;
              try {
                await deps.renderer.onProgress(result.text, toolNames);
              } catch (renderErr) {
                log.debug("ollama.progress_failed", {
                  auditId: deps.auditId,
                  error: (renderErr as Error).message,
                });
              }
            }
          }
        }
      }
    }
    return result;
  }

  try {
    while (round < deps.maxIterations) {
      round++;
      const r = await runStreamingRound();

      if (r.error !== null) {
        errorMessage = r.error;
        break;
      }

      // True input is round 1's prompt only — round N's prompt cumulatively
      // includes 1..N-1, so summing would N×-overcount the user-perceived input.
      if (round === 1) inputTokens = r.inputTokens;
      if (r.outputTokens !== null) {
        outputTokens += r.outputTokens;
        outputTokensSeen = true;
      }

      assistantText = r.text;

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
          log.warn("ollama.tool_hard_denied", {
            auditId: deps.auditId,
            chatId: deps.chatId,
            tool: call.name,
          });
          messages.push({
            role: "tool",
            tool_name: call.name,
            content: denyMsg,
          });
          continue;
        }

        // Single-confirm-per-round: pre-classify confirm-tier; deny 2nd+.
        const tier = deps.toolTiers.get(call.name) ?? "confirm";
        const wouldConfirm = tier !== "auto";
        if (wouldConfirm && confirmsUsedThisRound > 0) {
          const msg =
            "denied: only one confirmable tool per round; retry separately";
          log.info("ollama.tool_confirm_skipped_round_cap", {
            auditId: deps.auditId,
            chatId: deps.chatId,
            tool: call.name,
          });
          messages.push({
            role: "tool",
            tool_name: call.name,
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
          },
          call,
        );

        // The confirm budget is consumed whether the broker allowed or
        // denied — what matters is that the operator was already prompted.
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
          content: exec.content,
        });
      }
    }

    // Iteration cap — coax a closing message rather than show a half-finished
    // tool stream as the final UX state.
    if (round >= deps.maxIterations && errorMessage === null && !isAborted()) {
      iterationCapHit = true;
      log.warn("ollama.tool_iteration_cap", {
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
      try {
        const res = await fetchImpl(`${deps.url}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: deps.model,
            messages,
            stream: false,
          }),
          signal: deps.signal,
        });
        if (res.ok) {
          const body = (await res.json().catch(() => null)) as
            | { message?: { content?: string }; eval_count?: number }
            | null;
          const text = body?.message?.content;
          if (typeof text === "string" && text.length > 0) {
            assistantText = text;
          }
          if (typeof body?.eval_count === "number") {
            outputTokens += body.eval_count;
            outputTokensSeen = true;
          }
        }
      } catch (capErr) {
        // Swallow — assistantText still reflects the last streaming round.
        log.warn("ollama.cap_finalize_failed", {
          auditId: deps.auditId,
          error: (capErr as Error).message,
        });
      }
    }
  } catch (err) {
    const e = err as Error;
    if (e.name === "AbortError" || isAborted()) {
      // Caller aborted (timeout / shutdown). Distinct from a fetch failure.
    } else {
      errorMessage = `ollama unreachable: ${deps.url}`;
      log.error("ollama.tool_loop_failed", {
        auditId: deps.auditId,
        url: deps.url,
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
    rounds: round + (iterationCapHit ? 1 : 0),
    toolsFired,
    iterationCapHit,
    errorMessage:
      errorMessage ??
      (aborted ? "aborted" : iterationCapHit ? "iteration_cap" : null),
    aborted,
  };

  log.info("ollama.tool_loop_done", {
    auditId: deps.auditId,
    chatId: deps.chatId,
    model: deps.model,
    rounds: result.rounds,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    toolsFired,
    iterationCapHit,
    aborted,
    errorMessage: result.errorMessage,
  });

  return result;
}
