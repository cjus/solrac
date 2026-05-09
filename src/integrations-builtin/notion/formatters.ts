/**
 * @fileoverview Pure transforms between Notion API shapes and the shorthand
 *               DSL the model writes/reads.
 * @purpose Keep all type-driven serialization logic here, free of I/O.
 *          `client.ts` owns network + caches; this module owns mappings.
 *
 * The model writes shorthand (e.g. `{Status: "Done"}`) and reads back the
 * same flat shape. Notion's typed property envelope (`{type:"status",
 * status:{name:"Done"}}`) is internal-only.
 *
 * Per-type behavior:
 *
 *   serialize (write direction, DSL → Notion):
 *     - title/rich_text         string         → wrapped rich_text
 *     - select/status           string | null  → {name} | null
 *     - multi_select            string[]       → [{name}, ...]
 *     - date                    ISO string|null→ {start} | null
 *     - people/relation         string[]       → [{id}, ...]
 *     - number                  number | null
 *     - checkbox                boolean
 *     - url/email/phone_number  string | null
 *     - formula / rollup / created_time / last_edited_time / created_by /
 *       last_edited_by  THROWS read-only
 *     - files            THROWS unsupported
 *
 *   format (read direction, Notion -> DSL):
 *     - title / rich_text                       plain text
 *     - select / status                         name (string) | null
 *     - multi_select                            string[]
 *     - date                                    {start, end} | null
 *     - people                                  [{id, name}, ...]
 *     - relation                                string[] (page IDs)
 *     - number / checkbox / url / email /
 *       phone_number                            underlying value
 *     - formula / rollup                        plain string (per OQ2)
 *     - created_time / last_edited_time         ISO string | null
 *     - created_by / last_edited_by             {id, name} | null
 *     - files                                   [{name}, ...] (read-only)
 *
 * Block depth: `notion_get_page` walks up to BLOCK_DEPTH_CAP nested levels.
 * Beyond that, blocks render with `truncated: true` so the model knows it's
 * not seeing the full tree. Per OQ3.
 *
 * Annotations (bold/italic/color/etc.) are intentionally dropped on read —
 * round-trip fidelity is not a v1 goal. The model gets plain text, which is
 * what it usually needs anyway.
 *
 * Cross-references:
 *   - PLAN.md (solrac-dev) §3 (property DSL), §4 (block DSL), §5 (surface)
 *   - ./client.ts — DatabaseSchema type used by serializeProperties
 */

import type {
  BlockTreeNode,
  DatabaseProperty,
  DatabaseSchema,
} from "./client.ts";

export type { BlockTreeNode };

type LooseAny = any; // narrow alias to avoid eslint-disable proliferation

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PageSummary {
  readonly id: string;
  readonly url: string;
  readonly archived: boolean;
  readonly created_time: string;
  readonly last_edited_time: string;
  readonly parent: { readonly type: string; readonly id: string };
  readonly title: string;
}

export interface FullPage extends PageSummary {
  readonly properties: Record<string, unknown>;
  readonly blocks: ReadonlyArray<RenderedBlock>;
}

export interface RenderedBlock {
  id: string;
  type: string;
  depth: number;
  text?: string;
  language?: string;
  checked?: boolean;
  emoji?: string;
  has_children?: boolean;
  truncated?: boolean;
  children?: RenderedBlock[];
}

export type BlockInput =
  | { type: "paragraph"; text: string }
  | { type: "heading_1"; text: string }
  | { type: "heading_2"; text: string }
  | { type: "heading_3"; text: string }
  | { type: "bulleted_list_item"; text: string }
  | { type: "numbered_list_item"; text: string }
  | { type: "to_do"; text: string; checked?: boolean }
  | { type: "quote"; text: string }
  | { type: "code"; text: string; language?: string }
  | { type: "divider" }
  | { type: "callout"; text: string; emoji?: string };

/**
 * Maximum nesting level rendered for `notion_get_page`. With
 * BLOCK_DEPTH_CAP=3, blocks at depth 0/1/2 are fetched; deeper blocks are
 * not fetched and parents at depth 2 are marked `truncated: true` if they
 * had children. Per OQ3 — see docs/USAGE.md#notion-block-depth-cap.
 */
export const BLOCK_DEPTH_CAP = 3 as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function plainText(richText: ReadonlyArray<LooseAny> | undefined): string {
  if (!Array.isArray(richText)) return "";
  return richText
    .map((rt: LooseAny) => rt.plain_text ?? rt.text?.content ?? "")
    .join("");
}

function richTextOf(s: string): LooseAny[] {
  return [{ type: "text", text: { content: s } }];
}

function extractPageTitle(page: LooseAny): string {
  const props = (page?.properties ?? {}) as Record<string, LooseAny>;
  for (const v of Object.values(props)) {
    if (v?.type === "title" && Array.isArray(v.title)) return plainText(v.title);
  }
  return "";
}

// ---------------------------------------------------------------------------
// Page rendering (read direction)
// ---------------------------------------------------------------------------

