/**
 * @fileoverview Unit tests for Notion DSL ↔ API shape transforms.
 * @proves Per-type property serialize/parse, write-direction errors for
 *         read-only and unsupported types, block serialize for every
 *         supported block type, chunkBlocks math, page+block read renderers
 *         (incl. nested tree depth metadata).
 *
 * No network. Schemas + page/block payloads are hand-rolled to mirror what
 * Notion's API returns. If Notion's response shape ever changes for a type
 * we care about, a test here breaks before users do.
 *
 * Cross-references:
 *   - ./formatters.ts — system under test
 *   - PLAN.md (solrac-dev) §3, §4, §7
 */

import { describe, expect, test } from "bun:test";
import type { DatabaseSchema } from "./client.ts";
import {
  BLOCK_DEPTH_CAP,
  type BlockInput,
  type BlockTreeNode,
  chunkBlocks,
  formatBlock,
  formatFullPage,
  formatPageSummary,
  formatProperty,
  serializeBlocks,
  serializeProperties,
} from "./formatters.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function schemaWith(properties: Record<string, string>): DatabaseSchema {
  const props: Record<string, { id: string; name: string; type: string; raw: unknown }> = {};
  for (const [name, type] of Object.entries(properties)) {
    props[name] = { id: name, name, type, raw: { id: name, type } };
  }
  return { id: "db-1", properties: props };
}

function richTextNode(s: string): { plain_text: string; text: { content: string } } {
  return { plain_text: s, text: { content: s } };
}

// ---------------------------------------------------------------------------
// serializeProperties — happy paths per type
// ---------------------------------------------------------------------------

describe("serializeProperties", () => {
  test("title and rich_text wrap as Notion rich_text array", () => {
    const schema = schemaWith({ Name: "title", Notes: "rich_text" });
    const out = serializeProperties({ Name: "Hello", Notes: "World" }, schema);
    expect(out.Name.title).toEqual([{ type: "text", text: { content: "Hello" } }]);
    expect(out.Notes.rich_text).toEqual([{ type: "text", text: { content: "World" } }]);
  });

  test("select / status take a string and emit {name}", () => {
    const schema = schemaWith({ Priority: "select", State: "status" });
    const out = serializeProperties({ Priority: "High", State: "Done" }, schema);
    expect(out.Priority).toEqual({ select: { name: "High" } });
    expect(out.State).toEqual({ status: { name: "Done" } });
  });

  test("select / status accept null to clear", () => {
    const schema = schemaWith({ Priority: "select", State: "status" });
    const out = serializeProperties({ Priority: null, State: null }, schema);
    expect(out.Priority).toEqual({ select: null });
    expect(out.State).toEqual({ status: null });
  });

  test("multi_select takes string[] and emits [{name},...]", () => {
    const schema = schemaWith({ Tags: "multi_select" });
    const out = serializeProperties({ Tags: ["a", "b", "c"] }, schema);
    expect(out.Tags).toEqual({
      multi_select: [{ name: "a" }, { name: "b" }, { name: "c" }],
    });
  });

  test("date takes ISO string and emits {start}", () => {
    const schema = schemaWith({ Due: "date" });
    const out = serializeProperties({ Due: "2026-05-09" }, schema);
    expect(out.Due).toEqual({ date: { start: "2026-05-09" } });
  });

  test("people / relation take string[] of IDs", () => {
    const schema = schemaWith({ Owners: "people", Refs: "relation" });
    const out = serializeProperties(
      { Owners: ["u-1", "u-2"], Refs: ["p-1"] },
      schema,
    );
    expect(out.Owners).toEqual({ people: [{ id: "u-1" }, { id: "u-2" }] });
    expect(out.Refs).toEqual({ relation: [{ id: "p-1" }] });
  });

  test("number, checkbox, url/email/phone_number pass through", () => {
    const schema = schemaWith({
      Count: "number",
      Done: "checkbox",
      Site: "url",
      Mail: "email",
      Tel: "phone_number",
    });
    const out = serializeProperties(
      {
        Count: 42,
        Done: true,
        Site: "https://example.com",
        Mail: "x@y.z",
        Tel: "+1-555-0100",
      },
      schema,
    );
    expect(out.Count).toEqual({ number: 42 });
    expect(out.Done).toEqual({ checkbox: true });
    expect(out.Site).toEqual({ url: "https://example.com" });
    expect(out.Mail).toEqual({ email: "x@y.z" });
    expect(out.Tel).toEqual({ phone_number: "+1-555-0100" });
  });

  test("number accepts null to clear", () => {
    const schema = schemaWith({ Count: "number" });
    const out = serializeProperties({ Count: null }, schema);
    expect(out.Count).toEqual({ number: null });
  });
});

