/**
 * @fileoverview Backend driver for the `local` engine — Ollama + LMStudio.
 * @purpose Hide every wire-format difference (NDJSON vs SSE, Ollama vs OpenAI
 *          shapes, tool-call delta accumulation, usage-chunk ordering) behind a
 *          normalized event stream so `local.ts` and `local-tools.ts` consume
 *          one shape regardless of backend.
 *
 * One file, two implementations:
 *   - `OllamaDriver` — `POST /api/chat` NDJSON (one JSON object per line).
 *     Probe: `GET /api/tags` and check `models[]` for the configured name.
 *   - `LmstudioDriver` — `POST /v1/chat/completions` SSE (`data: <json>\n\n`,
 *     `data: [DONE]` terminator). Probe: `GET /v1/models` and check `data[]`.
 *     Sends `parallel_tool_calls: false` (Gemma-4 workaround). Accumulates
 *     `tool_calls[].function.arguments` delta strings across chunks before
 *     emitting one parsed `tool_call` event. Dedupes identical `(name, args)`
 *     pairs within one assistant message.
 *
 * Why one file (not two):
 *   The shared event union + serializer + probe-result shape + custom error
 *   class are ~100 lines that both drivers consume. Splitting would introduce
 *   a third file with no behavior. The drivers themselves are concentrated
 *   enough that side-by-side reading helps debug "Ollama emits a JSON line,
 *   LMStudio emits a parsable-after-prefix-strip JSON line — what's different?"
 *
 * Position in the dependency graph:
 *   log → local-driver → local, local-tools
 *
 * Exports:
 *   - `LocalBackend` — `"ollama" | "lmstudio"`.
 *   - `LocalChatRole`, `LocalChatMessage`, `LocalToolCallRef`, `LocalToolDef`.
 *   - `LocalChatEvent` — `text | tool_call | done | error`.
 *   - `LocalProbeResult` — `{ ok; reason?; modelMissing? }`.
 *   - `LocalDriver` — interface (`backend`, `probe`, `streamChat`).
 *   - `LocalDriverError` — typed error for connection/HTTP failures.
 *   - `createOllamaDriver(opts)`, `createLmstudioDriver(opts)` — factories.
 *
 * Key invariants:
 *   - `streamChat` ALWAYS resolves the async iterable, even on errors —
 *     errors surface as `kind: "error"` events OR throw `LocalDriverError`
 *     for network-level failures (connection refused, timeout, 4xx/5xx).
 *   - The Ollama driver's tool-call extraction reads `message.tool_calls`
 *     from any frame (Ollama emits them on the final `done:true` frame
 *     in practice, but the parser tolerates earlier frames defensively).
 *   - The LMStudio driver MUST accumulate `function.arguments` deltas
 *     across multiple SSE events before emitting a `tool_call` event with
 *     fully-parsed JSON args. Per-chunk emit would deliver fragments.
 *   - Tool-call dedup (Gemma-4 workaround) compares stableStringify-ed
 *     `(name, args)` pairs; identical duplicates within one assistant
 *     message are skipped silently.
 *   - `LocalDriverError` carries a `code` discriminant so callers can
 *     render different UX for `unreachable` vs `model_missing` vs
 *     `timeout` vs `http_error`.
 *
 * Gotchas:
 *   - LMStudio emits `usage` either on a dedicated trailing chunk
 *     (with `choices: []`) OR inline on the last `choices[0]` chunk.
 *     The driver captures whichever arrives last and emits it via the
 *     `done` event.
 *   - Ollama tool-call args may be a real object OR a JSON-encoded string
 *     (some models double-encode). The driver passes the raw value through;
 *     `local-tools.ts::normalizeToolArgs` coerces.
 *   - `[DONE]` is the LMStudio SSE terminator. After it, the stream may have
 *     a trailing newline — driver tolerates.
 */

import { log } from "./log.ts";

export type LocalBackend = "ollama" | "lmstudio";