export function formatPageSummary(page: LooseAny): PageSummary {
  const parentType = String(page?.parent?.type ?? "");
  // Notion's parent shape is `{type: "database_id", database_id: "..."}` —
  // the id lives at the type-named key, not at `id`.
  const parentId =
    parentType && page?.parent ? String(page.parent[parentType] ?? "") : "";
  return {
    id: String(page?.id ?? ""),
    url: String(page?.url ?? ""),
    archived: Boolean(page?.archived),
    created_time: String(page?.created_time ?? ""),
    last_edited_time: String(page?.last_edited_time ?? ""),
    parent: { type: parentType, id: parentId },
    title: extractPageTitle(page),
  };
}

export function formatFullPage(page: LooseAny, tree: BlockTreeNode[]): FullPage {
  const summary = formatPageSummary(page);
  const properties: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(
    (page?.properties ?? {}) as Record<string, LooseAny>,
  )) {
    properties[name] = formatProperty(value);
  }
  return {
    ...summary,
    properties,
    blocks: tree.map((node) => formatBlockNode(node, 0)),
  };
}

function formatBlockNode(node: BlockTreeNode, depth: number): RenderedBlock {
  const rendered = formatBlock(node.block, depth);
  if (node.children.length > 0) {
    rendered.children = node.children.map((c) => formatBlockNode(c, depth + 1));
  }
  if (node.truncated) rendered.truncated = true;
  return rendered;
}

// ---------------------------------------------------------------------------
// Block rendering (read direction, single block)
// ---------------------------------------------------------------------------

export function formatBlock(block: LooseAny, depth: number): RenderedBlock {
  const type = String(block?.type ?? "unknown");
  const data = (block?.[type] ?? {}) as LooseAny;
  const out: RenderedBlock = {
    id: String(block?.id ?? ""),
    type,
    depth,
  };
  if (Array.isArray(data.rich_text)) out.text = plainText(data.rich_text);
  if (type === "to_do") out.checked = Boolean(data.checked);
  if (type === "code") out.language = String(data.language ?? "plain text");
  if (type === "callout" && data.icon?.type === "emoji") {
    out.emoji = String(data.icon.emoji);
  }
  if (block?.has_children) out.has_children = true;
  return out;
}

// ---------------------------------------------------------------------------
// Property rendering (read direction)
// ---------------------------------------------------------------------------

export function formatProperty(prop: LooseAny): unknown {
  const type = String(prop?.type ?? "");
  const data = prop?.[type];
  switch (type) {
    case "title":
    case "rich_text":
      return plainText(data ?? []);
    case "select":
    case "status":
      return data?.name ?? null;
    case "multi_select":
      return Array.isArray(data) ? data.map((opt: LooseAny) => String(opt.name)) : [];
    case "date":
      return data ? { start: data.start ?? null, end: data.end ?? null } : null;
    case "people":
      return Array.isArray(data)
        ? data.map((p: LooseAny) => ({ id: String(p.id), name: p.name ?? null }))
        : [];
    case "relation":
      return Array.isArray(data) ? data.map((r: LooseAny) => String(r.id)) : [];
    case "number":
      return typeof data === "number" ? data : null;
    case "checkbox":
      return Boolean(data);
    case "url":
    case "email":
    case "phone_number":
      return data ?? null;
    case "formula":
      return formatFormulaValue(data);
    case "rollup":
      return formatRollupValue(data);
    case "created_time":
    case "last_edited_time":
      return data ?? null;
    case "created_by":
    case "last_edited_by":
      return data ? { id: String(data.id), name: data.name ?? null } : null;
    case "files":
      return Array.isArray(data)
        ? data.map((f: LooseAny) => ({ name: String(f.name ?? "") }))
        : [];
    default:
      return `[unsupported: ${type}]`;
  }
}

function formatFormulaValue(formula: LooseAny): string {
  if (!formula) return "";
  const t = String(formula.type ?? "");
  switch (t) {
    case "string":
      return String(formula.string ?? "");
    case "number":
      return formula.number == null ? "" : String(formula.number);
    case "boolean":
      return String(Boolean(formula.boolean));
    case "date":
      return String(formula.date?.start ?? "");
    default:
      return "";
  }
}

function formatRollupValue(rollup: LooseAny): string {
  if (!rollup) return "";
  const t = String(rollup.type ?? "");
  switch (t) {
    case "number":
      return rollup.number == null ? "" : String(rollup.number);
    case "date":
      return String(rollup.date?.start ?? "");
    case "array":
      return Array.isArray(rollup.array)
        ? rollup.array.map(formatRollupItem).filter(Boolean).join(", ")
        : "";
    default:
      return "";
  }
}

function formatRollupItem(item: LooseAny): string {
  const t = String(item?.type ?? "");
  if (t === "title" || t === "rich_text") return plainText(item[t] ?? []);
  if (t === "number") return item.number == null ? "" : String(item.number);
  if (t === "select") return String(item.select?.name ?? "");
  if (t === "status") return String(item.status?.name ?? "");
  return "";
}

// ---------------------------------------------------------------------------
// Property serialization (write direction)
// ---------------------------------------------------------------------------

const READ_ONLY_TYPES = new Set([
  "formula",
  "rollup",
  "created_time",
  "last_edited_time",
  "created_by",
  "last_edited_by",
]);

