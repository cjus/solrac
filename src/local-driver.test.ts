/**
 * @fileoverview Unit tests for `local-driver.ts` — on-host backends only
 *               (Ollama + LMStudio). OpenRouter tests live in
 *               `remote-driver.test.ts`.
 * @proves NDJSON and SSE wire-format parsing, partial-line buffering,
 *         multi-event-per-chunk, tool-call arg-delta accumulation,
 *         Gemma-4 dedup, usage-chunk capture, error paths.
 *
 * Drivers ship with handwritten-fake fetches (no mocking framework,
 * per CLAUDE.md Testing Philosophy). Each test constructs a `Response` with
 * a `ReadableStream` body so the driver consumes real chunk boundaries —
 * partial-line / partial-event behavior is exercised by hand-splitting the
 * payload into multiple `controller.enqueue` calls.
 */

import { describe, expect, test } from "bun:test";
import {
  EngineDriverError,
  type EngineChatEvent,
} from "./engine-driver.ts";
import { createLmstudioDriver, createOllamaDriver } from "./local-driver.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function streamResponse(chunks: string[], status = 200): Response {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status });
}

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeFetch(
  impl: (url: string, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(impl(String(url), init))) as unknown as typeof fetch;
}

async function collectEvents(
  iter: AsyncIterable<EngineChatEvent>,
): Promise<EngineChatEvent[]> {
  const out: EngineChatEvent[] = [];
  for await (const evt of iter) out.push(evt);
  return out;
}

// ---------------------------------------------------------------------------
// OllamaDriver — probe
// ---------------------------------------------------------------------------

describe("OllamaDriver — probe", () => {
  test("model present → ok", async () => {
    const fetch = fakeFetch((url) => {
      expect(url).toBe("http://localhost:11434/api/tags");
      return jsonResponse({ models: [{ name: "gemma3:e4b" }, { name: "llama3.2" }] });
    });
    const driver = createOllamaDriver({ url: "http://localhost:11434", fetch });
    const result = await driver.probe("gemma3:e4b");
    expect(result.ok).toBe(true);
  });

  test("model absent → modelMissing with actionable hint", async () => {
    const fetch = fakeFetch(() => jsonResponse({ models: [{ name: "llama3.2" }] }));
    const driver = createOllamaDriver({ url: "http://localhost:11434", fetch });
    const result = await driver.probe("gemma3:e4b");
    expect(result.ok).toBe(false);
    expect(result.modelMissing).toBe(true);
    expect(result.reason).toMatch(/ollama pull gemma3:e4b/);
  });

  test("HTTP 500 from /api/tags → ok:false", async () => {
    const fetch = fakeFetch(() => new Response("oops", { status: 500 }));
    const driver = createOllamaDriver({ url: "http://localhost:11434", fetch });
    const result = await driver.probe("gemma3:e4b");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/HTTP 500/);
  });

  test("network error → ok:false unreachable", async () => {
    const fetch = (() => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof globalThis.fetch;
    const driver = createOllamaDriver({ url: "http://localhost:11434", fetch });
    const result = await driver.probe("gemma3:e4b");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/unreachable/);
  });
});

// ---------------------------------------------------------------------------
// OllamaDriver — streamChat
// ---------------------------------------------------------------------------

