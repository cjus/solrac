/**
 * @fileoverview Engine-slot driver abstraction — the wire-format-agnostic
 *               contract that `local-driver.ts` (Ollama, LMStudio) and
 *               `remote-driver.ts` (OpenRouter) both implement.
 * @purpose Centralize the normalized event stream + error class + shared
 *          helpers so the runner in `engine.ts` consumes one driver shape
 *          regardless of whether the engine slot is filled by an on-host
 *          daemon (Ollama, LMStudio) or a hosted provider (OpenRouter).
 *
 * Position in the dependency graph:
 *   log → engine-driver → local-driver, remote-driver
 *                       → engine-tools → engine
 *
 * Exports:
 *   - `EngineBackend` — `"ollama" | "lmstudio" | "openrouter"`.
 *   - `EngineChatRole`, `EngineChatMessage`, `EngineToolCallRef`, `EngineToolDef`.
 *   - `EngineChatEvent` — `text | tool_call | done | error`.
 *   - `EngineProbeResult` — `{ ok; reason?; modelMissing? }`.
 *   - `EngineStreamChatOpts` — `streamChat` argument shape.
 *   - `EngineDriver` — interface (`backend`, `mode`, `probe`, `streamChat`).
 *   - `EngineDriverError` — typed error for connection/HTTP failures.
 *   - `DriverOpts` — base factory options (`url`, optional `fetch`).
 *   - `stableStringify` — order-insensitive JSON stringify for tool-call dedup.
 *   - `maybeLogEmptyStream` — diagnostic log helper for the empty-stream
 *     failure mode (parsed zero text + zero tool calls). Per-driver
 *     `logEvent` parameter so operators can grep distinct events per backend.
 *
 * Key invariants:
 *   - `streamChat` ALWAYS resolves the async iterable, even on errors —
 *     errors surface as `kind: "error"` events OR throw `EngineDriverError`
 *     for network-level failures (connection refused, timeout, 4xx/5xx).
 *   - `EngineDriverError` carries a `code` discriminant so callers can render
 *     different UX for `unreachable` vs `model_missing` vs `timeout` vs
 *     `http_error`.
 *   - `EngineDriver.mode` is the engine-slot identity — `"local"` for on-host
 *     backends (cost is always free; audit tag prefix `local:`), `"remote"`
 *     for hosted providers (cost captured per-turn from the usage chunk;
 *     audit tag prefix `remote:`). The runner reads this field to pick the
 *     capability-note framing and the cost-write matrix.
 */

import { log } from "./log.ts";

export type EngineBackend = "ollama" | "lmstudio" | "openrouter";

export type EngineChatRole = "system" | "user" | "assistant" | "tool";

/**
 * Reference to one tool call emitted by an assistant message. `id` is set
 * by backends that namespace calls (LMStudio, OpenRouter); for Ollama, the
 * consumer synthesizes one (`call_<round>_<idx>`) so cross-backend message
 * arrays carry a stable identifier.
 */
export interface EngineToolCallRef {
  id?: string;
  function: { name: string; arguments: unknown };
}

/**
 * Unified chat message shape. Each driver maps to its backend's wire shape:
 *   - Ollama matches tool results by `tool_name`.
 *   - LMStudio / OpenRouter match by `tool_call_id`.
 * Consumers populate both on tool-result messages; drivers pick what they
 * need. Extra fields are harmless on either wire.
 */
export interface EngineChatMessage {
  role: EngineChatRole;
  content: string;
  tool_calls?: ReadonlyArray<EngineToolCallRef>;
  tool_call_id?: string;
  tool_name?: string;
}

/**
 * Wire-shape tool definition shared by all backends — Ollama adopted OpenAI's
 * function-calling JSON Schema directly; LMStudio + OpenRouter are
 * OpenAI-compatible.
 */
export interface EngineToolDef {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Readonly<Record<string, unknown>>;
  };
}

/**
 * One event from `EngineDriver.streamChat`. Driver consumers iterate until
 * the stream ends or a `done`/`error` event arrives.
 */
