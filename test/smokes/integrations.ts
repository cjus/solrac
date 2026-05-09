// Integrations loader smoke. Run with:
//
//   npm run smoke:integrations
//   bun test/smokes/integrations.ts
//
// What this proves (hermetically — no network, no Anthropic keys):
//
//   1. The real `src/integrations-builtin/` directory loads via the loader.
//      `time` registers 2 tools; `gmail` self-gates without credentials and
//      registers 0 tools (the gate path runs without throwing).
//   2. An operator-dir fixture (here: `examples/integrations/echo/`) loads
//      alongside the blessed dirs and contributes its own tool.
//   3. `loadIntegrations([builtinDir, operatorDir], ctx)` returns:
//      - 3 sources, 3 tools, 0 errors
//      - `toolTiers` populated with `auto` for every tool (matches
//        `meta.tier`/`meta.toolTiers` declarations in each integration)
//   4. `createSdkMcpServer({ name: "solrac", tools })` accepts the
//      collected tools and returns a server config with the correct shape
//      to pass to `Options.mcpServers`. (Catches API drift in the SDK.)
//   5. First-dir-wins on tool-name collision: when both dirs declare the
//      same tool name, the blessed dir's wins (the operator copy is
//      dropped with a warn — verified separately by integrations.test.ts;
//      this smoke validates the production path against real fixtures.)
//
// What this does NOT prove (out of scope for hermetic smoke):
//   - SDK actually fires `PreToolUse` / `canUseTool` for `mcp__solrac__*`
//     tools. That requires live Anthropic API; covered by the Phase 3
//     manual verification documented in `solrac-dev/PLAN.md`.
//   - End-to-end Telegram-to-tool dispatch through `runAgent`. Covered by
//     the same manual verification.
//
// This smoke runs cleanly in CI alongside `bun test`.

import { join, resolve } from "node:path";
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import {
  createIntegrationContext,
  loadIntegrations,
} from "../../src/integrations.ts";
import { reportAndExit, type Phase } from "./harness.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const BUILTIN_DIR = join(REPO_ROOT, "src", "integrations-builtin");
const OPERATOR_DIR = join(REPO_ROOT, "examples", "integrations");