describe("OllamaDriver — streamChat text", () => {
  test("single-frame text + done", async () => {
    const body = [
      JSON.stringify({ message: { role: "assistant", content: "hello" } }) + "\n",
      JSON.stringify({
        done: true,
        prompt_eval_count: 5,
        eval_count: 3,
        message: { role: "assistant", content: "" },
      }) + "\n",
    ];
    const fetch = fakeFetch(() => streamResponse(body));
    const driver = createOllamaDriver({ url: "http://x", fetch });
    const events = await collectEvents(
      driver.streamChat({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    );
    expect(events).toEqual([
      { kind: "text", delta: "hello" },
      { kind: "done", inputTokens: 5, outputTokens: 3 , costUsd: null },
    ]);
  });

  test("partial-line buffering across read chunks", async () => {
    const frame1 =
      JSON.stringify({ message: { content: "hel" } }) + "\n";
    const frame2 =
      JSON.stringify({ message: { content: "lo" } }) + "\n";
    const done = JSON.stringify({ done: true, prompt_eval_count: 1, eval_count: 2 }) + "\n";
    // Split each frame mid-JSON across multiple chunks so the driver MUST
    // buffer. Concatenation: `<half1><half2-of-frame1><frame2-start><frame2-end\n><done>`.
    const blob = frame1 + frame2 + done;
    const chunkA = blob.slice(0, 15);
    const chunkB = blob.slice(15, 40);
    const chunkC = blob.slice(40);
    const fetch = fakeFetch(() => streamResponse([chunkA, chunkB, chunkC]));
    const driver = createOllamaDriver({ url: "http://x", fetch });
    const events = await collectEvents(
      driver.streamChat({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    );
    const texts = events.filter((e): e is EngineChatEvent & { kind: "text" } => e.kind === "text").map((e) => e.delta);
    expect(texts.join("")).toBe("hello");
    expect(events.at(-1)).toEqual({ kind: "done", inputTokens: 1, outputTokens: 2 , costUsd: null });
  });

  test("tool_calls on final frame produces tool_call events", async () => {
    const body = [
      JSON.stringify({ message: { content: "calling tool…" } }) + "\n",
      JSON.stringify({
        done: true,
        prompt_eval_count: 10,
        eval_count: 5,
        message: {
          content: "",
          tool_calls: [
            { function: { name: "time_now", arguments: { tz: "UTC" } } },
          ],
        },
      }) + "\n",
    ];
    const fetch = fakeFetch(() => streamResponse(body));
    const driver = createOllamaDriver({ url: "http://x", fetch });
    const events = await collectEvents(
      driver.streamChat({ model: "m", messages: [{ role: "user", content: "what time?" }] }),
    );
    const toolEvt = events.find((e): e is EngineChatEvent & { kind: "tool_call" } => e.kind === "tool_call");
    expect(toolEvt?.call.function.name).toBe("time_now");
    expect(toolEvt?.call.function.arguments).toEqual({ tz: "UTC" });
  });

  test("frame.error → error event terminates stream", async () => {
    const body = [
      JSON.stringify({ message: { content: "starting" } }) + "\n",
      JSON.stringify({ error: "model out of memory" }) + "\n",
    ];
    const fetch = fakeFetch(() => streamResponse(body));
    const driver = createOllamaDriver({ url: "http://x", fetch });
    const events = await collectEvents(
      driver.streamChat({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    );
    expect(events).toEqual([
      { kind: "text", delta: "starting" },
      { kind: "error", message: "model out of memory" },
    ]);
  });

  test("malformed JSON line is skipped, not fatal", async () => {
    const body = [
      "{not json\n",
      JSON.stringify({ message: { content: "ok" } }) + "\n",
      JSON.stringify({ done: true, prompt_eval_count: 1, eval_count: 1 }) + "\n",
    ];
    const fetch = fakeFetch(() => streamResponse(body));
    const driver = createOllamaDriver({ url: "http://x", fetch });
    const events = await collectEvents(
      driver.streamChat({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    );
    const texts = events.filter((e) => e.kind === "text");
    expect(texts).toHaveLength(1);
  });
});

describe("OllamaDriver — streamChat errors", () => {
  test("HTTP 404 → EngineDriverError model_missing with pull hint", async () => {
    const fetch = fakeFetch(
      () => new Response(JSON.stringify({ error: "model not found" }), { status: 404 }),
    );
    const driver = createOllamaDriver({ url: "http://x", fetch });
    try {
      await collectEvents(
        driver.streamChat({ model: "gemma3:e4b", messages: [{ role: "user", content: "hi" }] }),
      );
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(EngineDriverError);
      expect((err as EngineDriverError).code).toBe("model_missing");
      expect((err as EngineDriverError).message).toMatch(/ollama pull gemma3:e4b/);
    }
  });

  test("HTTP 500 → EngineDriverError http_error", async () => {
    const fetch = fakeFetch(() => new Response("oom", { status: 500 }));
    const driver = createOllamaDriver({ url: "http://x", fetch });
    try {
      await collectEvents(
        driver.streamChat({ model: "m", messages: [{ role: "user", content: "hi" }] }),
      );
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(EngineDriverError);
      expect((err as EngineDriverError).code).toBe("http_error");
      expect((err as EngineDriverError).status).toBe(500);
    }
  });

  test("network error → EngineDriverError unreachable", async () => {
    const fetch = (() => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof globalThis.fetch;
    const driver = createOllamaDriver({ url: "http://x", fetch });
    try {
      await collectEvents(
        driver.streamChat({ model: "m", messages: [{ role: "user", content: "hi" }] }),
      );
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(EngineDriverError);
      expect((err as EngineDriverError).code).toBe("unreachable");
    }
  });

  test("AbortSignal pre-fetch → EngineDriverError timeout", async () => {
    const fetch = ((_url: string, init?: RequestInit) => {
      const e = new Error("aborted");
      e.name = "AbortError";
      // Simulate fetch rejecting because signal was aborted before/during the call.
      if (init?.signal?.aborted) return Promise.reject(e);
      return Promise.reject(e);
    }) as unknown as typeof globalThis.fetch;
    const ac = new AbortController();
    ac.abort();
    const driver = createOllamaDriver({ url: "http://x", fetch });
    try {
      await collectEvents(
        driver.streamChat({
          model: "m",
          messages: [{ role: "user", content: "hi" }],
          signal: ac.signal,
        }),
      );
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(EngineDriverError);
      expect((err as EngineDriverError).code).toBe("timeout");
    }
  });
});

// ---------------------------------------------------------------------------
// LmstudioDriver — probe
// ---------------------------------------------------------------------------

describe("LmstudioDriver — probe", () => {
  test("model present in data[] → ok", async () => {
    const fetch = fakeFetch((url) => {
      expect(url).toBe("http://localhost:1234/v1/models");
      return jsonResponse({ data: [{ id: "qwen2.5-7b" }, { id: "llama3.2" }] });
    });
    const driver = createLmstudioDriver({ url: "http://localhost:1234", fetch });
    const result = await driver.probe("qwen2.5-7b");
    expect(result.ok).toBe(true);
  });

  test("model absent → modelMissing", async () => {
    const fetch = fakeFetch(() => jsonResponse({ data: [{ id: "other" }] }));
    const driver = createLmstudioDriver({ url: "http://localhost:1234", fetch });
    const result = await driver.probe("qwen2.5-7b");
    expect(result.ok).toBe(false);
    expect(result.modelMissing).toBe(true);
    expect(result.reason).toMatch(/qwen2\.5-7b/);
  });
});

// ---------------------------------------------------------------------------
// LmstudioDriver — streamChat (SSE wire format)
// ---------------------------------------------------------------------------

function ssePayload(events: Array<Record<string, unknown> | "[DONE]">): string {
  return events.map((e) => (e === "[DONE]" ? "data: [DONE]\n\n" : `data: ${JSON.stringify(e)}\n\n`)).join("");
}

describe("LmstudioDriver — streamChat text", () => {
  test("simple text completion with [DONE] terminator", async () => {
    const body = ssePayload([
      { choices: [{ delta: { role: "assistant", content: "" } }] },
      { choices: [{ delta: { content: "hello " } }] },
      { choices: [{ delta: { content: "world" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      "[DONE]",
    ]);
    const fetch = fakeFetch(() => streamResponse([body]));
    const driver = createLmstudioDriver({ url: "http://x", fetch });
    const events = await collectEvents(
      driver.streamChat({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    );
    const texts = events.filter((e) => e.kind === "text") as Array<EngineChatEvent & { kind: "text" }>;
    expect(texts.map((t) => t.delta).join("")).toBe("hello world");
    expect(events.at(-1)).toEqual({ kind: "done", inputTokens: null, outputTokens: null , costUsd: null });
  });

  test("multiple SSE events in one chunk are all parsed", async () => {
    const body = ssePayload([
      { choices: [{ delta: { content: "a" } }] },
      { choices: [{ delta: { content: "b" } }] },
      { choices: [{ delta: { content: "c" } }] },
      "[DONE]",
    ]);
    const fetch = fakeFetch(() => streamResponse([body]));
    const driver = createLmstudioDriver({ url: "http://x", fetch });
    const events = await collectEvents(
      driver.streamChat({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    );
    const texts = events.filter((e) => e.kind === "text") as Array<EngineChatEvent & { kind: "text" }>;
    expect(texts.map((t) => t.delta).join("")).toBe("abc");
  });

  test("single SSE event split across multiple TCP reads", async () => {
    const body = ssePayload([
      { choices: [{ delta: { content: "hello" } }] },
      "[DONE]",
    ]);
    // Split the SSE event mid-JSON across 3 chunks.
    const chunkA = body.slice(0, 10);
    const chunkB = body.slice(10, 30);
    const chunkC = body.slice(30);
    const fetch = fakeFetch(() => streamResponse([chunkA, chunkB, chunkC]));
    const driver = createLmstudioDriver({ url: "http://x", fetch });
    const events = await collectEvents(
      driver.streamChat({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    );
    const texts = events.filter((e) => e.kind === "text") as Array<EngineChatEvent & { kind: "text" }>;
    expect(texts.map((t) => t.delta).join("")).toBe("hello");
  });

  test("CRLF line endings tolerated", async () => {
    const body =
      `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\r\n\r\n` +
      `data: [DONE]\r\n\r\n`;
    const fetch = fakeFetch(() => streamResponse([body]));
    const driver = createLmstudioDriver({ url: "http://x", fetch });
    const events = await collectEvents(
      driver.streamChat({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    );
    const text = (events.find((e) => e.kind === "text") as EngineChatEvent & { kind: "text" }).delta;
    expect(text).toBe("ok");
  });

  test("usage chunk on trailing message captures token counts", async () => {
    const body = ssePayload([
      { choices: [{ delta: { content: "hi" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 4 } },
      "[DONE]",
    ]);
    const fetch = fakeFetch(() => streamResponse([body]));
    const driver = createLmstudioDriver({ url: "http://x", fetch });
    const events = await collectEvents(
      driver.streamChat({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    );
    expect(events.at(-1)).toEqual({ kind: "done", inputTokens: 12, outputTokens: 4 , costUsd: null });
  });

  test("missing usage chunk → null token counts", async () => {
    const body = ssePayload([
      { choices: [{ delta: { content: "hi" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      "[DONE]",
    ]);
    const fetch = fakeFetch(() => streamResponse([body]));
    const driver = createLmstudioDriver({ url: "http://x", fetch });
    const events = await collectEvents(
      driver.streamChat({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    );
    expect(events.at(-1)).toEqual({ kind: "done", inputTokens: null, outputTokens: null , costUsd: null });
  });
});

describe("LmstudioDriver — tool calls", () => {
  test("function.arguments split across multiple deltas → single parsed emit", async () => {
    const body = ssePayload([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call_abc", function: { name: "time_now", arguments: '{"tz":' } },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '"UTC"}' } }],
            },
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      "[DONE]",
    ]);
    const fetch = fakeFetch(() => streamResponse([body]));
    const driver = createLmstudioDriver({ url: "http://x", fetch });
    const events = await collectEvents(
      driver.streamChat({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    );
    const calls = events.filter((e) => e.kind === "tool_call") as Array<
      EngineChatEvent & { kind: "tool_call" }
    >;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.call.id).toBe("call_abc");
    expect(calls[0]!.call.function.name).toBe("time_now");
    expect(calls[0]!.call.function.arguments).toEqual({ tz: "UTC" });
  });

  test("duplicate identical tool_calls dedup (Gemma-4 workaround)", async () => {
    const body = ssePayload([
      // First call (index 0)
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  function: { name: "time_now", arguments: '{"tz":"UTC"}' },
                },
              ],
            },
          },
        ],
      },
      // Identical second call (index 1) — Gemma-4 bug emits both
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 1,
                  id: "call_2",
                  function: { name: "time_now", arguments: '{"tz":"UTC"}' },
                },
              ],
            },
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      "[DONE]",
    ]);
    const fetch = fakeFetch(() => streamResponse([body]));
    const driver = createLmstudioDriver({ url: "http://x", fetch });
    const events = await collectEvents(
      driver.streamChat({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    );
    const calls = events.filter((e) => e.kind === "tool_call");
    expect(calls).toHaveLength(1);
  });

  test("differing args produce separate tool_calls", async () => {
    const body = ssePayload([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  function: { name: "time_now", arguments: '{"tz":"UTC"}' },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 1,
                  id: "call_2",
                  function: { name: "time_now", arguments: '{"tz":"PST"}' },
                },
              ],
            },
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      "[DONE]",
    ]);
    const fetch = fakeFetch(() => streamResponse([body]));
    const driver = createLmstudioDriver({ url: "http://x", fetch });
    const events = await collectEvents(
      driver.streamChat({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    );
    const calls = events.filter((e) => e.kind === "tool_call");
    expect(calls).toHaveLength(2);
  });

  test("tools serialized with parallel_tool_calls:false (Gemma-4 guard)", async () => {
    let observedBody: string | null = null;
    const fetch = fakeFetch((_url, init) => {
      observedBody = init?.body as string;
      return streamResponse([ssePayload(["[DONE]"])]);
    });
    const driver = createLmstudioDriver({ url: "http://x", fetch });
    await collectEvents(
      driver.streamChat({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        tools: [
          {
            type: "function",
            function: { name: "t", description: "d", parameters: {} },
          },
        ],
      }),
    );
    const parsed = JSON.parse(observedBody!) as { parallel_tool_calls?: boolean };
    expect(parsed.parallel_tool_calls).toBe(false);
  });
});

describe("LmstudioDriver — streamChat errors", () => {
  test("HTTP 404 → EngineDriverError model_missing", async () => {
    const fetch = fakeFetch(
      () =>
        new Response(JSON.stringify({ error: { message: "model not loaded" } }), { status: 404 }),
    );
    const driver = createLmstudioDriver({ url: "http://x", fetch });
    try {
      await collectEvents(
        driver.streamChat({ model: "qwen", messages: [{ role: "user", content: "hi" }] }),
      );
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(EngineDriverError);
      expect((err as EngineDriverError).code).toBe("model_missing");
    }
  });

  test("HTTP 500 → EngineDriverError http_error", async () => {
    const fetch = fakeFetch(() => new Response("oom", { status: 500 }));
    const driver = createLmstudioDriver({ url: "http://x", fetch });
    try {
      await collectEvents(
        driver.streamChat({ model: "m", messages: [{ role: "user", content: "hi" }] }),
      );
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(EngineDriverError);
      expect((err as EngineDriverError).code).toBe("http_error");
      expect((err as EngineDriverError).status).toBe(500);
    }
  });

  test("HTTP 200 with chunk.model != requested → model_missing (silent substitution)", async () => {
    // LMStudio's OpenAI-compatible endpoint returns 200 OK and silently serves
    // whatever's loaded when the requested model isn't. Driver detects this by
    // comparing `chunk.model` (echoed by the OpenAI streaming protocol) on the
    // first chunk that carries it.
    const body = ssePayload([
      { model: "actually-loaded-model", choices: [{ delta: { content: "I'm here" } }] },
      "[DONE]",
    ]);
    const fetch = fakeFetch(() => streamResponse([body]));
    const driver = createLmstudioDriver({ url: "http://x", fetch });
    try {
      await collectEvents(
        driver.streamChat({
          model: "requested-but-not-loaded",
          messages: [{ role: "user", content: "hi" }],
        }),
      );
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(EngineDriverError);
      expect((err as EngineDriverError).code).toBe("model_missing");
      expect((err as EngineDriverError).message).toContain("requested-but-not-loaded");
      expect((err as EngineDriverError).message).toContain("actually-loaded-model");
      expect((err as EngineDriverError).message).toContain("lms load");
    }
  });

  test("HTTP 200 with chunk.model == requested → streams normally (no false positive)", async () => {
    const body = ssePayload([
      { model: "qwen", choices: [{ delta: { content: "hi" } }] },
      "[DONE]",
    ]);
    const fetch = fakeFetch(() => streamResponse([body]));
    const driver = createLmstudioDriver({ url: "http://x", fetch });
    const events = await collectEvents(
      driver.streamChat({ model: "qwen", messages: [{ role: "user", content: "hi" }] }),
    );
    const texts = events.filter((e) => e.kind === "text") as Array<EngineChatEvent & { kind: "text" }>;
    expect(texts.map((t) => t.delta).join("")).toBe("hi");
    expect(events.at(-1)?.kind).toBe("done");
  });

  test("HTTP 200 with chunk.model case-mismatched but otherwise equal → streams normally", async () => {
    // LMStudio's catalog ids include uppercase (e.g. `Qwen/Qwen2.5-7B-Instruct-GGUF`).
    // Operators commonly write LOCAL_MODEL in lowercase; the server echoes the
    // canonical id. The substitution check must tolerate this and not flag a
    // false-positive model_missing.
    const body = ssePayload([
      {
        model: "Qwen/Qwen2.5-7B-Instruct-GGUF",
        choices: [{ delta: { content: "ok" } }],
      },
      "[DONE]",
    ]);
    const fetch = fakeFetch(() => streamResponse([body]));
    const driver = createLmstudioDriver({ url: "http://x", fetch });
    const events = await collectEvents(
      driver.streamChat({
        model: "qwen/qwen2.5-7b-instruct-gguf",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    const texts = events.filter((e) => e.kind === "text") as Array<EngineChatEvent & { kind: "text" }>;
    expect(texts.map((t) => t.delta).join("")).toBe("ok");
    expect(events.at(-1)?.kind).toBe("done");
  });

  test("error.message-shaped 200 body with 'model not loaded' string → still model_missing", async () => {
    // Some LMStudio builds return 400 (not 404) with a 'model not loaded' message.
    const fetch = fakeFetch(
      () =>
        new Response(JSON.stringify({ error: { message: "Model not loaded: qwen" } }), {
          status: 400,
        }),
    );
    const driver = createLmstudioDriver({ url: "http://x", fetch });
    try {
      await collectEvents(
        driver.streamChat({ model: "qwen", messages: [{ role: "user", content: "hi" }] }),
      );
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(EngineDriverError);
      expect((err as EngineDriverError).code).toBe("model_missing");
    }
  });
});

