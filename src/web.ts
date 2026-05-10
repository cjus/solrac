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

// PNX-168 — text imports of UI assets so the compiled binary serves the web
// UI without runtime fs reads of the source tree. In dev these resolve to the
// checked-in files at module-evaluation time; in the packaged binary they're
// baked-in string constants.
//
// `with { type: "text" }` is honored by Bun at runtime — every import below
// receives the file content as a string. TypeScript's resolver does NOT honor
// the attribute and falls back to bun-types' built-in `*.html` declaration
// (which types as `HTMLBundle`). We cast through `unknown` to land each
// binding as `string`. Single-site rather than mass-edited at every consumer.
//
// `web-sanitize.embed.js` is generated from `web-sanitize.ts` via the
// `embed:web-sanitize` script (run automatically by the prepare/pretest/
// prebuild:bin lifecycle hooks). Bun's text-import attribute does NOT work
// on `.ts` files — the loader treats them as TS modules first regardless of
// the attribute, so the source must live in a non-TS file.
import _EMBEDDED_INDEX_HTML from "../public/index.html" with { type: "text" };
import _EMBEDDED_APP_JS from "../public/app.js" with { type: "text" };
import _EMBEDDED_STYLE_CSS from "../public/style.css" with { type: "text" };
import _EMBEDDED_WEB_SANITIZE_JS from "./web-sanitize.embed.js" with { type: "text" };
// `marked` is the only browser-side dep that lives outside `public/` — text-
// import the UMD build so we don't need the node_modules tree at runtime.
import _EMBEDDED_MARKED_JS from "../node_modules/marked/lib/marked.umd.js" with { type: "text" };

const EMBEDDED_INDEX_HTML = _EMBEDDED_INDEX_HTML as unknown as string;
const EMBEDDED_APP_JS = _EMBEDDED_APP_JS as unknown as string;
const EMBEDDED_STYLE_CSS = _EMBEDDED_STYLE_CSS as unknown as string;
const EMBEDDED_WEB_SANITIZE_JS = _EMBEDDED_WEB_SANITIZE_JS as unknown as string;
const EMBEDDED_MARKED_JS = _EMBEDDED_MARKED_JS as unknown as string;

export interface WebServerDeps {
  host: string;
  port: number;
  token: string;
  webChatId: number;
  webClient: WebClient;
  /**
   * Server-resolved label for the default-engine pill in the UI ("ollama" |
   * "primary Claude (Sonnet)" | "secondary Claude (Opus)"). Substituted into
   * `index.html` at serve time so the user sees what no-prefix actually does
   * on this deploy without a `/config` round-trip.
   */
  defaultEngineLabel: string;
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

  function staticHandler(req: Request, fileName: string): Response {
    if (fileName === "sanitize.js") {
      return new Response(getSanitizeJs(), {
        headers: { "content-type": "application/javascript" },
      });
    }
    const asset = EMBEDDED_STATIC_ASSETS.get(fileName);
    if (!asset) return new Response("not found", { status: 404 });
    return new Response(asset.body, { headers: { "content-type": asset.mime } });
  }

  function rootHandler(req: Request): Response {
    const html = renderIndexHtml(EMBEDDED_INDEX_HTML, deps.defaultEngineLabel);
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
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
        if (req.method === "GET" && path === "/") return rootHandler(req);
        if (req.method === "GET" && path.startsWith("/static/")) {
          return staticHandler(req, path.slice("/static/".length));
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

// Embedded static assets served under /static/<filename>. Strict allowlist —
// no path traversal because we look up by exact filename. Bodies are baked
// into the binary at build time via the text imports at the top of this file.
const EMBEDDED_STATIC_ASSETS = new Map<string, { body: string; mime: string }>([
  ["app.js", { body: EMBEDDED_APP_JS, mime: "application/javascript" }],
  ["style.css", { body: EMBEDDED_STYLE_CSS, mime: "text/css" }],
  ["marked.min.js", { body: EMBEDDED_MARKED_JS, mime: "application/javascript" }],
]);

// `web-sanitize.ts` is the single source of truth for HTML allowlisting; it's
// tested under bun:test (server-side) and shipped to the browser as
// `web-sanitize.embed.js` (pre-transpiled by `scripts/embed-web-sanitize.ts`).
// No runtime transpilation step needed — the embed file is already
// browser-ready JS, just served as-is.
function getSanitizeJs(): string {
  return EMBEDDED_WEB_SANITIZE_JS;
}

/**
 * Substitute the `{{DEFAULT_ENGINE_LABEL}}` placeholder in `index.html` with
 * the operator-resolved label. HTML-escapes the label first so a future
 * config value (or operator-controlled string) can't break out of the title
 * attr context. Exported for `web.test.ts`.
 */
export function renderIndexHtml(raw: string, defaultEngineLabel: string): string {
  return raw.replaceAll("{{DEFAULT_ENGINE_LABEL}}", htmlEscapeAttr(defaultEngineLabel));
}

function htmlEscapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