export type EngineChatEvent =
  | { kind: "text"; delta: string }
  | { kind: "tool_call"; call: EngineToolCallRef }
  | {
      kind: "done";
      inputTokens: number | null;
      outputTokens: number | null;
      // USD cost reported by the backend's usage chunk. Always `null` for
      // on-host backends (Ollama, LMStudio); set by remote backends that
      // bill per-token (OpenRouter populates from `usage.cost` in the
      // trailing SSE chunk). Consumed by the runner to decide what to
      // write to `audit.cost_usd` — `null` here means "this backend
      // didn't tell us the cost," not "the cost was zero." The runner
      // distinguishes the two based on `driver.mode`.
      costUsd: number | null;
    }
  | { kind: "error"; message: string };

export interface EngineProbeResult {
  ok: boolean;
  reason?: string;
  modelMissing?: boolean;
}

export interface EngineStreamChatOpts {
  model: string;
  messages: ReadonlyArray<EngineChatMessage>;
  tools?: ReadonlyArray<EngineToolDef>;
  signal?: AbortSignal;
}

/**
 * Engine-slot driver contract. Implementations live in `local-driver.ts`
 * (Ollama, LMStudio) and `remote-driver.ts` (OpenRouter); the runner in
 * `engine.ts` consumes only this interface.
 *
 * `mode` is the engine-slot identity:
 *   - `"local"` — on-host backend (Ollama, LMStudio). Cost always 0; audit
 *     tag prefix `local:`. The runner writes `cost_usd = 0` regardless of
 *     what the driver reports.
 *   - `"remote"` — hosted backend (OpenRouter). Cost captured from the
 *     driver's `done` event; audit tag prefix `remote:`. The runner writes
 *     either the captured cost or `null` (with a `remote.cost_missing` warn)
 *     when the driver returned no cost.
 */
export interface EngineDriver {
  readonly backend: EngineBackend;
  readonly mode: "local" | "remote";
  probe(model: string, signal?: AbortSignal): Promise<EngineProbeResult>;
  streamChat(opts: EngineStreamChatOpts): AsyncIterable<EngineChatEvent>;
}

/**
 * Typed error surface for `streamChat` and `probe`. `code` lets callers
 * render distinct UX for "ollama daemon not running" (`unreachable`) vs
 * "model not pulled" (`model_missing`) without parsing the message.
 */
export class EngineDriverError extends Error {
  readonly backend: EngineBackend;
  readonly code: "unreachable" | "timeout" | "model_missing" | "http_error";
  readonly status?: number;
  constructor(
    backend: EngineBackend,
    code: "unreachable" | "timeout" | "model_missing" | "http_error",
    message: string,
    status?: number,
  ) {
    super(message);
    this.name = "EngineDriverError";
    this.backend = backend;
    this.code = code;
    this.status = status;
  }
}

export interface DriverOpts {
  url: string; // base, no trailing slash
  fetch?: typeof fetch;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Order-insensitive JSON stringify so `{a:1,b:2}` and `{b:2,a:1}` hash to the
 * same dedup key. Used by SSE drivers (LMStudio, OpenRouter) to suppress
 * duplicate tool calls inside one assistant message (Gemma-4
 * `parallel_tool_calls: false` workaround).
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

// Caps on the empty-stream diagnostic buffer — bounded so a runaway stream
// (huge content + zero parsed events somehow) can't blow up the log line.
export const RAW_FRAME_BUFFER_MAX = 30;
export const RAW_FRAME_TRUNC = 400;

/**
 * Diagnostic log for the empty-stream failure mode (some models close the SSE
 * with `[DONE]` immediately when `tools` is in the body — template lacks tool
 * branch). Driver buffers raw `data:` payloads and calls this on close; the
 * log fires only when zero text + zero tool calls were emitted. Per-driver
 * `logEvent` parameter so operators can grep distinct events per backend.
 */
export function maybeLogEmptyStream(args: {
  model: string;
  textCharsEmitted: number;
  toolCallsEmitted: number;
  rawFrameBuffer: ReadonlyArray<string>;
  logEvent: string;
}): void {
  if (args.textCharsEmitted > 0 || args.toolCallsEmitted > 0) return;
  log.warn(args.logEvent, {
    model: args.model,
    frameCount: args.rawFrameBuffer.length,
    frames: args.rawFrameBuffer,
  });
}
