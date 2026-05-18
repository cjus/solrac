/**
 * @fileoverview Unit tests for the pure-logic helpers in `voice.ts`.
 * @proves Markdown → speech token-walk handles each construct correctly,
 *         length-cap math is right, cost-estimate math matches the
 *         documented rates, and the voice-mode prompt substitutes `words`
 *         and `words * 3` correctly.
 *
 * Per CLAUDE.md "Testing Philosophy" — `bun:test` for pure logic only.
 * Orchestration helpers (`handleWebStt` etc.) touch ElevenLabs HTTP +
 * sqlite and are verified manually + smoke-flood.
 */

import { describe, expect, test } from "bun:test";
import {
  buildVoiceModePrompt,
  estimateSttCostUsd,
  estimateTtsCostUsd,
  stripMarkdownForSpeech,
} from "./voice.ts";

describe("buildVoiceModePrompt", () => {
  test("default 60 words → 'under 60' and 'up to 180'", () => {
    const out = buildVoiceModePrompt({ words: 60 });
    expect(out).toContain("under 60 words");
    expect(out).toContain("up to 180 words");
  });

  test("expand budget is words × 3", () => {
    expect(buildVoiceModePrompt({ words: 30 })).toContain("up to 90 words");
    expect(buildVoiceModePrompt({ words: 100 })).toContain("up to 300 words");
  });

  test("wraps in <voice-mode> tags", () => {
    const out = buildVoiceModePrompt({ words: 60 });
    expect(out.startsWith("<voice-mode>")).toBe(true);
    expect(out.endsWith("</voice-mode>")).toBe(true);
  });

  test("instructs against preamble and lists/code/tables", () => {
    const out = buildVoiceModePrompt({ words: 60 });
    expect(out).toMatch(/no preamble/i);
    expect(out).toMatch(/prose over lists/i);
  });
});

describe("stripMarkdownForSpeech", () => {
  test("plain paragraph passes through", () => {
    expect(stripMarkdownForSpeech("hello world")).toBe("hello world");
  });

  test("headers strip hash marks, keep text", () => {
    expect(stripMarkdownForSpeech("# Big news")).toBe("Big news.");
  });

  test("bold and italic unwrap to inner text", () => {
    expect(stripMarkdownForSpeech("this is **important** and *fine*")).toBe(
      "this is important and fine",
    );
  });

  test("fenced code blocks summarize", () => {
    const md = "Here is code:\n\n```js\nconst x = 1;\n```\n\nDone.";
    const out = stripMarkdownForSpeech(md);
    expect(out).toContain("[code block omitted]");
    expect(out).not.toContain("const x = 1");
  });

  test("inline code keeps inner text", () => {
    expect(stripMarkdownForSpeech("call `foo()` first")).toBe("call foo() first");
  });

  test("tables summarize", () => {
    const md = "before\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nafter";
    const out = stripMarkdownForSpeech(md);
    expect(out).toContain("[table omitted]");
    expect(out).not.toContain("| a | b |");
  });

  test("lists flatten with comma separators", () => {
    const md = "Items:\n- apples\n- oranges\n- pears";
    const out = stripMarkdownForSpeech(md);
    expect(out).toContain("apples, oranges, pears");
  });

  test("link text kept, URL dropped", () => {
    expect(stripMarkdownForSpeech("see [the docs](https://example.com)")).toBe(
      "see the docs",
    );
  });

  test("blockquote prefixed with 'Quote:'", () => {
    expect(stripMarkdownForSpeech("> remember this")).toContain("Quote: remember this");
  });

  test("hr renders as a sentence break", () => {
    const out = stripMarkdownForSpeech("before\n\n---\n\nafter");
    expect(out).toContain("before");
    expect(out).toContain("after");
  });

  test("strikethrough text is kept (TTS can't whisper a strike)", () => {
    expect(stripMarkdownForSpeech("this is ~~wrong~~ actually right")).toBe(
      "this is wrong actually right",
    );
  });

  test("whitespace collapses", () => {
    expect(stripMarkdownForSpeech("hello   \n\n  world  ")).toBe("hello world");
  });

  test("empty input returns empty string", () => {
    expect(stripMarkdownForSpeech("")).toBe("");
  });

  test("strips Claude tier agent footer", () => {
    const md = "Here's the answer.\n\n*✅ 2 turns · $0.0123*";
    const out = stripMarkdownForSpeech(md);
    expect(out).toBe("Here's the answer.");
    expect(out).not.toContain("✅");
    expect(out).not.toContain("turns");
    expect(out).not.toContain("$");
  });

  test("strips engine-slot footer with model and tools", () => {
    const md =
      "London is in BST right now, 19:42.\n\n" +
      "*✅ remote:openrouter:z-ai/glm-5.1 · 1 tools · 6.6s · $0.0048*";
    const out = stripMarkdownForSpeech(md);
    expect(out).toContain("London");
    expect(out).not.toContain("openrouter");
    expect(out).not.toContain("$");
    expect(out).not.toContain("tools");
  });

  test("strips footer even with surrounding whitespace", () => {
    const md = "Answer.\n\n  *  ✅ 1 turn · $0.0001  *  \n\n";
    const out = stripMarkdownForSpeech(md);
    expect(out).toBe("Answer.");
  });

  test("plain ✅ in content is preserved (no italic markers)", () => {
    // The footer specifically uses italic markers (*...*). A bare ✅
    // inside content shouldn't be stripped.
    const md = "Test passed ✅ — moving on.";
    const out = stripMarkdownForSpeech(md);
    expect(out).toContain("Test passed");
    expect(out).toContain("moving on");
  });
});

describe("estimateSttCostUsd", () => {
  test("1 hour at $0.22/hr = $0.22", () => {
    expect(estimateSttCostUsd(3600, 0.22)).toBeCloseTo(0.22, 6);
  });

  test("30 seconds at $0.22/hr ≈ $0.00183", () => {
    expect(estimateSttCostUsd(30, 0.22)).toBeCloseTo(0.001833, 5);
  });

  test("0 seconds is free", () => {
    expect(estimateSttCostUsd(0, 0.22)).toBe(0);
  });

  test("custom rate respected", () => {
    expect(estimateSttCostUsd(3600, 1.0)).toBe(1.0);
  });
});

describe("estimateTtsCostUsd", () => {
  test("1000 chars at $0.05/1k = $0.05", () => {
    expect(estimateTtsCostUsd(1000, 0.05)).toBeCloseTo(0.05, 6);
  });

  test("3000 chars at $0.05/1k = $0.15", () => {
    expect(estimateTtsCostUsd(3000, 0.05)).toBeCloseTo(0.15, 6);
  });

  test("0 chars is free", () => {
    expect(estimateTtsCostUsd(0, 0.05)).toBe(0);
  });

  test("multi v2 price ($0.10/1k) doubles the spend", () => {
    expect(estimateTtsCostUsd(1000, 0.1)).toBeCloseTo(0.1, 6);
  });
});