// ---------------------------------------------------------------------------
// serializeProperties — error paths
// ---------------------------------------------------------------------------

describe("serializeProperties (errors)", () => {
  test("unknown property name throws", () => {
    const schema = schemaWith({ Name: "title" });
    expect(() => serializeProperties({ Bogus: "x" }, schema)).toThrow(/not found/);
  });

  test("read-only types throw with type in message", () => {
    for (const t of [
      "formula",
      "rollup",
      "created_time",
      "last_edited_time",
      "created_by",
      "last_edited_by",
    ]) {
      const schema = schemaWith({ Foo: t });
      expect(() => serializeProperties({ Foo: "x" }, schema)).toThrow(
        new RegExp(`read-only.*${t}`),
      );
    }
  });

  test("files property throws as unsupported", () => {
    const schema = schemaWith({ Attachments: "files" });
    expect(() => serializeProperties({ Attachments: [] }, schema)).toThrow(
      /not supported/,
    );
  });

  test("multi_select with non-array throws", () => {
    const schema = schemaWith({ Tags: "multi_select" });
    expect(() => serializeProperties({ Tags: "a" }, schema)).toThrow(/expects string\[\]/);
  });

  test("number with string value throws", () => {
    const schema = schemaWith({ Count: "number" });
    expect(() => serializeProperties({ Count: "42" }, schema)).toThrow(/number/);
  });
});

// ---------------------------------------------------------------------------
// formatProperty — read direction
// ---------------------------------------------------------------------------

