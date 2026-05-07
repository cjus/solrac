/**
 * @fileoverview Bun.serve HTTP surface: /health (public) and /stats (bearer).
 * @purpose Provide the two routes Solrac exposes: a public liveness probe and
 *          a bearer-gated counters endpoint. Bearer auth uses constant-time
 *          comparison via `node:crypto.timingSafeEqual`.
 *
 * Solrac uses `Bun.serve` `routes` directly — no HTTP framework. The HTTP
 * surface is exactly two routes; a framework would obscure ~40 lines of code
 * with ~40 lines of dependency surface. See docs/ARCHITECTURE.md#anti-goals.
 *
 * `/health` is public (no auth) and returns `{ ok: true, uptime }`. Use it
 * for systemd's `MAINPID` health checks or any external uptime monitor.
 *
 * `/stats` is bearer-gated. Three response codes with distinct meaning:
 *   - 503: `STATS_BEARER_TOKEN` is unset (stats explicitly disabled).
 *   - 401: bearer token is set but the request didn't match (wrong/missing).
 *   - 200: bearer matched; body is the snapshot JSON.
 * Operators monitoring stats should distinguish 503 (config) from 401 (auth).
 *
 * Position in the dependency graph:
 *   log → server → consumed by main
 *
 * Exports:
 *   - `startServer({port, startedAt, stats?})` — boots Bun.serve, returns
 *     the server handle.
 *   - `statsHandler(req, stats?)` — pure handler for /stats; testable in
 *     isolation (server.test.ts).
 *   - `authorizeBearer(headerValue, expected)` — pure constant-time bearer
 *     check; testable in isolation.
 *   - `ServerDeps`, `StatsDeps` — input shapes.
 *
 * Key invariants:
 *   - The bearer compare uses `timingSafeEqual` AND a length-mismatch
 *     short-circuit (different-length buffers throw in `timingSafeEqual`).
 *     Don't replace either with naive `===` — both prevent timing leaks.
 *   - The /stats `snapshot` callback is invoked PER REQUEST so values are
 *     fresh. If you cache, make the cache TTL explicit.
 *   - The Authorization header parse is `^Bearer ` exactly (case-sensitive
 *     scheme). Anything else (Basic, lowercase bearer, missing) → 401.
 *
 * Gotchas:
 *   - `stats` deps are optional in `ServerDeps` so the webhook-only future
 *     transport (Step 9, deferred) can omit them and `/stats` returns 503.
 *   - `startServer` returns Bun's server handle; `server.stop()` is what
 *     lifecycle calls during graceful shutdown.
 *   - The `fetch` fallback returns 404 for unrouted requests. There's no
 *     wildcard handler; if you add a route, also add it here.
 *
 * Cross-references:
 *   - docs/OPERATIONS.md#health-and-stats — bearer setup + curl examples
 *   - main.ts — wires the snapshot from queue + tracker + db
 */

import { timingSafeEqual } from "node:crypto";
import { log } from "./log.ts";

export interface StatsDeps {
  bearerToken: string | null;
  snapshot: () => Record<string, unknown>;
}

export interface ServerDeps {
  port: number;
  startedAt: number;
  stats?: StatsDeps;
}

export function startServer({ port, startedAt, stats }: ServerDeps) {
  const server = Bun.serve({
    port,
    routes: {
      "/health": () =>
        Response.json({
          ok: true,
          uptime: (Date.now() - startedAt) / 1000,
        }),
      "/stats": (req) => statsHandler(req, stats),
    },
    fetch() {
      return new Response("Not Found", { status: 404 });
    },
  });
  log.info("server.listening", { port: server.port, statsEnabled: !!stats?.bearerToken });
  return server;
}

export function statsHandler(req: Request, stats?: StatsDeps): Response {
  if (!stats || !stats.bearerToken) {
    return new Response("stats disabled", { status: 503 });
  }
  if (!authorizeBearer(req.headers.get("authorization"), stats.bearerToken)) {
    return new Response("unauthorized", { status: 401 });
  }
  return Response.json(stats.snapshot());
}

export function authorizeBearer(headerValue: string | null, expected: string): boolean {
  if (!headerValue) return false;
  const m = /^Bearer (.+)$/.exec(headerValue);
  if (!m) return false;
  return constantTimeEqual(m[1]!, expected);
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