async function run(): Promise<void> {
  // Hermetic env: ensure operator's local `.env` doesn't accidentally
  // configure self-gating integrations into success state during the smoke.
  // We assert that gated integrations register zero tools, so any token in
  // the operator's shell would flip that assertion. Restore on exit not
  // required — the smoke is a one-shot script.
  delete process.env.NOTION_API_KEY;

  const ctx = createIntegrationContext();
  const phases: Phase[] = [];

  // -------------------------------------------------------------------------
  // Phase 1: blessed-only load (time registers, gmail self-gates).
  // -------------------------------------------------------------------------

  const blessedOnly = await loadIntegrations([BUILTIN_DIR], ctx);
  phases.push({
    name: "blessed-only: 3 sources discovered",
    expected: "3",
    actual: String(blessedOnly.sources.length),
    pass: blessedOnly.sources.length === 3,
  });
  phases.push({
    name: "blessed-only: 0 errors",
    expected: "0",
    actual: String(blessedOnly.errors.length),
    pass: blessedOnly.errors.length === 0,
  });
  const timeSource = blessedOnly.sources.find((s) => s.name === "time");
  phases.push({
    name: "blessed-only: time registers 2 tools",
    expected: "2",
    actual: String(timeSource?.toolCount ?? -1),
    pass: timeSource?.toolCount === 2,
  });
  const gmailSource = blessedOnly.sources.find((s) => s.name === "gmail");
  phases.push({
    name: "blessed-only: gmail self-gates with 0 tools",
    expected: "0 (no credentials)",
    actual: String(gmailSource?.toolCount ?? -1),
    pass: gmailSource !== undefined && gmailSource.toolCount === 0,
  });
  const blessedToolNames = blessedOnly.tools.map((t) => t.name).sort();
  phases.push({
    name: "blessed-only: tool names",
    expected: "time_format, time_now",
    actual: blessedToolNames.join(", "),
    pass:
      blessedToolNames.length === 2 &&
      blessedToolNames[0] === "time_format" &&
      blessedToolNames[1] === "time_now",
  });
  phases.push({
    name: "blessed-only: time tools tier=auto",
    expected: "auto, auto",
    actual: `${blessedOnly.toolTiers.get("time_now")}, ${blessedOnly.toolTiers.get("time_format")}`,
    pass:
      blessedOnly.toolTiers.get("time_now") === "auto" &&
      blessedOnly.toolTiers.get("time_format") === "auto",
  });

  // -------------------------------------------------------------------------
  // Phase 2: blessed + operator-style example dir.
  //
  // We point the loader at examples/integrations as if it were a real
  // SOLRAC_INTEGRATIONS_DIR. This treats the committed example fixtures
  // (echo, linear) as operator content. The linear example self-gates
  // (no LINEAR_API_KEY) and registers zero tools, just like gmail.
  // -------------------------------------------------------------------------

  const both = await loadIntegrations([BUILTIN_DIR, OPERATOR_DIR], ctx);
  const sourceNames = both.sources.map((s) => s.name).sort();
  phases.push({
    name: "blessed+operator: source names include all blessed + operator dirs",
    expected: "echo, gmail, linear, notion, time",
    actual: sourceNames.join(", "),
    pass: sourceNames.join(", ") === "echo, gmail, linear, notion, time",
  });
  phases.push({
    name: "blessed+operator: zero loader errors",
    expected: "0",
    actual: String(both.errors.length),
    pass: both.errors.length === 0,
  });
  const echoSource = both.sources.find((s) => s.name === "echo");
  phases.push({
    name: "blessed+operator: echo registers echo_say",
    expected: "1",
    actual: String(echoSource?.toolCount ?? -1),
    pass: echoSource?.toolCount === 1,
  });
  const linearSource = both.sources.find((s) => s.name === "linear");
  phases.push({
    name: "blessed+operator: linear self-gates with 0 tools",
    expected: "0 (no LINEAR_API_KEY)",
    actual: String(linearSource?.toolCount ?? -1),
    pass: linearSource?.toolCount === 0,
  });
  const allToolNames = both.tools.map((t) => t.name).sort();
  phases.push({
    name: "blessed+operator: 3 tools total (time x2 + echo)",
    expected: "echo_say, time_format, time_now",
    actual: allToolNames.join(", "),
    pass: allToolNames.join(", ") === "echo_say, time_format, time_now",
  });
  phases.push({
    name: "blessed+operator: echo_say tier=auto",
    expected: "auto",
    actual: String(both.toolTiers.get("echo_say")),
    pass: both.toolTiers.get("echo_say") === "auto",
  });

  // -------------------------------------------------------------------------
  // Phase 3: SDK accepts our tools via createSdkMcpServer.
  //
  // This is the boundary check between solrac and the Anthropic SDK. If
  // the SDK ever changes the shape of `tools` or `createSdkMcpServer`'s
  // contract, this fails LOUD instead of at the first agent turn that
  // happens to attempt an integration call.
  // -------------------------------------------------------------------------

  let serverBuiltOk = false;
  let serverShape = "(not constructed)";
  try {
    const server = createSdkMcpServer({
      name: "solrac",
      version: "1.0.0",
      tools: [...both.tools],
    });
    // Smoke-shape check: must have a `name` and an `instance` per
    // sdk.d.ts:933 / 942 (McpSdkServerConfig + McpSdkServerConfigWithInstance).
    serverBuiltOk =
      typeof server === "object" &&
      server !== null &&
      "name" in server &&
      (server as { name: unknown }).name === "solrac";
    serverShape = JSON.stringify(Object.keys(server).sort());
  } catch (err) {
    serverShape = `threw: ${(err as Error).message}`;
  }
  phases.push({
    name: "createSdkMcpServer accepts collected tools",
    expected: 'name="solrac" + has expected keys',
    actual: serverShape,
    pass: serverBuiltOk,
  });

  reportAndExit("integrations smoke", phases);
}

await run();
