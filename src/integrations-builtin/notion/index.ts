/**
 * @fileoverview Built-in `notion` integration — single-token Notion API
 *               wrapper exposing read tools (Phase 2) plus future write
 *               tools (Phase 3) to both Claude tiers and the Ollama tool
 *               loop.
 *
 * Why blessed (in-process MCP), not external:
 *   - Solrac's Ollama tool loop only sees `mcp__solrac__*` names; an
 *     external `@notionhq/notion-mcp-server` would be invisible to the
 *     `>`-prefix engine. See `policy.ts` for the prefix branch.
 *   - Per-tool tier control (auto/confirm) only applies to in-process
 *     integrations; external MCP can't participate.
 *
 * Setup gates (in order, all log once):
 *   1. `notionModuleAvailable()` — `@notionhq/client` loadable from
 *      `node_modules`? (Shipped in solrac's `dependencies`; this only
 *      fails on a broken or unpopulated `node_modules`.)
 *   2. `isNotionConfigured()` — `NOTION_API_KEY` set?
 *   3. `probeNotionToken(3000)` — token valid? (3s hard timeout)
 *   4. Register tools.
 *
 * Token security: `NOTION_API_KEY` is scrubbed from the SDK subprocess env
 * by `agent.ts::sanitizedSubprocessEnv` (deny-list). The integration handler
 * runs in-process so the SDK subprocess never needs the token; without
 * scrubbing, an auto-allowed `Bash(echo $NOTION_API_KEY)` could exfiltrate.
 *
 * Cross-references:
 *   - PLAN.md (solrac-dev) §2 (tool surface), §6 (env scrub)
 *   - ./client.ts — lazy-loader, probe, schema cache, block tree fetcher
 *   - ./formatters.ts — DSL ↔ API shape transforms
 *   - ../gmail/index.ts — sibling pattern (multi-account, more tools)
 */

import type {
  IntegrationContext,
  IntegrationModule,
} from "../../integrations.ts";
import {
  type DatabaseSchema,
  fetchBlockTree,
  getDatabaseSchema,
  getNotionClient,
  invalidateSchemaCache,
  isNotionConfigured,
  notionModuleAvailable,
  probeNotionToken,
  queryDatabase,
} from "./client.ts";
import {
  BLOCK_DEPTH_CAP,
  type BlockInput,
  chunkBlocks,
  formatFullPage,
  formatPageSummary,
  formatProperty,
  serializeBlocks,
  serializeProperties,
} from "./formatters.ts";

type LooseAny = any;
type ToolResult = { content: Array<{ type: "text"; text: string }> };

const PROBE_TIMEOUT_MS = 3000;
const DEFAULT_PAGE_SIZE = 25;
// notion_query_database returns full per-property serialization per row, which
// overflows TOOL_RESULT_MAX_LEN on mid-size DBs. Default smaller; the model
// can opt up via `page_size: 25` when it knows the rows are slim.
const QUERY_DATABASE_DEFAULT_PAGE_SIZE = 10;

