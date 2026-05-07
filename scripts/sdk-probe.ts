/**
 * SDK probe — captures the surface of @anthropic-ai/claude-agent-sdk that
 * Solrac depends on. Run once after `npm install` pins the version. Pipe stdout
 * into docs/SDK_NOTES.md so you have a verified snapshot.
 *
 *   bun scripts/sdk-probe.ts > docs/SDK_NOTES.md
 */

import * as sdk from "@anthropic-ai/claude-agent-sdk";

const pkgPath = require.resolve("@anthropic-ai/claude-agent-sdk/package.json");
const pkg = (await Bun.file(pkgPath).json()) as { name: string; version: string };

const exportNames = Object.keys(sdk).sort();
const queryFn = (sdk as Record<string, unknown>)["query"];
const queryArity = typeof queryFn === "function" ? queryFn.length : null;

const out: string[] = [];
out.push(`# Anthropic Agent SDK — verified surface`);
out.push("");
out.push(`Package: \`${pkg.name}@${pkg.version}\``);
out.push(`Probed: ${new Date().toISOString()}`);
out.push("");
out.push(`## Exports`);
out.push("");
for (const name of exportNames) {
  const v = (sdk as Record<string, unknown>)[name];
  const t = typeof v === "function" ? `function/arity=${(v as Function).length}` : typeof v;
  out.push(`- \`${name}\` — ${t}`);
}
out.push("");
out.push(`## query() signature`);
out.push("");
out.push(`- arity: ${queryArity}`);
out.push("");
out.push(`Option names referenced by Solrac plan (verify against SDK \`.d.ts\`):`);
out.push("");
out.push("- `canUseTool` — three-tier policy hook (Step 6)");
out.push("- `permissionMode` — auto/prompt/deny default (Step 6)");
out.push("- `resume` — session id for follow-up turns (Step 5)");
out.push("- `maxTurns` — turn cap, belt-and-suspenders (Step 6)");
out.push("- `hooks` — pre/post tool hooks (TBD)");
out.push("- `mcpServers` — MCP wiring (TBD)");
out.push("- `cwd` — per-chat workspace dir (Step 5)");
out.push("- `model` — `claude-opus-4-7` etc. (Step 0)");
out.push("- `systemPrompt` — agent persona (TBD)");
out.push("");
out.push(`> Cross-check the actual option names in \`node_modules/@anthropic-ai/claude-agent-sdk/dist/*.d.ts\` before Step 5 wires \`query()\`. Update this file if names drift.`);

process.stdout.write(out.join("\n") + "\n");
