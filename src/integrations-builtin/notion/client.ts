/**
 * @fileoverview Notion API client wrapper for the blessed `notion` integration.
 * @purpose Lazy-loads `@notionhq/client` (shipped in solrac's runtime
 *          `dependencies`), resolves the `NOTION_API_KEY`, probes
 *          `/v1/users/me` at boot for fast feedback on bad tokens, and
 *          caches per-database schemas so the property DSL serializer can
 *          stay fast.
 *
 *          The dep is bundled, but the integration still dynamic-imports it
 *          so a missing/broken `node_modules` (e.g. fresh checkout without
 *          `npm install` yet) degrades gracefully via the `deps_missing`
 *          gate rather than crashing boot.
 *
 * Differences from gmail/client.ts:
 *
 *   1. Single-token auth — Notion uses static integration tokens (one
 *      workspace per Solrac instance). No filesystem tokens, no refresh
 *      dance, no per-alias caches. Multi-token is YAGNI for v1.
 *
 *   2. Boot probe is a raw `fetch` to `/v1/users/me` with a 3s timeout, NOT
 *      a call through the SDK. The SDK would add its own retry + backoff,
 *      which would mask the fast-fail intent of the probe.
 *
 *   3. Schema cache is in-process, no TTL. Notion DB schemas don't churn,
 *      Solrac is "boot once, never reload", and write paths invalidate on
 *      400/404 to handle the rare operator-renamed-a-select-option case.
 *
 * Token leakage posture:
 *   - The integration handler runs in solrac's main process. The SDK-spawned
 *     `claude` subprocess never needs `NOTION_API_KEY`.
 *   - `agent.ts::sanitizedSubprocessEnv` scrubs the var so an auto-allowed
 *     `Bash(echo …)` call cannot exfiltrate the token.
 *
 * Cross-references:
 *   - PLAN.md (solrac-dev) §5 — exported surface
 *   - ./index.ts — setup(ctx) gates registration on the boot probe.
 *   - ../gmail/client.ts — sibling lazy-load + cache pattern.
 */

// `@notionhq/client` is in solrac's runtime dependencies, but we keep the
// dynamic-import pattern so the integration self-gates on a missing/broken
// `node_modules` (e.g. fresh checkout pre-`npm install`) rather than
// crashing boot. The runtime gate (`notionModuleAvailable()`) returns false
// if the package can't be loaded, and `setup()` registers zero tools in
// that case.
type LooseAny = any; // narrow alias to avoid eslint-disable proliferation

// ---------------------------------------------------------------------------
// Lazy module loader (cached after first call)
// ---------------------------------------------------------------------------

interface NotionModules {
  Client: LooseAny;
}

let notionModulesCache: NotionModules | null = null;
let notionModulesError: Error | null = null;

/**
 * Dynamic-import `@notionhq/client` on first use. Cached.
 *
 * Throws if the package is not installed; `setup()` is expected to probe-
 * and-disable BEFORE any handler runs, so this should only ever throw under
 * unusual conditions (e.g. operator deleted node_modules between boot and a
 * tool call).
 */
export async function loadNotionModule(): Promise<NotionModules> {
  if (notionModulesCache !== null) return notionModulesCache;
  if (notionModulesError !== null) throw notionModulesError;
  try {
    // Non-literal specifier → TS treats result as `any`; runtime resolves
    // through Bun's normal module resolution.
    const moduleName = "@notionhq/client";
    const mod = (await import(moduleName)) as LooseAny;
    notionModulesCache = { Client: mod.Client };
    return notionModulesCache;
  } catch (err) {
    notionModulesError = err as Error;
    throw err;
  }
}

