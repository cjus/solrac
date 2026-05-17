/**
 * @fileoverview Engine-slot driver for hosted/remote LLM providers — currently
 *               OpenRouter; designed so future remote backends (Together,
 *               Groq, Fireworks, …) slot in as additional factories.
 * @purpose Hide every wire-format detail of remote OpenAI-compatible APIs
 *          behind the normalized `EngineChatEvent` stream so the runner in
 *          `engine.ts` consumes one shape regardless of whether the engine
 *          slot is filled by an on-host daemon or a hosted provider.
 *
 * Today: one implementation.
 *   - `OpenrouterDriver` — `POST ${baseUrl}/chat/completions` SSE (`data:`
 *     events, `[DONE]` terminator). Probe: `GET ${baseUrl}/models`. Auth via
 *     `Authorization: Bearer <apiKey>`. Attribution via `HTTP-Referer` +
 *     `X-Title`. Captures `usage.cost` (USD) from the trailing chunk so the
 *     runner writes a real per-turn cost to `audit.cost_usd`, gating the
 *     same per-chat + global hourly cost caps as Anthropic burn.
 *
 * Why a dedicated file (vs sharing the LMStudio SSE driver):
 *   The bodies are 95% identical but each backend has quirks that have
 *   already drifted (LMStudio silent-substitution, Gemma-4 dedup, harmony
 *   tokens) and will keep drifting. Duplication scopes regression risk
 *   per-backend; the cross-cutting concern (cost capture) lives in a single
 *   line per driver — easy to keep in sync, hard to accidentally couple.
 *
 * Differences from the LMStudio driver in `local-driver.ts`:
 *   - Endpoint is `${baseUrl}/chat/completions` (OpenRouter's base URL
 *     already contains `/api/v1`; LMStudio's base URL does not).
 *   - `Authorization: Bearer <apiKey>` is required.
 *   - `HTTP-Referer` + `X-Title` are recommended attribution headers;
 *     OpenRouter uses them for analytics + listing in the model-usage
 *     leaderboard.
 *   - No `parallel_tool_calls: false` flag — OpenRouter routes to the actual
 *     provider's API, which handles parallel calls correctly (the Gemma-4
 *     bug was specifically LMStudio's adapter).
 *   - No silent model substitution — OpenRouter returns HTTP 4xx with an
 *     error message when the model slug is unknown, so the first-chunk model
 *     check is skipped (it would also break legitimate provider-fallback
 *     responses where `chunk.model` is the served model, not the requested
 *     one).
 *   - `usage.cost` (USD) is included in the trailing chunk automatically —
 *     no opt-in required (the historical `usage: { include: true }` /
 *     `stream_options: { include_usage: true }` flags are deprecated and
 *     have no effect as of 2026 per OpenRouter docs). Captured and emitted
 *     via the `done` event so the runner can write a real cost to
 *     `audit.cost_usd`.
 *   - Probe path is `${baseUrl}/models` (no `/v1` prefix doubled).
 *
 * Position in the dependency graph:
 *   log + engine-driver → remote-driver → engine-tools, engine
 *
 * Exports:
 *   - `OpenrouterDriverOpts` — factory options (extends `DriverOpts` with
 *     `apiKey`, optional `referer`, optional `title`).
 *   - `createOpenrouterDriver(opts)` — OpenRouter factory.
 *   - `createRemoteDriver(backend, opts)` — dispatch factory; mirrors
 *     `createLocalDriver` in shape so boot wiring stays symmetric.
 *
 * Key invariants:
 *   - Each driver sets `mode: "remote"` so the runner writes the
 *     `remote:<backend>:<model>` audit-tag prefix and captures cost.
 *   - The OpenRouter driver populates `EngineChatEvent.done.costUsd` from
 *     `usage.cost` in the trailing SSE chunk. If the field is absent (the
 *     model omitted it, or OpenRouter changed shape), `costUsd` stays
 *     `null` — the runner writes `audit.cost_usd = null` plus a
 *     `remote.cost_missing` warn, NOT `0` (a `0` would silently bypass the
 *     `COALESCE(SUM(cost_usd), 0)` cost cap).
 */

import {
  type DriverOpts,
  type EngineBackend,
  type EngineChatEvent,
  type EngineChatMessage,
  type EngineDriver,
  type EngineProbeResult,
  EngineDriverError,
  RAW_FRAME_BUFFER_MAX,
  RAW_FRAME_TRUNC,
  maybeLogEmptyStream,
  stableStringify,
} from "./engine-driver.ts";
import { log } from "./log.ts";

/**
 * OpenRouter-specific factory options. Required auth + recommended
 * attribution headers. Distinct from `DriverOpts` so callers can't
 * accidentally pass an Ollama/LMStudio config to the openrouter factory.
 */
