import { describe, expect, test } from "bun:test";
import { htmlEscapeAttr, htmlEscapeText } from "./telegram.ts";

describe("htmlEscapeText (3-char text-context form)", () => {
  test("escapes ampersand, less-than, greater-than", () => {
    expect(htmlEscapeText("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
  });

  test("does not escape quotes (text context is quote-safe)", () => {
    expect(htmlEscapeText(`he said "hi" o'clock`)).toBe(`he said "hi" o'clock`);
  });

  test("ampersand escapes first so &lt; doesn't double-encode", () => {
    expect(htmlEscapeText("<")).toBe("&lt;");
    expect(htmlEscapeText("&lt;")).toBe("&amp;lt;");
  });

  test("empty string returns empty", () => {
    expect(htmlEscapeText("")).toBe("");
  });
});

describe("htmlEscapeAttr (5-char OWASP attribute-context form)", () => {
  test("escapes ampersand, less-than, greater-than, double-quote, single-quote", () => {
    expect(htmlEscapeAttr(`& < > " '`)).toBe(`&amp; &lt; &gt; &quot; &#39;`);
  });

  test("breaks an attribute-context XSS payload", () => {
    const payload = `" onmouseover="alert(1)`;
    const escaped = htmlEscapeAttr(payload);
    expect(escaped).not.toContain('"');
    expect(escaped).toBe(`&quot; onmouseover=&quot;alert(1)`);
  });

  test("single-quote uses numeric entity (HTML4 compatibility)", () => {
    expect(htmlEscapeAttr("'")).toBe("&#39;");
  });

  test("ampersand escapes first so &quot; doesn't double-encode", () => {
    expect(htmlEscapeAttr(`"`)).toBe("&quot;");
    expect(htmlEscapeAttr(`&quot;`)).toBe("&amp;quot;");
  });
});
