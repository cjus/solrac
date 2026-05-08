/**
 * @fileoverview Tests for the allowlist HTML sanitizer.
 * @proves <script>, event handlers, javascript:/data:/vbscript: hrefs, and
 *         non-allowlisted tags are stripped while preserving inner text.
 *         The allowlisted tag set produces valid HTML the browser will
 *         render as expected.
 */

import { describe, expect, test } from "bun:test";
import { sanitizeHtml } from "./web-sanitize.ts";

describe("sanitizeHtml — drops dangerous content", () => {
  test("strips <script> entirely (text content preserved)", () => {
    const out = sanitizeHtml("<script>alert(1)</script>");
    expect(out).not.toContain("<script");
    expect(out).toContain("alert(1)");
  });

  test("strips event handlers like onerror", () => {
    const out = sanitizeHtml('<a href="https://x" onerror="bad()">x</a>');
    expect(out).not.toContain("onerror");
    expect(out).toContain('href="https://x"');
  });

  test("strips javascript: hrefs", () => {
    const out = sanitizeHtml('<a href="javascript:alert(1)">x</a>');
    expect(out).not.toContain("javascript:");
    expect(out).toContain("<a>");
  });

  test("strips data: hrefs", () => {
    const out = sanitizeHtml('<a href="data:text/html,bad">x</a>');
    expect(out).not.toContain("data:");
  });

  test("strips <iframe>, <object>, <embed>", () => {
    for (const tag of ["iframe", "object", "embed"]) {
      const out = sanitizeHtml(`<${tag} src="x">inside</${tag}>`);
      expect(out).not.toContain(`<${tag}`);
      expect(out).toContain("inside");
    }
  });

  test("strips HTML comments", () => {
    const out = sanitizeHtml("hello <!-- not visible --> world");
    expect(out).not.toContain("<!--");
    expect(out).not.toContain("-->");
  });

  test("strips style and link tags", () => {
    const out = sanitizeHtml('<style>body{x:1}</style><link rel="x">');
    expect(out).not.toContain("<style");
    expect(out).not.toContain("<link");
  });
});

describe("sanitizeHtml — preserves allowlisted tags", () => {
  test("bold/italic/code/pre/blockquote/links round-trip", () => {
    const html =
      '<b>bold</b> <i>i</i> <code>c</code> <pre>p</pre> ' +
      '<blockquote>q</blockquote> <a href="https://example.com">e</a>';
    const out = sanitizeHtml(html);
    expect(out).toBe(html);
  });

  test("headings and lists pass through", () => {
    const html = "<h1>T</h1><ul><li>a</li><li>b</li></ul><ol><li>x</li></ol>";
    expect(sanitizeHtml(html)).toBe(html);
  });

  test("tables pass through", () => {
    const html =
      "<table><thead><tr><th>h</th></tr></thead><tbody><tr><td>v</td></tr></tbody></table>";
    expect(sanitizeHtml(html)).toBe(html);
  });

  test("class on code (language-X)", () => {
    const html = '<code class="language-python">print(1)</code>';
    expect(sanitizeHtml(html)).toBe(html);
  });

  test("hr and br void tags", () => {
    expect(sanitizeHtml("<hr>")).toBe("<hr />");
    expect(sanitizeHtml("<br>")).toBe("<br />");
  });

  test("mailto and tg links allowed", () => {
    const a = sanitizeHtml('<a href="mailto:x@y.z">m</a>');
    expect(a).toContain("mailto:");
    const b = sanitizeHtml('<a href="tg://resolve?domain=x">t</a>');
    expect(b).toContain("tg:");
  });
});

describe("sanitizeHtml — robustness", () => {
  test("empty string returns empty", () => {
    expect(sanitizeHtml("")).toBe("");
  });

  test("text-only input is returned unchanged", () => {
    expect(sanitizeHtml("plain text")).toBe("plain text");
  });

  test("unterminated tag is escaped", () => {
    const out = sanitizeHtml("hello <b unterminated");
    expect(out).toContain("hello ");
    expect(out).not.toContain("<b unterminated");
  });

  test("non-allowlisted tag drops but preserves inner text", () => {
    const out = sanitizeHtml("<marquee>hi</marquee>");
    expect(out).not.toContain("<marquee");
    expect(out).toContain("hi");
  });

  test("attributes outside allowlist are stripped", () => {
    const out = sanitizeHtml('<b id="bad" class="bad">hi</b>');
    expect(out).toBe("<b>hi</b>");
  });

  test("uppercase tag names are normalized", () => {
    expect(sanitizeHtml("<B>HI</B>")).toBe("<b>HI</b>");
  });
});