export type LocalChatRole = "system" | "user" | "assistant" | "tool";

/**
 * Reference to one tool call emitted by an assistant message. `id` is set
 * by backends that namespace calls (LMStudio); for Ollama, the consumer
 * synthesizes one (`call_<round>_<idx>`) so cross-backend message arrays
 * carry a stable identifier.
 */
export interface LocalToolCallRef {
  id?: string;
  function: { name: string; arguments: unknown };
}

/**
 * Unified chat message shape. Each driver maps to its backend's wire shape:
 *   - Ollama matches tool results by `tool_name`.
 *   - LMStudio matches by `tool_call_id`.
 * Consumers populate both on tool-result messages; drivers pick what they
 * need. Extra fields are harmless on either wire.
 */
export interface LocalChatMessage {
  role: LocalChatRole;
  content: string;
  tool_calls?: ReadonlyArray<LocalToolCallRef>;
  tool_call_id?: string;
  tool_name?: string;
}

/**
 * Wire-shape tool definition shared by both backends — Ollama adopted OpenAI's
 * function-calling JSON Schema directly; LMStudio is OpenAI-compatible.
 */
export interface LocalToolDef {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Readonly<Record<string, unknown>>;
  };
}

/**
 * One event from `LocalDriver.streamChat`. Driver consumers iterate until the
 * stream ends or a `done`/`error` event arrives.
 */
export type LocalChatEvent =
  | { kind: "text"; delta: string }
  | { kind: "tool_call"; call: LocalToolCallRef }
  | { kind: "done"; inputTokens: number | null; outputTokens: number | null }
  | { kind: "error"; message: string };

export interface LocalProbeResult {
  ok: boolean;
  reason?: string;
  modelMissing?: boolean;
}

export interface LocalStreamChatOpts {
  model: string;
  messages: ReadonlyArray<LocalChatMessage>;
  tools?: ReadonlyArray<LocalToolDef>;
  signal?: AbortSignal;
}

export interface LocalDriver {
  readonly backend: LocalBackend;
  probe(model: string, signal?: AbortSignal): Promise<LocalProbeResult>;
  streamChat(opts: LocalStreamChatOpts): AsyncIterable<LocalChatEvent>;
}

/**
 * Typed error surface for `streamChat` and `probe`. `code` lets callers
 * render distinct UX for "ollama daemon not running" (`unreachable`) vs
 * "model not pulled" (`model_missing`) without parsing the message.
 */
