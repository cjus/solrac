/**
 * @fileoverview Unit tests for `mcpToOllamaTools` (Phase 1) and
 *               `executeToolCall` (Phase 2).
 * @proves The schema converter produces wire-format Ollama tool definitions
 *         that match what `gemma4`-class models expect, across every Zod 4
 *         feature solrac integrations actually use today, AND the executor
 *         walks loop → classify → broker → handler in order, returning a
 *         structured result on every branch (model always sees a tool message).
 *
 * Why these specific cases:
 *   Phase 1 inventory mirrors PLAN.md Phase 1's checklist plus the shapes
 *   actually observed in `src/integrations-builtin/time/index.ts` (the
 *   reference integration). If a future Zod minor release ships different
 *   `toJSONSchema` output, these tests fail fast and the PLAN.md fallback
 *   (hand-rolled walker) becomes the right answer.
 *
 *   Phase 2 inventory matches PLAN.md's Phase 2 checklist:
 *   allow / deny / confirm-allow / confirm-deny / confirm-timeout /
 *   malformed args / handler throws / content truncation / loop detected
 *   / unknown tool / string-encoded `arguments`.
 *
 * Cross-references:
 *   - src/ollama-tools.ts — implementation
 *   - PLAN.md (solrac-dev) Phases 1+2 — checklist
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import {
  executeToolCall,
  mcpToOllamaTools,
  runToolLoop,
  stripThoughts,
  TOOL_RESULT_MAX_LEN,
  type ExecuteToolCallDeps,
  type OllamaMessage,
  type OllamaToolCall,
  type OllamaToolDef,
  type RunToolLoopDeps,
  type RunToolLoopRenderer,
} from "./ollama-tools.ts";
import {
  createLoopDetector,
  type ConfirmationBroker,
  type ConfirmDecision,
} from "./policy.ts";
import type { IntegrationTier } from "./integrations.ts";

// Helper: build a `SdkMcpToolDefinition` the same way an integration does.
// `tool(name, description, inputSchema, handler)` mirrors `ctx.tool(...)`.
function noopHandler() {
  return Promise.resolve({ content: [{ type: "text" as const, text: "" }] });
}

describe("mcpToOllamaTools", () => {
  test("empty input returns empty array", () => {
    expect(mcpToOllamaTools([])).toEqual([]);
  });

  test("tool with no fields produces empty properties object", () => {
    const def = tool("ping", "no-arg ping", {}, noopHandler);
    const [out] = mcpToOllamaTools([def]);

    expect(out!.type).toBe("function");
    expect(out!.function.name).toBe("ping");
    expect(out!.function.description).toBe("no-arg ping");
    const params = out!.function.parameters as Record<string, unknown>;
    expect(params.type).toBe("object");
    expect(params.properties).toEqual({});
    // No required keys when there are no fields.
    expect(params.required).toBeUndefined();
  });

  test("required + optional mix produces correct `required` array", () => {
    const def = tool(
      "create_thing",
      "create a thing",
      {
        title: z.string().describe("title of the thing"),
        notes: z.string().optional().describe("optional notes"),
        count: z.number().int().min(0),
      },
      noopHandler,
    );
    const [out] = mcpToOllamaTools([def]);
    const params = out!.function.parameters as {
      type: string;
      properties: Record<string, { type: string; description?: string }>;
      required?: string[];
      additionalProperties?: boolean;
    };

    expect(params.type).toBe("object");
    expect(params.properties.title!.type).toBe("string");
    expect(params.properties.title!.description).toBe("title of the thing");
    expect(params.properties.notes!.type).toBe("string");
    expect(params.properties.count!.type).toBe("integer");
    expect(params.required).toEqual(["title", "count"]);
    expect(params.additionalProperties).toBe(false);
  });

  test("z.enum produces enum array in output", () => {
    const def = tool(
      "set_status",
      "set status",
      {
        status: z.enum(["open", "closed", "pending"]).describe("target status"),
      },
      noopHandler,
    );
    const [out] = mcpToOllamaTools([def]);
    const status = (out!.function.parameters as {
      properties: Record<string, { type: string; enum?: string[] }>;
    }).properties.status;

    expect(status!.type).toBe("string");
    expect(status!.enum).toEqual(["open", "closed", "pending"]);
  });

  test("nested object fields are converted recursively", () => {
    const def = tool(
      "send",
      "send",
      {
        recipient: z.object({
          email: z.string(),
          name: z.string().optional(),
        }),
      },
      noopHandler,
    );
    const [out] = mcpToOllamaTools([def]);
    const recipient = (out!.function.parameters as {
      properties: Record<string, unknown>;
    }).properties.recipient as {
      type: string;
      properties: Record<string, { type: string }>;
      required?: string[];
    };

    expect(recipient.type).toBe("object");
    expect(recipient.properties.email!.type).toBe("string");
    expect(recipient.properties.name!.type).toBe("string");
    expect(recipient.required).toEqual(["email"]);
  });

  test("array fields populate `items`", () => {
    const def = tool(
      "tag",
      "apply tags",
      {
        tags: z.array(z.string()).describe("tag list"),
      },
      noopHandler,
    );
    const [out] = mcpToOllamaTools([def]);
    const tags = (out!.function.parameters as {
      properties: Record<string, { type: string; items?: { type: string } }>;
    }).properties.tags;

    expect(tags!.type).toBe("array");
    expect(tags!.items?.type).toBe("string");
  });

  test("top-level $schema annotation is stripped", () => {
    const def = tool("noop", "noop", { x: z.string() }, noopHandler);
    const [out] = mcpToOllamaTools([def]);
    expect(
      (out!.function.parameters as Record<string, unknown>).$schema,
    ).toBeUndefined();
  });

  test("name passes through unchanged (no mcp__solrac__ prefix)", () => {
    const def = tool("time_now", "get the time", {}, noopHandler);
    const [out] = mcpToOllamaTools([def]);
    expect(out!.function.name).toBe("time_now");
  });

  test("multiple tools preserve input order and independent schemas", () => {
    const a = tool("a_tool", "first", { foo: z.string() }, noopHandler);
    const b = tool("b_tool", "second", { bar: z.number() }, noopHandler);
    const c = tool("c_tool", "third", {}, noopHandler);
    const out = mcpToOllamaTools([a, b, c]);

    expect(out.map((t) => t.function.name)).toEqual([
      "a_tool",
      "b_tool",
      "c_tool",
    ]);
    expect(
      (out[0]!.function.parameters as { properties: Record<string, { type: string }> })
        .properties.foo!.type,
    ).toBe("string");
    expect(
      (out[1]!.function.parameters as { properties: Record<string, { type: string }> })
        .properties.bar!.type,
    ).toBe("number");
    expect(
      (out[2]!.function.parameters as { properties: Record<string, unknown> })
        .properties,
    ).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Phase 2 — executeToolCall
// ---------------------------------------------------------------------------

// Test helpers shared across the Phase 2 cases.
function makeBroker(
  verdict: ConfirmDecision = "allow",
  hooks: { onRequest?: () => void; throwOnRequest?: Error } = {},
): ConfirmationBroker {
  return {
    request: async () => {
      hooks.onRequest?.();
      if (hooks.throwOnRequest) throw hooks.throwOnRequest;
      return verdict;
    },
    resolve: () => true,
    size: () => 0,
  };
}

function buildDeps(
  tools: ReadonlyArray<{
    def: SdkMcpToolDefinition<any>;
    tier: IntegrationTier;
  }>,
  overrides: Partial<ExecuteToolCallDeps> = {},
): ExecuteToolCallDeps {
  const toolMap = new Map<string, SdkMcpToolDefinition<any>>();
  const tierMap = new Map<string, IntegrationTier>();
  for (const t of tools) {
    toolMap.set(t.def.name, t.def);
    tierMap.set(t.def.name, t.tier);
  }
  return {
    chatId: 1,
    auditId: 100,
    tools: toolMap,
    toolTiers: tierMap,
    broker: makeBroker(),
    loopDetector: createLoopDetector({ threshold: 3 }),
    ...overrides,
  };
}

function textTool(
  name: string,
  responseText: string,
  shape: z.ZodRawShape = {},
): SdkMcpToolDefinition<any> {
  return tool(
    name,
    `tool ${name}`,
    shape,
    async () => ({ content: [{ type: "text", text: responseText }] }),
  );
}

describe("executeToolCall", () => {
  test("auto-tier tool: invokes handler, returns text content", async () => {
    const def = textTool("time_now", "12:00 UTC");
    const deps = buildDeps([{ def, tier: "auto" }]);
    const r = await executeToolCall(deps, { name: "time_now", arguments: {} });

    expect(r.disposition).toBe("ok");
    expect(r.content).toBe("12:00 UTC");
    expect(r.truncated).toBe(false);
  });

  test("confirm-allow: broker grants, handler invoked", async () => {
    const def = textTool("write_thing", "wrote ok");
    const deps = buildDeps([{ def, tier: "confirm" }], {
      broker: makeBroker("allow"),
    });
    const r = await executeToolCall(deps, {
      name: "write_thing",
      arguments: {},
    });

    expect(r.disposition).toBe("ok");
    expect(r.content).toBe("wrote ok");
  });

  test("confirm-deny: handler is NOT invoked, returns user-deny string", async () => {
    let invoked = false;
    const def = tool(
      "write_thing",
      "writes",
      {},
      async () => {
        invoked = true;
        return { content: [{ type: "text", text: "wrote" }] };
      },
    );
    const deps = buildDeps([{ def, tier: "confirm" }], {
      broker: makeBroker("deny"),
    });
    const r = await executeToolCall(deps, {
      name: "write_thing",
      arguments: {},
    });

    expect(invoked).toBe(false);
    expect(r.disposition).toBe("denied_user");
    expect(r.content).toContain("denied:");
  });

  test("confirm-timeout: returns timeout-deny string", async () => {
    const def = textTool("write_thing", "wrote");
    const deps = buildDeps([{ def, tier: "confirm" }], {
      broker: makeBroker("timeout"),
    });
    const r = await executeToolCall(deps, {
      name: "write_thing",
      arguments: {},
    });

    expect(r.disposition).toBe("denied_timeout");
    expect(r.content).toContain("timed out");
  });

  test("broker throws: treated as deny, handler not invoked", async () => {
    let invoked = false;
    const def = tool(
      "write_thing",
      "writes",
      {},
      async () => {
        invoked = true;
        return { content: [{ type: "text", text: "wrote" }] };
      },
    );
    const deps = buildDeps([{ def, tier: "confirm" }], {
      broker: makeBroker("allow", { throwOnRequest: new Error("network down") }),
    });
    const r = await executeToolCall(deps, {
      name: "write_thing",
      arguments: {},
    });

    expect(invoked).toBe(false);
    expect(r.disposition).toBe("denied_send_failed");
    expect(r.content).toContain("network down");
  });

  test("malformed args: zod validation fails, handler not invoked", async () => {
    let invoked = false;
    const def = tool(
      "set_status",
      "sets",
      { status: z.enum(["open", "closed"]) },
      async () => {
        invoked = true;
        return { content: [{ type: "text", text: "ok" }] };
      },
    );
    const deps = buildDeps([{ def, tier: "auto" }]);
    const r = await executeToolCall(deps, {
      name: "set_status",
      arguments: { status: "garbage" },
    });

    expect(invoked).toBe(false);
    expect(r.disposition).toBe("error_invalid_args");
    expect(r.content).toContain("invalid arguments");
  });

  test("handler throws: caught, content surfaces error", async () => {
    const def = tool(
      "explodes",
      "explodes",
      {},
      async () => {
        throw new Error("kaboom");
      },
    );
    const deps = buildDeps([{ def, tier: "auto" }]);
    const r = await executeToolCall(deps, {
      name: "explodes",
      arguments: {},
    });

    expect(r.disposition).toBe("error_handler_threw");
    expect(r.content).toContain("kaboom");
  });

  test("unknown tool name: returns error_unknown_tool", async () => {
    const def = textTool("known", "ok");
    const deps = buildDeps([{ def, tier: "auto" }]);
    const r = await executeToolCall(deps, {
      name: "made_up",
      arguments: {},
    });

    expect(r.disposition).toBe("error_unknown_tool");
    expect(r.content).toContain("made_up");
  });

  test("loop detector fires on Nth identical call", async () => {
    const def = textTool("ping", "pong");
    const deps = buildDeps([{ def, tier: "auto" }], {
      loopDetector: createLoopDetector({ threshold: 3 }),
    });
    const calls = [
      await executeToolCall(deps, { name: "ping", arguments: {} }),
      await executeToolCall(deps, { name: "ping", arguments: {} }),
      await executeToolCall(deps, { name: "ping", arguments: {} }),
    ];

    expect(calls[0]!.disposition).toBe("ok");
    expect(calls[1]!.disposition).toBe("ok");
    expect(calls[2]!.disposition).toBe("denied_loop");
    expect(calls[2]!.content).toContain("loop_detected");
  });

  test("string-encoded arguments are JSON-parsed", async () => {
    let receivedArgs: unknown;
    const def = tool(
      "echo",
      "echo",
      { msg: z.string() },
      async (args) => {
        receivedArgs = args;
        return { content: [{ type: "text", text: args.msg }] };
      },
    );
    const deps = buildDeps([{ def, tier: "auto" }]);
    const r = await executeToolCall(deps, {
      name: "echo",
      arguments: '{"msg":"hello"}',
    });

    expect(r.disposition).toBe("ok");
    expect(r.content).toBe("hello");
    expect(receivedArgs).toEqual({ msg: "hello" });
  });

  test("unparseable string arguments fall through to zod, surface as invalid_args", async () => {
    const def = tool(
      "echo",
      "echo",
      { msg: z.string() },
      async () => ({ content: [{ type: "text", text: "ok" }] }),
    );
    const deps = buildDeps([{ def, tier: "auto" }]);
    const r = await executeToolCall(deps, {
      name: "echo",
      arguments: "not json {",
    });

    expect(r.disposition).toBe("error_invalid_args");
  });

  test("content truncated when over the cap, marked truncated:true", async () => {
    const big = "x".repeat(TOOL_RESULT_MAX_LEN + 100);
    const def = textTool("big", big);
    const deps = buildDeps([{ def, tier: "auto" }]);
    const r = await executeToolCall(deps, {
      name: "big",
      arguments: {},
    });

    expect(r.disposition).toBe("ok");
    expect(r.truncated).toBe(true);
    expect(r.content.length).toBe(TOOL_RESULT_MAX_LEN);
    expect(r.content.endsWith("…")).toBe(true);
  });

  test("multiple text content blocks are concatenated", async () => {
    const def = tool(
      "multi",
      "multi-block",
      {},
      async () => ({
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      }),
    );
    const deps = buildDeps([{ def, tier: "auto" }]);
    const r = await executeToolCall(deps, { name: "multi", arguments: {} });

    expect(r.disposition).toBe("ok");
    expect(r.content).toBe("first\nsecond");
  });

  test("non-text content blocks fall through to JSON serialisation", async () => {
    const def = tool(
      "imagey",
      "image",
      {},
      async () =>
        ({
          content: [
            { type: "image", data: "abc", mimeType: "image/png" },
          ],
        }) as never,
    );
    const deps = buildDeps([{ def, tier: "auto" }]);
    const r = await executeToolCall(deps, { name: "imagey", arguments: {} });

    expect(r.disposition).toBe("ok");
    // Concrete shape isn't important — we just want the model to see SOMETHING
    // rather than an empty string.
    expect(r.content).toContain("image");
  });

  test("stripThoughts: plain text passes through unchanged", () => {
    expect(stripThoughts("hello world")).toBe("hello world");
    expect(stripThoughts("")).toBe("");
  });

  test("stripThoughts: removes a single <think> block", () => {
    const input = "before <think>secret reasoning</think> after";
    expect(stripThoughts(input)).toBe("before  after");
  });

  test("stripThoughts: removes multiple <think> blocks", () => {
    const input = "a <think>x</think> b <think>y</think> c";
    expect(stripThoughts(input)).toBe("a  b  c");
  });

  test("stripThoughts: removes the <|think|> gemma fence", () => {
    const input = "before <|think|>plan<|/think|> after";
    expect(stripThoughts(input)).toBe("before  after");
  });

  test("stripThoughts: handles both fence styles in one string", () => {
    const input = "<think>a</think> mid <|think|>b<|/think|>";
    expect(stripThoughts(input)).toBe(" mid ");
  });

  test("stripThoughts: blocks spanning newlines are removed", () => {
    const input = "before <think>line1\nline2\nline3</think> after";
    expect(stripThoughts(input)).toBe("before  after");
  });

  test("stripThoughts: unclosed fences are left intact", () => {
    // An unclosed fence is the model's bug — leaving it in history makes the
    // misbehavior debuggable rather than silently swallowing partial output.
    const input = "before <think>never closed";
    expect(stripThoughts(input)).toBe("before <think>never closed");
  });

  test("stripThoughts: case-insensitive on fence tokens", () => {
    const input = "x <THINK>y</THINK> z";
    expect(stripThoughts(input)).toBe("x  z");
  });

  test("undefined arguments are coerced to empty object", async () => {
    let receivedArgs: unknown;
    const def = tool(
      "noargs",
      "noargs",
      {},
      async (args) => {
        receivedArgs = args;
        return { content: [{ type: "text", text: "ok" }] };
      },
    );
    const deps = buildDeps([{ def, tier: "auto" }]);
    const r = await executeToolCall(deps, {
      name: "noargs",
      arguments: undefined,
    });

    expect(r.disposition).toBe("ok");
    expect(receivedArgs).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Phase 3 — runToolLoop
// ---------------------------------------------------------------------------

// Build NDJSON wire bytes for a fake `/api/chat` stream. Each frame is one
// JSON object; trailing newline included so the driver's split-on-`\n` walks
// every frame including the final `done:true`.
function ndjsonStream(frames: ReadonlyArray<unknown>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const parts = frames.map((f) => enc.encode(JSON.stringify(f) + "\n"));
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const p of parts) controller.enqueue(p);
      controller.close();
    },
  });
}

function streamingResponse(frames: ReadonlyArray<unknown>): Response {
  return new Response(ndjsonStream(frames), {
    status: 200,
    headers: { "content-type": "application/x-ndjson" },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface FakeFetchPlan {
  /** One Response (or an Error to throw) per fetch call, in order. */
  readonly responses: ReadonlyArray<Response | Error>;
}