const UNSUPPORTED_TYPES = new Set(["files"]);

/**
 * Translate the model's flat DSL (e.g. `{Status: "Done"}`) into Notion's
 * typed property update shape, using the cached database schema to look up
 * each property's type.
 *
 * Throws on:
 *   - Unknown property name (not in schema).
 *   - Read-only property type (formula/rollup/timestamps/users).
 *   - Unsupported property type (files in v1).
 *   - Wrong-shape DSL value (e.g. multi_select got a string).
 *
 * Callers in index.ts catch and wrap in the `{success:false, error}` envelope.
 */
export function serializeProperties(
  input: Record<string, unknown>,
  schema: DatabaseSchema,
): Record<string, LooseAny> {
  const out: Record<string, LooseAny> = {};
  for (const [name, value] of Object.entries(input)) {
    const prop = schema.properties[name];
    if (!prop) {
      throw new Error(`property "${name}" not found in database schema`);
    }
    out[name] = serializeOneProperty(name, prop, value);
  }
  return out;
}

function serializeOneProperty(
  name: string,
  prop: DatabaseProperty,
  value: unknown,
): LooseAny {
  if (READ_ONLY_TYPES.has(prop.type)) {
    throw new Error(
      `cannot write to read-only property "${name}" (type: ${prop.type})`,
    );
  }
  if (UNSUPPORTED_TYPES.has(prop.type)) {
    throw new Error(`${prop.type} property "${name}" not supported in v1`);
  }
  switch (prop.type) {
    case "title":
      return { title: richTextOf(String(value ?? "")) };
    case "rich_text":
      return { rich_text: richTextOf(String(value ?? "")) };
    case "select":
      return { select: value === null ? null : { name: String(value) } };
    case "status":
      return { status: value === null ? null : { name: String(value) } };
    case "multi_select":
      if (!Array.isArray(value)) {
        throw new Error(`"${name}": multi_select expects string[]`);
      }
      return { multi_select: value.map((s) => ({ name: String(s) })) };
    case "date":
      return { date: value === null ? null : { start: String(value) } };
    case "people":
      if (!Array.isArray(value)) {
        throw new Error(`"${name}": people expects string[] of user IDs`);
      }
      return { people: value.map((id) => ({ id: String(id) })) };
    case "relation":
      if (!Array.isArray(value)) {
        throw new Error(`"${name}": relation expects string[] of page IDs`);
      }
      return { relation: value.map((id) => ({ id: String(id) })) };
    case "number":
      if (value !== null && typeof value !== "number") {
        throw new Error(`"${name}": number expects number | null`);
      }
      return { number: value };
    case "checkbox":
      return { checkbox: Boolean(value) };
    case "url":
      return { url: value === null ? null : String(value) };
    case "email":
      return { email: value === null ? null : String(value) };
    case "phone_number":
      return { phone_number: value === null ? null : String(value) };
    default:
      throw new Error(`unsupported property type: ${prop.type}`);
  }
}

// ---------------------------------------------------------------------------
// Block serialization (write direction)
// ---------------------------------------------------------------------------

export function serializeBlocks(input: ReadonlyArray<BlockInput>): LooseAny[] {
  return input.map(serializeOneBlock);
}

function serializeOneBlock(b: BlockInput): LooseAny {
  switch (b.type) {
    case "paragraph":
    case "heading_1":
    case "heading_2":
    case "heading_3":
    case "bulleted_list_item":
    case "numbered_list_item":
    case "quote":
      return {
        object: "block",
        type: b.type,
        [b.type]: { rich_text: richTextOf(b.text) },
      };
    case "to_do":
      return {
        object: "block",
        type: "to_do",
        to_do: {
          rich_text: richTextOf(b.text),
          checked: b.checked ?? false,
        },
      };
    case "code":
      return {
        object: "block",
        type: "code",
        code: {
          rich_text: richTextOf(b.text),
          language: b.language ?? "plain text",
        },
      };
    case "divider":
      return { object: "block", type: "divider", divider: {} };
    case "callout":
      return {
        object: "block",
        type: "callout",
        callout: {
          rich_text: richTextOf(b.text),
          ...(b.emoji ? { icon: { type: "emoji", emoji: b.emoji } } : {}),
        },
      };
    default: {
      // Exhaustive check — adding a new BlockInput variant should land here.
      const _exhaustive: never = b;
      void _exhaustive;
      throw new Error(`unknown block type: ${(b as LooseAny).type}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Block chunking
// ---------------------------------------------------------------------------

/**
 * Split `blocks` into chunks of at most `size` items each. Used for
 * `notion_append_blocks` since Notion's API caps appends at 100 blocks per
 * call. With 250 inputs and size=100, returns three chunks of [100, 100, 50].
 */
export function chunkBlocks<T>(blocks: ReadonlyArray<T>, size: number): T[][] {
  if (size <= 0) throw new Error("size must be > 0");
  const out: T[][] = [];
  for (let i = 0; i < blocks.length; i += size) {
    out.push(blocks.slice(i, i + size) as T[]);
  }
  return out;
}