export class LocalDriverError extends Error {
  readonly backend: LocalBackend;
  readonly code: "unreachable" | "timeout" | "model_missing" | "http_error";
  readonly status?: number;
  constructor(
    backend: LocalBackend,
    code: "unreachable" | "timeout" | "model_missing" | "http_error",
    message: string,
    status?: number,
  ) {
    super(message);
    this.name = "LocalDriverError";
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
// Stable stringify (tool-call dedup key)
// ---------------------------------------------------------------------------

// Order-insensitive JSON stringify so `{a:1,b:2}` and `{b:2,a:1}` hash to the
// same dedup key. Used by the LMStudio driver to suppress duplicate tool calls
// inside one assistant message (Gemma-4 `parallel_tool_calls: false` bug).
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

// ---------------------------------------------------------------------------
// Ollama driver — NDJSON
// ---------------------------------------------------------------------------

interface OllamaFrame {
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

function ollamaSerializeMessage(m: LocalChatMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { role: m.role, content: m.content };
  if (m.tool_calls) {
    out.tool_calls = m.tool_calls.map((tc) => ({
      function: { name: tc.function.name, arguments: tc.function.arguments ?? {} },
    }));
  }
  if (m.tool_name) out.tool_name = m.tool_name;
  return out;
}

export function createOllamaDriver(opts: DriverOpts): LocalDriver {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const url = opts.url;

  return {
    backend: "ollama",

    async probe(model, signal): Promise<LocalProbeResult> {
      let res: Response;
      try {
        res = await fetchImpl(`${url}/api/tags`, { signal });
      } catch (err) {
        return { ok: false, reason: `unreachable: ${(err as Error).message}` };
      }
      if (!res.ok) {
        return { ok: false, reason: `probe HTTP ${res.status}` };
      }
      const body = (await res.json().catch(() => null)) as
        | { models?: ReadonlyArray<{ name?: string }> }
        | null;
      const models = body?.models ?? [];
      const found = models.some((m) => m?.name === model);
      if (!found) {
        return {
          ok: false,
          modelMissing: true,
          reason: `model ${model} not pulled — run \`ollama pull ${model}\` on the host`,
        };
      }
      return { ok: true };
    },

    async *streamChat(opts): AsyncIterable<LocalChatEvent> {
      const body: Record<string, unknown> = {
        model: opts.model,
        messages: opts.messages.map(ollamaSerializeMessage),
        stream: true,
      };
      if (opts.tools && opts.tools.length > 0) body.tools = opts.tools;

      let res: Response;
      try {
        res = await fetchImpl(`${url}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: opts.signal,
        });
      } catch (err) {
        const e = err as Error;
        if (e.name === "AbortError") {
          throw new LocalDriverError("ollama", "timeout", "request aborted");
        }
        throw new LocalDriverError("ollama", "unreachable", `unreachable: ${url}`);
      }

      if (!res.ok) {
        const bodyText = await res.text().catch(() => "");
        let parsed: { error?: string } = {};
        try {
          parsed = JSON.parse(bodyText) as { error?: string };
        } catch {
          // not JSON — fall through
        }
        if (res.status === 404) {
          throw new LocalDriverError(
            "ollama",
            "model_missing",
            `model not found: ${opts.model} — pull with \`ollama pull ${opts.model}\` on the host`,
            404,
          );
        }
        const detail = parsed.error ?? (bodyText.slice(0, 200) || res.statusText);
        throw new LocalDriverError(
          "ollama",
          "http_error",
          `HTTP ${res.status} ${detail}`,
          res.status,
        );
      }
      if (!res.body) {
        throw new LocalDriverError("ollama", "http_error", "empty body");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let inputTokens: number | null = null;
      let outputTokens: number | null = null;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) continue;
            let frame: OllamaFrame;
            try {
              frame = JSON.parse(line) as OllamaFrame;
            } catch (parseErr) {
              log.warn("local.ollama_bad_frame", {
                error: (parseErr as Error).message,
                line: line.slice(0, 120),
              });
              continue;
            }
            if (frame.error) {
              yield { kind: "error", message: frame.error };
              return;
            }
            const chunk = frame.message?.content;
            if (chunk) yield { kind: "text", delta: chunk };
            const tcs = frame.message?.tool_calls;
            if (Array.isArray(tcs)) {
              for (const tc of tcs) {
                const fn = tc?.function;
                if (fn && typeof fn === "object" && typeof fn.name === "string") {
                  yield {
                    kind: "tool_call",
                    call: { function: { name: fn.name, arguments: fn.arguments ?? {} } },
                  };
                }
              }
            }
            if (frame.done) {
              inputTokens = frame.prompt_eval_count ?? null;
              outputTokens = frame.eval_count ?? null;
            }
          }
        }
      } catch (err) {
        // Symmetric with the LMStudio driver below: pass already-typed driver
        // errors through unchanged so their `code` discriminant survives. No
        // in-stream `LocalDriverError` throws exist in the Ollama path today,
        // but future defensive checks (e.g. context-window detection, symmetric
        // substitution detection if the daemon adds it) would otherwise get
        // their typed code clobbered by the generic `unreachable` wrap.
        if (err instanceof LocalDriverError) throw err;
        const e = err as Error;
        if (e.name === "AbortError") {
          throw new LocalDriverError("ollama", "timeout", "stream aborted");
        }
        throw new LocalDriverError("ollama", "unreachable", `stream failed: ${e.message}`);
      }

      yield { kind: "done", inputTokens, outputTokens };
    },
  };
}

