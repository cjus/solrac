/**
 * @fileoverview Unit tests for `web.ts` pure-logic helpers.
 * @proves Cookie parsing handles real-world cookie strings (multiple keys,
 *         spaces, missing values), SSE event serialization sanitizes the
 *         html fallback, and the markdown_source is passed through verbatim
 *         (browser sanitizes after marked.parse).
 */

import { describe, expect, test } from "bun:test";
import { formatSseEvent, parseCookieValue, renderIndexHtml } from "./web.ts";

describe("parseCookieValue", () => {
  test("returns null on empty header", () => {
    expect(parseCookieValue("", "solrac_web")).toBeNull();
  });

  test("extracts a single cookie", () => {
    expect(parseCookieValue("solrac_web=abc123", "solrac_web")).toBe("abc123");
  });

  test("extracts a cookie among many, handling spaces", () => {
    const h = "_ga=123; solrac_web=xyz; other=4";
    expect(parseCookieValue(h, "solrac_web")).toBe("xyz");
  });

  test("returns null when name is absent", () => {
    expect(parseCookieValue("a=1; b=2", "solrac_web")).toBeNull();
  });

  test("does not partial-match similar names", () => {
    expect(parseCookieValue("solrac_web_other=x", "solrac_web")).toBeNull();
  });
});

describe("formatSseEvent", () => {
  test("message event sanitizes html and forwards markdown_source", () => {
    const out = formatSseEvent({
      kind: "message",
      chat_id: -1000,
      message_id: 1,
      html: '<b>hi</b><script>bad()</script>',
      markdown_source: "**hi**\n\n<script>bad()</script>",
      reply_markup: null,
    });
    expect(out.startsWith("data: ")).toBe(true);
    expect(out.endsWith("\n\n")).toBe(true);
    const payload = JSON.parse(out.slice("data: ".length).trim());
    expect(payload.kind).toBe("message");
    expect(payload.html).not.toContain("<script");
    expect(payload.html).toContain("<b>hi</b>");
    // markdown_source is verbatim — browser sanitizes after marked.parse
    expect(payload.markdown_source).toContain("<script>");
  });

  test("edit event also sanitizes html", () => {
    const out = formatSseEvent({
      kind: "edit",
      chat_id: -1000,
      message_id: 7,
      html: '<i>x</i><iframe src="x"></iframe>',
      markdown_source: null,
    });
    const payload = JSON.parse(out.slice("data: ".length).trim());
    expect(payload.html).not.toContain("<iframe");
    expect(payload.html).toContain("<i>x</i>");
  });

  test("reaction event passes through", () => {
    const out = formatSseEvent({
      kind: "reaction",
      chat_id: -1000,
      message_id: 1,
      emoji: "👍",
    });
    const payload = JSON.parse(out.slice("data: ".length).trim());
    expect(payload.kind).toBe("reaction");
    expect(payload.emoji).toBe("👍");
  });

  test("inline_keyboard reply_markup is preserved for tool-confirm", () => {
    const keyboard = {
      inline_keyboard: [
        [
          { text: "✅ Allow", callback_data: "cb:abc:a" },
          { text: "❌ Deny", callback_data: "cb:abc:d" },
        ],
      ],
    };
    const out = formatSseEvent({
      kind: "message",
      chat_id: -1000,
      message_id: 5,
      html: "🔐 confirm",
      markdown_source: null,
      reply_markup: keyboard,
    });
    const payload = JSON.parse(out.slice("data: ".length).trim());
    expect(payload.reply_markup).toEqual(keyboard);
  });
});

describe("renderIndexHtml", () => {
  const TEMPLATE = `<button title="default ({{DEFAULT_ENGINE_LABEL}})">●</button>`;

  test("substitutes the placeholder with the operator label", () => {
    expect(renderIndexHtml(TEMPLATE, "local (ollama)")).toBe(
      `<button title="default (local (ollama))">●</button>`,
    );
  });

  test("HTML-escapes the label so it can't break out of the title attr", () => {
    expect(renderIndexHtml(TEMPLATE, 'evil"><script>alert(1)</script>')).not.toContain(
      "<script>alert(1)</script>",
    );
  });

  test("replaces every occurrence (replaceAll, not replace)", () => {
    const t = `a:{{DEFAULT_ENGINE_LABEL}} b:{{DEFAULT_ENGINE_LABEL}}`;
    expect(renderIndexHtml(t, "x")).toBe("a:x b:x");
  });

  test("leaves text alone when the placeholder is absent", () => {
    expect(renderIndexHtml("<html>plain</html>", "local (ollama)")).toBe("<html>plain</html>");
  });
});