/** Cheap presence check used by `setup()` at boot. Doesn't throw. */
export async function notionModuleAvailable(): Promise<boolean> {
  try {
    await loadNotionModule();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Token resolution + boot probe
// ---------------------------------------------------------------------------

const NOTION_API_BASE = "https://api.notion.com/v1";
// Stable Notion API version — pinned so a server-side default change cannot
// silently alter response shapes our serializers depend on.
const NOTION_API_VERSION = "2022-06-28";

/** True iff `NOTION_API_KEY` is set to a non-empty string. */
export function isNotionConfigured(): boolean {
  const v = process.env.NOTION_API_KEY;
  return typeof v === "string" && v.length > 0;
}

export type ProbeResult =
  | { ok: true; user: { id: string; name: string } }
  | { ok: false; error: string };

/**
 * GET `/v1/users/me` with a hard timeout. Used at boot for fast feedback
 * on a bad token before tool registration. On failure, the integration's
 * `setup()` logs and registers zero tools (boot still succeeds).
 *
 * Uses `fetch` directly (not the SDK) so the SDK's own retry/backoff cannot
 * mask the fast-fail intent. Honors `globalThis.fetch` so tests can stub.
 */
export async function probeNotionToken(timeoutMs: number): Promise<ProbeResult> {
  const token = process.env.NOTION_API_KEY;
  if (typeof token !== "string" || token.length === 0) {
    return { ok: false, error: "NOTION_API_KEY is not set" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${NOTION_API_BASE}/users/me`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_API_VERSION,
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        ok: false,
        error: `HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
      };
    }
    const data = (await res.json()) as LooseAny;
    return {
      ok: true,
      user: {
        id: String(data?.id ?? ""),
        name: String(data?.name ?? data?.bot?.owner?.user?.name ?? "unknown"),
      },
    };
  } catch (err) {
    const e = err as { name?: string; message?: string };
    if (e.name === "AbortError") {
      return { ok: false, error: `probe timed out after ${timeoutMs}ms` };
    }
    return { ok: false, error: e.message ?? String(err) };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Notion client (cached singleton)
// ---------------------------------------------------------------------------

let clientCache: LooseAny | null = null;

/**
 * Get the cached Notion `Client` instance. Constructs it lazily on first
 * call using the current `NOTION_API_KEY`. Throws if the env var is unset
 * (handlers should never see this — `setup()` gates on `isNotionConfigured`).
 *
 * `notionVersion` is pinned to `NOTION_API_VERSION` (2022-06-28). The SDK's
 * default since v5 is `2025-09-03`, which introduced the multi-source-
 * database model and changed the search filter shape (`object: "database"`
 * → `object: "data_source"`). Without pinning, our `search({filter:{
 * property:"object", value:"database"}})` calls fail with `validation_error`
 * under the SDK's default version.
 */
export async function getNotionClient(): Promise<LooseAny> {
  if (clientCache !== null) return clientCache;
  const token = process.env.NOTION_API_KEY;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("NOTION_API_KEY is not set");
  }
  const { Client } = await loadNotionModule();
  clientCache = new Client({ auth: token, notionVersion: NOTION_API_VERSION });
  return clientCache;
}

// ---------------------------------------------------------------------------
// Database schema cache
// ---------------------------------------------------------------------------

/**
 * Subset of the Notion database schema used by the property DSL serializer.
 * The full response shape is much larger; we keep only what the formatter
 * needs (property name → type + select-option metadata).
 */
export interface DatabaseSchema {
  readonly id: string;
  readonly properties: Readonly<Record<string, DatabaseProperty>>;
}

export interface DatabaseProperty {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  /** Raw property descriptor — kept verbatim so the formatter can read
   *  type-specific fields (e.g. `select.options`) without re-fetching. */
  readonly raw: LooseAny;
}

const schemaCache = new Map<string, DatabaseSchema>();

function normalizeSchema(raw: LooseAny): DatabaseSchema {
  const props: Record<string, DatabaseProperty> = {};
  const rawProps = (raw?.properties ?? {}) as Record<string, LooseAny>;
  for (const [name, descriptor] of Object.entries(rawProps)) {
    props[name] = {
      id: String(descriptor?.id ?? ""),
      name,
      type: String(descriptor?.type ?? ""),
      raw: descriptor,
    };
  }
  return { id: String(raw?.id ?? ""), properties: props };
}

/**
 * Fetch a database's schema, caching by `dbId`. Subsequent calls are free.
 *
 * Cache invalidation policy: callers in write paths invalidate on 400/404
 * via `invalidateSchemaCache(dbId)` and retry once. There is no TTL — Notion
 * schemas don't churn, and Solrac restarts are cheap.
 */
export async function getDatabaseSchema(dbId: string): Promise<DatabaseSchema> {
  const cached = schemaCache.get(dbId);
  if (cached !== undefined) return cached;
  const client = await getNotionClient();
  const raw = await client.databases.retrieve({ database_id: dbId });
  const schema = normalizeSchema(raw);
  schemaCache.set(dbId, schema);
  return schema;
}

/** Drop the cached schema for `dbId`. Used by write paths after 400/404. */
export function invalidateSchemaCache(dbId: string): void {
  schemaCache.delete(dbId);
}

// ---------------------------------------------------------------------------
// Database query — raw HTTP (SDK v5 dropped `client.databases.query`)
// ---------------------------------------------------------------------------

/**
 * `@notionhq/client` v5 reorganized querying around the new multi-source-
 * database model: `databases.query` was removed in favor of
 * `dataSources.query`. Pinning `notionVersion: "2022-06-28"` only changes
 * the request/response *shape*, not the SDK's available method names.
 *
 * The legacy `POST /v1/databases/{id}/query` endpoint still works under
 * version `2022-06-28` and returns the legacy result shape our formatters
 * expect. We hit it directly to keep the integration compatible without
 * rewriting `dataSources` plumbing.
 *
 * Errors mirror the SDK's `APIResponseError` shape (status + code +
 * message) so `index.ts::errorResult` can map them uniformly.
 */
export async function queryDatabase(
  databaseId: string,
  body: Record<string, unknown>,
): Promise<LooseAny> {
  const token = process.env.NOTION_API_KEY;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("NOTION_API_KEY is not set");
  }
  const res = await fetch(`${NOTION_API_BASE}/databases/${databaseId}/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_API_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody: LooseAny = await res.json().catch(() => ({}));
    const err = new Error(
      String(errBody?.message ?? `HTTP ${res.status}`),
    ) as Error & { status?: number; code?: string };
    err.status = res.status;
    if (errBody?.code) err.code = String(errBody.code);
    throw err;
  }
  return await res.json();
}

/**
 * Clear all in-process caches (module, client, schemas). Tests use this to
 * isolate runs. Not used at runtime.
 */
export function clearNotionCaches(): void {
  notionModulesCache = null;
  notionModulesError = null;
  clientCache = null;
  schemaCache.clear();
}

// ---------------------------------------------------------------------------
// Block tree fetcher (used by notion_get_page)
// ---------------------------------------------------------------------------

export interface BlockTreeNode {
  block: LooseAny;
  children: BlockTreeNode[];
  /** True iff fetcher stopped at depth cap and the block had children. */
  truncated?: boolean;
}

/**
 * Walk a page's (or block's) descendant blocks up to `maxDepth` nested
 * levels, paginating `blocks.children.list` internally. Returned tree mirrors
 * Notion's structure but with truncation markers where recursion bottomed
 * out. The depth-3 cap (`formatters.ts::BLOCK_DEPTH_CAP`) means we fetch
 * top-level + 2 nested levels; depth-3 blocks are not fetched and their
 * parents are flagged `truncated: true`.
 *
 * `parentId` may be a page id or a block id — Notion's API treats both the
 * same way for `blocks.children.list`.
 */
export async function fetchBlockTree(
  parentId: string,
  maxDepth: number,
): Promise<BlockTreeNode[]> {
  const client = await getNotionClient();
  return walkBlocks(client, parentId, 0, maxDepth);
}

async function walkBlocks(
  client: LooseAny,
  parentId: string,
  depth: number,
  maxDepth: number,
): Promise<BlockTreeNode[]> {
  const blocks: LooseAny[] = [];
  let cursor: string | undefined = undefined;
  // Notion paginates at 100 by default — pull all of one level before
  // descending so the returned tree is complete at each depth.
  do {
    const res: LooseAny = await client.blocks.children.list({
      block_id: parentId,
      start_cursor: cursor,
      page_size: 100,
    });
    blocks.push(...(res.results ?? []));
    cursor = res.has_more ? (res.next_cursor as string | undefined) : undefined;
  } while (cursor);

  const nextDepth = depth + 1;
  if (nextDepth >= maxDepth) {
    return blocks.map((b) => ({
      block: b,
      children: [],
      ...(b.has_children ? { truncated: true } : {}),
    }));
  }

  const out: BlockTreeNode[] = [];
  for (const b of blocks) {
    const children = b.has_children
      ? await walkBlocks(client, b.id, nextDepth, maxDepth)
      : [];
    out.push({ block: b, children });
  }
  return out;
}
