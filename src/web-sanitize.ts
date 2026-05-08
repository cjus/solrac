/**
 * @fileoverview Allowlist HTML sanitizer for the web UI.
 * @purpose Strip any tag/attribute that isn't on the allowlist before the
 *          browser injects markdown-rendered HTML into the DOM. Defense in
 *          depth: the markdown source comes from Claude (semi-trusted) and
 *          gets parsed by `marked` (battle-tested) — but a permissive
 *          sanitizer between them and `innerHTML` is the rule, not the
 *          exception.
 *
 * Approach: single-pass tokenizer that recognizes `<tag …>`, `</tag>`, and
 * text. Tags not on the allowlist are dropped; their contents are kept as
 * text. Attributes not on the per-tag allowlist are dropped. `href` is
 * scheme-validated.
 *
 * This file is also bundled and served to the browser by `web.ts`; the
 * single source of truth keeps server tests and client behavior in sync.
 *
 * Position in the dependency graph:
 *   (no internal deps) → web-sanitize → consumed by browser app + bun:test
 *
 * Key invariants:
 *   - The output never contains `<script>`, `<iframe>`, `<object>`, event
 *     handlers (`onerror`, `onload`, etc.), `javascript:` / `data:` / `vbscript:`
 *     hrefs, `srcdoc`, or any tag outside `ALLOWED_TAGS`.
 *   - Text content is preserved verbatim — marked already escaped `<`, `>`,
 *     `&` in inline text. Stripped tags' inner text is preserved (so a
 *     `<script>alert(1)</script>` becomes the literal string `alert(1)`).
 *
 * Not a goal:
 *   - Full HTML5 parsing semantics (e.g. implicit tag closure, foreign
 *     content). The input is `marked`'s deterministic output, not arbitrary
 *     web HTML.
 */

const ALLOWED_TAGS: ReadonlySet<string> = new Set([
  "b", "i", "em", "strong", "code", "pre", "a", "br",
  "ul", "ol", "li", "blockquote", "p", "s", "u", "span",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "table", "thead", "tbody", "tr", "td", "th",
  "hr", "del", "ins",
]);

// Per-tag attribute allowlist. Tags not listed get no attributes.
const ALLOWED_ATTRS: Readonly<Record<string, ReadonlySet<string>>> = {
  a: new Set(["href", "title"]),
  code: new Set(["class"]),
  pre: new Set(["class"]),
  span: new Set(["class"]),
  td: new Set(["align"]),
  th: new Set(["align"]),
};

const VOID_TAGS: ReadonlySet<string> = new Set(["br", "hr"]);

const SAFE_HREF_RE = /^(?:https?:|mailto:|tg:|#)/i;

const TAG_NAME_RE = /^([a-zA-Z][a-zA-Z0-9]*)/;
const ATTR_RE = /([a-zA-Z_:][a-zA-Z0-9_.:-]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

interface ParsedTag {
  name: string;
  attrs: Array<{ name: string; value: string }>;
  selfClosing: boolean;
}

function parseTag(body: string): ParsedTag | null {
  const m = TAG_NAME_RE.exec(body);
  if (!m) return null;
  const name = m[1]!.toLowerCase();
  const rest = body.slice(m[1]!.length);
  const selfClosing = /\/\s*$/.test(rest) || VOID_TAGS.has(name);
  const attrs: Array<{ name: string; value: string }> = [];
  ATTR_RE.lastIndex = 0;
  let am: RegExpExecArray | null;
  while ((am = ATTR_RE.exec(rest)) !== null) {
    const aname = am[1]!.toLowerCase();
    if (aname === "/") continue;
    const aval = am[2] ?? am[3] ?? am[4] ?? "";
    attrs.push({ name: aname, value: aval });
  }
  return { name, attrs, selfClosing };
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function emitOpen(t: ParsedTag): string {
  const allowedAttrs = ALLOWED_ATTRS[t.name] ?? new Set<string>();
  const parts: string[] = [`<${t.name}`];
  for (const a of t.attrs) {
    if (!allowedAttrs.has(a.name)) continue;
    if (a.name === "href") {
      if (!SAFE_HREF_RE.test(a.value.trim())) continue;
    }
    parts.push(` ${a.name}="${escapeAttr(a.value)}"`);
  }
  parts.push(t.selfClosing ? " />" : ">");
  return parts.join("");
}

export function sanitizeHtml(html: string): string {
  const out: string[] = [];
  let i = 0;
  const n = html.length;
  while (i < n) {
    if (html[i] === "<") {
      // Strip <!-- comments --> and <!DOCTYPE …> outright.
      if (html.startsWith("<!--", i)) {
        const end = html.indexOf("-->", i + 4);
        i = end === -1 ? n : end + 3;
        continue;
      }
      if (html[i + 1] === "!" || html[i + 1] === "?") {
        const end = html.indexOf(">", i);
        i = end === -1 ? n : end + 1;
        continue;
      }
      // Find the closing `>` (naive, but marked's output never embeds `>` in
      // attribute values without quoting).
      const end = html.indexOf(">", i);
      if (end === -1) {
        // Unterminated tag — treat the rest as text.
        out.push(escapeText(html.slice(i)));
        break;
      }
      const inner = html.slice(i + 1, end);
      i = end + 1;
      const isClose = inner.startsWith("/");
      const body = isClose ? inner.slice(1) : inner;
      const parsed = parseTag(body);
      if (!parsed || !ALLOWED_TAGS.has(parsed.name)) {
        // Skip the tag entirely. Inner text (between open and close) will
        // still be emitted by the outer loop on later iterations.
        continue;
      }
      if (isClose) {
        if (!VOID_TAGS.has(parsed.name)) out.push(`</${parsed.name}>`);
      } else {
        out.push(emitOpen(parsed));
      }
    } else {
      const next = html.indexOf("<", i);
      out.push(next === -1 ? html.slice(i) : html.slice(i, next));
      i = next === -1 ? n : next;
    }
  }
  return out.join("");
}

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