export interface OpenrouterDriverOpts extends DriverOpts {
  apiKey: string;
  // OpenRouter attribution headers — recommended (not required). Optional
  // here so tests don't need to set them; main.ts boot wiring supplies
  // operator-configurable defaults.
  referer?: string;
  title?: string;
}

// ---------------------------------------------------------------------------
// OpenRouter SSE frame shapes
// ---------------------------------------------------------------------------
//
// Cloned from `LmstudioSseFrame` in local-driver.ts intentionally — each
// backend's quirks have drifted before and will drift again (e.g. provider-
// fallback metadata, BYOK signaling). Keeping the typedef per-driver scopes
// future churn to one file at a time.

interface OpenrouterSseToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenrouterSseChoice {
  index?: number;
  delta?: {
    role?: string;
    content?: string | null;
    tool_calls?: ReadonlyArray<OpenrouterSseToolCallDelta>;
  };
  finish_reason?: string | null;
}

interface OpenrouterSseFrame {
  // OpenAI streaming includes the model id on every chunk. OpenRouter echoes
  // the served-model id (which differs from the requested one under provider-
  // fallback). Driver does NOT compare this against the requested model —
  // legitimate fallbacks would otherwise look like substitution.
  model?: string;
  choices?: ReadonlyArray<OpenrouterSseChoice>;
  // OpenAI's streaming usage shape. OpenRouter populates `cost` (USD) and
  // `is_byok` in addition to the standard token counts; the runner reads
  // `cost` to write `audit.cost_usd`.
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number;
    is_byok?: boolean;
  };
  // OpenRouter inlines errors inside the SSE stream rather than via HTTP
  // status when the upstream provider returns mid-stream. Surface to the
  // consumer as a normalized `error` event.
  error?: { message?: string } | string;
}

interface ToolCallAccumulator {
  id?: string;
  name: string;
  argsBuffer: string;
}

