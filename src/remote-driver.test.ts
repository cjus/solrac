/**
 * @fileoverview Unit tests for `remote-driver.ts` — OpenRouter.
 * @proves SSE wire-format parsing (text + tool-call deltas), trailing usage
 *         chunk capture (the load-bearing `costUsd` path), auth + attribution
 *         header injection on probe + streamChat, and HTTP error mapping
 *         (`http_error`, `model_missing`).
 *
 * Driver ships with a handwritten-fake fetch (no mocking framework, per
 * CLAUDE.md Testing Philosophy). Each test constructs a `Response` with a
 * `ReadableStream` body so the driver consumes real chunk boundaries —
 * partial-event behavior is exercised by hand-splitting payloads into
 * multiple `controller.enqueue` calls.
 */

import { describe, expect, test } from "bun:test";
import {
  EngineDriverError,
  type EngineChatEvent,
} from "./engine-driver.ts";
import { createOpenrouterDriver } from "./remote-driver.ts";

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
// OpenrouterDriver — probe
// ---------------------------------------------------------------------------

describe("OpenrouterDriver — probe", () => {
  test("model present in data[] → ok; auth + attribution headers sent", async () => {
    let observedAuth = "";
    let observedReferer = "";
    let observedTitle = "";
    const fetch = fakeFetch((url, init) => {
      expect(url).toBe("https://openrouter.ai/api/v1/models");
      const headers = (init?.headers ?? {}) as Record<string, string>;
      observedAuth = headers.authorization ?? "";
      observedReferer = headers["http-referer"] ?? "";
      observedTitle = headers["x-title"] ?? "";
      return jsonResponse({
        data: [
          { id: "anthropic/claude-3.5-sonnet" },
          { id: "openai/gpt-4o-mini" },
        ],
      });
    });
    const driver = createOpenrouterDriver({
      url: "https://openrouter.ai/api/v1",
      apiKey: "sk-or-test-key",
      referer: "https://example.com",
      title: "test-title",
      fetch,
    });
    const result = await driver.probe("anthropic/claude-3.5-sonnet");
    expect(result.ok).toBe(true);
    expect(observedAuth).toBe("Bearer sk-or-test-key");
    expect(observedReferer).toBe("https://example.com");
    expect(observedTitle).toBe("test-title");
  });

  test("model absent → modelMissing with actionable hint", async () => {
    const fetch = fakeFetch(() =>
      jsonResponse({ data: [{ id: "openai/gpt-4o-mini" }] }),
    );
    const driver = createOpenrouterDriver({
      url: "https://openrouter.ai/api/v1",
      apiKey: "sk-or-test-key",
      fetch,
    });
    const result = await driver.probe("anthropic/claude-3.5-sonnet");
    expect(result.ok).toBe(false);
    expect(result.modelMissing).toBe(true);
    expect(result.reason).toMatch(/openrouter\.ai\/models/);
  });

  test("HTTP 401 → auth_failed reason", async () => {
    const fetch = fakeFetch(() => new Response("unauthorized", { status: 401 }));
    const driver = createOpenrouterDriver({
      url: "https://openrouter.ai/api/v1",
      apiKey: "bad",
      fetch,
    });
    const result = await driver.probe("anthropic/claude-3.5-sonnet");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/auth_failed/);
  });

  test("network error → ok:false unreachable", async () => {
    const fetch = (() =>
      Promise.reject(new TypeError("fetch failed"))) as unknown as typeof globalThis.fetch;
    const driver = createOpenrouterDriver({
      url: "https://openrouter.ai/api/v1",
      apiKey: "sk-or-test-key",
      fetch,
    });
    const result = await driver.probe("anthropic/claude-3.5-sonnet");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/unreachable/);
  });
});

// ---------------------------------------------------------------------------
// OpenrouterDriver — streamChat (the load-bearing path: cost capture)
// ---------------------------------------------------------------------------

