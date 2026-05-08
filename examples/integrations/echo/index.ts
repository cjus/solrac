/**
 * Minimal integration — proves the wiring end-to-end and serves as the
 * smallest possible operator-authored example. Copy this directory into
 * `$SOLRAC_INTEGRATIONS_DIR/echo/` and the agent gets one new tool:
 * `mcp__solrac__echo_say`. No deps, no API keys, no secrets.
 *
 * Use it for:
 *   - Verifying integrations are loading on a fresh deployment
 *     (`integrations.loaded` log line names "echo").
 *   - Running the Phase 3 hook-firing smoke (PLAN.md).
 *   - As a starting template — `cp -r examples/integrations/echo
 *     ~/.solrac/integrations/myservice` and edit.
 *
 * The setup function receives `ctx` carrying solrac's zod, the SDK's
 * `tool()` factory, fetch, log, and env. Operators don't import zod or
 * the SDK directly — those come through ctx so integrations need no
 * `npm install` for the basics.
 *
 * `meta.tier: "auto"` skips the Telegram-confirm prompt for this tool
 * (it has no side effects). For tools that mutate or call external
 * services, omit the meta or set `tier: "confirm"` so the operator must
 * approve each call via inline keyboard.
 */

// Type-only import so editors offer autocomplete; runtime values come
// through `ctx`. Operators don't need zod installed for this to work.
import type { IntegrationContext, IntegrationModule } from "../../../src/integrations.ts";

export default function setup(ctx: IntegrationContext): IntegrationModule {
  return {
    apiVersion: 1,
    tools: [
      ctx.tool(
        "echo_say",
        "Echo the input back. Verifies integrations wiring end-to-end.",
        { msg: ctx.z.string() },
        async (args) => ({
          content: [{ type: "text", text: `echo: ${args.msg}` }],
        }),
        // alwaysLoad makes this tool visible to the model WITHOUT requiring
        // ToolSearch discovery first. Tradeoff: every turn pays the schema
        // tokens (~50-100 tokens per tool). For ≤ ~10 integration tools
        // this is the right default — direct reference > search overhead.
        // For very large integrations (50+ tools), prefer the default
        // (search-discoverable) so the upfront tool list stays small.
        { alwaysLoad: true },
      ),
    ],
    meta: { tier: "auto" },
  };
}