function openrouterSerializeMessage(m: EngineChatMessage): Record<string, unknown> {
  // Identical to LMStudio's serializer — OpenRouter is OpenAI-compatible at
  // the message-shape level. Duplicated rather than shared because the
  // shapes can diverge per-backend in the future (e.g. provider-specific
  // message metadata) and a shared helper would invite premature unification.
  const out: Record<string, unknown> = { role: m.role, content: m.content };
  if (m.tool_calls) {
    out.tool_calls = m.tool_calls.map((tc, idx) => ({
      id: tc.id ?? `call_${idx}`,
      type: "function",
      function: {
        name: tc.function.name,
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

export function createOpenrouterDriver(opts: OpenrouterDriverOpts): EngineDriver {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const url = opts.url;
  const apiKey = opts.apiKey;
  // Attribution headers — recommended by OpenRouter docs; not required, but
  // omitting them means our usage shows as "anonymous" in OpenRouter's model
  // leaderboards. Defaults keep dev-mode boots from needing extra env wiring.
  const referer = opts.referer ?? "https://github.com/cjus/solrac";
  const title = opts.title ?? "solrac";

  function authHeaders(): Record<string, string> {
    return {
      authorization: `Bearer ${apiKey}`,
      "http-referer": referer,
      "x-title": title,
    };
  }

  return {
    backend: "openrouter",
    mode: "remote",

    async probe(model, signal): Promise<EngineProbeResult> {
      let res: Response;
      try {
        res = await fetchImpl(`${url}/models`, {
          signal,
          headers: authHeaders(),
        });
      } catch (err) {
        return { ok: false, reason: `unreachable: ${(err as Error).message}` };
      }
      if (!res.ok) {
        // 401 here usually means a bad API key; surface as `auth_failed` text
        // so the operator's boot log makes the fix obvious.
        if (res.status === 401) {
          return { ok: false, reason: `auth_failed: invalid REMOTE_API_KEY (HTTP 401)` };
        }
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
          reason: `model ${model} not listed on OpenRouter — check the slug at https://openrouter.ai/models`,
        };
      }
      return { ok: true };
    },

    async *streamChat(opts): AsyncIterable<EngineChatEvent> {
      const requestBody: Record<string, unknown> = {
        model: opts.model,
        messages: opts.messages.map(openrouterSerializeMessage),
        stream: true,
      };
      if (opts.tools && opts.tools.length > 0) {
        requestBody.tools = opts.tools;
      }

      let res: Response;
      try {
        res = await fetchImpl(`${url}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...authHeaders(),
          },
          body: JSON.stringify(requestBody),
          signal: opts.signal,
        });
      } catch (err) {
        const e = err as Error;
        if (e.name === "AbortError") {
          throw new EngineDriverError("openrouter", "timeout", "request aborted");
        }
        throw new EngineDriverError("openrouter", "unreachable", `unreachable: ${url}`);
      }

      if (!res.ok) {
        const bodyText = await res.text().catch(() => "");
        let parsed: { error?: { message?: string; code?: number } | string } = {};
        try {
          parsed = JSON.parse(bodyText) as {
            error?: { message?: string; code?: number } | string;
          };
        } catch {
          // not JSON
        }
        const errObj = parsed.error;
        const errMsg =
          typeof errObj === "string"
            ? errObj
            : (errObj?.message ?? (bodyText.slice(0, 200) || res.statusText));
        if (res.status === 401) {
          throw new EngineDriverError(
            "openrouter",
            "http_error",
            `auth failed (HTTP 401): ${errMsg} — check REMOTE_API_KEY`,
            401,
          );
        }
        // OpenRouter returns 404 (or a 4xx with "model" in the message) when
        // the requested slug is unknown. Surface as `model_missing` so the
        // boot probe + per-turn render share the same diagnostic.
        if (
          res.status === 404 ||
          (typeof errMsg === "string" && /model.*not.*(found|exist|available)/i.test(errMsg))
        ) {
          throw new EngineDriverError(
            "openrouter",
            "model_missing",
            `model not available on OpenRouter: ${opts.model} — ${errMsg}`,
            res.status,
          );
        }
        throw new EngineDriverError(
          "openrouter",
          "http_error",
          `HTTP ${res.status} ${errMsg}`,
          res.status,
        );
      }
      if (!res.body) {
        throw new EngineDriverError("openrouter", "http_error", "empty body");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let inputTokens: number | null = null;
      let outputTokens: number | null = null;
      // OpenRouter populates `usage.cost` (USD) in the trailing usage chunk,
      // independently of token counts. `null` here means the field never
      // arrived; the runner treats `null` as "cost unknown" (NOT zero) and
      // writes `audit.cost_usd = null` plus a `remote.cost_missing` warn so
      // operators see the issue. Without that distinction, a missing field
      // would slip past the cap query's `COALESCE(SUM(cost_usd), 0)`.
      let costUsd: number | null = null;
      const toolAccum = new Map<number, ToolCallAccumulator>();
      const emittedDedup = new Set<string>();
      const rawFrameBuffer: string[] = [];
      let textCharsEmitted = 0;
      let toolCallsEmitted = 0;

      function emitAccumulated(): EngineChatEvent[] {
        const events: EngineChatEvent[] = [];
        const indices = [...toolAccum.keys()].sort((a, b) => a - b);
        for (const i of indices) {
          const acc = toolAccum.get(i);
          if (!acc) continue;
          let parsedArgs: unknown;
          try {
            parsedArgs = acc.argsBuffer === "" ? {} : JSON.parse(acc.argsBuffer);
          } catch {
            parsedArgs = acc.argsBuffer;
          }
          const dedupKey = stableStringify({ name: acc.name, args: parsedArgs });
          if (emittedDedup.has(dedupKey)) {
            log.info("openrouter.tool_call_deduped", { name: acc.name });
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
          buffer = buffer.replace(/\r\n/g, "\n");
          let evtEnd: number;
          while ((evtEnd = buffer.indexOf("\n\n")) !== -1) {
            const rawEvent = buffer.slice(0, evtEnd);
            buffer = buffer.slice(evtEnd + 2);
            const dataLines: string[] = [];
            for (const line of rawEvent.split("\n")) {
              if (line.startsWith("data:")) {
                dataLines.push(line.slice(5).replace(/^ /, ""));
              }
            }
            if (dataLines.length === 0) continue;
            const data = dataLines.join("\n");
            // OpenRouter sometimes emits keep-alive SSE comments (`: ...`) on
            // long-running streams. Those have no `data:` line; the dataLines
            // filter above already drops them. Belt-and-suspenders: skip empty
            // payloads.
            if (data === "") continue;
            if (rawFrameBuffer.length < RAW_FRAME_BUFFER_MAX) {
              rawFrameBuffer.push(data.slice(0, RAW_FRAME_TRUNC));
            }
            if (data === "[DONE]") {
              const pending = emitAccumulated();
              toolCallsEmitted += pending.length;
              for (const evt of pending) yield evt;
              maybeLogEmptyStream({
                model: opts.model,
                textCharsEmitted,
                toolCallsEmitted,
                rawFrameBuffer,
                logEvent: "openrouter.empty_stream",
              });
              yield { kind: "done", inputTokens, outputTokens, costUsd };
              return;
            }
            let frame: OpenrouterSseFrame;
            try {
              frame = JSON.parse(data) as OpenrouterSseFrame;
            } catch (parseErr) {
              log.warn("openrouter.bad_frame", {
                error: (parseErr as Error).message,
                data: data.slice(0, 120),
              });
              continue;
            }
            if (frame.error !== undefined) {
              const msg =
                typeof frame.error === "string"
                  ? frame.error
                  : (frame.error.message ?? "openrouter returned an error frame");
              yield { kind: "error", message: msg };
              return;
            }
            // Capture usage (tokens + cost) from any chunk that carries it.
            // OpenRouter sends it on a dedicated trailing chunk AFTER the
            // finish_reason chunk; the parser tolerates either position.
            if (frame.usage) {
              if (typeof frame.usage.prompt_tokens === "number") {
                inputTokens = frame.usage.prompt_tokens;
              }
              if (typeof frame.usage.completion_tokens === "number") {
                outputTokens = frame.usage.completion_tokens;
              }
              if (typeof frame.usage.cost === "number") {
                costUsd = frame.usage.cost;
              }
            }
            const choices = frame.choices;
            if (!Array.isArray(choices) || choices.length === 0) continue;
            const choice = choices[0]!;
            const delta = choice.delta;
            if (delta) {
              if (typeof delta.content === "string" && delta.content.length > 0) {
                textCharsEmitted += delta.content.length;
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
            if (choice.finish_reason) {
              const pending = emitAccumulated();
              toolCallsEmitted += pending.length;
              for (const evt of pending) yield evt;
            }
          }
        }
      } catch (err) {
        if (err instanceof EngineDriverError) throw err;
        const e = err as Error;
        if (e.name === "AbortError") {
          throw new EngineDriverError("openrouter", "timeout", "stream aborted");
        }
        throw new EngineDriverError(
          "openrouter",
          "unreachable",
          `stream failed: ${e.message}`,
        );
      }

      // Stream ended without a `[DONE]` line. Flush pending tool calls and
      // emit done with whatever usage we captured.
      const pending = emitAccumulated();
      toolCallsEmitted += pending.length;
      for (const evt of pending) yield evt;
      maybeLogEmptyStream({
        model: opts.model,
        textCharsEmitted,
        toolCallsEmitted,
        rawFrameBuffer,
        logEvent: "openrouter.empty_stream",
      });
      yield { kind: "done", inputTokens, outputTokens, costUsd };
    },
  };
}

/**
 * Pick the driver implementation for the configured remote backend. Mirrors
 * `createLocalDriver` in `local-driver.ts` so boot wiring in `main.ts` stays
 * symmetric across modes.
 *
 * Today only `openrouter` is supported. Future remote providers (Together,
 * Groq, Fireworks, …) add new factories above and a new branch here.
 */
export function createRemoteDriver(
  backend: EngineBackend,
  opts: OpenrouterDriverOpts,
): EngineDriver {
  if (backend === "openrouter") return createOpenrouterDriver(opts);
  throw new Error(
    `createRemoteDriver: unsupported backend "${backend}" (expected "openrouter")`,
  );
}

// ---------------------------------------------------------------------------
// Capability note (remote-mode system-prompt clause)
// ---------------------------------------------------------------------------

/**
 * Remote-mode capability statement appended to SOUL.md before it ships as
 * the first `system` message. Always frames the cost as per-token via
 * OpenRouter, encouraging the model to be concise (the existing per-chat +
 * global hourly cost caps gate burn — this is the operator-friendly nudge
 * in the prompt itself). Local-mode (Ollama / LMStudio) has a parallel
 * `buildLocalCapabilityNote` in `local-driver.ts`. The runner in `engine.ts`
 * picks the right builder from `driver.mode`.
 *
 * Matrix mirrors `LocalCapabilityNoteOpts`; the only diff is the cost
 * clause. Kept as two separate builders (rather than one with a `mode`
 * parameter) so each builder reads as a coherent story for its mode.
 */
export interface RemoteCapabilityNoteOpts {
  toolsEnabled: boolean;
  isDefaultEngine: boolean;
  toolNames: ReadonlyArray<string>;
}

export function buildRemoteCapabilityNote(opts: RemoteCapabilityNoteOpts): string {
  const { toolsEnabled, isDefaultEngine, toolNames } = opts;
  const costClause = "your replies cost the operator per-token via OpenRouter, so be concise";
  if (toolsEnabled) {
    const list = toolNames.join(", ");
    return (
      `You are the default chat engine; ${costClause}. ` +
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
      `You are the default chat engine; ${costClause}. ` +
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
 * Convenience for the tools-on path. Defers to `buildRemoteCapabilityNote`
 * so the matrix has a single source of truth.
 */
export function buildRemoteToolCapabilityNote(
  toolNames: ReadonlyArray<string>,
  isDefaultEngine: boolean,
): string {
  return buildRemoteCapabilityNote({
    toolsEnabled: true,
    isDefaultEngine,
    toolNames,
  });
}