describe("OpenrouterDriver — streamChat", () => {
  test("trailing usage chunk populates costUsd alongside tokens", async () => {
    // The whole point of the OpenRouter driver — without this, cost cap
    // accounting silently treats remote turns as free (post-COALESCE).
    const fetch = fakeFetch(
      () =>
        streamResponse([
          'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
          'data: {"usage":{"prompt_tokens":12,"completion_tokens":3,"total_tokens":15,"cost":0.00007,"is_byok":false}}\n\n',
          "data: [DONE]\n\n",
        ]),
    );
    const driver = createOpenrouterDriver({
      url: "https://openrouter.ai/api/v1",
      apiKey: "sk-or-test-key",
      fetch,
    });
    const events = await collectEvents(
      driver.streamChat({
        model: "anthropic/claude-3.5-sonnet",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    const last = events.at(-1);
    expect(last).toEqual({
      kind: "done",
      inputTokens: 12,
      outputTokens: 3,
      costUsd: 0.00007,
    });
  });

  test("usage chunk without cost → costUsd stays null (NOT 0)", async () => {
    // Defensive case: if OpenRouter ever stops emitting cost, the runner must
    // see `null` (so it logs remote.cost_missing) rather than `0` (which would
    // silently bypass the cap query's COALESCE(SUM(cost_usd), 0)).
    const fetch = fakeFetch(
      () =>
        streamResponse([
          'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
          'data: {"usage":{"prompt_tokens":5,"completion_tokens":1}}\n\n',
          "data: [DONE]\n\n",
        ]),
    );
    const driver = createOpenrouterDriver({
      url: "https://openrouter.ai/api/v1",
      apiKey: "sk-or-test-key",
      fetch,
    });
    const events = await collectEvents(
      driver.streamChat({
        model: "anthropic/claude-3.5-sonnet",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    const last = events.at(-1);
    expect(last).toEqual({
      kind: "done",
      inputTokens: 5,
      outputTokens: 1,
      costUsd: null,
    });
  });

  test("model slug with / flows through unchanged", async () => {
    // OpenRouter slugs are <provider>/<model>; verify the slash doesn't trip
    // any parser between the request body and the audit-tag composition.
    let observedModel: unknown = null;
    const fetch = fakeFetch((url, init) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      observedModel = body.model;
      return streamResponse([
        'data: {"choices":[{"delta":{"content":"x"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: {"usage":{"prompt_tokens":1,"completion_tokens":1,"cost":0.000001}}\n\n',
        "data: [DONE]\n\n",
      ]);
    });
    const driver = createOpenrouterDriver({
      url: "https://openrouter.ai/api/v1",
      apiKey: "k",
      fetch,
    });
    await collectEvents(
      driver.streamChat({
        model: "meta-llama/llama-3.3-70b-instruct",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(observedModel).toBe("meta-llama/llama-3.3-70b-instruct");
  });

  test("auth + attribution headers ride every streamChat request", async () => {
    let observedAuth = "";
    let observedReferer = "";
    let observedTitle = "";
    const fetch = fakeFetch((url, init) => {
      expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
      const headers = (init?.headers ?? {}) as Record<string, string>;
      observedAuth = headers.authorization ?? "";
      observedReferer = headers["http-referer"] ?? "";
      observedTitle = headers["x-title"] ?? "";
      return streamResponse(["data: [DONE]\n\n"]);
    });
    const driver = createOpenrouterDriver({
      url: "https://openrouter.ai/api/v1",
      apiKey: "sk-or-test-key",
      referer: "https://solrac.dev",
      title: "solrac-prod",
      fetch,
    });
    await collectEvents(
      driver.streamChat({
        model: "anthropic/claude-3.5-sonnet",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(observedAuth).toBe("Bearer sk-or-test-key");
    expect(observedReferer).toBe("https://solrac.dev");
    expect(observedTitle).toBe("solrac-prod");
  });

  test("HTTP 401 → EngineDriverError http_error with REMOTE_API_KEY hint", async () => {
    const fetch = fakeFetch(
      () =>
        new Response(
          JSON.stringify({ error: { message: "Invalid API key", code: 401 } }),
          { status: 401 },
        ),
    );
    const driver = createOpenrouterDriver({
      url: "https://openrouter.ai/api/v1",
      apiKey: "bad",
      fetch,
    });
    try {
      await collectEvents(
        driver.streamChat({
          model: "anthropic/claude-3.5-sonnet",
          messages: [{ role: "user", content: "hi" }],
        }),
      );
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(EngineDriverError);
      const drvErr = err as EngineDriverError;
      expect(drvErr.code).toBe("http_error");
      expect(drvErr.status).toBe(401);
      expect(drvErr.message).toMatch(/REMOTE_API_KEY/);
    }
  });

  test("HTTP 404 → EngineDriverError model_missing", async () => {
    const fetch = fakeFetch(
      () =>
        new Response(
          JSON.stringify({ error: { message: "Model not found: foo/bar" } }),
          { status: 404 },
        ),
    );
    const driver = createOpenrouterDriver({
      url: "https://openrouter.ai/api/v1",
      apiKey: "k",
      fetch,
    });
    try {
      await collectEvents(
        driver.streamChat({
          model: "foo/bar",
          messages: [{ role: "user", content: "hi" }],
        }),
      );
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(EngineDriverError);
      expect((err as EngineDriverError).code).toBe("model_missing");
    }
  });

  test("inline error frame → kind:error event terminates stream", async () => {
    const fetch = fakeFetch(
      () =>
        streamResponse([
          'data: {"error":{"message":"context length exceeded"}}\n\n',
          "data: [DONE]\n\n",
        ]),
    );
    const driver = createOpenrouterDriver({
      url: "https://openrouter.ai/api/v1",
      apiKey: "k",
      fetch,
    });
    const events = await collectEvents(
      driver.streamChat({
        model: "anthropic/claude-3.5-sonnet",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(events.length).toBe(1);
    expect(events[0]).toEqual({
      kind: "error",
      message: "context length exceeded",
    });
  });

  test("tool_call SSE chunks accumulate then emit on finish_reason", async () => {
    // OpenAI tool-call deltas split function.arguments across multiple chunks.
    // Verify the OpenRouter driver assembles them like the LMStudio driver does.
    const fetch = fakeFetch(
      () =>
        streamResponse([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"time_now","arguments":"{\\"tz\\""}}]}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"UTC\\"}"}}]}}]}\n\n',
          'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
          'data: {"usage":{"prompt_tokens":20,"completion_tokens":5,"cost":0.0001}}\n\n',
          "data: [DONE]\n\n",
        ]),
    );
    const driver = createOpenrouterDriver({
      url: "https://openrouter.ai/api/v1",
      apiKey: "k",
      fetch,
    });
    const events = await collectEvents(
      driver.streamChat({
        model: "anthropic/claude-3.5-sonnet",
        messages: [{ role: "user", content: "what time is it?" }],
      }),
    );
    const toolCalls = events.filter((e) => e.kind === "tool_call") as Array<
      EngineChatEvent & { kind: "tool_call" }
    >;
    expect(toolCalls.length).toBe(1);
    expect(toolCalls[0]?.call.function.name).toBe("time_now");
    expect(toolCalls[0]?.call.function.arguments).toEqual({ tz: "UTC" });
    expect(toolCalls[0]?.call.id).toBe("call_1");
  });
});
