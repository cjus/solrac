# Linear — real-pattern integration example

Multi-file integration showing how to wrap a third-party SDK (`@linear/sdk`) and expose it as solrac tools. Use this as the template when porting any SDK-backed integration (Notion, Slack, Stripe, Asana, etc.) — the structure transfers directly.

> ℹ️ **Engine reachability.** Integrations are visible to the Claude tiers (`@`, `!`) and the local Ollama path (when `OLLAMA_TOOLS_ENABLED=true`). For Linear's multi-step flows (look up team → filter issues → format output), the Claude tiers are still more reliable — small Ollama tool-callers (e.g. `gemma4:e4b`) can struggle with multi-arg filter shapes across consecutive calls. Prefer `@ list my Linear issues` when you need confidence.

## What this example demonstrates

| Pattern | File | Why |
|---|---|---|
| Multi-file structure | `index.ts`, `client.ts`, `formatters.ts` | Larger SDK ports benefit from separating wiring (handlers) from infrastructure (client + formatters). Same shape utcp-tools uses. |
| Lazy SDK load | `client.ts::getLinearClient`, `index.ts::setup` | `@linear/sdk` is ~5MB. Dynamic `import()` keeps it out of solrac's import graph until the first tool call. The `setup()` function probes the import at boot so a missing local install fails loud, not on the first user message. |
| Per-tool tier overrides | `index.ts::meta.toolTiers` | Reads (`linear_get_user`, `linear_list_issues`, `linear_get_issue`) auto-allow. Mutating ops (`linear_create_issue`) require Telegram inline-keyboard confirmation per call. |
| Graceful no-op without creds | `index.ts::setup` early returns | If `LINEAR_API_KEY` is unset, registers zero tools and logs once. Solrac runs normally; the agent simply doesn't see Linear tools. |
| `alwaysLoad: true` per tool | each `ctx.tool(..., { alwaysLoad: true })` | Tools surface in the model's upfront tool list, skipping the SDK's `ToolSearch` discovery round-trip. Right default for ≤ ~10 tools. |
| Local `package.json` | `package.json` | Each integration directory is its own dependency root (verified — Bun's `import()` resolves bare specifiers from the integration's location upward). Solrac itself does NOT have `@linear/sdk` as a dep. |

## Setup

```bash
# 1. From the solrac repo root, copy the integration into your operator dir.
cp -r examples/integrations/linear $SOLRAC_INTEGRATIONS_DIR/linear

# 2. Install the integration's local deps.
cd $SOLRAC_INTEGRATIONS_DIR/linear
npm install

# 3. Add your Linear API key to solrac's .env (NOT the integration's directory).
#    Get the key from: Linear Settings → API → Personal API keys
echo "LINEAR_API_KEY=lin_api_…" >> /path/to/solrac/.env

# 4. Enable integrations and restart solrac.
echo "SOLRAC_INTEGRATIONS_ENABLED=true" >> /path/to/solrac/.env
# … then restart.
```

Boot log should show `integrations.loaded ... names:["linear", ...]` with `tools:4`. If you see `integrations.linear.disabled` or `integrations.linear.deps_missing`, the boot log message tells you which precondition failed.

## Tools exposed

| Tool | Tier | Description |
|---|---|---|
| `mcp__solrac__linear_get_user` | auto | Authenticated user profile + team memberships. Use first to discover team IDs. |
| `mcp__solrac__linear_list_issues` | auto | Filter by assignee/status/priority/team. |
| `mcp__solrac__linear_get_issue` | auto | Full issue details including description, project, cycle, comments. |
| `mcp__solrac__linear_create_issue` | **confirm** | Create a new issue. Telegram inline-keyboard prompt before execution. |

This example covers 4 of utcp-tools' 8 Linear ops. To add the remaining ones (`linear_update_issue`, `linear_list_cycles`, `linear_list_workflow_states`, `linear_list_projects`), copy the corresponding handlers from `apps/utcp-tools/src/integrations/linear/index.ts` in the PNXStudios monorepo, swap `c.req.valid("json")` reads for the typed `args` parameter, and return `{ content: [{ type: "text", text: JSON.stringify(...) }] }` instead of `c.json(...)`.

## Use it

After setup, from an allowed Telegram user (or web UI):

```
@ what Linear issues are assigned to me?
@ create a Linear ticket in ENG titled "fix login redirect"
```

The first request reads issues silently. The second triggers a Telegram confirmation prompt because `linear_create_issue` is `tier: "confirm"`. Tap **✅ Allow** to execute, **❌ Deny** to refuse.

## Customizing this example

If you fork this for your own SDK port:

1. Rename the directory and update `package.json` `name`.
2. Replace `@linear/sdk` with your SDK; update `client.ts::getLinearClient` to use it.
3. Update `formatters.ts` for your domain types.
4. Replace tool definitions in `index.ts` with your operations. Keep the per-tool tier convention: reads → `auto`, mutations → `confirm`.
5. Update this README with the new env var name (e.g. `STRIPE_API_KEY`) and tool list.

## Limits to know

- `@linear/sdk`'s status updates are unreliable per-issue; this example deliberately omits `linear_update_issue` for that reason. Status changes are best done in Linear's UI. (Source: `apps/utcp-tools/CLAUDE.md` flagged this.)
- The integration runs as solrac with full process access. See the security note in `docs/USAGE.md#security-note`. You wrote (or vetted) this code; treat it as trusted operator infrastructure.
- No tests ship with this example. The loader is covered in `src/integrations.test.ts`; if you want unit tests for handlers, set up your own test harness inside the integration directory (Bun's `bun:test` works there too).
