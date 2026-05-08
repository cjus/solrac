/**
 * @fileoverview Markdown → Telegram-safe HTML converter.
 * @purpose Render Claude/Ollama responses (which are markdown) into the small
 *          HTML subset that Telegram's `parse_mode: "HTML"` actually accepts.
 *
 * Telegram HTML mode supports only:
 *   <b> <i> <u> <s> <a href="..."> <code> <pre>
 *   <pre><code class="language-X"> <blockquote> <span class="tg-spoiler">
 * No headers, no lists, no tables, no <hr>. Anything Claude emits outside
 * that subset has to be flattened into a Telegram-safe approximation.
 *
 * Mappings:
 *   #..###### heading       → <b>…</b> + double newline
 *   **bold** / __bold__     → <b>
 *   *em* / _em_             → <i>
 *   ~~strike~~              → <s>
 *   `inline`                → <code>
 *   ```lang\ncode```        → <pre><code class="language-lang">…</code></pre>
 *   [text](href)            → <a href="…">text</a> (href attr-escaped)
 *   > blockquote            → <blockquote>
 *   - / * / 1. lists        → "• item" / "1. item" lines (no <ul>/<ol>)
 *   | tbl |                 → ASCII inside <pre>
 *   ---                     → \n──────\n
 *   plain text              → htmlEscapeText
 *
 * Wrapped in `mdToTelegramHtml(md)` which try/catches `marked.parse` and
 * falls back to `htmlEscapeText(md)` on any failure — a parser glitch must
 * not break the existing Telegram path.
 *
 * The same `marked` library is reused in the browser (Phase 5), so prompt
 * outputs render consistently across transports.
 *
 * Position in the dependency graph:
 *   telegram (htmlEscape only) → markdown → consumed by agent + ollama
 *
 * Exports:
 *   - `mdToTelegramHtml(md)` — pure function, no I/O.
 */

import { Marked } from "marked";
import type { RendererObject, Token, Tokens } from "marked";
import { htmlEscapeAttr, htmlEscapeText } from "./telegram.ts";

function safeHref(href: string): string | null {
  const trimmed = href.trim();
  if (!trimmed) return null;
  // Allow http(s), mailto, tg (telegram deep links). Reject javascript: and
  // anything else to keep render targets honest in both transports.
  if (/^(https?:|mailto:|tg:)/i.test(trimmed)) return trimmed;
  return null;
}

function stripTags(html: string): string {
  // ASCII tables embed in <pre>, so any inline-rendered HTML inside cells
  // would render literally. Strip the wrapper tags and decode the basic
  // entities our escaper produced. Cells rarely carry markup; this is a
  // best-effort path, not a full HTML parser.
  return html
    .replace(/<\/?(b|i|s|u|code|a)(\s[^>]*)?>/gi, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

const telegramRenderer: RendererObject = {
  heading({ tokens }: Tokens.Heading): string {
    return `<b>${this.parser.parseInline(tokens)}</b>\n\n`;
  },
  paragraph({ tokens }: Tokens.Paragraph): string {
    return `${this.parser.parseInline(tokens)}\n\n`;
  },
  blockquote({ tokens }: Tokens.Blockquote): string {
    const inner = this.parser.parse(tokens as Token[]).trim();
    return `<blockquote>${inner}</blockquote>\n\n`;
  },
  code({ text, lang }: Tokens.Code): string {
    const cleanLang = (lang ?? "").trim().replace(/[^\w.+-]/g, "");
    const escaped = htmlEscapeText(text);
    if (cleanLang) {
      return `<pre><code class="language-${htmlEscapeAttr(cleanLang)}">${escaped}</code></pre>\n\n`;
    }
    return `<pre>${escaped}</pre>\n\n`;
  },
  hr(): string {
    return "──────\n\n";
  },
  list(token: Tokens.List): string {
    const ordered = token.ordered;
    const start = typeof token.start === "number" ? token.start : 1;
    const lines: string[] = [];
    token.items.forEach((item, idx) => {
      const marker = ordered ? `${start + idx}.` : "•";
      const body = this.parser.parse(item.tokens as Token[]).trim();
      // Compact internal paragraph breaks so list items stay tightly packed
      // in Telegram's renderer.
      const compact = body.replace(/\n{2,}/g, "\n");
      lines.push(`${marker} ${compact}`);
    });
    return `${lines.join("\n")}\n\n`;
  },
  listitem(): string {
    // Unused — `list` handles items inline so Telegram can't break the visual
    // layout with stray <li> tokens.
    return "";
  },
  table(token: Tokens.Table): string {
    const headerCells = token.header.map((c) => stripTags(this.parser.parseInline(c.tokens)));
    const rows = token.rows.map((row) =>
      row.map((c) => stripTags(this.parser.parseInline(c.tokens))),
    );
    const widths = headerCells.map((h, i) =>
      Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
    );
    const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));
    const fmt = (cells: string[]) =>
      cells.map((c, i) => pad(c, widths[i] ?? c.length)).join(" │ ");
    const sep = widths.map((w) => "─".repeat(w)).join("─┼─");
    const lines = [fmt(headerCells), sep, ...rows.map(fmt)];
    return `<pre>${htmlEscapeText(lines.join("\n"))}</pre>\n\n`;
  },
  strong({ tokens }: Tokens.Strong): string {
    return `<b>${this.parser.parseInline(tokens)}</b>`;
  },
  em({ tokens }: Tokens.Em): string {
    return `<i>${this.parser.parseInline(tokens)}</i>`;
  },
  del({ tokens }: Tokens.Del): string {
    return `<s>${this.parser.parseInline(tokens)}</s>`;
  },
  codespan({ text }: Tokens.Codespan): string {
    return `<code>${htmlEscapeText(text)}</code>`;
  },
  br(): string {
    return "\n";
  },
  link({ href, tokens }: Tokens.Link): string {
    const safe = safeHref(href);
    const inner = this.parser.parseInline(tokens);
    if (!safe) return inner;
    return `<a href="${htmlEscapeAttr(safe)}">${inner}</a>`;
  },
  image({ text, href }: Tokens.Image): string {
    // Telegram HTML mode doesn't support inline images. Render as a link
    // to the image URL with the alt text, or fall back to alt text alone.
    const safe = safeHref(href);
    const alt = htmlEscapeText(text || "image");
    if (safe) return `<a href="${htmlEscapeAttr(safe)}">${alt}</a>`;
    return alt;
  },
  text(token): string {
    const t = token as Tokens.Text & { tokens?: Token[] };
    if (t.tokens && t.tokens.length > 0) {
      return this.parser.parseInline(t.tokens);
    }
    return htmlEscapeText(t.text ?? "");
  },
  html({ text }: Tokens.HTML | Tokens.Tag): string {
    // Don't trust raw HTML from upstream — escape and emit as text.
    return htmlEscapeText(text);
  },
};

const sharedMarked = new Marked({ renderer: telegramRenderer });

export function mdToTelegramHtml(md: string): string {
  if (!md) return "";
  try {
    const out = sharedMarked.parse(md, { async: false }) as string;
    // Trim trailing newlines so callers can append footers without extra
    // blank lines.
    return out.replace(/\n+$/, "");
  } catch {
    return htmlEscapeText(md);
  }
}
