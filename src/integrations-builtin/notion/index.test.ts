/**
 * @fileoverview Unit tests for Notion integration `setup()` + tool handlers.
 * @proves Setup gating, tier map, archive body-confirm gate, error envelope
 *         mapping, schema-cache invalidate-and-retry on validation_error,
 *         tool name validation per integrations.ts.
 *
 * Strategy:
 *   - Mock `@notionhq/client` via `mock.module` with a class whose instances
 *     pull behavior from a per-test `fakeNotionClient` object — so each test
 *     can swap individual API methods without re-mocking the whole module.
 *   - Stub `globalThis.fetch` for the boot probe so setup() reaches tool
 *     registration without hitting the network.
 *   - Invoke handlers directly: `tool.handler(args, undefined)`. The handler
 *     signature comes from the SDK (verified in sdk.d.ts).
 *
 * What we do NOT test here (intentional):
 *   - The actual SDK `tool()` / Anthropic call path — that's the SDK's job.
 *   - Live Notion API — see `test/smokes/notion-smoke.ts` (Phase 4, optional).
 *
 * Cross-references:
 *   - ./index.ts — system under test
 *   - PLAN.md (solrac-dev) §7
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { log } from "../../log.ts";
import type { IntegrationContext } from "../../integrations.ts";
import { clearNotionCaches } from "./client.ts";
import setup from "./index.ts";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_KEY = process.env.NOTION_API_KEY;

// Anthropic's tool-name regex — duplicated here so we can re-validate names
// without importing the loader (which has unrelated side effects). Keep in
// sync with `integrations.ts::TOOL_NAME_RE`.
const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

interface FakeClient {
  search: (body: unknown) => Promise<unknown>;
  pages: {
    create: (body: unknown) => Promise<unknown>;
    retrieve: (body: unknown) => Promise<unknown>;
    update: (body: unknown) => Promise<unknown>;
  };
  databases: {
    retrieve: (body: unknown) => Promise<unknown>;
    query: (body: unknown) => Promise<unknown>;
  };
  blocks: {
    children: {
      list: (body: unknown) => Promise<unknown>;
      append: (body: unknown) => Promise<unknown>;
    };
  };
  users: {
    list: (body: unknown) => Promise<unknown>;
  };
}

let fakeNotionClient: FakeClient;

function defaultFakeClient(): FakeClient {
  return {
    search: async () => ({ results: [], has_more: false, next_cursor: null }),
    pages: {
      create: async () => ({}),
      retrieve: async () => ({
        id: "p-1",
        parent: { type: "database_id", database_id: "db-1" },
        properties: {},
      }),
      update: async (body: unknown) => ({
        id: (body as { page_id: string }).page_id ?? "p-1",
        parent: { type: "database_id", database_id: "db-1" },
        properties: {},
      }),
    },
    databases: {
      retrieve: async () => ({ id: "db-1", properties: {} }),
      query: async () => ({ results: [], has_more: false, next_cursor: null }),
    },
    blocks: {
      children: {
        list: async () => ({ results: [], has_more: false, next_cursor: null }),
        append: async () => ({}),
      },
    },
    users: {
      list: async () => ({ results: [], has_more: false, next_cursor: null }),
    },
  };
}

// Per-test handler for the legacy `POST /v1/databases/{id}/query` endpoint
// — used by `client.ts::queryDatabase` since SDK v5 dropped
// `client.databases.query`. Tests assign this to capture the body and
// return a custom response. Defaults to an empty result list.
let queryFetchHandler: (
  url: string,
  init: RequestInit | undefined,
) => Promise<Response>;

function defaultQueryHandler(): typeof queryFetchHandler {
  return async () =>
    new Response(
      JSON.stringify({ results: [], has_more: false, next_cursor: null }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
}

beforeEach(() => {
  clearNotionCaches();
  process.env.NOTION_API_KEY = "secret_test";
  queryFetchHandler = defaultQueryHandler();
  // Router fetch: /users/me → probe response; /databases/{id}/query → the
  // current test's query handler. Anything else 404s so a regression that
  // routes through fetch unintentionally surfaces loudly.
  globalThis.fetch = (async (input: string | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.endsWith("/users/me")) {
      return new Response(
        JSON.stringify({ id: "u-bot", name: "Test Bot" }),
        { status: 200 },
      );
    }
    if (url.includes("/databases/") && url.endsWith("/query")) {
      return queryFetchHandler(url, init);
    }
    return new Response("unmocked", { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  fakeNotionClient = defaultFakeClient();
  mock.module("@notionhq/client", () => ({
    Client: class FakeClient {
      constructor(_opts: unknown) {
        Object.assign(this, fakeNotionClient);
      }
    },
  }));
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_KEY === undefined) delete process.env.NOTION_API_KEY;
  else process.env.NOTION_API_KEY = ORIGINAL_KEY;
});

function makeCtx(): IntegrationContext {
  return Object.freeze({
    z,
    tool,
    fetch: globalThis.fetch,
    log,
    env: process.env as Readonly<Record<string, string | undefined>>,
    solracHome: "/tmp/solrac-test-home",
  });
}

interface ToolDef {
  name: string;
  description: string;
  handler: (args: unknown, extra: unknown) => Promise<{
    content: Array<{ type: "text"; text: string }>;
  }>;
}

function findTool(tools: ReadonlyArray<unknown>, name: string): ToolDef {
  const t = tools.find((tt) => (tt as ToolDef).name === name);
  if (!t) throw new Error(`tool not found: ${name}`);
  return t as ToolDef;
}

async function callTool(
  tool: ToolDef,
  args: Record<string, unknown>,
): Promise<unknown> {
  const out = await tool.handler(args, undefined);
  return JSON.parse(out.content[0].text);
}

// ---------------------------------------------------------------------------
// Setup gating
// ---------------------------------------------------------------------------

describe("setup gates", () => {
  test("registers all 10 tools when probe succeeds", async () => {
    const result = await setup(makeCtx());
    expect(result.tools).toHaveLength(10);
    expect(result.apiVersion).toBe(1);
  });

  test("returns zero tools when NOTION_API_KEY is unset", async () => {
    delete process.env.NOTION_API_KEY;
    const result = await setup(makeCtx());
    expect(result.tools).toHaveLength(0);
  });

  test("returns zero tools when probe returns 401", async () => {
    globalThis.fetch = (async () =>
      new Response("invalid", { status: 401 })) as unknown as typeof globalThis.fetch;
    const result = await setup(makeCtx());
    expect(result.tools).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tool naming
// ---------------------------------------------------------------------------

describe("tool naming", () => {
  test("every tool name matches Anthropic's MCP convention", async () => {
    const result = await setup(makeCtx());
    for (const t of result.tools as ReadonlyArray<ToolDef>) {
      expect(t.name).toMatch(TOOL_NAME_RE);
    }
  });

  test("expected names present", async () => {
    const result = await setup(makeCtx());
    const names = (result.tools as ReadonlyArray<ToolDef>).map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "notion_append_blocks",
        "notion_archive_page",
        "notion_create_page",
        "notion_get_database_schema",
        "notion_get_page",
        "notion_list_databases",
        "notion_list_users",
        "notion_query_database",
        "notion_search",
        "notion_update_page_properties",
      ].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// Tier map
// ---------------------------------------------------------------------------

describe("tier map", () => {
  test("reads are auto, writes are confirm", async () => {
    const result = await setup(makeCtx());
    const tiers = (result.meta?.toolTiers ?? {}) as Record<string, string>;
    // Reads
    expect(tiers.notion_search).toBe("auto");
    expect(tiers.notion_list_databases).toBe("auto");
    expect(tiers.notion_get_page).toBe("auto");
    expect(tiers.notion_query_database).toBe("auto");
    expect(tiers.notion_get_database_schema).toBe("auto");
    expect(tiers.notion_list_users).toBe("auto");
    // Writes
    expect(tiers.notion_create_page).toBe("confirm");
    expect(tiers.notion_update_page_properties).toBe("confirm");
    expect(tiers.notion_append_blocks).toBe("confirm");
    expect(tiers.notion_archive_page).toBe("confirm");
  });

  test("default tier is confirm (defensive)", async () => {
    const result = await setup(makeCtx());
    expect(result.meta?.tier).toBe("confirm");
  });
});

// ---------------------------------------------------------------------------
// notion_archive_page body-confirm gate
// ---------------------------------------------------------------------------

describe("notion_archive_page body-confirm gate", () => {
  test("rejects confirm:false without calling the API", async () => {
    let updateCalls = 0;
    fakeNotionClient.pages.update = async () => {
      updateCalls++;
      return {};
    };
    const result = await setup(makeCtx());
    const archive = findTool(result.tools, "notion_archive_page");

    // confirm: false bypasses zod literal narrowing in TS but the runtime
    // handler still defends — that's the test.
    const parsed = (await callTool(archive, {
      page_id: "p-1",
      confirm: false,
    })) as { success: boolean; error: string };

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("confirm must be exactly");
    expect(updateCalls).toBe(0);
  });

  test("calls API and sets archived:true when confirm:true", async () => {
    let updateBody: { page_id?: string; archived?: boolean } | null = null;
    fakeNotionClient.pages.update = async (body: unknown) => {
      updateBody = body as typeof updateBody;
      return {
        id: "p-1",
        parent: { type: "database_id", database_id: "db-1" },
        properties: {},
        archived: true,
      };
    };
    const result = await setup(makeCtx());
    const archive = findTool(result.tools, "notion_archive_page");

    const parsed = (await callTool(archive, {
      page_id: "p-1",
      confirm: true,
    })) as { success: boolean; warning: string };

    expect(parsed.success).toBe(true);
    expect(updateBody).toMatchObject({ page_id: "p-1", archived: true });
    expect(parsed.warning).toContain("Reversible");
  });
});

// ---------------------------------------------------------------------------
// Error envelope mapping (use notion_list_users — simplest path through errorResult)
// ---------------------------------------------------------------------------

describe("error envelope mapping", () => {
  function makeErr(status: number, code?: string, message = "boom"): Error {
    const e = new Error(message) as Error & { status?: number; code?: string };
    e.status = status;
    if (code !== undefined) e.code = code;
    return e;
  }

  test("401 → authRequired envelope", async () => {
    fakeNotionClient.users.list = async () => {
      throw makeErr(401, "unauthorized");
    };
    const result = await setup(makeCtx());
    const tool = findTool(result.tools, "notion_list_users");
    const parsed = (await callTool(tool, {})) as {
      success: boolean;
      error: string;
      authRequired?: boolean;
    };
    expect(parsed.success).toBe(false);
    expect(parsed.authRequired).toBe(true);
    expect(parsed.error).toContain("NOTION_API_KEY");
  });

  test("403 → mentions Notion connections sharing", async () => {
    fakeNotionClient.users.list = async () => {
      throw makeErr(403, "restricted_resource");
    };
    const result = await setup(makeCtx());
    const tool = findTool(result.tools, "notion_list_users");
    const parsed = (await callTool(tool, {})) as { error: string };
    expect(parsed.error).toContain("Connections");
  });

  test("404 → bare message", async () => {
    fakeNotionClient.users.list = async () => {
      throw makeErr(404, "object_not_found", "page not found");
    };
    const result = await setup(makeCtx());
    const tool = findTool(result.tools, "notion_list_users");
    const parsed = (await callTool(tool, {})) as { success: boolean; error: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe("page not found");
  });

  test("429 → retry hint with retryAfter", async () => {
    fakeNotionClient.users.list = async () => {
      throw makeErr(429, "rate_limited");
    };
    const result = await setup(makeCtx());
    const tool = findTool(result.tools, "notion_list_users");
    const parsed = (await callTool(tool, {})) as {
      success: boolean;
      retryAfter: number;
    };
    expect(parsed.success).toBe(false);
    expect(parsed.retryAfter).toBe(60);
  });

  test("non-mapped error falls through with raw message", async () => {
    fakeNotionClient.users.list = async () => {
      throw new Error("something weird");
    };
    const result = await setup(makeCtx());
    const tool = findTool(result.tools, "notion_list_users");
    const parsed = (await callTool(tool, {})) as { success: boolean; error: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe("something weird");
  });
});

// ---------------------------------------------------------------------------
// Schema invalidate-and-retry on validation_error
// ---------------------------------------------------------------------------

describe("schema invalidate-and-retry", () => {
  test("notion_create_page retries once after a 400 from pages.create", async () => {
    let retrieveCalls = 0;
    fakeNotionClient.databases.retrieve = async () => {
      retrieveCalls++;
      return {
        id: "db-1",
        properties: {
          Title: { id: "title", type: "title", title: {} },
        },
      };
    };

    let createCalls = 0;
    fakeNotionClient.pages.create = async () => {
      createCalls++;
      if (createCalls === 1) {
        const e = new Error("invalid select option") as Error & {
          status: number;
          code: string;
        };
        e.status = 400;
        e.code = "validation_error";
        throw e;
      }
      return {
        id: "p-1",
        parent: { type: "database_id", database_id: "db-1" },
        properties: {},
      };
    };

    const result = await setup(makeCtx());
    const tool = findTool(result.tools, "notion_create_page");
    const parsed = (await callTool(tool, {
      database_id: "db-1",
      properties: { Title: "Hello" },
    })) as { success: boolean };

    expect(parsed.success).toBe(true);
    expect(createCalls).toBe(2); // 1 fail + 1 retry
    expect(retrieveCalls).toBe(2); // initial + invalidate-then-fetch
  });

  test("non-validation errors do NOT trigger retry", async () => {
    let retrieveCalls = 0;
    fakeNotionClient.databases.retrieve = async () => {
      retrieveCalls++;
      return {
        id: "db-1",
        properties: { Title: { id: "title", type: "title", title: {} } },
      };
    };
    let createCalls = 0;
    fakeNotionClient.pages.create = async () => {
      createCalls++;
      const e = new Error("server fire") as Error & { status: number };
      e.status = 500;
      throw e;
    };

    const result = await setup(makeCtx());
    const tool = findTool(result.tools, "notion_create_page");
    const parsed = (await callTool(tool, {
      database_id: "db-1",
      properties: { Title: "Hello" },
    })) as { success: boolean };

    expect(parsed.success).toBe(false);
    expect(createCalls).toBe(1); // no retry
    expect(retrieveCalls).toBe(1); // no invalidate-refetch
  });
});

// ---------------------------------------------------------------------------
// notion_query_database — filter coercion + pass-through
// ---------------------------------------------------------------------------

describe("notion_query_database filter coercion", () => {
  // Helper: install a queryFetchHandler that captures the request body and
  // returns an empty success response. Tests assert against `observed.filter`.
  function captureFilter(): { observed: { filter: unknown } } {
    const observed: { filter: unknown } = { filter: null };
    queryFetchHandler = async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      observed.filter = body.filter;
      return new Response(
        JSON.stringify({ results: [], has_more: false, next_cursor: null }),
        { status: 200 },
      );
    };
    return { observed };
  }

  test("rewrites a `select`-keyed filter to `status` when the property is status-typed", async () => {
    fakeNotionClient.databases.retrieve = async () => ({
      id: "db-1",
      properties: {
        Status: {
          id: "status",
          type: "status",
          status: { options: [{ name: "In progress" }] },
        },
      },
    });
    const { observed } = captureFilter();
    const result = await setup(makeCtx());
    const tool = findTool(result.tools, "notion_query_database");
    const parsed = (await callTool(tool, {
      database_id: "db-1",
      filter: {
        and: [{ property: "Status", select: { equals: "In progress" } }],
      },
    })) as { success: boolean; filter_coerced?: string[] };

    expect(parsed.success).toBe(true);
    expect(observed.filter).toEqual({
      and: [{ property: "Status", status: { equals: "In progress" } }],
    });
    expect(parsed.filter_coerced).toEqual(["Status: select -> status"]);
  });

  test("leaves a correctly-keyed filter untouched (no coercion)", async () => {
    fakeNotionClient.databases.retrieve = async () => ({
      id: "db-1",
      properties: {
        Priority: {
          id: "p",
          type: "select",
          select: { options: [{ name: "High" }] },
        },
      },
    });
    const { observed } = captureFilter();
    const result = await setup(makeCtx());
    const tool = findTool(result.tools, "notion_query_database");
    const parsed = (await callTool(tool, {
      database_id: "db-1",
      filter: { property: "Priority", select: { equals: "High" } },
    })) as { success: boolean; filter_coerced?: string[] };

    expect(parsed.success).toBe(true);
    expect(observed.filter).toEqual({
      property: "Priority",
      select: { equals: "High" },
    });
    expect(parsed.filter_coerced).toBeUndefined();
  });

  test("walks `or` composition and coerces inner leaves", async () => {
    fakeNotionClient.databases.retrieve = async () => ({
      id: "db-1",
      properties: {
        Status: { id: "s", type: "status", status: {} },
        Tags: { id: "t", type: "multi_select", multi_select: {} },
      },
    });
    const { observed } = captureFilter();
    const result = await setup(makeCtx());
    const tool = findTool(result.tools, "notion_query_database");
    await callTool(tool, {
      database_id: "db-1",
      filter: {
        or: [
          { property: "Status", select: { equals: "Done" } },
          { property: "Tags", select: { equals: "urgent" } },
        ],
      },
    });
    expect(observed.filter).toEqual({
      or: [
        { property: "Status", status: { equals: "Done" } },
        { property: "Tags", multi_select: { equals: "urgent" } },
      ],
    });
  });

  test("unknown property name passes through (Notion will surface the error)", async () => {
    fakeNotionClient.databases.retrieve = async () => ({
      id: "db-1",
      properties: { Status: { id: "s", type: "status", status: {} } },
    });
    const { observed } = captureFilter();
    const result = await setup(makeCtx());
    const tool = findTool(result.tools, "notion_query_database");
    await callTool(tool, {
      database_id: "db-1",
      filter: { property: "Bogus", select: { equals: "x" } },
    });
    expect(observed.filter).toEqual({
      property: "Bogus",
      select: { equals: "x" },
    });
  });

  test("no filter — no schema fetch, no coercion", async () => {
    let retrieveCalls = 0;
    fakeNotionClient.databases.retrieve = async () => {
      retrieveCalls++;
      return { id: "db-1", properties: {} };
    };
    captureFilter();
    const result = await setup(makeCtx());
    const tool = findTool(result.tools, "notion_query_database");
    await callTool(tool, { database_id: "db-1" });
    expect(retrieveCalls).toBe(0);
  });

  test("hits the legacy /v1/databases/{id}/query endpoint with the right headers", async () => {
    let observedUrl = "";
    let observedHeaders: Record<string, string> = {};
    queryFetchHandler = async (url, init) => {
      observedUrl = url;
      observedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response(
        JSON.stringify({ results: [], has_more: false, next_cursor: null }),
        { status: 200 },
      );
    };
    const result = await setup(makeCtx());
    const tool = findTool(result.tools, "notion_query_database");
    await callTool(tool, { database_id: "db-1" });
    expect(observedUrl).toBe(
      "https://api.notion.com/v1/databases/db-1/query",
    );
    expect(observedHeaders.Authorization).toBe("Bearer secret_test");
    expect(observedHeaders["Notion-Version"]).toBe("2022-06-28");
  });
});

// ---------------------------------------------------------------------------
// notion_query_database page_size defaults — the cap-overflow defense.
// Per-row property serialization is heavy enough that the shared
// DEFAULT_PAGE_SIZE = 25 overflows TOOL_RESULT_MAX_LEN on mid-size DBs;
// query_database uses its own smaller default (10).
// ---------------------------------------------------------------------------

describe("notion_query_database page_size defaults", () => {
  function capturePageSize(): { observed: { page_size: unknown } } {
    const observed: { page_size: unknown } = { page_size: null };
    queryFetchHandler = async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      observed.page_size = body.page_size;
      return new Response(
        JSON.stringify({ results: [], has_more: false, next_cursor: null }),
        { status: 200 },
      );
    };
    return { observed };
  }

  test("defaults to 10 when caller omits page_size", async () => {
    const { observed } = capturePageSize();
    const result = await setup(makeCtx());
    const tool = findTool(result.tools, "notion_query_database");
    await callTool(tool, { database_id: "db-1" });
    expect(observed.page_size).toBe(10);
  });

  test("honors caller-provided page_size up to 100", async () => {
    const { observed } = capturePageSize();
    const result = await setup(makeCtx());
    const tool = findTool(result.tools, "notion_query_database");
    await callTool(tool, { database_id: "db-1", page_size: 25 });
    expect(observed.page_size).toBe(25);
  });
});

// ---------------------------------------------------------------------------
// notion_get_database_schema — emits filter_template per property
// ---------------------------------------------------------------------------

describe("notion_get_database_schema filter_template", () => {
  test("returns type-correct filter_template for each property", async () => {
    fakeNotionClient.databases.retrieve = async () => ({
      id: "db-1",
      properties: {
        Name: { id: "title", type: "title", title: {} },
        Status: {
          id: "status",
          type: "status",
          status: { options: [{ name: "Done" }, { name: "In progress" }] },
        },
        Priority: {
          id: "priority",
          type: "select",
          select: { options: [{ name: "High" }] },
        },
        Tags: {
          id: "tags",
          type: "multi_select",
          multi_select: { options: [{ name: "urgent" }] },
        },
        Done: { id: "done", type: "checkbox", checkbox: {} },
        Due: { id: "due", type: "date", date: {} },
      },
    });
    const result = await setup(makeCtx());
    const tool = findTool(result.tools, "notion_get_database_schema");
    const parsed = (await callTool(tool, { database_id: "db-1" })) as {
      properties: Array<{ name: string; type: string; filter_template: unknown }>;
    };
    const byName = Object.fromEntries(parsed.properties.map((p) => [p.name, p]));
    // The status vs select distinction is the exact failure we're fixing —
    // both must produce the right discriminator key.
    expect(byName.Status.filter_template).toEqual({
      property: "Status",
      status: { equals: "<value>" },
    });
    expect(byName.Priority.filter_template).toEqual({
      property: "Priority",
      select: { equals: "<value>" },
    });
    expect(byName.Tags.filter_template).toEqual({
      property: "Tags",
      multi_select: { contains: "<value>" },
    });
    expect(byName.Done.filter_template).toEqual({
      property: "Done",
      checkbox: { equals: true },
    });
    expect(byName.Due.filter_template).toEqual({
      property: "Due",
      date: { on_or_after: "<YYYY-MM-DD>" },
    });
    // title uses contains
    expect(byName.Name.filter_template).toEqual({
      property: "Name",
      title: { contains: "<value>" },
    });
  });
});

// ---------------------------------------------------------------------------
// notion_list_databases — discovery wrapper around search(filter:database)
// ---------------------------------------------------------------------------

describe("notion_list_databases", () => {
  test("calls client.search with object=database filter and shapes the result", async () => {
    let observedBody: Record<string, unknown> | null = null;
    fakeNotionClient.search = async (body: unknown) => {
      observedBody = body as Record<string, unknown>;
      return {
        results: [
          {
            object: "database",
            id: "db-projects",
            url: "https://notion.so/db-projects",
            title: [{ plain_text: "Projects" }],
          },
          {
            object: "database",
            id: "db-tasks",
            url: "https://notion.so/db-tasks",
            title: [{ plain_text: "Tasks" }],
          },
        ],
        has_more: false,
        next_cursor: null,
      };
    };
    const result = await setup(makeCtx());
    const tool = findTool(result.tools, "notion_list_databases");
    const parsed = (await callTool(tool, { query: "proj" })) as {
      success: boolean;
      count: number;
      databases: Array<{ id: string; title: string; url: string }>;
    };

    expect(parsed.success).toBe(true);
    expect(parsed.count).toBe(2);
    expect(parsed.databases[0]).toEqual({
      id: "db-projects",
      title: "Projects",
      url: "https://notion.so/db-projects",
    });
    expect(observedBody).toMatchObject({
      filter: { property: "object", value: "database" },
      query: "proj",
    });
  });

  test("omits query when not provided", async () => {
    let observedBody: Record<string, unknown> | null = null;
    fakeNotionClient.search = async (body: unknown) => {
      observedBody = body as Record<string, unknown>;
      return { results: [], has_more: false, next_cursor: null };
    };
    const result = await setup(makeCtx());
    const tool = findTool(result.tools, "notion_list_databases");
    await callTool(tool, {});
    expect(observedBody).not.toHaveProperty("query");
    expect(observedBody).toMatchObject({
      filter: { property: "object", value: "database" },
    });
  });
});

// ---------------------------------------------------------------------------
// notion_update_page_properties — rejects non-database pages
// ---------------------------------------------------------------------------

describe("notion_update_page_properties", () => {
  test("rejects pages not in a database", async () => {
    fakeNotionClient.pages.retrieve = async () => ({
      id: "p-2",
      parent: { type: "page_id", page_id: "parent-page" },
      properties: {},
    });
    const result = await setup(makeCtx());
    const tool = findTool(result.tools, "notion_update_page_properties");
    const parsed = (await callTool(tool, {
      page_id: "p-2",
      properties: { Title: "x" },
    })) as { success: boolean; error: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("not in a database");
  });
});

// ---------------------------------------------------------------------------
// notion_append_blocks — chunking and partial-failure envelope
// ---------------------------------------------------------------------------

describe("notion_append_blocks", () => {
  test("chunks 250 blocks into 3 calls and reports counts", async () => {
    const callBatches: number[] = [];
    fakeNotionClient.blocks.children.append = async (body: unknown) => {
      const children = (body as { children: unknown[] }).children;
      callBatches.push(children.length);
      return {};
    };
    const result = await setup(makeCtx());
    const tool = findTool(result.tools, "notion_append_blocks");

    const blocks = Array.from({ length: 250 }, (_, i) => ({
      type: "paragraph" as const,
      text: `b${i}`,
    }));
    const parsed = (await callTool(tool, {
      block_id: "p-1",
      blocks,
    })) as { success: boolean; blocksAppended: number; chunks: number };

    expect(parsed.success).toBe(true);
    expect(parsed.blocksAppended).toBe(250);
    expect(parsed.chunks).toBe(3);
    expect(callBatches).toEqual([100, 100, 50]);
  });

  test("partial failure reports lastError and stops after first failed chunk", async () => {
    let appendCalls = 0;
    fakeNotionClient.blocks.children.append = async () => {
      appendCalls++;
      if (appendCalls === 2) throw new Error("network blip");
      return {};
    };
    const result = await setup(makeCtx());
    const tool = findTool(result.tools, "notion_append_blocks");
    const blocks = Array.from({ length: 250 }, (_, i) => ({
      type: "paragraph" as const,
      text: `b${i}`,
    }));
    const parsed = (await callTool(tool, {
      block_id: "p-1",
      blocks,
    })) as {
      success: boolean;
      blocksAppended: number;
      chunks: number;
      lastError: string;
    };
    expect(parsed.success).toBe(false);
    expect(parsed.blocksAppended).toBe(100); // only first chunk landed
    expect(parsed.chunks).toBe(3);
    expect(parsed.lastError).toContain("network blip");
    expect(appendCalls).toBe(2); // halted after second chunk failed
  });
});