describe("formatProperty", () => {
  test("title and rich_text → plain text", () => {
    expect(formatProperty({ type: "title", title: [richTextNode("Hello")] })).toBe("Hello");
    expect(
      formatProperty({ type: "rich_text", rich_text: [richTextNode("a"), richTextNode("b")] }),
    ).toBe("ab");
  });

  test("select / status → name | null", () => {
    expect(formatProperty({ type: "select", select: { name: "High" } })).toBe("High");
    expect(formatProperty({ type: "status", status: { name: "Done" } })).toBe("Done");
    expect(formatProperty({ type: "select", select: null })).toBeNull();
  });

  test("multi_select → string[] of names", () => {
    expect(
      formatProperty({
        type: "multi_select",
        multi_select: [{ name: "a" }, { name: "b" }],
      }),
    ).toEqual(["a", "b"]);
  });

  test("date → {start, end} | null", () => {
    expect(formatProperty({ type: "date", date: { start: "2026-01-01", end: null } })).toEqual({
      start: "2026-01-01",
      end: null,
    });
    expect(formatProperty({ type: "date", date: null })).toBeNull();
  });

  test("people → [{id, name}, ...]", () => {
    expect(
      formatProperty({
        type: "people",
        people: [{ id: "u1", name: "Alice" }, { id: "u2" }],
      }),
    ).toEqual([
      { id: "u1", name: "Alice" },
      { id: "u2", name: null },
    ]);
  });

  test("relation → string[] (page IDs)", () => {
    expect(
      formatProperty({ type: "relation", relation: [{ id: "p1" }, { id: "p2" }] }),
    ).toEqual(["p1", "p2"]);
  });

  test("number/checkbox/url/email/phone_number pass through", () => {
    expect(formatProperty({ type: "number", number: 42 })).toBe(42);
    expect(formatProperty({ type: "checkbox", checkbox: true })).toBe(true);
    expect(formatProperty({ type: "url", url: "https://x" })).toBe("https://x");
    expect(formatProperty({ type: "email", email: "x@y" })).toBe("x@y");
    expect(formatProperty({ type: "phone_number", phone_number: "+1" })).toBe("+1");
  });

  test("formula renders as plain string per OQ2", () => {
    expect(formatProperty({ type: "formula", formula: { type: "string", string: "abc" } })).toBe(
      "abc",
    );
    expect(formatProperty({ type: "formula", formula: { type: "number", number: 42 } })).toBe(
      "42",
    );
    expect(formatProperty({ type: "formula", formula: { type: "boolean", boolean: true } })).toBe(
      "true",
    );
    expect(
      formatProperty({ type: "formula", formula: { type: "date", date: { start: "2026-01-01" } } }),
    ).toBe("2026-01-01");
  });

  test("rollup array renders as comma-joined string", () => {
    expect(
      formatProperty({
        type: "rollup",
        rollup: {
          type: "array",
          array: [
            { type: "title", title: [richTextNode("Foo")] },
            { type: "title", title: [richTextNode("Bar")] },
          ],
        },
      }),
    ).toBe("Foo, Bar");
  });

  test("unknown type → [unsupported: <type>] sentinel", () => {
    expect(formatProperty({ type: "weird_new_type" })).toBe("[unsupported: weird_new_type]");
  });
});

// ---------------------------------------------------------------------------
// Round-trip: serialize → format ≈ input (for symmetric types)
// ---------------------------------------------------------------------------

describe("round-trip", () => {
  test("title", () => {
    const schema = schemaWith({ Name: "title" });
    const serialized = serializeProperties({ Name: "Hello" }, schema);
    // Notion read response wraps the payload with `type` — synthesize that.
    const readShape = { type: "title", title: serialized.Name.title };
    expect(formatProperty(readShape)).toBe("Hello");
  });

  test("status", () => {
    const schema = schemaWith({ State: "status" });
    const serialized = serializeProperties({ State: "Done" }, schema);
    const readShape = { type: "status", status: serialized.State.status };
    expect(formatProperty(readShape)).toBe("Done");
  });

  test("multi_select", () => {
    const schema = schemaWith({ Tags: "multi_select" });
    const serialized = serializeProperties({ Tags: ["a", "b"] }, schema);
    const readShape = { type: "multi_select", multi_select: serialized.Tags.multi_select };
    expect(formatProperty(readShape)).toEqual(["a", "b"]);
  });

  test("number", () => {
    const schema = schemaWith({ Count: "number" });
    const serialized = serializeProperties({ Count: 42 }, schema);
    const readShape = { type: "number", number: serialized.Count.number };
    expect(formatProperty(readShape)).toBe(42);
  });

  test("checkbox", () => {
    const schema = schemaWith({ Done: "checkbox" });
    const serialized = serializeProperties({ Done: true }, schema);
    const readShape = { type: "checkbox", checkbox: serialized.Done.checkbox };
    expect(formatProperty(readShape)).toBe(true);
  });

  test("relation", () => {
    const schema = schemaWith({ Refs: "relation" });
    const serialized = serializeProperties({ Refs: ["p-1", "p-2"] }, schema);
    const readShape = { type: "relation", relation: serialized.Refs.relation };
    expect(formatProperty(readShape)).toEqual(["p-1", "p-2"]);
  });
});

// ---------------------------------------------------------------------------
// serializeBlocks — happy paths per type
// ---------------------------------------------------------------------------

