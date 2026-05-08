/**
 * Linear integration — example operator integration showing the
 * "real pattern" for a multi-tool integration with external SDK deps.
 *
 * Demonstrates:
 *   - Lazy loading of optional heavy deps (`@linear/sdk`) so solrac itself
 *     doesn't pull in Linear unless this integration is enabled.
 *   - Multi-file structure (`client.ts`, `formatters.ts`, `index.ts`) for
 *     ports of larger SDK-backed integrations. Mirrors utcp-tools layout.
 *   - Per-tool tier overrides via `meta.toolTiers`: reads run auto-tier,
 *     mutating ops (`linear_create_issue`) require Telegram confirmation.
 *   - Graceful no-op when API key is missing — integration registers zero
 *     tools, logs once, boot continues.
 *   - JSON-stringified responses (`{ content: [{ type: "text", text }] }`)
 *     so the model receives structured data it can quote back to the user.
 *
 * Subset of utcp-tools' 8 Linear ops, picked for teaching value:
 *   - linear_get_user           (read,   auto)
 *   - linear_list_issues        (read,   auto)
 *   - linear_get_issue          (read,   auto)
 *   - linear_create_issue       (mutate, confirm)
 *
 * For a complete production port (8 ops, full schema coverage), reference
 * `apps/utcp-tools/src/integrations/linear/` in the PNXStudios monorepo
 * and adapt the remaining handlers using the same pattern.
 *
 * Setup:
 *   1. `cp -r examples/integrations/linear $SOLRAC_INTEGRATIONS_DIR/linear`
 *   2. `cd $SOLRAC_INTEGRATIONS_DIR/linear && npm install`
 *   3. Add `LINEAR_API_KEY=lin_api_…` to solrac's `.env`
 *      (Settings → API → Personal API keys in your Linear workspace)
 *   4. Restart solrac
 *
 * Ollama path does not see this integration — Claude tiers (`@`/`!`) only.
 * See `docs/USAGE.md#integrations`.
 */

import type {
  IntegrationContext,
  IntegrationModule,
} from "../../../src/integrations.ts";
import { getLinearClient, findIssueByIdentifier } from "./client.ts";
import { formatIssue } from "./formatters.ts";

