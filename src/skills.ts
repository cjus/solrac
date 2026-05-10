/**
 * @fileoverview Operator-defined skills loaded from the filesystem at boot.
 * @purpose Let an operator add new slash commands without touching TypeScript.
 *          A "skill" is a single `SKILL.md` file under `$SOLRAC_SKILLS_DIR`
 *          with YAML-ish frontmatter and a prompt-template body. The loader
 *          discovers skills at boot only — there is no hot-reload (matches
 *          Solrac's "boot once, never reload" config story; see config.ts).
 *
 * Why filesystem and not DB: skills are operator-authored, not user-authored,
 * and version-controlled per-deployment. `~/.solrac/skills` or
 * `./skills` (cwd-relative) keeps them outside the Solrac source tree so
 * different operators can ship different skills without forking.
 *
 * Why a homemade frontmatter parser: Solrac has zero runtime deps beyond the
 * Anthropic Agent SDK. Adding `gray-matter` or `js-yaml` for a 5-key schema
 * is disproportionate. The parser handles only what the schema needs:
 * `key: scalar`, `key: [a, b, c]`, quoted strings, integers, booleans. Real
 * YAML features (anchors, multi-line, nested maps) are explicitly rejected
 * with a clear error pointing at the file and line.
 *
 * Position in the dependency graph:
 *   log + telegram → skills → consumed by commands, main
 *
 * Exports:
 *   - `Skill` — frozen typed shape of one loaded skill.
 *   - `SkillRegistry` — read-only map + list view consumed by `parseCommand`
 *     and `runCommand`.
 *   - `EMPTY_SKILL_REGISTRY` — sentinel used when skills are disabled.
 *   - `loadSkillsSync(dir, reservedNames)` — discovers + parses + validates,
 *     returning the registry + non-fatal errors.
 *   - `parseSkillFile(content, sourcePath, reservedNames)` — pure parser used
 *     by the loader and tests.
 *   - `renderSkillTemplate(body, args)` — `{{args}}` substitution.
 *   - `skillsToBotCommands(skills)` — convert registry to `setMyCommands`
 *     payload entries.
 *
 * Key invariants:
 *   - Skill `name` must match `/^[a-z0-9_-]{1,32}$/` and must NOT collide with
 *     a built-in command name (passed in via `reservedNames`). Collisions are
 *     non-fatal at load time — the skill is dropped with a warn and the
 *     built-in wins.
 *   - Two skills with the same `name` produce a warn and the SECOND is dropped
 *     (load order is `readdirSync`, which is filesystem-order — operators
 *     should rename rather than rely on order).
 *   - Loader is fail-soft: a malformed SKILL.md adds an error to the result
 *     but does not throw. Boot continues. The registry only contains valid
 *     skills.
 *   - Missing skills directory → empty registry + one error entry. NOT a boot
 *     failure (operator may have `SOLRAC_SKILLS_ENABLED=true` without
 *     creating the dir yet).
 *   - Body MUST be non-empty after trim. Empty bodies are rejected.
 *   - `{{args}}` substitution is literal — no escaping, no nested templating.
 *     The user's raw arg text replaces every `{{args}}` occurrence in the
 *     body. Skill authors MUST treat their body as a prompt that may receive
 *     arbitrary text.
 *
 * Gotchas:
 *   - The frontmatter parser does NOT support multi-line strings, comments
 *     beyond `# foo` end-of-line, or escape sequences inside quoted strings.
 *     Schema rejection messages name the offending key + line.
 *   - `loadSkillsSync` walks ONE level deep: `$dir/<name>/SKILL.md`. A flat
 *     layout (`$dir/<name>.md`) is NOT supported — the per-skill subdirectory
 *     is reserved for future companion files (examples, tests).
 *   - Skill names in the registry are stored lowercased; matching against
 *     incoming `/cmd` is case-insensitive (handled by `parseCommand`).
 *
 * Cross-references:
 *   - docs/USAGE.md#skills — operator-facing docs and SKILL.md example
 *   - src/commands.ts — parser + dispatcher integration
 *   - src/main.ts — boot loader call site
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { log } from "./log.ts";
import type { BotCommand } from "./telegram.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SkillTier = "primary" | "secondary" | "ollama";

export interface Skill {
  readonly name: string;
  readonly description: string;
  readonly tier: SkillTier;
  readonly body: string;
  readonly sourcePath: string;
  // PNX-167.x — when true, the skill is exposed as a callable MCP tool to the
  // Ollama agent (in addition to its existing /<name> slash invocation). The
  // model decides when to call based on `description`; the handler runs the
  // skill body and returns its text as the tool result. Phase 1 restriction:
  // `tool: true` requires `tier: "ollama"` (free-only — avoids cross-engine
  // cost surprises from agent-driven invocations).
  readonly tool: boolean;
}

export interface SkillLoadError {
  readonly path: string;
  readonly message: string;
}

export interface SkillRegistry {
  readonly all: ReadonlyArray<Skill>;
  get(name: string): Skill | undefined;
  size(): number;
}

export interface SkillLoadResult {
  readonly registry: SkillRegistry;
  readonly errors: ReadonlyArray<SkillLoadError>;
  readonly loadedCount: number;
}

export const EMPTY_SKILL_REGISTRY: SkillRegistry = Object.freeze({
  all: Object.freeze([] as ReadonlyArray<Skill>),
  get: () => undefined,
  size: () => 0,
});

// Strict slug: lowercase, digits, underscore. Matches Telegram's
// `setMyCommands` spec exactly so what the operator writes in SKILL.md is
// what users type and what autocomplete shows. Hyphens are NOT supported —
// the existing `COMMAND_RE` in commands.ts (which predates skills) only
// matches `[A-Za-z0-9_]`, and Telegram itself rejects hyphens.
const NAME_RE = /^[a-z0-9_]{1,32}$/;
const MAX_DESCRIPTION_LEN = 256;
const FRONTMATTER_DELIM = "---";

// ---------------------------------------------------------------------------
// Frontmatter parser (schema-restricted YAML subset)
// ---------------------------------------------------------------------------

type ScalarValue = string | number | boolean | ReadonlyArray<string>;

function parseValue(raw: string, line: number): ScalarValue {
  const v = raw.trim();
  if (v === "") return "";
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+$/.test(v)) return Number(v);
  if (v.startsWith("[") && v.endsWith("]")) {
    const inner = v.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map((s, i) => {
      const item = parseStringScalar(s.trim());
      if (item === null) {
        throw new Error(`line ${line}: array item ${i} could not be parsed as a string scalar`);
      }
      return item;
    });
  }
  const s = parseStringScalar(v);
  if (s === null) {
    throw new Error(`line ${line}: unparseable value "${raw}"`);
  }
  return s;
}

function parseStringScalar(raw: string): string | null {
  if (raw === "") return "";
  if (
    (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) ||
    (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2)
  ) {
    return raw.slice(1, -1);
  }
  if (raw.includes('"') || raw.includes("'")) return null;
  return raw;
}

interface RawFrontmatter {
  readonly fields: Readonly<Record<string, ScalarValue>>;
}

function parseFrontmatter(yaml: string): RawFrontmatter {
  const fields: Record<string, ScalarValue> = {};
  const lines = yaml.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const raw = lines[i]!;
    // Strip trailing comments. Naive — `key: "a # b"` becomes `key: "a `,
    // which then fails to parse as a balanced quoted string. Operators with
    // `#` in values must avoid them; documented in USAGE.md.
    const stripped = raw.replace(/\s+#.*$/, "").trim();
    if (stripped === "") continue;
    const m = /^([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(stripped);
    if (!m) {
      throw new Error(`line ${lineNo}: malformed frontmatter line: "${raw}"`);
    }
    const key = m[1]!;
    if (key in fields) {
      throw new Error(`line ${lineNo}: duplicate key "${key}"`);
    }
    fields[key] = parseValue(m[2]!, lineNo);
  }
  return { fields };
}

// ---------------------------------------------------------------------------
// Skill file parser (frontmatter + body + schema validation)
// ---------------------------------------------------------------------------

export function parseSkillFile(
  content: string,
  sourcePath: string,
  reservedNames: ReadonlySet<string>,
  defaultTier: SkillTier = "primary",
): Skill {
  // Split frontmatter and body. Expected layout:
  //   ---\n
  //   <yaml>\n
  //   ---\n
  //   <body>
  // We accept BOM, leading whitespace, and CRLF line endings.
  const normalized = content.replace(/\r\n/g, "\n").replace(/^﻿/, "");
  const trimmed = normalized.replace(/^\s+/, "");
  if (!trimmed.startsWith(FRONTMATTER_DELIM + "\n") && trimmed !== FRONTMATTER_DELIM) {
    throw new Error(`${sourcePath}: file must begin with "---" frontmatter delimiter`);
  }
  const afterOpen = trimmed.slice(FRONTMATTER_DELIM.length + 1); // skip `---\n`
  const closeIdx = afterOpen.indexOf("\n" + FRONTMATTER_DELIM);
  if (closeIdx === -1) {
    throw new Error(`${sourcePath}: missing closing "---" frontmatter delimiter`);
  }
  const yaml = afterOpen.slice(0, closeIdx);
  const afterClose = afterOpen.slice(closeIdx + 1 + FRONTMATTER_DELIM.length);
  // Body starts on the line AFTER the closing delim.
  const body = afterClose.replace(/^[ \t]*\n/, "");

  let raw: RawFrontmatter;
  try {
    raw = parseFrontmatter(yaml);
  } catch (err) {
    throw new Error(`${sourcePath}: ${(err as Error).message}`);
  }

  const f = raw.fields;
  // name
  const nameVal = f.name;
  if (typeof nameVal !== "string" || nameVal === "") {
    throw new Error(`${sourcePath}: "name" is required and must be a non-empty string`);
  }
  const name = nameVal.toLowerCase();
  if (!NAME_RE.test(name)) {
    throw new Error(
      `${sourcePath}: "name" must match ${NAME_RE.source} (got "${nameVal}")`,
    );
  }
  if (reservedNames.has(name)) {
    throw new Error(
      `${sourcePath}: "name" "${name}" collides with a built-in command (reserved: ${[...reservedNames].sort().join(", ")})`,
    );
  }
  // description
  const descVal = f.description;
  if (typeof descVal !== "string" || descVal.trim() === "") {
    throw new Error(`${sourcePath}: "description" is required and must be a non-empty string`);
  }
  if (descVal.length > MAX_DESCRIPTION_LEN) {
    throw new Error(
      `${sourcePath}: "description" must be ≤${MAX_DESCRIPTION_LEN} chars (got ${descVal.length})`,
    );
  }
  // tier — defaults to deploy's default engine. When explicit `ollama`, refuse
  // if the deploy default isn't ollama (PR-B removed the `>` prefix; mirrors
  // scheduler.ts engine handling).
  let tier: SkillTier = defaultTier;
  if ("tier" in f) {
    const tierVal = f.tier;
    if (tierVal !== "primary" && tierVal !== "secondary" && tierVal !== "ollama") {
      throw new Error(`${sourcePath}: "tier" must be primary | secondary | ollama (got "${String(tierVal)}")`);
    }
    if (tierVal === "ollama" && defaultTier !== "ollama") {
      throw new Error(
        `${sourcePath}: "tier: ollama" is unreachable when SOLRAC_DEFAULT_ENGINE != ollama ` +
          `(PR-B removed the > prefix). Set SOLRAC_DEFAULT_ENGINE=ollama or use tier: primary/secondary`,
      );
    }
    tier = tierVal;
  }
  // tool — opt-in flag exposing the skill as a callable MCP tool. Default
  // false. Phase 1 restriction: only `tier: "ollama"` skills are tool-eligible
  // (the Claude path's tool catalog is untouched until Phase 2). Operators who
  // want a Claude-tier skill keep it slash-only.
  let toolFlag = false;
  if ("tool" in f) {
    const v = f.tool;
    if (typeof v !== "boolean") {
      throw new Error(`${sourcePath}: "tool" must be a boolean (got "${String(v)}")`);
    }
    if (v && tier !== "ollama") {
      throw new Error(
        `${sourcePath}: "tool: true" requires "tier: ollama" in Phase 1 ` +
          `(got tier=${tier}). Set tier: ollama or omit tier to inherit ` +
          `SOLRAC_DEFAULT_ENGINE=ollama, or remove tool: true to keep this ` +
          `skill slash-only.`,
      );
    }
    toolFlag = v;
  }

  // body
  if (body.trim() === "") {
    throw new Error(`${sourcePath}: body must be non-empty (no prompt template)`);
  }

  // Reject unknown keys so typos don't silently skip.
  const ALLOWED = new Set(["name", "description", "tier", "tool"]);
  for (const k of Object.keys(f)) {
    if (!ALLOWED.has(k)) {
      throw new Error(
        `${sourcePath}: unknown frontmatter key "${k}" (allowed: ${[...ALLOWED].sort().join(", ")})`,
      );
    }
  }

  return Object.freeze({
    name,
    description: descVal,
    tier,
    body,
    sourcePath,
    tool: toolFlag,
  });
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export function loadSkillsSync(
  dir: string,
  reservedNames: ReadonlySet<string>,
  defaultTier: SkillTier,
): SkillLoadResult {
  const errors: SkillLoadError[] = [];
  const byName = new Map<string, Skill>();

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    errors.push({
      path: dir,
      message: `cannot read skills directory: ${(err as Error).message}`,
    });
    return {
      registry: EMPTY_SKILL_REGISTRY,
      errors,
      loadedCount: 0,
    };
  }

  for (const entry of entries.sort()) {
    const subdir = join(dir, entry);
    let isDir: boolean;
    try {
      isDir = statSync(subdir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    const skillPath = join(subdir, "SKILL.md");
    let content: string;
    try {
      content = readFileSync(skillPath, "utf8");
    } catch {
      // No SKILL.md in this subdir — skip silently. Operator may keep other
      // files (e.g. README.md) alongside without intending them as skills.
      continue;
    }
    let skill: Skill;
    try {
      skill = parseSkillFile(content, skillPath, reservedNames, defaultTier);
    } catch (err) {
      errors.push({ path: skillPath, message: (err as Error).message });
      continue;
    }
    if (byName.has(skill.name)) {
      const first = byName.get(skill.name)!;
      errors.push({
        path: skillPath,
        message: `skill name "${skill.name}" already loaded from ${first.sourcePath}; this file is ignored`,
      });
      continue;
    }
    byName.set(skill.name, skill);
  }

  const all = Object.freeze([...byName.values()]);
  const registry: SkillRegistry = Object.freeze({
    all,
    get: (name: string) => byName.get(name.toLowerCase()),
    size: () => byName.size,
  });
  return {
    registry,
    errors,
    loadedCount: byName.size,
  };
}

// ---------------------------------------------------------------------------
// Template rendering
// ---------------------------------------------------------------------------

// `{{args}}` is the only template placeholder. Multiple occurrences all
// receive the same value. Empty `args` is allowed — the placeholder becomes
// an empty string. We do NOT escape — the body is a Claude prompt, not HTML.
//
// Function replacement (not string replacement) is required: `String.replace`
// with a string interprets `$&`, `$1`, etc. as backreferences, so a user typing
// literal `$&` inside `/skill <args>` would otherwise see their text mangled.
export function renderSkillTemplate(body: string, args: string): string {
  return body.replace(/\{\{args\}\}/g, () => args);
}

// ---------------------------------------------------------------------------
// Telegram setMyCommands payload
// ---------------------------------------------------------------------------

// Telegram's `setMyCommands` requires `command` to match `[a-z0-9_]{1,32}` —
// our schema already restricts `name` to that exact set. The map is therefore
// identity-on-name plus whitespace-collapsing on the description (Telegram
// rejects newlines in descriptions).
export function skillsToBotCommands(skills: ReadonlyArray<Skill>): ReadonlyArray<BotCommand> {
  return skills.map((s) => ({
    command: s.name,
    description: s.description.replace(/\s+/g, " ").trim().slice(0, 256),
  }));
}

// Convenience for boot: log a one-line summary so operators see the count
// and any non-fatal load errors at startup.
export function logSkillLoadResult(dir: string, result: SkillLoadResult): void {
  log.info("skills.loaded", {
    dir,
    count: result.loadedCount,
    errors: result.errors.length,
  });
  for (const e of result.errors) {
    log.warn("skills.load_error", { path: e.path, message: e.message });
  }
}