// Cast via `unknown` to satisfy Bun's `typeof fetch` (which adds a
// `preconnect` method we don't need to fake).
function makeFakeFetch(plan: FakeFetchPlan): {
  fetch: typeof globalThis.fetch;
  calls: Array<{ url: string; body: unknown }>;
} {
  let i = 0;
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchImpl = async (
    url: string | URL | Request,
    init?: { body?: unknown },
  ): Promise<Response> => {
    const bodyText =
      typeof init?.body === "string" ? init.body : "";
    let parsed: unknown = null;
    try {
      parsed = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      parsed = bodyText;
    }
    calls.push({ url: String(url), body: parsed });
    const next = plan.responses[i++];
    if (next === undefined) {
      throw new Error(
        `fakeFetch ran out of responses (call #${i}, plan has ${plan.responses.length})`,
      );
    }
    if (next instanceof Error) throw next;
    return next;
  };
  return {
    fetch: fetchImpl as unknown as typeof globalThis.fetch,
    calls,
  };
}

// Build a full RunToolLoopDeps with sensible defaults. Override anything via `overrides`.
function buildLoopDeps(
  overrides: Partial<RunToolLoopDeps> & {
    plan?: FakeFetchPlan;
  } = {},
): {
  deps: RunToolLoopDeps;
  fetchCalls: Array<{ url: string; body: unknown }>;
  ac: AbortController;
} {
  const ac = new AbortController();
  const fake = makeFakeFetch(overrides.plan ?? { responses: [] });
  const deps: RunToolLoopDeps = {
    fetch: overrides.fetch ?? fake.fetch,
    url: "http://localhost:11434",
    model: "gemma4:e4b",
    signal: ac.signal,
    tools: overrides.tools ?? new Map(),
    toolTiers: overrides.toolTiers ?? new Map(),
    toolDefs: overrides.toolDefs ?? [],
    broker: overrides.broker ?? makeBroker(),
    loopDetector: overrides.loopDetector ?? createLoopDetector({ threshold: 5 }),
    maxIterations: overrides.maxIterations ?? 5,
    auditId: overrides.auditId ?? 1,
    chatId: overrides.chatId ?? 1,
    denyTools: overrides.denyTools,
    renderer: overrides.renderer,
  };
  return { deps, fetchCalls: fake.calls, ac };
}