describe("serializeBlocks", () => {
  test("paragraph + headings + list items + quote share rich_text shape", () => {
    const inputs: BlockInput[] = [
      { type: "paragraph", text: "p" },
      { type: "heading_1", text: "h1" },
      { type: "heading_2", text: "h2" },
      { type: "heading_3", text: "h3" },
      { type: "bulleted_list_item", text: "b" },
      { type: "numbered_list_item", text: "n" },
      { type: "quote", text: "q" },
    ];
    const out = serializeBlocks(inputs);
    expect(out).toHaveLength(7);
    for (const [i, block] of out.entries()) {
      expect(block.object).toBe("block");
      expect(block.type).toBe(inputs[i].type);
      expect(block[inputs[i].type].rich_text).toEqual([
        { type: "text", text: { content: (inputs[i] as { text: string }).text } },
      ]);
    }
  });

  test("to_do honors checked default false and explicit true", () => {
    const out = serializeBlocks([
      { type: "to_do", text: "task" },
      { type: "to_do", text: "task2", checked: true },
    ]);
    expect(out[0].to_do.checked).toBe(false);
    expect(out[1].to_do.checked).toBe(true);
  });

  test("code uses 'plain text' as default language", () => {
    const out = serializeBlocks([
      { type: "code", text: "let x = 1" },
      { type: "code", text: "console.log(1)", language: "javascript" },
    ]);
    expect(out[0].code.language).toBe("plain text");
    expect(out[1].code.language).toBe("javascript");
  });

  test("divider has empty body", () => {
    const out = serializeBlocks([{ type: "divider" }]);
    expect(out[0]).toEqual({ object: "block", type: "divider", divider: {} });
  });

  test("callout includes emoji icon when provided, omits when not", () => {
    const out = serializeBlocks([
      { type: "callout", text: "hi" },
      { type: "callout", text: "hi", emoji: "💡" },
    ]);
    expect(out[0].callout.icon).toBeUndefined();
    expect(out[1].callout.icon).toEqual({ type: "emoji", emoji: "💡" });
  });
});

// ---------------------------------------------------------------------------
// chunkBlocks
// ---------------------------------------------------------------------------

