/**
 * @fileoverview Bun.serve HTTP+SSE surface for the web UI.
 * @purpose Second `Bun.serve` instance bound to `SOLRAC_WEB_HOST:SOLRAC_WEB_PORT`.
 *          Authenticates via bearer token → HttpOnly cookie, accepts user
 *          messages, streams the WebClient bus over SSE, brokers tool-confirm
 *          decisions back to `policy.ts::createConfirmationBroker`.
 *
 * The ops server (`server.ts`) keeps `/health` and `/stats` on the original
 * `PORT`; this server is purely the operator-facing UI. Same Solrac process,
 * separate ports — the operator can keep ops on localhost while exposing the
 * UI on a Tailnet IP, without changing the ops port.
 *
 * Position in the dependency graph:
 *   config + log + telegram (types) + web-client + web-sanitize + markdown →
 *   web → consumed by main + lifecycle
 *
 * Exports:
 *   - `startWebServer(deps)` — boots the server, returns `{stop, port}`.
 *   - `WebServerDeps` — deps shape; main.ts builds it.
 *
 * Key invariants:
 *   - Cookie session is HttpOnly + SameSite=Strict + Secure (when serving over
 *     HTTPS — left optional because LAN/Tailnet usage will often be HTTP).
 *   - Bearer compare uses `timingSafeEqual` (constant time), same pattern as
 *     `server.ts::authorizeBearer`.
 *   - The SSE response never closes from our side (until the request signal
 *     aborts); 25s keepalive lines (`: ping\n\n`) prevent intermediate proxies
 *     from idling out the connection.
 *   - On `stop()`, every active SSE writer is closed and the WebClient bus
 *     subscriber set is empty when the function returns.
 */

import { timingSafeEqual } from "node:crypto";
import { randomUUID } from "node:crypto";
import { log } from "./log.ts";
import { sanitizeHtml } from "./web-sanitize.ts";
import type { WebClient, WebBusEvent } from "./web-client.ts";

export interface WebServerDeps {
  host: string;
  port: number;
  token: string;
  webChatId: number;
  webClient: WebClient;
  /**
   * Called when a user message arrives. main.ts wires this to construct a
   * synthetic `Update` and call `enqueue` on the existing turn queue.
   */
  onMessage: (text: string) => "queued" | "queue_full";
  /**
   * Resolves a tool-confirmation prompt by id. Wired to
   * `policy.ts::ConfirmationBroker.resolve`.
   */
  onConfirm: (callbackId: string, decision: "allow" | "deny") => boolean;
  /**
   * Returns recent (prompt, response) pairs for the web chat. Used to
   * populate the page on reload. main.ts wires this to
   * `db.ts::recentChatTurns(webChatId, N)`. Markdown content; the browser
   * runs `marked` + sanitizer.
   */
  loadHistory: () => Array<{ prompt: string; response: string; model: string }>;
  /** Project root so static files resolve regardless of cwd. */
  rootDir: string;
}

export interface WebServerHandle {
  stop(): Promise<void>;
  port: number;
}

const COOKIE_NAME = "solrac_web";
const COOKIE_MAX_AGE_S = 86400; // 24h
// Keepalive cadence for SSE. Picked under the typical reverse-proxy/CDN idle
// thresholds so a stream stays open through nginx (60s default) and Cloudflare
// (100s) without an explicit tweak. Bun.serve's own per-request idle timeout
// is disabled (set to 0 below) since SSE is long-poll by design.
const KEEPALIVE_MS = 15_000;

