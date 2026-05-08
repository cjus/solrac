/**
 * @fileoverview Unit tests for `mdToTelegramHtml`.
 * @proves Each markdown construct lands in the Telegram-supported subset
 *         (`<b>`, `<i>`, `<s>`, `<code>`, `<pre>`, `<a>`, `<blockquote>`),
 *         lists/headers/tables flatten without producing `<ul>`, `<ol>`,
 *         `<h1>`, `<table>` etc., and unsafe link schemes are dropped.
 *
 * Why this exists: agent.ts and ollama.ts now feed responses through
 * `mdToTelegramHtml`. Telegram's HTML parse_mode rejects unsupported tags
 * with a 400 — so a regression here breaks every Telegram message. Goldens
 * are tight on the exact tag shapes that Telegram accepts.
 *
 * Cross-references:
 *   - markdown.ts — implementation
 */

import { describe, expect, test } from "bun:test";
import { mdToTelegramHtml } from "./markdown.ts";

describe("mdToTelegramHtml — inline", () => {
  test("plain text is escaped", () => {
    expect(mdToTelegramHtml("hello < world > & friends")).toBe(
      "hello &lt; world &gt; &amp; friends",
    );
  });

  test("bold renders as <b>", () => {
    expect(mdToTelegramHtml("**hi**")).toBe("<b>hi</b>");
  });

  test("italic renders as <i>", () => {
    expect(mdToTelegramHtml("*hi*")).toBe("<i>hi</i>");
  });

  test("strikethrough renders as <s>", () => {
    expect(mdToTelegramHtml("~~gone~~")).toBe("<s>gone</s>");
  });

  test("inline code renders as <code> with escapes", () => {
    expect(mdToTelegramHtml("`a < b`")).toBe("<code>a &lt; b</code>");
  });

  test("safe http link renders as <a>", () => {
    const out = mdToTelegramHtml("[home](https://example.com)");
    expect(out).toBe(`<a href="https://example.com">home</a>`);
  });

  test("javascript: link is stripped (anchor text only)", () => {
    const out = mdToTelegramHtml("[click](javascript:alert(1))");
    expect(out).toBe("click");
  });
});

describe("mdToTelegramHtml — block", () => {
  test("h1 collapses to <b> + double newline", () => {
    expect(mdToTelegramHtml("# Title")).toBe("<b>Title</b>");
  });

  test("h6 also collapses to <b>", () => {
    expect(mdToTelegramHtml("###### tiny")).toBe("<b>tiny</b>");
  });

  test("paragraph renders as escaped text", () => {
    expect(mdToTelegramHtml("hello world")).toBe("hello world");
  });

  test("two paragraphs separated by blank line", () => {
    expect(mdToTelegramHtml("para one\n\npara two")).toBe("para one\n\npara two");
  });

  test("hr renders as ascii separator", () => {
    expect(mdToTelegramHtml("---")).toBe("──────");
  });

  test("blockquote wraps content", () => {
    expect(mdToTelegramHtml("> quoted")).toBe("<blockquote>quoted</blockquote>");
  });

  test("fenced code with language", () => {
    const out = mdToTelegramHtml("```python\nprint(1)\n```");
    expect(out).toBe(`<pre><code class="language-python">print(1)</code></pre>`);
  });

  test("fenced code without language", () => {
    const out = mdToTelegramHtml("```\nplain\n```");
    expect(out).toBe("<pre>plain</pre>");
  });

  test("code-fence content is escaped", () => {
    const out = mdToTelegramHtml("```\n<script>x</script>\n```");
    expect(out).toContain("&lt;script&gt;");
    expect(out).not.toContain("<script>");
  });
});

describe("mdToTelegramHtml — lists & tables", () => {
  test("unordered list flattens to • markers", () => {
    expect(mdToTelegramHtml("- one\n- two")).toBe("• one\n• two");
  });

  test("ordered list flattens to 1. markers", () => {
    expect(mdToTelegramHtml("1. first\n2. second")).toBe("1. first\n2. second");
  });

  test("ordered list respects custom start", () => {
    expect(mdToTelegramHtml("3. three\n4. four")).toBe("3. three\n4. four");
  });

  test("table renders as ASCII inside <pre>", () => {
    const md = `| h1 | h2 |\n| --- | --- |\n| a | b |\n| cc | dd |`;
    const out = mdToTelegramHtml(md);
    expect(out.startsWith("<pre>")).toBe(true);
    expect(out.endsWith("</pre>")).toBe(true);
    expect(out).toContain("h1");
    expect(out).toContain("h2");
    expect(out).toContain("│");
  });

  test("output never contains tags Telegram rejects", () => {
    const md = "# H\n\n- list\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n---\n\n";
    const out = mdToTelegramHtml(md);
    for (const tag of ["<h1", "<h2", "<ul", "<ol", "<li", "<table", "<thead", "<tbody", "<tr", "<td", "<th", "<hr", "<p>"]) {
      expect(out).not.toContain(tag);
    }
  });
});

describe("mdToTelegramHtml — robustness", () => {
  test("empty string returns empty", () => {
    expect(mdToTelegramHtml("")).toBe("");
  });

  test("html tags in the source are escaped, not pass-through", () => {
    const out = mdToTelegramHtml("<script>bad</script>");
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });

  test("mixed inline composition", () => {
    const out = mdToTelegramHtml("a **b** *c* `d` ~~e~~");
    expect(out).toBe("a <b>b</b> <i>c</i> <code>d</code> <s>e</s>");
  });
});