function jsonResult(payload: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

/**
 * Coerce a model-supplied Notion filter to match the actual property types
 * in `schema`. Walks `and`/`or` composition. For each leaf
 * `{property: "X", <typeKey>: {...}}`, if `<typeKey>` doesn't match the
 * property's actual type but it's the only non-`property` key, rewrite it
 * to use the correct discriminator.
 *
 * Why we need this even though `notion_get_database_schema` returns a
 * `filter_template` per property: small models (gemma4:e4b) routinely
 * ignore the template and send `{property:"Status", select:{equals:...}}`
 * for a `status`-typed property, latching onto `select` from training-data
 * prior. The model gets the intent right (property + value) but mis-keys
 * the discriminator. Coercion fixes the obvious ones; anything ambiguous
 * passes through untouched and Notion's API surfaces the error.
 *
 * Corrections are logged + included in the tool's response envelope so the
 * operator can see which models need reinforcing in the descriptions.
 */
function coerceFilterToSchema(
  filter: unknown,
  schema: DatabaseSchema,
): { filter: unknown; corrections: string[] } {
  const corrections: string[] = [];

  function walk(node: unknown): unknown {
    if (node === null || typeof node !== "object") return node;
    const obj = node as Record<string, unknown>;
    // Composition: and/or
    if (Array.isArray(obj.and)) {
      return { and: obj.and.map(walk) };
    }
    if (Array.isArray(obj.or)) {
      return { or: obj.or.map(walk) };
    }
    // Leaf: {property: "X", <typeKey>: {<op>: <val>}}
    if (typeof obj.property === "string") {
      const prop = schema.properties[obj.property];
      if (!prop) return node;
      const expected = prop.type;
      const keys = Object.keys(obj).filter((k) => k !== "property");
      if (keys.length === 1 && keys[0] !== expected) {
        const wrong = keys[0];
        corrections.push(
          `${obj.property}: ${wrong} -> ${expected}`,
        );
        return { property: obj.property, [expected]: obj[wrong] };
      }
    }
    return node;
  }

  return { filter: walk(filter), corrections };
}

/**
 * Per-property-type filter template returned by `notion_get_database_schema`.
 * Notion's filter shape is type-discriminated (`status` vs `select` vs
 * `multi_select` all share similar names but distinct keys), and small
 * tool-callers (gemma4:e4b in particular) routinely confuse them. Returning
 * a worked template per property lets the model copy-paste a known-good
 * shape and only fill in the value, rather than infer the discriminator
 * from the property type.
 *
 * `<value>` is the placeholder the model substitutes.
 *
 * Returns `null` for property types where filter syntax is rare or
 * subjective (formula, rollup, files, …) — the model can fall back to the
 * Notion docs for those.
 */
function filterTemplateFor(name: string, type: string): unknown {
  switch (type) {
    case "title":
    case "rich_text":
    case "url":
    case "email":
    case "phone_number":
      return { property: name, [type]: { contains: "<value>" } };
    case "select":
      return { property: name, select: { equals: "<value>" } };
    case "status":
      return { property: name, status: { equals: "<value>" } };
    case "multi_select":
      return { property: name, multi_select: { contains: "<value>" } };
    case "checkbox":
      return { property: name, checkbox: { equals: true } };
    case "number":
      return { property: name, number: { equals: 0 } };
    case "date":
    case "created_time":
    case "last_edited_time":
      return { property: name, [type]: { on_or_after: "<YYYY-MM-DD>" } };
    case "people":
    case "created_by":
    case "last_edited_by":
      return { property: name, [type]: { contains: "<user-id>" } };
    case "relation":
      return { property: name, relation: { contains: "<page-id>" } };
    default:
      return null;
  }
}

/**
 * Run `op` with the cached schema for `databaseId`. If `op` throws a 400 or
 * 404 (or `validation_error`), invalidate and retry once with a fresh fetch.
 * Handles the rare case where the cached schema is stale relative to a
 * just-renamed/added select option. A second failure propagates.
 */
async function withSchemaRetry<T>(
  databaseId: string,
  op: (schema: DatabaseSchema) => Promise<T>,
): Promise<T> {
  const schema = await getDatabaseSchema(databaseId);
  try {
    return await op(schema);
  } catch (err) {
    const e = err as { status?: number; code?: string };
    const retryable =
      e?.status === 400 ||
      e?.status === 404 ||
      e?.code === "validation_error" ||
      e?.code === "object_not_found";
    if (!retryable) throw err;
    invalidateSchemaCache(databaseId);
    const fresh = await getDatabaseSchema(databaseId);
    return await op(fresh);
  }
}

/**
 * Map a thrown error to a friendly envelope. Notion's SDK throws errors with
 * `code` (string) + `status` (number) + `message`. Mirror gmail's mapping
 * for the common cases so the model gets actionable text.
 */
function errorResult(err: unknown): ToolResult {
  const e = err as LooseAny;
  const status: number | null = typeof e?.status === "number" ? e.status : null;
  const code: string | null = typeof e?.code === "string" ? e.code : null;
  const message: string = e?.message ?? String(err);

  if (status === 401 || code === "unauthorized") {
    return jsonResult({
      success: false,
      error: "Notion authentication failed. Check NOTION_API_KEY.",
      authRequired: true,
    });
  }
  if (status === 403 || code === "restricted_resource") {
    return jsonResult({
      success: false,
      error:
        "Permission denied. Make sure the integration is shared with this resource " +
        "(Notion → Settings → Connections → Add).",
    });
  }
  if (status === 404 || code === "object_not_found") {
    return jsonResult({ success: false, error: message });
  }
  if (status === 429 || code === "rate_limited") {
    return jsonResult({
      success: false,
      error: "Notion rate limit exceeded. Retry in 60 seconds.",
      retryAfter: 60,
    });
  }
  if (status === 400 || code === "validation_error") {
    return jsonResult({ success: false, error: message });
  }
  return jsonResult({ success: false, error: message });
}

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------

export default async function setup(
  ctx: IntegrationContext,
): Promise<IntegrationModule> {
  // Gate 1: dep loadable? `@notionhq/client` ships in dependencies, so
  // this should always succeed; the gate exists so a broken/unpopulated
  // `node_modules` (e.g. fresh checkout pre-`npm install`) doesn't crash
  // boot.
  const haveDep = await notionModuleAvailable();
  if (!haveDep) {
    ctx.log.warn("integrations.notion.deps_missing", {
      hint: "Run `npm ci` (or `npm install`) in the solrac repo root to populate node_modules.",
    });
    return { apiVersion: 1, tools: [] };
  }

  // Gate 2: env var set?
  if (!isNotionConfigured()) {
    ctx.log.info("integrations.notion.disabled", {
      reason: "NOTION_API_KEY not set",
      hint: "Create an internal integration at https://www.notion.so/my-integrations, copy the secret, set NOTION_API_KEY in solrac's environment, and share each target page or database with the integration.",
    });
    return { apiVersion: 1, tools: [] };
  }

  // Gate 3: token valid? (3s hard timeout — fast operator feedback)
  const probe = await probeNotionToken(PROBE_TIMEOUT_MS);
  if (!probe.ok) {
    ctx.log.warn("integrations.notion.token_invalid", { error: probe.error });
    return { apiVersion: 1, tools: [] };
  }

  // ===== Read tools (auto tier) =====

  const tools = [
    // notion_search
    ctx.tool(
      "notion_search",
      "Search the Notion workspace. Honors the integration's shared-page set: " +
        "you only see pages and databases that have been explicitly shared " +
        "with the integration. Filter by `page` or `database`. For database-" +
        "scoped queries, prefer `notion_query_database` (filters + sorts).",
      {
        query: ctx.z
          .string()
          .optional()
          .describe("Free-text search. Empty = list everything shared."),
        filter: ctx.z
          .enum(["page", "database"])
          .optional()
          .describe('"page" or "database" to restrict object type.'),
        page_size: ctx.z
          .number()
          .min(1)
          .max(100)
          .optional()
          .describe("Default 25, max 100."),
        start_cursor: ctx.z
          .string()
          .optional()
          .describe("Pagination cursor from a previous response."),
      },
      async (args): Promise<ToolResult> => {
        try {
          const client = await getNotionClient();
          const body: LooseAny = {
            page_size: args.page_size ?? DEFAULT_PAGE_SIZE,
          };
          if (args.query) body.query = args.query;
          if (args.start_cursor) body.start_cursor = args.start_cursor;
          if (args.filter) {
            body.filter = { property: "object", value: args.filter };
          }
          const res: LooseAny = await client.search(body);
          const results: LooseAny[] = res.results ?? [];
          return jsonResult({
            success: true,
            count: results.length,
            has_more: Boolean(res.has_more),
            next_cursor: res.next_cursor ?? null,
            results: results.map((r: LooseAny) => {
              if (r.object === "page") {
                return { object: "page", ...formatPageSummary(r) };
              }
              if (r.object === "database") {
                const titleArr = Array.isArray(r.title) ? r.title : [];
                return {
                  object: "database",
                  id: String(r.id ?? ""),
                  url: String(r.url ?? ""),
                  title: titleArr
                    .map((rt: LooseAny) => rt.plain_text ?? rt.text?.content ?? "")
                    .join(""),
                };
              }
              return { object: r.object, id: r.id };
            }),
          });
        } catch (err) {
          return errorResult(err);
        }
      },
      { alwaysLoad: true },
    ),

    // notion_list_databases — dedicated discovery path. Implemented as a
    // thin wrapper over `client.search({filter: object=database})` so weak
    // tool-callers (gemma4:e4b in particular) get an obvious step between
    // "user mentioned a database by name" and `notion_query_database`,
    // without needing to combine `notion_search` with the right filter.
    ctx.tool(
      "notion_list_databases",
      "List Notion databases visible to the integration. Returns id + title " +
        "+ url per database. **Use this BEFORE `notion_query_database` or " +
        "`notion_get_database_schema`** when you don't already know the " +
        "database id. Optional `query` filters by title substring. The " +
        "integration only sees databases that have been shared (directly or " +
        "via a connected parent page).",
      {
        query: ctx.z
          .string()
          .optional()
          .describe(
            "Optional case-insensitive substring filter on database title. " +
              'Empty = list every database the integration can see.',
          ),
        page_size: ctx.z.number().min(1).max(100).optional(),
        start_cursor: ctx.z.string().optional(),
      },
      async (args): Promise<ToolResult> => {
        try {
          const client = await getNotionClient();
          const body: LooseAny = {
            filter: { property: "object", value: "database" },
            page_size: args.page_size ?? DEFAULT_PAGE_SIZE,
          };
          if (args.query) body.query = args.query;
          if (args.start_cursor) body.start_cursor = args.start_cursor;
          const res: LooseAny = await client.search(body);
          const results: LooseAny[] = res.results ?? [];
          return jsonResult({
            success: true,
            count: results.length,
            has_more: Boolean(res.has_more),
            next_cursor: res.next_cursor ?? null,
            databases: results.map((r: LooseAny) => {
              const titleArr = Array.isArray(r.title) ? r.title : [];
              return {
                id: String(r.id ?? ""),
                url: String(r.url ?? ""),
                title: titleArr
                  .map((rt: LooseAny) => rt.plain_text ?? rt.text?.content ?? "")
                  .join(""),
              };
            }),
          });
        } catch (err) {
          return errorResult(err);
        }
      },
      { alwaysLoad: true },
    ),

    // notion_get_page
    ctx.tool(
      "notion_get_page",
      `Get a Notion page's properties + block tree. Returns blocks nested up to ` +
        `${BLOCK_DEPTH_CAP} levels deep; deeper blocks are flagged ` +
        `\`truncated: true\` so you know more content exists. To retrieve a ` +
        `block's deeper children directly, call \`notion_get_page\` again ` +
        `with the block's id.`,
      {
        page_id: ctx.z
          .string()
          .describe("Page id (or block id). UUIDs with or without dashes."),
      },
      async (args): Promise<ToolResult> => {
        try {
          const client = await getNotionClient();
          const [page, tree] = await Promise.all([
            client.pages
              .retrieve({ page_id: args.page_id })
              .catch(() => null) as Promise<LooseAny>,
            fetchBlockTree(args.page_id, BLOCK_DEPTH_CAP),
          ]);
          if (!page) {
            // page_id might be a block id — return blocks-only view.
            return jsonResult({
              success: true,
              page: null,
              blocks: tree.map((node) => ({
                id: String(node.block?.id ?? ""),
                type: String(node.block?.type ?? ""),
                has_children: Boolean(node.block?.has_children),
              })),
            });
          }
          return jsonResult({
            success: true,
            page: formatFullPage(page, tree),
          });
        } catch (err) {
          return errorResult(err);
        }
      },
      { alwaysLoad: true },
    ),

    // notion_query_database
    ctx.tool(
      "notion_query_database",
      "Query a Notion database with filters + sorts. Returns matching pages " +
        "as flat property summaries (use `notion_get_page` for full content). " +
        "If you don't already know the database id, call " +
        "`notion_list_databases` first. ALWAYS call " +
        "`notion_get_database_schema` before constructing a filter — its " +
        "`filter_template` field gives you the exact filter shape for each " +
        "property.",
      {
        database_id: ctx.z.string(),
        filter: ctx.z
          .unknown()
          .optional()
          .describe(
            "Notion filter object. The filter key is TYPE-DISCRIMINATED — " +
              "use the property's type (from notion_get_database_schema), " +
              "NOT a guess. Examples by type:\n" +
              '- status:       {"property":"Status","status":{"equals":"In progress"}}\n' +
              '- select:       {"property":"Priority","select":{"equals":"High"}}\n' +
              '- multi_select: {"property":"Tags","multi_select":{"contains":"urgent"}}\n' +
              '- checkbox:     {"property":"Done","checkbox":{"equals":true}}\n' +
              '- date:         {"property":"Due","date":{"on_or_after":"2026-01-01"}}\n' +
              '- combine:      {"and":[<filter1>,<filter2>,...]}  (also "or")\n' +
              "See https://developers.notion.com/reference/post-database-query-filter for full spec.",
          ),
        sorts: ctx.z
          .array(ctx.z.unknown())
          .optional()
          .describe(
            "Array of sort descriptors per Notion spec, e.g. " +
              '[{"property":"Priority","direction":"descending"}].',
          ),
        page_size: ctx.z
          .number()
          .min(1)
          .max(100)
          .optional()
          .describe(
            "Default 10 (lower than the 25 used by other notion_* tools " +
              "because per-row property serialization is heavier here and " +
              "overflows the tool-result cap on mid-size DBs). Max 100. " +
              "Opt up when you know the rows are slim or you've already " +
              "paginated the heavier ones away.",
          ),
        start_cursor: ctx.z.string().optional(),
      },
      async (args): Promise<ToolResult> => {
        try {
          // Coerce a bad filter discriminator (e.g. `select` for a `status`
          // property) using the cached schema before sending to Notion.
          // Small tool-callers (gemma4:e4b) routinely send the wrong
          // discriminator key despite the `filter_template` in the schema
          // response.
          let coercions: string[] = [];
          let filter: unknown = args.filter;
          if (filter !== undefined) {
            const schema = await getDatabaseSchema(args.database_id);
            const result = coerceFilterToSchema(filter, schema);
            filter = result.filter;
            coercions = result.corrections;
            if (coercions.length > 0) {
              ctx.log.info("integrations.notion.filter_coerced", {
                database_id: args.database_id,
                corrections: coercions,
              });
            }
          }
          // We call the legacy POST /v1/databases/{id}/query directly
          // because the SDK v5 dropped `client.databases.query` in favor of
          // `dataSources.query`. See `client.ts::queryDatabase`.
          const body: Record<string, unknown> = {
            page_size: args.page_size ?? QUERY_DATABASE_DEFAULT_PAGE_SIZE,
          };
          if (filter !== undefined) body.filter = filter;
          if (args.sorts !== undefined) body.sorts = args.sorts;
          if (args.start_cursor) body.start_cursor = args.start_cursor;
          const res: LooseAny = await queryDatabase(args.database_id, body);
          const results: LooseAny[] = res.results ?? [];
          return jsonResult({
            success: true,
            count: results.length,
            has_more: Boolean(res.has_more),
            next_cursor: res.next_cursor ?? null,
            ...(coercions.length > 0 ? { filter_coerced: coercions } : {}),
            results: results.map((p: LooseAny) => {
              const summary = formatPageSummary(p);
              const properties: Record<string, unknown> = {};
              for (const [name, value] of Object.entries(
                (p.properties ?? {}) as Record<string, LooseAny>,
              )) {
                properties[name] = formatProperty(value);
              }
              return { ...summary, properties };
            }),
          });
        } catch (err) {
          return errorResult(err);
        }
      },
      { alwaysLoad: true },
    ),

    // notion_get_database_schema
    ctx.tool(
      "notion_get_database_schema",
      "Get a database's property schema (names + types + options). USE THIS " +
        "BEFORE creating/updating rows OR querying with a filter — each " +
        "property entry includes a `filter_template` showing the exact " +
        "Notion filter shape for that property. Copy the template, " +
        "substitute the value, and pass to `notion_query_database`. Notion's " +
        "filter shape is type-discriminated (status vs select vs " +
        "multi_select all use different keys), so the template eliminates " +
        "guesswork. Cached in-process; subsequent calls are free.",
      {
        database_id: ctx.z.string(),
      },
      async (args): Promise<ToolResult> => {
        try {
          const schema = await getDatabaseSchema(args.database_id);
          // Flatten properties for the model: {name, type, options?, filter_template}.
          const properties: Array<Record<string, unknown>> = [];
          for (const [name, prop] of Object.entries(schema.properties)) {
            const entry: Record<string, unknown> = {
              name,
              type: prop.type,
            };
            const raw = prop.raw as LooseAny;
            if (prop.type === "select" || prop.type === "multi_select") {
              const opts = raw?.[prop.type]?.options ?? [];
              entry.options = Array.isArray(opts)
                ? opts.map((o: LooseAny) => String(o.name))
                : [];
            } else if (prop.type === "status") {
              const opts = raw?.status?.options ?? [];
              entry.options = Array.isArray(opts)
                ? opts.map((o: LooseAny) => String(o.name))
                : [];
            }
            const template = filterTemplateFor(name, prop.type);
            if (template !== null) entry.filter_template = template;
            properties.push(entry);
          }
          return jsonResult({
            success: true,
            database_id: schema.id,
            property_count: properties.length,
            properties,
          });
        } catch (err) {
          return errorResult(err);
        }
      },
      { alwaysLoad: true },
    ),

    // notion_list_users
    ctx.tool(
      "notion_list_users",
      "List workspace members visible to the integration. Returns id + name " +
        "+ type (`person` | `bot`) per user. Required to set `Assignee` " +
        "(person-typed) properties — pass user IDs, not names.",
      {
        page_size: ctx.z.number().min(1).max(100).optional(),
        start_cursor: ctx.z.string().optional(),
      },
      async (args): Promise<ToolResult> => {
        try {
          const client = await getNotionClient();
          const res: LooseAny = await client.users.list({
            page_size: args.page_size ?? DEFAULT_PAGE_SIZE,
            ...(args.start_cursor ? { start_cursor: args.start_cursor } : {}),
          });
          const users: LooseAny[] = res.results ?? [];
          return jsonResult({
            success: true,
            count: users.length,
            has_more: Boolean(res.has_more),
            next_cursor: res.next_cursor ?? null,
            users: users.map((u: LooseAny) => ({
              id: String(u.id ?? ""),
              name: String(u.name ?? ""),
              type: String(u.type ?? ""),
              ...(u.person?.email ? { email: String(u.person.email) } : {}),
            })),
          });
        } catch (err) {
          return errorResult(err);
        }
      },
      { alwaysLoad: true },
    ),

    // ===== WRITE TOOLS (confirm tier) =====

    // notion_create_page — new row in a database
    ctx.tool(
      "notion_create_page",
      "Create a new page (row) in a Notion database. `properties` is a flat " +
        "DSL keyed by property name (e.g. `{Status: \"Done\", Priority: \"High\", " +
        "Assignee: [\"<user-id>\"]}`); use `notion_get_database_schema` first to " +
        "discover types and select options. Optional `content` is an array of " +
        "typed blocks to seed the page body.",
      {
        database_id: ctx.z.string(),
        properties: ctx.z
          .record(ctx.z.string(), ctx.z.unknown())
          .describe("DSL keyed by property name. See notion_get_database_schema."),
        content: ctx.z
          .array(ctx.z.unknown())
          .optional()
          .describe(
            'Optional initial blocks. Each: {type: "paragraph"|"heading_1"|"heading_2"|' +
              '"heading_3"|"bulleted_list_item"|"numbered_list_item"|"to_do"|"quote"|"code"|' +
              '"divider"|"callout", text: string, ...}.',
          ),
      },
      async (args): Promise<ToolResult> => {
        try {
          const client = await getNotionClient();
          return await withSchemaRetry(args.database_id, async (schema) => {
            const props = serializeProperties(
              args.properties as Record<string, unknown>,
              schema,
            );
            const body: LooseAny = {
              parent: { database_id: args.database_id },
              properties: props,
            };
            if (args.content && args.content.length > 0) {
              body.children = serializeBlocks(args.content as BlockInput[]);
            }
            const res: LooseAny = await client.pages.create(body);
            return jsonResult({
              success: true,
              page: formatPageSummary(res),
            });
          });
        } catch (err) {
          return errorResult(err);
        }
      },
      { alwaysLoad: true },
    ),

    // notion_update_page_properties — patch an existing page's properties
    ctx.tool(
      "notion_update_page_properties",
      "Patch properties on an existing database page. The page must be in a " +
        "database (workspace pages are not supported in v1). `properties` is " +
        "the same flat DSL as notion_create_page. Set `archived: false` to " +
        "restore an archived page; for archiving, use notion_archive_page.",
      {
        page_id: ctx.z.string(),
        properties: ctx.z.record(ctx.z.string(), ctx.z.unknown()),
        archived: ctx.z
          .boolean()
          .optional()
          .describe("Set false to restore. To archive, use notion_archive_page."),
      },
      async (args): Promise<ToolResult> => {
        try {
          const client = await getNotionClient();
          // Fetch the page once to discover its database_id (parent.database_id).
          // After this, the schema cache makes subsequent updates against the
          // same DB free.
          const page: LooseAny = await client.pages.retrieve({
            page_id: args.page_id,
          });
          const parentType = String(page?.parent?.type ?? "");
          if (parentType !== "database_id") {
            return jsonResult({
              success: false,
              error:
                "page is not in a database; only database pages support property updates",
            });
          }
          const databaseId = String(page.parent.database_id);
          return await withSchemaRetry(databaseId, async (schema) => {
            const props = serializeProperties(
              args.properties as Record<string, unknown>,
              schema,
            );
            const body: LooseAny = {
              page_id: args.page_id,
              properties: props,
            };
            if (args.archived !== undefined) body.archived = args.archived;
            const res: LooseAny = await client.pages.update(body);
            return jsonResult({
              success: true,
              page: formatPageSummary(res),
            });
          });
        } catch (err) {
          return errorResult(err);
        }
      },
      { alwaysLoad: true },
    ),

    // notion_append_blocks — append typed blocks to a page or block
    ctx.tool(
      "notion_append_blocks",
      "Append typed blocks to a page or block. Auto-chunks at 100 blocks per " +
        "call (Notion API limit). On partial failure, returns " +
        "`{blocksAppended, chunks, lastError}` so the caller can decide " +
        "whether to retry remaining blocks. Block shape: same as " +
        "`notion_create_page.content`.",
      {
        block_id: ctx.z
          .string()
          .describe("Page id or parent block id to append children to."),
        blocks: ctx.z
          .array(ctx.z.unknown())
          .describe("Typed-block array (see notion_create_page for shapes)."),
      },
      async (args): Promise<ToolResult> => {
        try {
          const client = await getNotionClient();
          const serialized = serializeBlocks(args.blocks as BlockInput[]);
          const chunks = chunkBlocks(serialized, 100);
          let appended = 0;
          let lastError: string | null = null;
          for (const chunk of chunks) {
            try {
              await client.blocks.children.append({
                block_id: args.block_id,
                children: chunk,
              });
              appended += chunk.length;
            } catch (err) {
              lastError = (err as Error).message ?? String(err);
              break;
            }
          }
          return jsonResult({
            success: lastError === null,
            blocksAppended: appended,
            chunks: chunks.length,
            ...(lastError !== null ? { lastError } : {}),
          });
        } catch (err) {
          return errorResult(err);
        }
      },
      { alwaysLoad: true },
    ),

    // notion_archive_page — soft-delete (reversible). Body confirm:true required.
    ctx.tool(
      "notion_archive_page",
      "Archive (soft-delete) a Notion page. Reversible — call " +
        "`notion_update_page_properties` with `archived: false` to restore. " +
        "Requires `confirm: true` to execute (belt-and-suspenders alongside " +
        "the user's Telegram-confirm prompt).",
      {
        page_id: ctx.z.string(),
        confirm: ctx.z
          .literal(true)
          .describe(
            "Must be exactly `true`. The MODEL must explicitly assert intent " +
              "before the user's Telegram approval is even shown.",
          ),
      },
      async (args): Promise<ToolResult> => {
        try {
          if (args.confirm !== true) {
            return jsonResult({
              success: false,
              error: "confirm must be exactly `true` to archive.",
            });
          }
          const client = await getNotionClient();
          const res: LooseAny = await client.pages.update({
            page_id: args.page_id,
            archived: true,
          });
          return jsonResult({
            success: true,
            page: formatPageSummary(res),
            warning:
              "Page archived. Reversible — notion_update_page_properties with archived:false restores it.",
          });
        } catch (err) {
          return errorResult(err);
        }
      },
      { alwaysLoad: true },
    ),
  ];

  ctx.log.info("integrations.notion.loaded", {
    user: probe.user.name,
    toolCount: tools.length,
  });

  return {
    apiVersion: 1,
    tools,
    meta: {
      // Default to confirm — defensive for the writes. Reads override below.
      tier: "confirm",
      toolTiers: {
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
      },
    },
  };
}
