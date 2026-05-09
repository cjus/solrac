# Solrac integration examples

Templates for operator-authored integrations. **The loader does not scan this directory.** Copy whichever example matches your starting point into `$SOLRAC_INTEGRATIONS_DIR/<name>/` and `setup(ctx)` will pick it up on the next boot.

If you're looking for blessed integrations that ship with Solrac, those live in [`../../src/integrations-builtin/`](../../src/integrations-builtin/) and load automatically when `SOLRAC_INTEGRATIONS_ENABLED=true`. The two paths intentionally differ:

| Path | Loaded? | Use |
|---|---|---|
| `examples/integrations/<name>/` | No — templates only | `cp -r` into your operator dir |
| `src/integrations-builtin/<name>/` | Yes, always (self-gates on missing creds) | Ships with Solrac; operators don't manage these |

## What's here

- **[`echo/`](./echo/)** — Minimal one-tool integration (~50 lines). Starting template for any "wrap a function as a tool" port. No deps, no creds. Useful for verifying the integrations wiring on a fresh deployment.
- **[`linear/`](./linear/)** — Multi-file SDK port (`@linear/sdk`). Demonstrates the per-integration `package.json` + `node_modules` pattern, lazy SDK load, per-tool tier overrides (`auto` reads, `confirm` mutations), and graceful no-op without creds. Use this as the template when porting any SDK-backed integration (Linear, Slack, Stripe, Asana, etc.).

For the canonical "how to author an integration" reference inside Solrac itself, read [`../../src/integrations-builtin/time/index.ts`](../../src/integrations-builtin/time/index.ts) — heavily commented and demonstrates `IntegrationContext`, `meta.tier`, `alwaysLoad`, and multi-tool registration in one focused file.

## Quick start

```bash
mkdir -p ~/.solrac/integrations
cp -r examples/integrations/echo ~/.solrac/integrations/echo

echo "SOLRAC_INTEGRATIONS_ENABLED=true" >> .env
echo "SOLRAC_INTEGRATIONS_DIR=$HOME/.solrac/integrations" >> .env

# Restart solrac. Boot log should show:
#   integrations.loaded names:["echo", ...]
```

For SDK-backed integrations (`linear/`), also run `npm install` inside the copied directory before restarting. See each example's own README for specifics.

## See also

- [`docs/USAGE.md#integrations`](../../docs/USAGE.md#integrations) — full integration contract, env vars, gating, sharing.
- [`docs/ARCHITECTURE.md#integrations-in-process-mcp-server`](../../docs/ARCHITECTURE.md#integrations-in-process-mcp-server) — boot path, MCP server registration, tier policy.
