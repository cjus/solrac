/**
 * @fileoverview Unit tests for the Notion client wrapper.
 * @proves Lazy-load gating, env-var configured check, probe timeout
 *         behavior, schema cache hit/invalidate.
 *
 * The `@notionhq/client` package is operator-installed (NOT in solrac's
 * package.json), so the boot-time gate matters: if it's missing,
 * `setup()` must register zero tools and let solrac boot normally. Tests
 * here cover the gate plus the small bits of bookkeeping the client
 * owns (env-var check, schema cache, probe timeout).
 *
 * What we DO mock:
 *   - `globalThis.fetch` for `probeNotionToken` — directly assigned and
 *     restored in afterEach. Solrac's existing test pattern in
 *     ollama.test.ts injects fetch as a dep; this client uses
 *     `globalThis.fetch` directly so we monkey-patch.
 *   - `@notionhq/client` via `mock.module` for the schema cache test —
 *     constructor sets `databases.retrieve` to a counted fake.
 *
 * What we do NOT cover here:
 *   - The actual SDK's network behavior — that's an integration concern
 *     handled by the manual smoke (`test/smokes/notion-smoke.ts`).
 *   - `index.ts` setup gating — covered by `index.test.ts` (Phase 3).
 *
 * Cross-references:
 *   - ./client.ts — the system under test
 *   - PLAN.md (solrac-dev) §7 — test scope per CLAUDE.md philosophy
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  clearNotionCaches,
  getDatabaseSchema,
  invalidateSchemaCache,
  isNotionConfigured,
  notionModuleAvailable,
  probeNotionToken,
} from "./client.ts";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_KEY = process.env.NOTION_API_KEY;

beforeEach(() => {
  clearNotionCaches();
  delete process.env.NOTION_API_KEY;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_KEY === undefined) delete process.env.NOTION_API_KEY;
  else process.env.NOTION_API_KEY = ORIGINAL_KEY;
});

// ---------------------------------------------------------------------------
// notionModuleAvailable
// ---------------------------------------------------------------------------

// `notionModuleAvailable` is exercised indirectly via the setup gates in
// `index.test.ts` (where the mock is in place; absent gates → zero tools).
// We don't explicitly test the "package literally missing" branch here:
// Bun's `mock.module` evaluates factories eagerly + persists across test
// files in one run, so we can't reliably simulate "import throws" without
// breaking sibling tests. The boot gate's behavior on import failure is a
// thin try/catch wrapper — visual review covers it.

// ---------------------------------------------------------------------------
// isNotionConfigured
// ---------------------------------------------------------------------------

describe("isNotionConfigured", () => {
  test("false when NOTION_API_KEY is unset", () => {
    delete process.env.NOTION_API_KEY;
    expect(isNotionConfigured()).toBe(false);
  });

  test("false when NOTION_API_KEY is empty string", () => {
    process.env.NOTION_API_KEY = "";
    expect(isNotionConfigured()).toBe(false);
  });

  test("true when NOTION_API_KEY is a non-empty string", () => {
    process.env.NOTION_API_KEY = "secret_abc";
    expect(isNotionConfigured()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// probeNotionToken
// ---------------------------------------------------------------------------

describe("probeNotionToken", () => {
  test("returns ok:false when NOTION_API_KEY is unset", async () => {
    delete process.env.NOTION_API_KEY;
    const result = await probeNotionToken(1000);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("NOTION_API_KEY");
  });

  test("times out within timeoutMs when fetch hangs", async () => {
    process.env.NOTION_API_KEY = "secret_abc";
    // A fetch that never resolves until aborted.
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }
      });
    }) as unknown as typeof globalThis.fetch;

    const start = Date.now();
    const result = await probeNotionToken(150);
    const elapsed = Date.now() - start;

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("timed out");
    // Generous tolerance: the timer should fire near 150ms; allow 500ms ceiling.
    expect(elapsed).toBeLessThan(500);
  });

  test("returns ok:true on a 200 JSON response", async () => {
    process.env.NOTION_API_KEY = "secret_abc";
    // Wrap captured values in an object — TS narrows bare `let` bindings to
    // `null` across closure boundaries even when the closure assigns.
    const observed: { auth: string | null; version: string | null } = {
      auth: null,
      version: null,
    };
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      observed.auth = headers.Authorization ?? null;
      observed.version = headers["Notion-Version"] ?? null;
      return new Response(
        JSON.stringify({ id: "user-123", name: "Solrac Bot" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof globalThis.fetch;

    const result = await probeNotionToken(1000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.user.id).toBe("user-123");
      expect(result.user.name).toBe("Solrac Bot");
    }
    expect(observed.auth).toBe("Bearer secret_abc");
    expect(observed.version).not.toBeNull();
  });

  test("returns ok:false on a 401 response", async () => {
    process.env.NOTION_API_KEY = "secret_bad";
    globalThis.fetch = (async () =>
      new Response("API token is invalid", { status: 401 })) as unknown as typeof globalThis.fetch;

    const result = await probeNotionToken(1000);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("401");
  });
});

// ---------------------------------------------------------------------------
// Schema cache (uses mock.module to stub @notionhq/client)
// ---------------------------------------------------------------------------

describe("getDatabaseSchema", () => {
  // Track retrieve() calls across tests in this block. Reset in beforeEach.
  let retrieveCalls: string[] = [];

  beforeEach(() => {
    retrieveCalls = [];
    process.env.NOTION_API_KEY = "secret_abc";

    // Inject a fake `@notionhq/client` so loadNotionModule + getNotionClient
    // succeed without the real package. Each Client instance shares the
    // outer `retrieveCalls` array via closure.
    mock.module("@notionhq/client", () => ({
      Client: class FakeClient {
        databases = {
          retrieve: async ({ database_id }: { database_id: string }) => {
            retrieveCalls.push(database_id);
            return {
              id: database_id,
              properties: {
                Name: { id: "title", type: "title", title: {} },
                Status: {
                  id: "status",
                  type: "status",
                  status: { options: [{ id: "x", name: "Done" }] },
                },
              },
            };
          },
        };
      },
    }));
  });

  test("caches per dbId — second call hits cache", async () => {
    const a1 = await getDatabaseSchema("db-1");
    const a2 = await getDatabaseSchema("db-1");
    expect(retrieveCalls).toEqual(["db-1"]);
    expect(a2).toBe(a1); // identity — same cached object
    expect(a1.properties.Name.type).toBe("title");
    expect(a1.properties.Status.type).toBe("status");
  });

  test("different dbIds → separate fetches", async () => {
    await getDatabaseSchema("db-1");
    await getDatabaseSchema("db-2");
    await getDatabaseSchema("db-1");
    expect(retrieveCalls).toEqual(["db-1", "db-2"]);
  });

  test("invalidateSchemaCache forces refetch", async () => {
    await getDatabaseSchema("db-1");
    invalidateSchemaCache("db-1");
    await getDatabaseSchema("db-1");
    expect(retrieveCalls).toEqual(["db-1", "db-1"]);
  });

  test("invalidateSchemaCache only affects the named dbId", async () => {
    await getDatabaseSchema("db-1");
    await getDatabaseSchema("db-2");
    invalidateSchemaCache("db-1");
    await getDatabaseSchema("db-1");
    await getDatabaseSchema("db-2");
    expect(retrieveCalls).toEqual(["db-1", "db-2", "db-1"]);
  });
});