// ---------------------------------------------------------------------------
// LMStudio driver — SSE
// ---------------------------------------------------------------------------

interface LmstudioSseToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface LmstudioSseChoice {
  index?: number;
  delta?: {
    role?: string;
    content?: string | null;
    tool_calls?: ReadonlyArray<LmstudioSseToolCallDelta>;
  };
  finish_reason?: string | null;
}

interface LmstudioSseFrame {
  // OpenAI streaming includes the model id on every chunk. LMStudio echoes the
  // *loaded* model here even when the request asked for an unloaded one — it
  // silently substitutes rather than 404'ing. Driver compares this against the
  // requested model on the first chunk to catch mid-session model swaps.
  model?: string;
  choices?: ReadonlyArray<LmstudioSseChoice>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface ToolCallAccumulator {
  id?: string;
  name: string;
  argsBuffer: string;
}

function lmstudioSerializeMessage(m: LocalChatMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { role: m.role, content: m.content };
  if (m.tool_calls) {
    out.tool_calls = m.tool_calls.map((tc, idx) => ({
      id: tc.id ?? `call_${idx}`,
      type: "function",
      function: {
        name: tc.function.name,
        // OpenAI compat: arguments is a JSON-encoded STRING, not an object.
        arguments:
          typeof tc.function.arguments === "string"
            ? tc.function.arguments
            : JSON.stringify(tc.function.arguments ?? {}),
      },
    }));
  }
  if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
  return out;
}

export function createLmstudioDriver(opts: DriverOpts): LocalDriver {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const url = opts.url;

  return {
    backend: "lmstudio",

    async probe(model, signal): Promise<LocalProbeResult> {
      let res: Response;
      try {
        res = await fetchImpl(`${url}/v1/models`, { signal });
      } catch (err) {
        return { ok: false, reason: `unreachable: ${(err as Error).message}` };
      }
      if (!res.ok) {
        return { ok: false, reason: `probe HTTP ${res.status}` };
      }
      const body = (await res.json().catch(() => null)) as
        | { data?: ReadonlyArray<{ id?: string }> }
        | null;
      const models = body?.data ?? [];
      const found = models.some((m) => m?.id === model);
      if (!found) {
        return {
          ok: false,
          modelMissing: true,
          reason: `model ${model} not loaded in LMStudio — load it via the LMStudio UI or \`lms load\``,
        };
      }
      return { ok: true };
    },

    async *streamChat(opts): AsyncIterable<LocalChatEvent> {
      const requestBody: Record<string, unknown> = {
        model: opts.model,
        messages: opts.messages.map(lmstudioSerializeMessage),
        stream: true,
        // Request token usage on the trailing chunk. Some LMStudio builds emit
        // it without this flag; explicit opt-in keeps behavior portable.
        stream_options: { include_usage: true },
      };
      if (opts.tools && opts.tools.length > 0) {
        requestBody.tools = opts.tools;
        // Gemma-4 + parallel_tool_calls workaround (lmstudio-bug-tracker #1756):
        // request serial calls and dedupe identical (name, args) pairs below.
        requestBody.parallel_tool_calls = false;
      }

      let res: Response;
      try {
        res = await fetchImpl(`${url}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(requestBody),
          signal: opts.signal,
        });
      } catch (err) {
        const e = err as Error;
        if (e.name === "AbortError") {
          throw new LocalDriverError("lmstudio", "timeout", "request aborted");
        }
        throw new LocalDriverError("lmstudio", "unreachable", `unreachable: ${url}`);
      }

      if (!res.ok) {
        const bodyText = await res.text().catch(() => "");
        let parsed: { error?: { message?: string } | string } = {};
        try {
          parsed = JSON.parse(bodyText) as { error?: { message?: string } | string };
        } catch {
          // not JSON
        }
        const errObj = parsed.error;
        const errMsg =
          typeof errObj === "string"
            ? errObj
            : (errObj?.message ?? (bodyText.slice(0, 200) || res.statusText));
        if (
          res.status === 404 ||
          (typeof errMsg === "string" && /model.*not.*(loaded|found)/i.test(errMsg))
        ) {
          throw new LocalDriverError(
            "lmstudio",
            "model_missing",
            `model not loaded in LMStudio: ${opts.model} — load via UI or \`lms load ${opts.model}\``,
            res.status,
          );
        }
        throw new LocalDriverError(
          "lmstudio",
          "http_error",
          `HTTP ${res.status} ${errMsg}`,
          res.status,
        );
      }
      if (!res.body) {
        throw new LocalDriverError("lmstudio", "http_error", "empty body");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let inputTokens: number | null = null;
      let outputTokens: number | null = null;
      // Tracks whether we've validated the served-model id against the
      // requested one. LMStudio happily serves whatever's loaded when the
      // requested id isn't — silently. Per-turn validation is required because
      // `probe()` only runs at boot; operators who swap models mid-session
      // would otherwise see wrong-model responses with no signal.
      let modelChecked = false;
      // Per-assistant-message tool-call accumulator. Each entry indexed by
      // the `tool_calls[i].index` field from the OpenAI delta protocol.
      const toolAccum = new Map<number, ToolCallAccumulator>();
      // Dedup set within this assistant message (Gemma-4 workaround). Keyed
      // by stableStringify of `{name, args}` so re-ordered arg keys don't slip
      // through.
      const emittedDedup = new Set<string>();

      function emitAccumulated(): LocalChatEvent[] {
        const events: LocalChatEvent[] = [];
        // Emit in index order so the consumer sees calls in declaration order.
        const indices = [...toolAccum.keys()].sort((a, b) => a - b);
        for (const i of indices) {
          const acc = toolAccum.get(i);
          if (!acc) continue;
          let parsedArgs: unknown;
          try {
            parsedArgs = acc.argsBuffer === "" ? {} : JSON.parse(acc.argsBuffer);
          } catch {
            // Pass the raw string through; downstream `normalizeToolArgs`
            // will retry. The schema validator will produce a clean error
            // if the model emitted garbage.
            parsedArgs = acc.argsBuffer;
          }
          const dedupKey = stableStringify({ name: acc.name, args: parsedArgs });
          if (emittedDedup.has(dedupKey)) {
            log.info("local.lmstudio_tool_call_deduped", { name: acc.name });
            continue;
          }
          emittedDedup.add(dedupKey);
          events.push({
            kind: "tool_call",
            call: {
              id: acc.id,
              function: { name: acc.name, arguments: parsedArgs },
            },
          });
        }
        toolAccum.clear();
        return events;
      }

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          // SSE events end at `\n\n`. Tolerate `\r\n\r\n` from servers that
          // ship CRLF — collapse to LF first.
          buffer = buffer.replace(/\r\n/g, "\n");
          let evtEnd: number;
          while ((evtEnd = buffer.indexOf("\n\n")) !== -1) {
            const rawEvent = buffer.slice(0, evtEnd);
            buffer = buffer.slice(evtEnd + 2);
            // An event may have multiple lines (e.g. `event: ...` then
            // `data: ...`). Pick the `data:` line(s). Spec allows multiple
            // `data:` lines per event concatenated with `\n`; tolerate.
            const dataLines: string[] = [];
            for (const line of rawEvent.split("\n")) {
              if (line.startsWith("data:")) {
                dataLines.push(line.slice(5).replace(/^ /, ""));
              }
            }
            if (dataLines.length === 0) continue;
            const data = dataLines.join("\n");
            if (data === "[DONE]") {
              // Emit any pending accumulated tool calls before done.
              for (const evt of emitAccumulated()) yield evt;
              yield { kind: "done", inputTokens, outputTokens };
              return;
            }
            let frame: LmstudioSseFrame;
            try {
              frame = JSON.parse(data) as LmstudioSseFrame;
            } catch (parseErr) {
              log.warn("local.lmstudio_bad_frame", {
                error: (parseErr as Error).message,
                data: data.slice(0, 120),
              });
              continue;
            }
            if (!modelChecked && typeof frame.model === "string" && frame.model.length > 0) {
              modelChecked = true;
              // Case-insensitive compare: LMStudio echoes the canonical id
              // (e.g. `Qwen/Qwen2.5-7B-Instruct-GGUF`) even when LOCAL_MODEL
              // is lowercased. The OpenAI streaming protocol doesn't require
              // strict echo, so only treat differing IDs as substitution, not
              // case-normalized echoes of the same id.
              if (frame.model.toLowerCase() !== opts.model.toLowerCase()) {
                throw new LocalDriverError(
                  "lmstudio",
                  "model_missing",
                  `model not loaded in LMStudio: ${opts.model} — LMStudio served '${frame.model}' instead. Load with \`lms load ${opts.model}\``,
                );
              }
            }
            // `usage` may arrive on a dedicated trailing chunk (empty choices)
            // or inline on the last content chunk. Capture whichever arrives.
            if (frame.usage) {
              if (typeof frame.usage.prompt_tokens === "number") {
                inputTokens = frame.usage.prompt_tokens;
              }
              if (typeof frame.usage.completion_tokens === "number") {
                outputTokens = frame.usage.completion_tokens;
              }
            }
            const choices = frame.choices;
            if (!Array.isArray(choices) || choices.length === 0) continue;
            const choice = choices[0]!;
            const delta = choice.delta;
            if (delta) {
              if (typeof delta.content === "string" && delta.content.length > 0) {
                yield { kind: "text", delta: delta.content };
              }
              if (Array.isArray(delta.tool_calls)) {
                for (const tc of delta.tool_calls) {
                  const idx = typeof tc.index === "number" ? tc.index : 0;
                  let acc = toolAccum.get(idx);
                  if (!acc) {
                    acc = { name: "", argsBuffer: "" };
                    toolAccum.set(idx, acc);
                  }
                  if (typeof tc.id === "string") acc.id = tc.id;
                  if (tc.function?.name) acc.name = tc.function.name;
                  if (typeof tc.function?.arguments === "string") {
                    acc.argsBuffer += tc.function.arguments;
                  }
                }
              }
            }
            // `finish_reason` marks the end of one assistant message; emit
            // any accumulated tool_calls now (before any subsequent message
            // could reset the accumulator). LMStudio always emits at most
            // one assistant message per streamed completion so in practice
            // this fires once near the end.
            if (choice.finish_reason) {
              for (const evt of emitAccumulated()) yield evt;
            }
          }
        }
      } catch (err) {
        // Pass already-typed driver errors through unchanged (e.g. the
        // model-mismatch detection above) so callers see the precise code.
        if (err instanceof LocalDriverError) throw err;
        const e = err as Error;
        if (e.name === "AbortError") {
          throw new LocalDriverError("lmstudio", "timeout", "stream aborted");
        }
        throw new LocalDriverError("lmstudio", "unreachable", `stream failed: ${e.message}`);
      }

      // Stream ended without a `[DONE]` line (some servers omit it). Flush
      // any pending tool calls and emit done with whatever usage we saw.
      for (const evt of emitAccumulated()) yield evt;
      yield { kind: "done", inputTokens, outputTokens };
    },
  };
}

/**
 * Pick the driver implementation for the configured backend. Centralized so
 * callers (main.ts boot wiring, test harness) don't duplicate the switch.
 */
export function createLocalDriver(
  backend: LocalBackend,
  opts: DriverOpts,
): LocalDriver {
  if (backend === "ollama") return createOllamaDriver(opts);
  return createLmstudioDriver(opts);
}