describe("chunkBlocks", () => {
  test("250 items / size 100 → [100, 100, 50]", () => {
    const arr = Array.from({ length: 250 }, (_, i) => i);
    const chunks = chunkBlocks(arr, 100);
    expect(chunks.map((c) => c.length)).toEqual([100, 100, 50]);
    // Order preserved across chunks
    expect(chunks[0][0]).toBe(0);
    expect(chunks[2][49]).toBe(249);
  });

  test("empty input → empty output", () => {
    expect(chunkBlocks([], 10)).toEqual([]);
  });

  test("size larger than input → one chunk", () => {
    expect(chunkBlocks([1, 2, 3], 10)).toEqual([[1, 2, 3]]);
  });

  test("size <= 0 throws", () => {
    expect(() => chunkBlocks([1, 2, 3], 0)).toThrow();
    expect(() => chunkBlocks([1, 2, 3], -1)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// formatBlock — single block
// ---------------------------------------------------------------------------

describe("formatBlock", () => {
  test("paragraph extracts text and depth", () => {
    const block = {
      id: "b1",
      type: "paragraph",
      paragraph: { rich_text: [richTextNode("Hello")] },
    };
    expect(formatBlock(block, 2)).toEqual({
      id: "b1",
      type: "paragraph",
      depth: 2,
      text: "Hello",
    });
  });

  test("to_do exposes checked", () => {
    const block = {
      id: "b1",
      type: "to_do",
      to_do: { rich_text: [richTextNode("task")], checked: true },
    };
    expect(formatBlock(block, 0)).toMatchObject({ checked: true, text: "task" });
  });

  test("code exposes language", () => {
    const block = {
      id: "b1",
      type: "code",
      code: { rich_text: [richTextNode("x")], language: "ts" },
    };
    expect(formatBlock(block, 0)).toMatchObject({ language: "ts", text: "x" });
  });

  test("callout exposes emoji when icon is emoji", () => {
    const block = {
      id: "b1",
      type: "callout",
      callout: { rich_text: [richTextNode("note")], icon: { type: "emoji", emoji: "💡" } },
    };
    expect(formatBlock(block, 0)).toMatchObject({ emoji: "💡", text: "note" });
  });

  test("divider has no text", () => {
    const block = { id: "b1", type: "divider", divider: {} };
    const out = formatBlock(block, 0);
    expect(out.type).toBe("divider");
    expect(out.text).toBeUndefined();
  });

  test("has_children flag is preserved", () => {
    const block = {
      id: "b1",
      type: "paragraph",
      has_children: true,
      paragraph: { rich_text: [richTextNode("p")] },
    };
    expect(formatBlock(block, 0).has_children).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// formatPageSummary / formatFullPage with nested blocks
// ---------------------------------------------------------------------------

describe("formatFullPage", () => {
  test("extracts title from title-typed property and renders block tree", () => {
    const page = {
      id: "p-1",
      url: "https://notion.so/p-1",
      archived: false,
      created_time: "2026-01-01T00:00:00.000Z",
      last_edited_time: "2026-05-01T00:00:00.000Z",
      parent: { type: "database_id", database_id: "db-1" },
      properties: {
        Name: { type: "title", title: [richTextNode("My Page")] },
        Status: { type: "status", status: { name: "Done" } },
      },
    };
    const tree: BlockTreeNode[] = [
      {
        block: {
          id: "b1",
          type: "paragraph",
          has_children: true,
          paragraph: { rich_text: [richTextNode("intro")] },
        },
        children: [
          {
            block: {
              id: "b1a",
              type: "bulleted_list_item",
              bulleted_list_item: { rich_text: [richTextNode("nested")] },
            },
            children: [],
          },
        ],
      },
      {
        block: {
          id: "b2",
          type: "divider",
          divider: {},
        },
        children: [],
      },
    ];

    const full = formatFullPage(page, tree);
    expect(full.id).toBe("p-1");
    expect(full.title).toBe("My Page");
    expect(full.parent).toEqual({ type: "database_id", id: "db-1" });
    expect(full.properties.Status).toBe("Done");
    expect(full.blocks).toHaveLength(2);
    expect(full.blocks[0].depth).toBe(0);
    expect(full.blocks[0].text).toBe("intro");
    expect(full.blocks[0].children).toBeDefined();
    expect(full.blocks[0].children![0].depth).toBe(1);
    expect(full.blocks[0].children![0].text).toBe("nested");
  });

  test("propagates truncated marker from BlockTreeNode", () => {
    const page = {
      id: "p-1",
      url: "https://notion.so/p-1",
      archived: false,
      created_time: "",
      last_edited_time: "",
      parent: { type: "page_id", page_id: "x" },
      properties: {},
    };
    const tree: BlockTreeNode[] = [
      {
        block: {
          id: "b1",
          type: "paragraph",
          has_children: true,
          paragraph: { rich_text: [richTextNode("p")] },
        },
        children: [],
        truncated: true,
      },
    ];
    const full = formatFullPage(page, tree);
    expect(full.blocks[0].truncated).toBe(true);
  });
});

describe("formatPageSummary", () => {
  test("handles missing fields gracefully", () => {
    const summary = formatPageSummary({ id: "x" });
    expect(summary.id).toBe("x");
    expect(summary.title).toBe("");
    expect(summary.archived).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// BLOCK_DEPTH_CAP exported constant
// ---------------------------------------------------------------------------

describe("BLOCK_DEPTH_CAP", () => {
  test("is 3 per OQ3", () => {
    expect(BLOCK_DEPTH_CAP).toBe(3);
  });
});