const SYSTEM_HELLO: OllamaMessage = {
  role: "system",
  content: "you are a helpful assistant.",
};
const USER_HELLO: OllamaMessage = { role: "user", content: "hi" };

describe("runToolLoop", () => {
  test("0 tool calls — single round, returns assistant text", async () => {
    const { deps } = buildLoopDeps({
      plan: {
        responses: [
          streamingResponse([
            { message: { role: "assistant", content: "hello there" } },
            { done: true, prompt_eval_count: 5, eval_count: 7 },
          ]),
        ],
      },
    });
    const out = await runToolLoop(deps, {
      initialMessages: [SYSTEM_HELLO, USER_HELLO],
    });

    expect(out.errorMessage).toBeNull();
    expect(out.assistantText).toBe("hello there");
    expect(out.toolCallSummaries).toEqual([]);
    expect(out.inputTokens).toBe(5);
    expect(out.outputTokens).toBe(7);
    expect(out.rounds).toBe(1);
    expect(out.toolsFired).toBe(0);
    expect(out.iterationCapHit).toBe(false);
    expect(out.aborted).toBe(false);
  });

  test("1 tool call — round-1 emits call, executor invokes, round-2 finalizes", async () => {
    const def = tool(
      "time_now",
      "get the time",
      {},
      async () => ({ content: [{ type: "text", text: "12:34" }] }),
    );
    const tools = new Map([[def.name, def]]);
    const toolTiers = new Map<string, IntegrationTier>([[def.name, "auto"]]);
    const toolDefs: OllamaToolDef[] = mcpToOllamaTools([def]);

    const { deps, fetchCalls } = buildLoopDeps({
      tools,
      toolTiers,
      toolDefs,
      plan: {
        responses: [
          // round 1: model asks for time_now
          streamingResponse([
            {
              message: {
                role: "assistant",
                content: "calling tool",
                tool_calls: [
                  { function: { name: "time_now", arguments: {} } },
                ],
              },
            },
            { done: true, prompt_eval_count: 10, eval_count: 4 },
          ]),
          // round 2: model returns final answer
          streamingResponse([
            { message: { role: "assistant", content: "It's 12:34." } },
            { done: true, prompt_eval_count: 30, eval_count: 5 },
          ]),
        ],
      },
    });

    const out = await runToolLoop(deps, {
      initialMessages: [SYSTEM_HELLO, USER_HELLO],
    });

    expect(out.errorMessage).toBeNull();
    expect(out.assistantText).toBe("It's 12:34.");
    expect(out.toolCallSummaries).toEqual([{ name: "time_now", input: {} }]);
    expect(out.inputTokens).toBe(10); // ROUND 0 ONLY (not 10+30)
    expect(out.outputTokens).toBe(9); // 4+5 sum
    expect(out.rounds).toBe(2);
    expect(out.toolsFired).toBe(1);
    expect(fetchCalls.length).toBe(2);
  });

  test("2 sequential tool calls — three rounds total", async () => {
    const def = tool(
      "ask",
      "ask",
      { q: z.string() },
      async (args) => ({ content: [{ type: "text", text: `re:${args.q}` }] }),
    );
    const tools = new Map([[def.name, def]]);
    const toolTiers = new Map<string, IntegrationTier>([[def.name, "auto"]]);

    const { deps } = buildLoopDeps({
      tools,
      toolTiers,
      toolDefs: mcpToOllamaTools([def]),
      plan: {
        responses: [
          streamingResponse([
            {
              message: {
                tool_calls: [
                  { function: { name: "ask", arguments: { q: "first" } } },
                ],
              },
            },
            { done: true },
          ]),
          streamingResponse([
            {
              message: {
                tool_calls: [
                  { function: { name: "ask", arguments: { q: "second" } } },
                ],
              },
            },
            { done: true },
          ]),
          streamingResponse([
            { message: { content: "all done" } },
            { done: true },
          ]),
        ],
      },
    });

    const out = await runToolLoop(deps, {
      initialMessages: [SYSTEM_HELLO, USER_HELLO],
    });

    expect(out.errorMessage).toBeNull();
    expect(out.assistantText).toBe("all done");
    expect(out.toolCallSummaries.map((t) => t.name)).toEqual(["ask", "ask"]);
    expect(out.toolsFired).toBe(2);
    expect(out.rounds).toBe(3);
  });

  test("parallel tool_calls in one round — all execute, single follow-up round", async () => {
    const a = textTool("a_tool", "ra");
    const b = textTool("b_tool", "rb");
    const tools = new Map([
      [a.name, a],
      [b.name, b],
    ]);
    const toolTiers = new Map<string, IntegrationTier>([
      [a.name, "auto"],
      [b.name, "auto"],
    ]);

    const { deps } = buildLoopDeps({
      tools,
      toolTiers,
      toolDefs: mcpToOllamaTools([a, b]),
      plan: {
        responses: [
          streamingResponse([
            {
              message: {
                tool_calls: [
                  { function: { name: "a_tool", arguments: {} } },
                  { function: { name: "b_tool", arguments: {} } },
                ],
              },
            },
            { done: true },
          ]),
          streamingResponse([
            { message: { content: "got both" } },
            { done: true },
          ]),
        ],
      },
    });

    const out = await runToolLoop(deps, {
      initialMessages: [SYSTEM_HELLO, USER_HELLO],
    });

    expect(out.errorMessage).toBeNull();
    expect(out.toolsFired).toBe(2);
    expect(out.toolCallSummaries.map((t) => t.name)).toEqual([
      "a_tool",
      "b_tool",
    ]);
  });

  test("parallel-with-multiple-confirms — only first goes to broker, rest get retry hint", async () => {
    let brokerCalls = 0;
    const broker: ConfirmationBroker = {
      request: async () => {
        brokerCalls++;
        return "allow";
      },
      resolve: () => true,
      size: () => 0,
    };
    const a = textTool("a_tool", "ra");
    const b = textTool("b_tool", "rb");
    const c = textTool("c_tool", "rc");
    const tools = new Map([
      [a.name, a],
      [b.name, b],
      [c.name, c],
    ]);
    const toolTiers = new Map<string, IntegrationTier>([
      [a.name, "confirm"],
      [b.name, "confirm"],
      [c.name, "confirm"],
    ]);

    const { deps } = buildLoopDeps({
      broker,
      tools,
      toolTiers,
      toolDefs: mcpToOllamaTools([a, b, c]),
      plan: {
        responses: [
          streamingResponse([
            {
              message: {
                tool_calls: [
                  { function: { name: "a_tool", arguments: {} } },
                  { function: { name: "b_tool", arguments: {} } },
                  { function: { name: "c_tool", arguments: {} } },
                ],
              },
            },
            { done: true },
          ]),
          streamingResponse([
            { message: { content: "ok" } },
            { done: true },
          ]),
        ],
      },
    });

    const out = await runToolLoop(deps, {
      initialMessages: [SYSTEM_HELLO, USER_HELLO],
    });

    expect(out.errorMessage).toBeNull();
    expect(brokerCalls).toBe(1); // CRUCIAL — never spawn N back-to-back prompts
    // All three are TRACKED in summaries (model tried), but only one ran.
    expect(out.toolCallSummaries.length).toBe(3);
  });

  test("tool deny mid-loop — model gets denial string, can recover next round", async () => {
    let invokes = 0;
    const def = tool(
      "write_thing",
      "writes",
      {},
      async () => {
        invokes++;
        return { content: [{ type: "text", text: "wrote" }] };
      },
    );
    const tools = new Map([[def.name, def]]);
    const toolTiers = new Map<string, IntegrationTier>([[def.name, "confirm"]]);

    const { deps } = buildLoopDeps({
      broker: makeBroker("deny"),
      tools,
      toolTiers,
      toolDefs: mcpToOllamaTools([def]),
      plan: {
        responses: [
          streamingResponse([
            {
              message: {
                tool_calls: [
                  { function: { name: "write_thing", arguments: {} } },
                ],
              },
            },
            { done: true },
          ]),
          streamingResponse([
            { message: { content: "ok then i'll skip it" } },
            { done: true },
          ]),
        ],
      },
    });

    const out = await runToolLoop(deps, {
      initialMessages: [SYSTEM_HELLO, USER_HELLO],
    });

    expect(out.errorMessage).toBeNull();
    expect(invokes).toBe(0);
    expect(out.assistantText).toBe("ok then i'll skip it");
    expect(out.toolsFired).toBe(1);
  });

  test("iteration cap hit — runs cap+1 fetches, finalize round produces text", async () => {
    const def = textTool("ping", "pong");
    const tools = new Map([[def.name, def]]);
    const toolTiers = new Map<string, IntegrationTier>([[def.name, "auto"]]);

    // Build cap=2 streaming rounds that each emit a tool call, plus one
    // non-streaming finalize round.
    const toolingRound = streamingResponse([
      {
        message: {
          tool_calls: [{ function: { name: "ping", arguments: {} } }],
        },
      },
      { done: true },
    ]);
    const { deps } = buildLoopDeps({
      maxIterations: 2,
      // Disable per-call loop detector so it doesn't fire before iteration cap.
      loopDetector: createLoopDetector({ threshold: 100 }),
      tools,
      toolTiers,
      toolDefs: mcpToOllamaTools([def]),
      plan: {
        responses: [
          toolingRound,
          streamingResponse([
            {
              message: {
                tool_calls: [{ function: { name: "ping", arguments: {} } }],
              },
            },
            { done: true },
          ]),
          // cap-finalize, non-streaming
          jsonResponse({
            message: { content: "stopped early" },
            eval_count: 3,
          }),
        ],
      },
    });

    const out = await runToolLoop(deps, {
      initialMessages: [SYSTEM_HELLO, USER_HELLO],
    });

    expect(out.iterationCapHit).toBe(true);
    expect(out.assistantText).toBe("stopped early");
    expect(out.errorMessage).toBe("iteration_cap");
    expect(out.toolsFired).toBe(2);
    expect(out.rounds).toBe(3); // 2 streaming + 1 cap-finalize
  });

  test("malformed tool_call (string-encoded arguments) executes via normalizeToolArgs", async () => {
    let received: unknown;
    const def = tool(
      "echo",
      "echo",
      { msg: z.string() },
      async (args) => {
        received = args;
        return { content: [{ type: "text", text: args.msg }] };
      },
    );
    const tools = new Map([[def.name, def]]);
    const toolTiers = new Map<string, IntegrationTier>([[def.name, "auto"]]);

    const { deps } = buildLoopDeps({
      tools,
      toolTiers,
      toolDefs: mcpToOllamaTools([def]),
      plan: {
        responses: [
          streamingResponse([
            {
              message: {
                tool_calls: [
                  {
                    function: {
                      name: "echo",
                      arguments: '{"msg":"howdy"}',
                    },
                  },
                ],
              },
            },
            { done: true },
          ]),
          streamingResponse([
            { message: { content: "fini" } },
            { done: true },
          ]),
        ],
      },
    });

    await runToolLoop(deps, { initialMessages: [SYSTEM_HELLO, USER_HELLO] });
    expect(received).toEqual({ msg: "howdy" });
  });

  test("thoughts in assistant text are stripped before next-round messages", async () => {
    const def = textTool("ping", "pong");
    const tools = new Map([[def.name, def]]);
    const toolTiers = new Map<string, IntegrationTier>([[def.name, "auto"]]);

    // Sniff the second round's body to verify the assistant turn lacks the
    // <think> block.
    const enc = new TextEncoder();
    const round1 = new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(
            enc.encode(
              JSON.stringify({
                message: {
                  content: "<think>plan: call ping</think>okay",
                  tool_calls: [
                    { function: { name: "ping", arguments: {} } },
                  ],
                },
              }) + "\n",
            ),
          );
          c.enqueue(enc.encode(JSON.stringify({ done: true }) + "\n"));
          c.close();
        },
      }),
    );
    const round2 = streamingResponse([
      { message: { content: "done" } },
      { done: true },
    ]);

    const { deps, fetchCalls } = buildLoopDeps({
      tools,
      toolTiers,
      toolDefs: mcpToOllamaTools([def]),
      plan: { responses: [round1, round2] },
    });

    await runToolLoop(deps, {
      initialMessages: [SYSTEM_HELLO, USER_HELLO],
    });

    // Find the assistant turn appended in round 2's body.
    const round2Body = fetchCalls[1]!.body as { messages: OllamaMessage[] };
    const assistantTurn = round2Body.messages.find(
      (m) => m.role === "assistant",
    );
    expect(assistantTurn).toBeDefined();
    expect(assistantTurn!.content).toBe("okay"); // <think> block removed
    expect(assistantTurn!.content.includes("<think>")).toBe(false);
  });

  test("abort mid-round returns aborted:true with truthy errorMessage", async () => {
    // The round-1 fetch will be aborted before the stream finishes.
    const enc = new TextEncoder();
    const slowResponse = new Response(
      new ReadableStream<Uint8Array>({
        async start(c) {
          c.enqueue(enc.encode(JSON.stringify({ message: { content: "partial" } }) + "\n"));
          // Hang — caller aborts.
          await new Promise((r) => setTimeout(r, 1000));
          c.close();
        },
      }),
    );

    const { deps, ac } = buildLoopDeps({
      plan: { responses: [slowResponse] },
    });
    const p = runToolLoop(deps, {
      initialMessages: [SYSTEM_HELLO, USER_HELLO],
    });
    setTimeout(() => ac.abort(), 50);
    const out = await p;

    expect(out.aborted).toBe(true);
    expect(out.errorMessage).toBe("aborted");
  });

  test("HTTP 404 surfaces actionable pull hint", async () => {
    const { deps } = buildLoopDeps({
      plan: {
        responses: [
          new Response(
            JSON.stringify({ error: "model 'gemma4:e4b' not found" }),
            { status: 404, headers: { "content-type": "application/json" } },
          ),
        ],
      },
    });
    const out = await runToolLoop(deps, {
      initialMessages: [SYSTEM_HELLO, USER_HELLO],
    });

    expect(out.errorMessage).toContain("ollama pull");
    expect(out.aborted).toBe(false);
  });

  test("renderer.onProgress is throttled and de-duped", async () => {
    // Single round with three frames — each carries content and arrives
    // synchronously; the throttle ensures only the first reaches the renderer.
    const calls: Array<{ text: string; tools: string[] }> = [];
    const renderer: RunToolLoopRenderer = {
      onProgress(text, tools) {
        calls.push({ text, tools: [...tools] });
      },
    };
    const { deps } = buildLoopDeps({
      renderer,
      plan: {
        responses: [
          streamingResponse([
            { message: { content: "hello " } },
            { message: { content: "world" } },
            { done: true },
          ]),
        ],
      },
    });
    await runToolLoop(deps, { initialMessages: [SYSTEM_HELLO, USER_HELLO] });

    // First sub-second invocation suppresses follow-ups via 1500ms throttle.
    expect(calls.length).toBe(1);
    expect(calls[0]!.text).toBe("hello ");
  });

  test("OLLAMA_DENY_TOOLS rejects matching call without invoking handler", async () => {
    let invoked = false;
    const def = tool(
      "danger",
      "danger",
      {},
      async () => {
        invoked = true;
        return { content: [{ type: "text", text: "boom" }] };
      },
    );
    const tools = new Map([[def.name, def]]);
    const toolTiers = new Map<string, IntegrationTier>([[def.name, "auto"]]);

    const { deps } = buildLoopDeps({
      tools,
      toolTiers,
      toolDefs: mcpToOllamaTools([def]),
      denyTools: new Set(["danger"]),
      plan: {
        responses: [
          streamingResponse([
            {
              message: {
                tool_calls: [
                  { function: { name: "danger", arguments: {} } },
                ],
              },
            },
            { done: true },
          ]),
          streamingResponse([
            { message: { content: "ok skipped" } },
            { done: true },
          ]),
        ],
      },
    });
    const out = await runToolLoop(deps, {
      initialMessages: [SYSTEM_HELLO, USER_HELLO],
    });

    expect(invoked).toBe(false);
    expect(out.toolsFired).toBe(1);
    expect(out.assistantText).toBe("ok skipped");
  });
});