export function startWebServer(deps: WebServerDeps): WebServerHandle {
  const sessions = new Set<string>();
  const sseWriters = new Set<{ close(): void }>();
  const tokenBuf = Buffer.from(deps.token);

  function authorize(req: Request): boolean {
    const cookieHeader = req.headers.get("cookie") ?? "";
    const id = parseCookieValue(cookieHeader, COOKIE_NAME);
    return id !== null && sessions.has(id);
  }

  function loginHandler(req: Request, body: { token?: unknown }): Response {
    const provided = typeof body.token === "string" ? body.token : "";
    if (!constantTimeEqualStr(provided, deps.token, tokenBuf)) {
      log.warn("web.login_denied", { ip: clientIp(req) });
      return Response.json({ ok: false, error: "invalid_token" }, { status: 401 });
    }
    const id = randomUUID();
    sessions.add(id);
    log.info("web.login_ok", { ip: clientIp(req), session_count: sessions.size });
    const headers = new Headers({ "content-type": "application/json" });
    headers.append(
      "set-cookie",
      `${COOKIE_NAME}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_S}`,
    );
    return new Response(JSON.stringify({ ok: true }), { headers });
  }

  function logoutHandler(req: Request): Response {
    const id = parseCookieValue(req.headers.get("cookie") ?? "", COOKIE_NAME);
    if (id) sessions.delete(id);
    const headers = new Headers({ "content-type": "application/json" });
    headers.append("set-cookie", `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    return new Response(JSON.stringify({ ok: true }), { headers });
  }

  async function messageHandler(req: Request): Promise<Response> {
    if (!authorize(req)) return Response.json({ ok: false }, { status: 401 });
    const body = (await req.json().catch(() => null)) as { text?: unknown } | null;
    const text = body && typeof body.text === "string" ? body.text : "";
    if (!text.trim()) return Response.json({ ok: false, error: "empty" }, { status: 400 });
    const result = deps.onMessage(text);
    if (result === "queue_full") {
      return Response.json({ ok: false, error: "queue_full" }, { status: 429 });
    }
    return Response.json({ ok: true });
  }

  async function confirmHandler(req: Request): Promise<Response> {
    if (!authorize(req)) return Response.json({ ok: false }, { status: 401 });
    const body = (await req.json().catch(() => null)) as
      | { callback_id?: unknown; decision?: unknown }
      | null;
    const callbackId = body && typeof body.callback_id === "string" ? body.callback_id : "";
    const decision = body && (body.decision === "allow" || body.decision === "deny")
      ? body.decision
      : null;
    if (!callbackId || !decision) {
      return Response.json({ ok: false, error: "bad_payload" }, { status: 400 });
    }
    const found = deps.onConfirm(callbackId, decision);
    return Response.json({ ok: true, found });
  }

  function historyHandler(req: Request): Response {
    if (!authorize(req)) return Response.json({ ok: false }, { status: 401 });
    return Response.json({ ok: true, turns: deps.loadHistory() });
  }

  function streamHandler(req: Request): Response {
    if (!authorize(req)) return new Response("unauthorized", { status: 401 });
    const encoder = new TextEncoder();
    let writer: ReadableStreamDefaultController<Uint8Array> | null = null;
    let unsubscribe: (() => void) | null = null;
    let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
    let closed = false;

    const handle = {
      close: () => {
        if (closed) return;
        closed = true;
        if (keepaliveTimer) clearInterval(keepaliveTimer);
        unsubscribe?.();
        try {
          writer?.close();
        } catch {
          // already closed
        }
        sseWriters.delete(handle);
      },
    };

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        writer = controller;
        sseWriters.add(handle);
        // Initial comment so the client connection is established before any
        // event arrives.
        controller.enqueue(encoder.encode(`: connected\n\n`));
        unsubscribe = deps.webClient.subscribe((event) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(formatSseEvent(event)));
          } catch {
            handle.close();
          }
        });
        keepaliveTimer = setInterval(() => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`: keepalive\n\n`));
          } catch {
            handle.close();
          }
        }, KEEPALIVE_MS);
        req.signal.addEventListener("abort", () => handle.close());
      },
      cancel() {
        handle.close();
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  }

  async function staticHandler(req: Request, fileName: string): Promise<Response> {
    if (fileName === "sanitize.js") {
      const js = await fetchSanitizeJs(deps.rootDir);
      return new Response(js, {
        headers: { "content-type": "application/javascript" },
      });
    }
    // Restrict to a small allowlist of file names — no path traversal.
    const allowed = ALLOWED_STATIC.get(fileName);
    if (!allowed) return new Response("not found", { status: 404 });
    const file = Bun.file(allowed.path(deps.rootDir));
    if (!(await file.exists())) {
      return new Response("not found", { status: 404 });
    }
    return new Response(file, { headers: { "content-type": allowed.mime } });
  }

  async function rootHandler(req: Request): Promise<Response> {
    const file = Bun.file(`${deps.rootDir}/public/index.html`);
    if (!(await file.exists())) return new Response("ui missing", { status: 500 });
    return new Response(file, { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  const server = Bun.serve({
    hostname: deps.host,
    port: deps.port,
    // SSE streams stay open indefinitely; Bun's default 10s per-request idle
    // timeout would kill them mid-conversation. Disable here and rely on the
    // KEEPALIVE_MS comments + browser EventSource auto-reconnect.
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      try {
        if (req.method === "GET" && path === "/") return await rootHandler(req);
        if (req.method === "GET" && path.startsWith("/static/")) {
          return await staticHandler(req, path.slice("/static/".length));
        }
        if (req.method === "POST" && path === "/api/login") {
          const body = (await req.json().catch(() => ({}))) as { token?: unknown };
          return loginHandler(req, body);
        }
        if (req.method === "POST" && path === "/api/logout") return logoutHandler(req);
        if (req.method === "POST" && path === "/api/message") return await messageHandler(req);
        if (req.method === "POST" && path === "/api/confirm") return await confirmHandler(req);
        if (req.method === "GET" && path === "/api/stream") return streamHandler(req);
        if (req.method === "GET" && path === "/api/history") return historyHandler(req);
        return new Response("not found", { status: 404 });
      } catch (err) {
        log.error("web.handler_failed", {
          path,
          method: req.method,
          error: (err as Error).message,
        });
        return new Response("server error", { status: 500 });
      }
    },
  });

  log.info("web.listening", {
    host: server.hostname,
    port: server.port,
    bound_zero: server.hostname === "0.0.0.0",
  });

  return {
    port: server.port ?? deps.port,
    async stop() {
      // Close every SSE writer so their request handlers terminate, then the
      // server itself.
      for (const w of [...sseWriters]) w.close();
      await server.stop();
      log.info("web.stopped", {});
    },
  };
}

// ---------------------------------------------------------------------------
// Internals exported for tests
// ---------------------------------------------------------------------------

const ALLOWED_STATIC = new Map<
  string,
  { path: (root: string) => string; mime: string }
>([
  ["app.js", { path: (r) => `${r}/public/app.js`, mime: "application/javascript" }],
  ["style.css", { path: (r) => `${r}/public/style.css`, mime: "text/css" }],
  [
    "marked.min.js",
    {
      path: (r) => `${r}/node_modules/marked/lib/marked.umd.js`,
      mime: "application/javascript",
    },
  ],
]);

// `web-sanitize.ts` is the single source of truth for HTML allowlisting; it's
// tested under bun:test (server-side) and shipped to the browser by
// transpiling it on the fly (Bun.Transpiler). Cached in module scope so we
// transpile once per process.
let cachedSanitizeJs: string | null = null;
async function fetchSanitizeJs(rootDir: string): Promise<string> {
  if (cachedSanitizeJs !== null) return cachedSanitizeJs;
  const text = await Bun.file(`${rootDir}/src/web-sanitize.ts`).text();
  const transpiler = new Bun.Transpiler({ loader: "ts", target: "browser" });
  cachedSanitizeJs = transpiler.transformSync(text);
  return cachedSanitizeJs;
}

export function formatSseEvent(event: WebBusEvent): string {
  // Sanitize HTML-fallback at the boundary so consumers of the markdown_source
  // path can ignore it and clients that fall back to html still get scrubbed
  // content. The markdown_source itself is passed through verbatim — the
  // browser sanitizes after marked.parse().
  const safe: WebBusEvent =
    event.kind === "reaction"
      ? event
      : { ...event, html: sanitizeHtml(event.html) };
  return `data: ${JSON.stringify(safe)}\n\n`;
}

export function parseCookieValue(header: string, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    if (trimmed.slice(0, eq) === name) return trimmed.slice(eq + 1);
  }
  return null;
}

function constantTimeEqualStr(a: string, b: string, bBuf: Buffer): boolean {
  const aBuf = Buffer.from(a);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function clientIp(req: Request): string {
  // Best-effort. Behind a reverse proxy `x-forwarded-for` carries the chain.
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return "unknown";
}
