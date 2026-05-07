/**
 * @fileoverview Unit tests for /stats bearer auth and the stats handler.
 * @proves `authorizeBearer` is constant-time and rejects malformed/wrong
 *         headers; `statsHandler` returns 503/401/200 with correct semantics
 *         and invokes the snapshot callback per request.
 *
 * Tests use synthetic `Request` objects (from the `Request` constructor) and
 * a mock `snapshot` callback. No real `Bun.serve` instance — we test the
 * pure handler in isolation.
 *
 * Scenarios covered:
 *
 *   authorizeBearer:
 *     - Missing header → false.
 *     - Malformed scheme (`Token x`, `bearer x` lowercase, bare token) → false.
 *     - Matching token → true.
 *     - Same length but different content → false.
 *     - Different lengths → false (no timing leak).
 *
 *   statsHandler:
 *     - 503 when bearer not configured (token=null).
 *     - 503 when stats deps absent.
 *     - 401 with no auth header.
 *     - 401 with wrong bearer.
 *     - 200 with snapshot JSON when bearer matches.
 *     - Snapshot is invoked PER REQUEST (not cached).
 *
 * Not covered (intentional):
 *   - Real Bun.serve integration (covered manually).
 *   - Timing-attack measurement (we trust `node:crypto.timingSafeEqual`).
 *
 * Cross-references:
 *   - server.ts — implementation
 *   - docs/OPERATIONS.md#health-and-stats — operator-facing semantics
 */

import { describe, expect, test } from "bun:test";
import { authorizeBearer, statsHandler } from "./server.ts";

function reqWithAuth(value: string | null): Request {
  const headers = new Headers();
  if (value !== null) headers.set("authorization", value);
  return new Request("http://x/stats", { headers });
}

describe("authorizeBearer", () => {
  test("missing header → false", () => {
    expect(authorizeBearer(null, "secret")).toBe(false);
  });

  test("malformed scheme → false", () => {
    expect(authorizeBearer("Token secret", "secret")).toBe(false);
    expect(authorizeBearer("bearer secret", "secret")).toBe(false); // case-sensitive scheme
    expect(authorizeBearer("secret", "secret")).toBe(false);
  });

  test("matching token → true", () => {
    expect(authorizeBearer("Bearer secret", "secret")).toBe(true);
  });

  test("non-matching same-length → false", () => {
    expect(authorizeBearer("Bearer secret", "SECRET")).toBe(false);
  });

  test("different lengths → false (no timing leak)", () => {
    expect(authorizeBearer("Bearer abc", "abcdef")).toBe(false);
    expect(authorizeBearer("Bearer abcdef", "abc")).toBe(false);
  });
});

describe("statsHandler", () => {
  const snapshot = () => ({ rss: 12345, uptime: 60 });

  test("503 when bearer token not configured", async () => {
    const res = statsHandler(reqWithAuth("Bearer anything"), {
      bearerToken: null,
      snapshot,
    });
    expect(res.status).toBe(503);
  });

  test("503 when stats deps absent", async () => {
    const res = statsHandler(reqWithAuth("Bearer anything"), undefined);
    expect(res.status).toBe(503);
  });

  test("401 when no auth header", async () => {
    const res = statsHandler(reqWithAuth(null), { bearerToken: "secret", snapshot });
    expect(res.status).toBe(401);
  });

  test("401 when wrong bearer", async () => {
    const res = statsHandler(reqWithAuth("Bearer wrong"), { bearerToken: "secret", snapshot });
    expect(res.status).toBe(401);
  });

  test("200 + snapshot JSON when bearer matches", async () => {
    const res = statsHandler(reqWithAuth("Bearer secret"), { bearerToken: "secret", snapshot });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rss: number; uptime: number };
    expect(body.rss).toBe(12345);
    expect(body.uptime).toBe(60);
  });

  test("snapshot is invoked per request", async () => {
    let calls = 0;
    const dynSnapshot = () => {
      calls += 1;
      return { calls };
    };
    await statsHandler(reqWithAuth("Bearer t"), { bearerToken: "t", snapshot: dynSnapshot }).json();
    await statsHandler(reqWithAuth("Bearer t"), { bearerToken: "t", snapshot: dynSnapshot }).json();
    expect(calls).toBe(2);
  });
});
