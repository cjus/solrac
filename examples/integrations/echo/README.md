# Echo — minimal integration example

The smallest possible operator-authored integration. One tool, no deps, no API keys, no secrets. It exists to:

1. Verify the integrations wiring on a fresh deployment (`integrations.loaded` log line names `"echo"`).
2. Serve as the starting template you copy when writing your own.
3. Demonstrate what `IntegrationContext`, `apiVersion`, `meta.tier`, and `alwaysLoad` look like in a complete file.

The whole thing is ~50 lines including comments — read it before writing anything from scratch.

## Use it

```bash
# From the solrac repo root.
mkdir -p ~/.solrac/integrations
cp -r examples/integrations/echo ~/.solrac/integrations/echo

# Enable integrations.
echo "SOLRAC_INTEGRATIONS_ENABLED=true" >> .env
echo "SOLRAC_INTEGRATIONS_DIR=$HOME/.solrac/integrations" >> .env

# Restart solrac.
bun src/main.ts
```

Send the bot: `@ use the echo_say tool with msg="hello"`. Reply: `echo: hello`. That's the whole interaction — input goes in, the same string comes back wrapped in `echo:`.

## Use it as a starting template

```bash
# Copy + rename to your own integration.
cp -r examples/integrations/echo ~/.solrac/integrations/myservice
# Open ~/.solrac/integrations/myservice/index.ts and:
#   1. Rename `echo_say` to your tool name (snake_case, lowercase).
#   2. Update the description (the model reads it).
#   3. Replace the input schema (the `{ msg: ctx.z.string() }` line).
#   4. Replace the handler with your real implementation.
#   5. Decide tier — keep `auto` for read-only / pure tools; switch to
#      `confirm` (or just remove the `meta` block) for anything mutating.
```

## Notes on this example

- **`alwaysLoad: true`** makes the tool visible in the model's upfront tool list. Without it, the SDK hides MCP server tools behind `ToolSearch` discovery — works, but adds a round-trip and ~500 input tokens per turn. For ≤ ~10 integration tools, `alwaysLoad: true` is the right default.
- **`meta.tier: "auto"`** skips the Telegram-confirm prompt because echo has no side effects. Cost cap and loop detector still apply (verified — they fire from `PreToolUse`, which runs regardless of tier).
- **Type-only import** of `IntegrationContext` and `IntegrationModule` from `../../../src/integrations.ts`. The relative path resolves while the file lives inside the solrac repo. When you copy this file to `~/.solrac/integrations/`, the path becomes broken — but `import type` is erased at runtime by Bun, so it doesn't matter. If you want IDE autocomplete in your operator dir, change the import to a relative path that exists at your location, or remove it entirely (the `ctx` parameter will type as `any` but the runtime is unchanged).
- **No `package.json`.** Echo has zero deps. Real integrations that need `@linear/sdk`, `googleapis`, etc. drop a `package.json` next to `index.ts` and `npm install` from inside the integration directory. See `examples/integrations/linear/` for that pattern.
- **Reachable from all engines.** Integrations are visible to the Claude tiers (`@`, `!`) and the local engine (when `LOCAL_TOOLS_ENABLED=true`, both `LOCAL_BACKEND=ollama` and `LOCAL_BACKEND=lmstudio`). Cost cap and loop detector apply to every path; the local path additionally honors `LOCAL_MAX_TOOL_ITERATIONS`. Tool-calling reliability under the local engine varies by model — `gemma4:e4b` is the recommended baseline (see `docs/ROADMAP.md` OQ#16).

## What's NOT in this example

- Per-tool tier overrides (`meta.toolTiers`). See `examples/integrations/linear/` — it gates mutating ops to `confirm` while leaving reads on `auto`.
- Async setup, dynamic imports of optional heavy deps, OAuth credential loading. See `examples/integrations/linear/` and (when shipped) `src/integrations-builtin/gmail/`.
- Tests. Integrations don't have a test convention yet — operators are expected to test handlers via their own preferred path. The loader itself is covered in `src/integrations.test.ts`.