export default async function setup(
  ctx: IntegrationContext,
): Promise<IntegrationModule> {
  // Sanity-check the credential AT BOOT. If absent, register zero tools
  // and log once. Solrac continues normally; the agent simply won't see
  // Linear tools. This avoids per-call surprises and makes "did you set
  // LINEAR_API_KEY?" a boot-time question, not a runtime one.
  if (!ctx.env.LINEAR_API_KEY || ctx.env.LINEAR_API_KEY.trim() === "") {
    ctx.log.warn("integrations.linear.disabled", {
      reason: "LINEAR_API_KEY not set",
      hint: "Add LINEAR_API_KEY=lin_api_… to solrac's .env to enable.",
    });
    return { apiVersion: 1, tools: [] };
  }

  // Probe @linear/sdk presence early so a missing local install fails loud
  // at boot, not on the first tool call. The actual client is built lazily
  // inside `getLinearClient` on first use.
  try {
    await import("@linear/sdk");
  } catch (err) {
    ctx.log.warn("integrations.linear.deps_missing", {
      error: (err as Error).message,
      hint: "Run `npm install` from inside the integration directory.",
    });
    return { apiVersion: 1, tools: [] };
  }

  const tools = [
    // --- linear_get_user ---
    ctx.tool(
      "linear_get_user",
      "Get the authenticated user's Linear profile and team memberships. " +
        "Use as a first step to discover team IDs/keys for filtering.",
      {},
      async () => {
        try {
          const client = await getLinearClient(ctx.env);
          const viewer = await client.viewer;
          const teams = await viewer.teams();
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    success: true,
                    user: {
                      id: viewer.id,
                      name: viewer.name,
                      email: viewer.email,
                      teams: teams.nodes.map((t) => ({
                        id: t.id,
                        name: t.name,
                        key: t.key,
                      })),
                    },
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (err) {
          return errorResult(err);
        }
      },
      { alwaysLoad: true },
    ),

    // --- linear_list_issues ---
    ctx.tool(
      "linear_list_issues",
      "List Linear issues with optional filters. Use to find work assigned " +
        "to a user, in-progress issues, or high-priority backlog items.",
      {
        assignee: ctx.z
          .string()
          .optional()
          .describe('Assignee ID or "me" for current user (default).'),
        status: ctx.z
          .enum(["backlog", "unstarted", "started", "completed", "canceled"])
          .optional(),
        priority: ctx.z
          .number()
          .min(0)
          .max(4)
          .optional()
          .describe("0=None, 1=Urgent, 2=High, 3=Normal, 4=Low."),
        team: ctx.z.string().optional().describe("Team ID or key."),
        limit: ctx.z.number().min(1).max(100).optional(),
      },
      async (args) => {
        try {
          const client = await getLinearClient(ctx.env);
          const limit = args.limit ?? 25;
          const filter: Record<string, unknown> = {};

          if (args.assignee === "me" || args.assignee === undefined) {
            const viewer = await client.viewer;
            filter.assignee = { id: { eq: viewer.id } };
          } else {
            filter.assignee = { id: { eq: args.assignee } };
          }

          if (args.status) {
            const STATE_MAP: Record<string, string[]> = {
              backlog: ["Backlog"],
              unstarted: ["Todo", "Backlog"],
              started: ["In Progress", "In Review"],
              completed: ["Done", "Completed"],
              canceled: ["Canceled"],
            };
            filter.state = { name: { in: STATE_MAP[args.status] } };
          }
          if (args.priority !== undefined) filter.priority = { eq: args.priority };
          if (args.team) filter.team = { key: { eq: args.team.toUpperCase() } };
          filter.archivedAt = { null: true };

          const issues = await client.issues({ filter, first: limit });
          const formatted = await Promise.all(issues.nodes.map(formatIssue));
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { success: true, count: formatted.length, issues: formatted },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (err) {
          return errorResult(err);
        }
      },
      { alwaysLoad: true },
    ),

    // --- linear_get_issue ---
    ctx.tool(
      "linear_get_issue",
      "Get full details for one Linear issue including description, " +
        "comments, and metadata. Use when investigating a specific ticket.",
      {
        identifier: ctx.z
          .string()
          .describe('Issue identifier (e.g. "ENG-123") or UUID.'),
      },
      async (args) => {
        try {
          const client = await getLinearClient(ctx.env);
          const issue = await findIssueByIdentifier(client, args.identifier.trim());
          const [comments, project, cycle, formatted] = await Promise.all([
            issue.comments(),
            issue.project,
            issue.cycle,
            formatIssue(issue),
          ]);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    success: true,
                    issue: {
                      ...formatted,
                      description: issue.description ?? "",
                      project: project?.name ?? null,
                      cycle: cycle?.name ?? null,
                      comments: comments.nodes.map((c) => ({
                        body: c.body,
                        createdAt: c.createdAt,
                      })),
                    },
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (err) {
          return errorResult(err);
        }
      },
      { alwaysLoad: true },
    ),

    // --- linear_create_issue ---  (mutating — gated by toolTiers below)
    ctx.tool(
      "linear_create_issue",
      "Create a new Linear issue. Requires Telegram confirmation per call. " +
        "Use only when the user has explicitly asked to create a ticket.",
      {
        title: ctx.z.string().describe("Issue title."),
        teamId: ctx.z.string().describe("Team ID or key."),
        description: ctx.z.string().optional(),
        priority: ctx.z.number().min(0).max(4).optional(),
        assigneeId: ctx.z.string().optional(),
      },
      async (args) => {
        try {
          const client = await getLinearClient(ctx.env);
          let teamId = args.teamId;
          if (teamId.length < 10) {
            const teams = await client.teams({
              filter: { key: { eq: teamId.toUpperCase() } },
              first: 1,
            });
            if (teams.nodes.length === 0) {
              throw new Error(`Team not found: ${args.teamId}`);
            }
            teamId = teams.nodes[0]!.id;
          }
          const result = await client.createIssue({
            title: args.title,
            teamId,
            description: args.description,
            priority: args.priority,
            assigneeId: args.assigneeId,
          });
          if (!result.success) throw new Error("Linear createIssue rejected");
          const created = await result.issue;
          if (!created) throw new Error("Linear returned no issue object");
          const formatted = await formatIssue(created);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ success: true, issue: formatted }, null, 2),
              },
            ],
          };
        } catch (err) {
          return errorResult(err);
        }
      },
      { alwaysLoad: true },
    ),
  ];

  return {
    apiVersion: 1,
    tools,
    meta: {
      // Default tier for any tool not in `toolTiers`. Reads stay auto.
      tier: "auto",
      // Per-tool override beats `meta.tier`. Only mutating ops listed.
      toolTiers: {
        linear_create_issue: "confirm",
      },
    },
  };
}

function errorResult(err: unknown): {
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          { success: false, error: (err as Error).message ?? "unknown error" },
          null,
          2,
        ),
      },
    ],
  };
}
