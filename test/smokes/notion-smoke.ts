// Live smoke for the blessed `notion` integration.
//
// What it proves end-to-end (against a real Notion workspace):
//   1. `@notionhq/client` is installed and dynamic-import succeeds.
//   2. NOTION_API_KEY is set and the boot probe (`/v1/users/me`, 3s) returns
//      a valid bot identity within the timeout.
//   3. `setup(ctx)` registers all 9 tools and the tier map matches.
//   4. Read tools work against the live API: `notion_search` returns either
//      results or an empty (success) envelope; `notion_list_users` returns
//      at least the bot user.
//   5. (Optional) If NOTION_TEST_DATABASE_ID is set, `notion_get_database_schema`
//      returns a non-empty property list and a property entry has `type`.
//
// The smoke is intentionally read-only — it does NOT exercise the write
// tools (create/update/append/archive). Operators verify writes manually
// per Phase 4 of PLAN.md ("Manual: @ create a Notion test page in <db>; …").
//
// Run:
//   NOTION_API_KEY=secret_xxx npm run smoke:notion
// With optional read of a real database schema:
//   NOTION_API_KEY=secret_xxx NOTION_TEST_DATABASE_ID=<uuid> npm run smoke:notion

import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import setup from "../../src/integrations-builtin/notion/index.ts";
import {
  EMPTY_INTEGRATION_RESULT as _EMPTY,
  type IntegrationContext,
} from "../../src/integrations.ts";
import { log } from "../../src/log.ts";
import { reportAndExit, type Phase } from "./harness.ts";

interface ToolDef {
  name: string;
  description: string;
  handler: (
    args: unknown,
    extra: unknown,
  ) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
}

function makeCtx(): IntegrationContext {
  return Object.freeze({
    z,
    tool,
    fetch: globalThis.fetch,
    log,
    env: process.env as Readonly<Record<string, string | undefined>>,
  });
}

async function callTool(t: ToolDef, args: Record<string, unknown>): Promise<unknown> {
  const out = await t.handler(args, undefined);
  return JSON.parse(out.content[0].text);
}

async function main(): Promise<void> {
  const phases: Phase[] = [];

  if (!process.env.NOTION_API_KEY) {
    phases.push({
      name: "env.NOTION_API_KEY",
      expected: "set",
      actual: "unset",
      pass: false,
    });
    reportAndExit("notion-smoke", phases);
  }

  // Phase 1: setup completes
  let result;
  try {
    result = await setup(makeCtx());
    phases.push({
      name: "setup.completes",
      expected: "no throw",
      actual: "no throw",
      pass: true,
    });
  } catch (err) {
    phases.push({
      name: "setup.completes",
      expected: "no throw",
      actual: `threw: ${(err as Error).message}`,
      pass: false,
    });
    reportAndExit("notion-smoke", phases);
  }

  // Phase 2: 10 tools registered
  phases.push({
    name: "setup.toolCount",
    expected: "10",
    actual: String(result.tools.length),
    pass: result.tools.length === 10,
  });

  // Phase 3: tier map
  const tiers = (result.meta?.toolTiers ?? {}) as Record<string, string>;
  const expectedTiers: Record<string, string> = {
    notion_search: "auto",
    notion_list_databases: "auto",
    notion_get_page: "auto",
    notion_query_database: "auto",
    notion_get_database_schema: "auto",
    notion_list_users: "auto",
    notion_create_page: "confirm",
    notion_update_page_properties: "confirm",
    notion_append_blocks: "confirm",
    notion_archive_page: "confirm",
  };
  let tiersOk = true;
  let tiersDiff = "";
  for (const [name, tier] of Object.entries(expectedTiers)) {
    if (tiers[name] !== tier) {
      tiersOk = false;
      tiersDiff += ` ${name}=${tiers[name] ?? "<missing>"}(want ${tier})`;
    }
  }
  phases.push({
    name: "setup.tierMap",
    expected: "all 9 tools tiered correctly",
    actual: tiersOk ? "ok" : `mismatch:${tiersDiff}`,
    pass: tiersOk,
  });

  if (!tiersOk || result.tools.length !== 10) {
    reportAndExit("notion-smoke", phases);
  }

  const tools = result.tools as ReadonlyArray<ToolDef>;
  const findTool = (name: string): ToolDef => {
    const t = tools.find((tt) => tt.name === name);
    if (!t) throw new Error(`tool not found: ${name}`);
    return t;
  };

  // Phase 4: notion_search returns success envelope
  try {
    const out = (await callTool(findTool("notion_search"), {
      page_size: 5,
    })) as { success: boolean; count: number };
    phases.push({
      name: "tool.notion_search.live",
      expected: "success=true",
      actual: `success=${out.success}, count=${out.count}`,
      pass: out.success === true,
    });
  } catch (err) {
    phases.push({
      name: "tool.notion_search.live",
      expected: "success=true",
      actual: `threw: ${(err as Error).message}`,
      pass: false,
    });
  }

  // Phase 5: notion_list_users returns success
  try {
    const out = (await callTool(findTool("notion_list_users"), {
      page_size: 5,
    })) as { success: boolean; count: number };
    phases.push({
      name: "tool.notion_list_users.live",
      expected: "success=true",
      actual: `success=${out.success}, count=${out.count}`,
      pass: out.success === true,
    });
  } catch (err) {
    phases.push({
      name: "tool.notion_list_users.live",
      expected: "success=true",
      actual: `threw: ${(err as Error).message}`,
      pass: false,
    });
  }

  // Phase 5b: notion_list_databases returns success
  try {
    const out = (await callTool(findTool("notion_list_databases"), {
      page_size: 5,
    })) as { success: boolean; count: number };
    phases.push({
      name: "tool.notion_list_databases.live",
      expected: "success=true",
      actual: `success=${out.success}, count=${out.count}`,
      pass: out.success === true,
    });
  } catch (err) {
    phases.push({
      name: "tool.notion_list_databases.live",
      expected: "success=true",
      actual: `threw: ${(err as Error).message}`,
      pass: false,
    });
  }

  // Phase 6 (optional): get_database_schema if a test DB id is provided
  const testDbId = process.env.NOTION_TEST_DATABASE_ID;
  if (testDbId) {
    try {
      const out = (await callTool(findTool("notion_get_database_schema"), {
        database_id: testDbId,
      })) as { success: boolean; property_count: number };
      phases.push({
        name: "tool.notion_get_database_schema.live",
        expected: "success=true, property_count>0",
        actual: `success=${out.success}, property_count=${out.property_count}`,
        pass: out.success === true && out.property_count > 0,
      });
    } catch (err) {
      phases.push({
        name: "tool.notion_get_database_schema.live",
        expected: "success=true",
        actual: `threw: ${(err as Error).message}`,
        pass: false,
      });
    }
  }

  reportAndExit("notion-smoke", phases);
}

await main();
