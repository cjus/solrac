/**
 * @fileoverview Unit tests for `engine-tools.ts`.
 * @proves Schema converter shape, thought-fence stripper, and the
 *         multi-round `runToolLoop` driver behaviors that the
 *         `local-driver.test.ts` / `remote-driver.test.ts` event-stream
 *         tests don't already cover.
 *
 * `runToolLoop` is tested via a hand-rolled fake `EngineDriver` that yields
 * scripted `EngineChatEvent` sequences — that isolates loop logic from
 * wire-format concerns (already covered in the driver-impl test files).
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import {
  type EngineChatEvent,
  type EngineDriver,
  type EngineStreamChatOpts,
} from "./engine-driver.ts";
import {
  mcpToEngineTools,
  runToolLoop,
  stripThoughts,
  TOOL_RESULT_MAX_LEN,
} from "./engine-tools.ts";
import { createLoopDetector, type ConfirmationBroker } from "./policy.ts";

// ---------------------------------------------------------------------------
// Pure converter tests
// ---------------------------------------------------------------------------

describe("mcpToEngineTools", () => {
  function makeTool(
    name: string,
    inputSchema: z.ZodRawShape,
    description = "desc",
  ): SdkMcpToolDefinition<any> {
    return {
      name,
      description,
      inputSchema,
      handler: async () => ({ content: [{ type: "text", text: "" }] }),
    } as unknown as SdkMcpToolDefinition<any>;
  }

  test("converts a simple object schema with required + optional fields", () => {
    const out = mcpToEngineTools([
      makeTool("time_now", {
        tz: z.string().describe("IANA timezone"),
        format: z.enum(["iso", "human"]).optional(),
      }),
    ]);
    expect(out).toHaveLength(1);
    const fn = out[0]!.function;
    expect(fn.name).toBe("time_now");
    expect(fn.description).toBe("desc");
    const params = fn.parameters as Record<string, unknown>;
    // `$schema` stripped
    expect(params.$schema).toBeUndefined();
    expect(params.type).toBe("object");
    const props = params.properties as Record<string, unknown>;
    expect(props.tz).toBeDefined();
    expect(props.format).toBeDefined();
    expect(params.required).toEqual(["tz"]);
  });

  test("preserves descriptions on individual fields", () => {
    const out = mcpToEngineTools([
      makeTool("t", { foo: z.string().describe("the foo") }),
    ]);
    const params = out[0]!.function.parameters as Record<string, unknown>;
    const props = params.properties as Record<string, { description?: string }>;
    expect(props.foo!.description).toBe("the foo");
  });

  test("empty tools list → empty output", () => {
    expect(mcpToEngineTools([])).toEqual([]);
  });
});

describe("stripThoughts", () => {
  test("canonical <think>...</think> fence removed", () => {
    expect(stripThoughts("before<think>secret</think>after")).toBe("beforeafter");
  });

  test("gemma pipe-form with leading-slash close removed", () => {
    expect(stripThoughts("a<|think|>x</|think|>b")).toBe("ab");
  });

  test("gemma pipe-form with inside-slash close removed", () => {
    expect(stripThoughts("a<|think|>x<|/think|>b")).toBe("ab");
  });

  test("unclosed fence left intact (model misbehavior is debuggable)", () => {
    expect(stripThoughts("a<think>unclosed")).toBe("a<think>unclosed");
  });

  test("case-insensitive on tag tokens", () => {
    expect(stripThoughts("a<THINK>x</THINK>b")).toBe("ab");
  });

  test("empty input → empty output", () => {
    expect(stripThoughts("")).toBe("");
  });
});

describe("TOOL_RESULT_MAX_LEN", () => {
  test("is the 16 KB cap documented in the module", () => {
    expect(TOOL_RESULT_MAX_LEN).toBe(16384);
  });
});

// ---------------------------------------------------------------------------
// runToolLoop tests via a fake driver
// ---------------------------------------------------------------------------

// Scriptable fake — each call to `streamChat` consumes the next event batch.
function scriptedDriver(rounds: Array<EngineChatEvent[]>): EngineDriver {
  let i = 0;
  return {
    backend: "ollama",
    mode: "local",
    async probe() {
      return { ok: true };
    },
    async *streamChat(_opts: EngineStreamChatOpts): AsyncIterable<EngineChatEvent> {
      const events = rounds[i++] ?? [];
      for (const evt of events) yield evt;
    },
  };
}

// Minimal broker stub — request() throws since the test cases below don't
// exercise the confirm path. local-driver.test.ts covers that elsewhere.
const noopBroker: Pick<ConfirmationBroker, "request"> = {
  async request() {
    throw new Error("broker not expected in this test");
  },
};

describe("runToolLoop — single round, no tools", () => {
  test("text-only response → assistantText, no tool calls, ok result", async () => {
    const driver = scriptedDriver([
      [
        { kind: "text", delta: "hello world" },
        { kind: "done", inputTokens: 5, outputTokens: 3 , costUsd: null },
      ],
    ]);
    const result = await runToolLoop(
      {
        driver,
        model: "m",
        signal: new AbortController().signal,
        tools: new Map(),
        toolTiers: new Map(),
        toolDefs: [],
        broker: noopBroker,
        loopDetector: createLoopDetector(),
        maxIterations: 4,
        auditId: 1,
        chatId: 100,
      },
      { initialMessages: [{ role: "user", content: "hi" }] },
    );
    expect(result.assistantText).toBe("hello world");
    expect(result.toolCallSummaries).toEqual([]);
    expect(result.inputTokens).toBe(5);
    expect(result.outputTokens).toBe(3);
    expect(result.rounds).toBe(1);
    expect(result.iterationCapHit).toBe(false);
    expect(result.errorMessage).toBeNull();
  });

  test("error event → errorMessage set, no further rounds", async () => {
    const driver = scriptedDriver([
      [
        { kind: "text", delta: "starting" },
        { kind: "error", message: "model OOM" },
      ],
    ]);
    const result = await runToolLoop(
      {
        driver,
        model: "m",
        signal: new AbortController().signal,
        tools: new Map(),
        toolTiers: new Map(),
        toolDefs: [],
        broker: noopBroker,
        loopDetector: createLoopDetector(),
        maxIterations: 4,
        auditId: 1,
        chatId: 100,
      },
      { initialMessages: [{ role: "user", content: "hi" }] },
    );
    expect(result.errorMessage).toMatch(/model OOM/);
    expect(result.assistantText).toBe("starting");
  });
});

describe("runToolLoop — with tool calls", () => {
  test("one tool call → invokes handler, appends result, second round finalizes", async () => {
    const driver = scriptedDriver([
      // Round 1: text + tool_call
      [
        { kind: "text", delta: "calling…" },
        {
          kind: "tool_call",
          call: { id: "call_1", function: { name: "echo", arguments: { msg: "hi" } } },
        },
        { kind: "done", inputTokens: 8, outputTokens: 4 , costUsd: null },
      ],
      // Round 2: text-only finalization
      [
        { kind: "text", delta: "done!" },
        { kind: "done", inputTokens: 20, outputTokens: 2 , costUsd: null },
      ],
    ]);

    let handlerCalled = false;
    const echoTool = {
      name: "echo",
      description: "echo",
      inputSchema: { msg: z.string() },
      async handler(args: { msg: string }) {
        handlerCalled = true;
        return { content: [{ type: "text" as const, text: `you said: ${args.msg}` }] };
      },
    } as unknown as SdkMcpToolDefinition<any>;

    const result = await runToolLoop(
      {
        driver,
        model: "m",
        signal: new AbortController().signal,
        tools: new Map([["echo", echoTool]]),
        toolTiers: new Map([["echo", "auto"]]),
        toolDefs: mcpToEngineTools([echoTool]),
        broker: noopBroker,
        loopDetector: createLoopDetector(),
        maxIterations: 4,
        auditId: 1,
        chatId: 100,
      },
      { initialMessages: [{ role: "user", content: "say hi" }] },
    );

    expect(handlerCalled).toBe(true);
    expect(result.toolsFired).toBe(1);
    expect(result.toolCallSummaries).toEqual([{ name: "echo", input: { msg: "hi" } }]);
    expect(result.assistantText).toBe("done!");
    // True input is round 1's prompt only (avoids N×-overcount).
    expect(result.inputTokens).toBe(8);
    // Output tokens summed across rounds.
    expect(result.outputTokens).toBe(6);
    expect(result.errorMessage).toBeNull();
  });

  test("hard-denied tool (denyTools set) short-circuits without invoking handler", async () => {
    const driver = scriptedDriver([
      [
        {
          kind: "tool_call",
          call: { function: { name: "dangerous", arguments: {} } },
        },
        { kind: "done", inputTokens: 5, outputTokens: 1 , costUsd: null },
      ],
      [
        { kind: "text", delta: "ok, moving on" },
        { kind: "done", inputTokens: 10, outputTokens: 3 , costUsd: null },
      ],
    ]);

    let handlerCalled = false;
    const dangerousTool = {
      name: "dangerous",
      description: "d",
      inputSchema: {},
      async handler() {
        handlerCalled = true;
        return { content: [{ type: "text" as const, text: "" }] };
      },
    } as unknown as SdkMcpToolDefinition<any>;

    const result = await runToolLoop(
      {
        driver,
        model: "m",
        signal: new AbortController().signal,
        tools: new Map([["dangerous", dangerousTool]]),
        toolTiers: new Map([["dangerous", "auto"]]),
        toolDefs: mcpToEngineTools([dangerousTool]),
        broker: noopBroker,
        loopDetector: createLoopDetector(),
        maxIterations: 4,
        auditId: 1,
        chatId: 100,
        denyTools: new Set(["dangerous"]),
      },
      { initialMessages: [{ role: "user", content: "go" }] },
    );

    expect(handlerCalled).toBe(false);
    expect(result.toolsFired).toBe(1);
    expect(result.errorMessage).toBeNull();
  });
});

describe("runToolLoop — iteration cap", () => {
  test("cap hit fires the finalize round and sets iterationCapHit", async () => {
    // Build N+1 scripted rounds: N tool-calling rounds (cap) + 1 finalize round.
    const cap = 2;
    const rounds: Array<EngineChatEvent[]> = [];
    for (let i = 0; i < cap; i++) {
      rounds.push([
        { kind: "tool_call", call: { function: { name: "echo", arguments: { i } } } },
        { kind: "done", inputTokens: i === 0 ? 5 : 30, outputTokens: 2 , costUsd: null },
      ]);
    }
    // The finalize round (after cap nudge).
    rounds.push([
      { kind: "text", delta: "best effort answer" },
      { kind: "done", inputTokens: 40, outputTokens: 5 , costUsd: null },
    ]);
    const driver = scriptedDriver(rounds);

    const echoTool = {
      name: "echo",
      description: "echo",
      inputSchema: { i: z.number() },
      async handler() {
        return { content: [{ type: "text" as const, text: "ok" }] };
      },
    } as unknown as SdkMcpToolDefinition<any>;

    const result = await runToolLoop(
      {
        driver,
        model: "m",
        signal: new AbortController().signal,
        tools: new Map([["echo", echoTool]]),
        toolTiers: new Map([["echo", "auto"]]),
        toolDefs: mcpToEngineTools([echoTool]),
        broker: noopBroker,
        loopDetector: createLoopDetector(),
        maxIterations: cap,
        auditId: 1,
        chatId: 100,
      },
      { initialMessages: [{ role: "user", content: "go" }] },
    );

    expect(result.iterationCapHit).toBe(true);
    expect(result.toolsFired).toBe(cap);
    expect(result.assistantText).toBe("best effort answer");
    expect(result.errorMessage).toBe("iteration_cap");
  });
});

describe("runToolLoop — abort", () => {
  test("pre-aborted signal → aborted:true result", async () => {
    const driver = scriptedDriver([[]]);
    const ac = new AbortController();
    ac.abort();
    const result = await runToolLoop(
      {
        driver,
        model: "m",
        signal: ac.signal,
        tools: new Map(),
        toolTiers: new Map(),
        toolDefs: [],
        broker: noopBroker,
        loopDetector: createLoopDetector(),
        maxIterations: 4,
        auditId: 1,
        chatId: 100,
      },
      { initialMessages: [{ role: "user", content: "hi" }] },
    );
    expect(result.aborted).toBe(true);
    expect(result.errorMessage).toBe("aborted");
  });
});
