/**
 * @fileoverview Unit tests for the operator-defined skills loader.
 * @proves Frontmatter parsing, schema validation, filesystem discovery,
 *         name-collision handling, and `{{args}}` template substitution.
 *
 * Skills are operator-authored and loaded once at boot. A regression that
 * silently drops a valid skill (or accepts an invalid one) is hard to notice
 * without these tests — the skill is just "missing" until someone tries to
 * use it. These tests pin the contract.
 *
 * Scenarios covered:
 *
 *   parseSkillFile — happy path:
 *     - Minimal valid skill (name + description + body).
 *     - Optional `tier: secondary` accepted.
 *     - CRLF line endings normalized.
 *     - BOM stripped from start of file.
 *     - Underscores allowed in name; hyphens REJECTED (Telegram spec).
 *
 *   parseSkillFile — schema rejection:
 *     - Missing `---` opening delimiter.
 *     - Missing `---` closing delimiter.
 *     - Empty / missing `name`.
 *     - `name` failing the slug regex (uppercase, special chars, too long).
 *     - `name` collision with reserved built-in command names.
 *     - Empty / missing `description`.
 *     - `description` exceeding 256 chars.
 *     - Invalid `tier` value.
 *     - Empty body.
 *     - Unknown frontmatter key (typo guard).
 *     - Duplicate frontmatter key.
 *     - Malformed frontmatter line (no colon).
 *
 *   loadSkillsSync:
 *     - Missing directory → empty registry + one error.
 *     - Empty directory → empty registry, no errors.
 *     - Multiple valid skills → registry contains both.
 *     - Subdir without SKILL.md is silently skipped.
 *     - Two skills with the same `name` → second is dropped with an error.
 *     - One malformed skill among valid ones → others load; error recorded.
 *     - Reserved name → error recorded; skill dropped; others unaffected.
 *
 *   renderSkillTemplate:
 *     - `{{args}}` replaced with raw user input.
 *     - Multiple `{{args}}` occurrences all replaced.
 *     - Empty args → placeholder becomes empty string.
 *     - Body without `{{args}}` returned unchanged.
 *
 *   skillsToBotCommands:
 *     - Hyphens in name → underscores in Telegram payload.
 *     - Description newlines collapsed.
 *     - Description ≤256 chars (pre-validated, but defensive).
 *
 * Not covered (intentional):
 *   - Real Anthropic SDK calls. `runSkill` integration is in commands.test.ts
 *     with a mocked dispatcher.
 *   - Hot-reload — skills are boot-only by design.
 *
 * Cross-references:
 *   - skills.ts — implementation
 *   - commands.test.ts — dispatcher-side integration
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EMPTY_SKILL_REGISTRY,
  loadSkillsSync,
  parseSkillFile,
  renderSkillTemplate,
  skillsToBotCommands,
  type Skill,
} from "./skills.ts";

const RESERVED = new Set(["clear", "compact", "context", "help", "status"]);

const dirs: string[] = [];

beforeEach(() => {
  dirs.length = 0;
});

afterEach(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempSkillsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "solrac-skills-test-"));
  dirs.push(dir);
  return dir;
}

function writeSkill(root: string, name: string, content: string): string {
  const sub = join(root, name);
  mkdirSync(sub, { recursive: true });
  const path = join(sub, "SKILL.md");
  writeFileSync(path, content);
  return path;
}

const MINIMAL = `---
name: example
description: An example skill
---
You are an example.
{{args}}
`;

// ---------------------------------------------------------------------------
// parseSkillFile — happy path
// ---------------------------------------------------------------------------

describe("parseSkillFile — valid input", () => {
  test("minimal skill (name + description + body)", () => {
    const skill = parseSkillFile(MINIMAL, "/tmp/SKILL.md", RESERVED);
    expect(skill.name).toBe("example");
    expect(skill.description).toBe("An example skill");
    expect(skill.tier).toBe("primary");
    expect(skill.body.trim()).toBe("You are an example.\n{{args}}");
    expect(skill.sourcePath).toBe("/tmp/SKILL.md");
  });

  test("optional tier: secondary", () => {
    const c = `---
name: deepthink
description: Heavy thinking
tier: secondary
---
Body.`;
    const skill = parseSkillFile(c, "/tmp/SKILL.md", RESERVED);
    expect(skill.tier).toBe("secondary");
  });

  test("CRLF line endings normalized", () => {
    const c = `---\r\nname: example\r\ndescription: x\r\n---\r\nBody.\r\n`;
    const skill = parseSkillFile(c, "/tmp/SKILL.md", RESERVED);
    expect(skill.name).toBe("example");
  });

  test("BOM stripped from start of file", () => {
    const c = "﻿" + MINIMAL;
    const skill = parseSkillFile(c, "/tmp/SKILL.md", RESERVED);
    expect(skill.name).toBe("example");
  });

  test("underscores in name allowed", () => {
    const c = `---
name: pr_summary
description: x
---
Body.`;
    const skill = parseSkillFile(c, "/tmp/SKILL.md", RESERVED);
    expect(skill.name).toBe("pr_summary");
  });

  test("hyphens in name REJECTED (Telegram spec mismatch)", () => {
    const c = `---
name: pr-summary
description: x
---
Body.`;
    expect(() => parseSkillFile(c, "/p", RESERVED)).toThrow(/"name" must match/);
  });

  test("name lowercased automatically", () => {
    const c = `---
name: SUMMARIZE
description: x
---
Body.`;
    const skill = parseSkillFile(c, "/tmp/SKILL.md", RESERVED);
    expect(skill.name).toBe("summarize");
  });

  test("quoted description preserves leading/trailing spaces", () => {
    const c = `---
name: example
description: "  spaced description  "
---
Body.`;
    const skill = parseSkillFile(c, "/tmp/SKILL.md", RESERVED);
    expect(skill.description).toBe("  spaced description  ");
  });
});

// ---------------------------------------------------------------------------
// parseSkillFile — schema rejection
// ---------------------------------------------------------------------------

describe("parseSkillFile — schema rejection", () => {
  test("missing opening ---", () => {
    expect(() => parseSkillFile("name: x\n---\nBody.", "/p", RESERVED)).toThrow(
      /must begin with .* frontmatter/,
    );
  });

  test("missing closing ---", () => {
    expect(() => parseSkillFile("---\nname: x\nBody.", "/p", RESERVED)).toThrow(
      /missing closing/,
    );
  });

  test("missing name", () => {
    const c = `---
description: x
---
Body.`;
    expect(() => parseSkillFile(c, "/p", RESERVED)).toThrow(/"name" is required/);
  });

  test("name failing slug regex (uppercase letters disallowed via regex post-lowercase)", () => {
    // Names are lowercased before regex check — but `*` won't survive.
    const c = `---
name: bad*name
description: x
---
Body.`;
    expect(() => parseSkillFile(c, "/p", RESERVED)).toThrow(/"name" must match/);
  });

  test("name longer than 32 chars", () => {
    const long = "a".repeat(33);
    const c = `---
name: ${long}
description: x
---
Body.`;
    expect(() => parseSkillFile(c, "/p", RESERVED)).toThrow(/"name" must match/);
  });

  test("reserved built-in name → rejected", () => {
    const c = `---
name: clear
description: x
---
Body.`;
    expect(() => parseSkillFile(c, "/p", RESERVED)).toThrow(/collides with a built-in/);
  });

  test("missing description", () => {
    const c = `---
name: x
---
Body.`;
    expect(() => parseSkillFile(c, "/p", RESERVED)).toThrow(/"description" is required/);
  });

  test("description exceeding 256 chars", () => {
    const desc = "a".repeat(257);
    const c = `---
name: x
description: ${desc}
---
Body.`;
    expect(() => parseSkillFile(c, "/p", RESERVED)).toThrow(/"description" must be ≤256/);
  });

  test("invalid tier value", () => {
    const c = `---
name: x
description: y
tier: tertiary
---
Body.`;
    expect(() => parseSkillFile(c, "/p", RESERVED)).toThrow(/"tier" must be/);
  });

  test("empty body rejected", () => {
    const c = `---
name: x
description: y
---

`;
    expect(() => parseSkillFile(c, "/p", RESERVED)).toThrow(/body must be non-empty/);
  });

  test("unknown frontmatter key", () => {
    const c = `---
name: x
description: y
ranOuOfFingers: yes
---
Body.`;
    expect(() => parseSkillFile(c, "/p", RESERVED)).toThrow(/unknown frontmatter key/);
  });

  test("duplicate frontmatter key", () => {
    const c = `---
name: x
name: y
description: z
---
Body.`;
    expect(() => parseSkillFile(c, "/p", RESERVED)).toThrow(/duplicate key "name"/);
  });

  test("malformed frontmatter line (no colon)", () => {
    const c = `---
name x
description: y
---
Body.`;
    expect(() => parseSkillFile(c, "/p", RESERVED)).toThrow(/malformed frontmatter line/);
  });

  test("tier: ollama rejected when defaultTier is not ollama", () => {
    const c = `---
name: x
description: y
tier: ollama
---
Body.`;
    expect(() => parseSkillFile(c, "/p", RESERVED, "primary")).toThrow(
      /unreachable when SOLRAC_DEFAULT_ENGINE != ollama/,
    );
  });

  test("tool: true rejected when tier is primary (Phase 1 restriction)", () => {
    const c = `---
name: x
description: y
tier: primary
tool: true
---
Body.`;
    expect(() => parseSkillFile(c, "/p", RESERVED, "primary")).toThrow(
      /"tool: true" requires "tier: ollama"/,
    );
  });

  test("tool: true rejected when tier is secondary", () => {
    const c = `---
name: x
description: y
tier: secondary
tool: true
---
Body.`;
    expect(() => parseSkillFile(c, "/p", RESERVED, "ollama")).toThrow(
      /"tool: true" requires "tier: ollama"/,
    );
  });

  test("tool: true rejected when default tier is non-ollama and tier omitted", () => {
    // Skill omits tier; defaultTier is "primary" so resolved tier is primary.
    // tool: true must then fail.
    const c = `---
name: x
description: y
tool: true
---
Body.`;
    expect(() => parseSkillFile(c, "/p", RESERVED, "primary")).toThrow(
      /"tool: true" requires "tier: ollama"/,
    );
  });

  test("tool: <non-boolean> rejected", () => {
    const c = `---
name: x
description: y
tool: yes
---
Body.`;
    expect(() => parseSkillFile(c, "/p", RESERVED, "ollama")).toThrow(
      /"tool" must be a boolean/,
    );
  });
});

// ---------------------------------------------------------------------------
// parseSkillFile — `tool` field happy path
// ---------------------------------------------------------------------------

describe("parseSkillFile — tool field", () => {
  test("tool field defaults to false when omitted", () => {
    const c = `---
name: example
description: x
---
Body.`;
    const skill = parseSkillFile(c, "/p", RESERVED, "ollama");
    expect(skill.tool).toBe(false);
  });

  test("tool: true accepted with tier: ollama", () => {
    const c = `---
name: example
description: x
tier: ollama
tool: true
---
Body.`;
    const skill = parseSkillFile(c, "/p", RESERVED, "ollama");
    expect(skill.tool).toBe(true);
    expect(skill.tier).toBe("ollama");
  });

  test("tool: true accepted with omitted tier inheriting ollama default", () => {
    const c = `---
name: example
description: x
tool: true
---
Body.`;
    const skill = parseSkillFile(c, "/p", RESERVED, "ollama");
    expect(skill.tool).toBe(true);
    expect(skill.tier).toBe("ollama");
  });

  test("tool: false accepted with any tier", () => {
    const c = `---
name: example
description: x
tier: primary
tool: false
---
Body.`;
    const skill = parseSkillFile(c, "/p", RESERVED, "ollama");
    expect(skill.tool).toBe(false);
    expect(skill.tier).toBe("primary");
  });
});

// ---------------------------------------------------------------------------
// parseSkillFile — tier inheritance from defaultTier
// ---------------------------------------------------------------------------

describe("parseSkillFile — tier inheritance", () => {
  const BARE = `---
name: example
description: An example skill
---
Body.`;

  test("omitted tier inherits defaultTier=primary", () => {
    const skill = parseSkillFile(BARE, "/p", RESERVED, "primary");
    expect(skill.tier).toBe("primary");
  });

  test("omitted tier inherits defaultTier=secondary", () => {
    const skill = parseSkillFile(BARE, "/p", RESERVED, "secondary");
    expect(skill.tier).toBe("secondary");
  });

  test("omitted tier inherits defaultTier=ollama", () => {
    const skill = parseSkillFile(BARE, "/p", RESERVED, "ollama");
    expect(skill.tier).toBe("ollama");
  });

  test("explicit tier: ollama parses when defaultTier=ollama", () => {
    const c = `---
name: example
description: x
tier: ollama
---
Body.`;
    const skill = parseSkillFile(c, "/p", RESERVED, "ollama");
    expect(skill.tier).toBe("ollama");
  });

  test("explicit tier: primary still works under defaultTier=ollama (escalation override)", () => {
    const c = `---
name: example
description: x
tier: primary
---
Body.`;
    const skill = parseSkillFile(c, "/p", RESERVED, "ollama");
    expect(skill.tier).toBe("primary");
  });
});

// ---------------------------------------------------------------------------
// loadSkillsSync
// ---------------------------------------------------------------------------

describe("loadSkillsSync", () => {
  test("missing directory → empty registry + one error", () => {
    const result = loadSkillsSync("/no/such/path", RESERVED, "primary");
    expect(result.loadedCount).toBe(0);
    expect(result.registry.size()).toBe(0);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]!.message).toMatch(/cannot read skills directory/);
  });

  test("empty directory → empty registry, no errors", () => {
    const root = tempSkillsDir();
    const result = loadSkillsSync(root, RESERVED, "primary");
    expect(result.loadedCount).toBe(0);
    expect(result.errors.length).toBe(0);
  });

  test("multiple valid skills load", () => {
    const root = tempSkillsDir();
    writeSkill(root, "summarize", MINIMAL.replace("name: example", "name: summarize"));
    writeSkill(root, "translate", MINIMAL.replace("name: example", "name: translate"));
    const result = loadSkillsSync(root, RESERVED, "primary");
    expect(result.loadedCount).toBe(2);
    expect(result.registry.get("summarize")).toBeDefined();
    expect(result.registry.get("translate")).toBeDefined();
  });

  test("subdir without SKILL.md silently skipped", () => {
    const root = tempSkillsDir();
    mkdirSync(join(root, "empty-dir"));
    writeSkill(root, "valid", MINIMAL.replace("name: example", "name: valid"));
    const result = loadSkillsSync(root, RESERVED, "primary");
    expect(result.loadedCount).toBe(1);
    expect(result.errors.length).toBe(0);
  });

  test("two skills with the same name → second dropped", () => {
    const root = tempSkillsDir();
    // First subdir name `aaa` sorts before `zzz` so it loads first; both
    // SKILL.md files declare `name: dup`.
    const dup = MINIMAL.replace("name: example", "name: dup");
    writeSkill(root, "aaa", dup);
    writeSkill(root, "zzz", dup);
    const result = loadSkillsSync(root, RESERVED, "primary");
    expect(result.loadedCount).toBe(1);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]!.message).toMatch(/already loaded/);
    // First-wins: the surviving skill points at the `aaa` subdir.
    expect(result.registry.get("dup")!.sourcePath).toMatch(/aaa/);
  });

  test("one malformed file does not block siblings", () => {
    const root = tempSkillsDir();
    writeSkill(root, "good", MINIMAL.replace("name: example", "name: good"));
    writeSkill(root, "bad", "no frontmatter at all");
    const result = loadSkillsSync(root, RESERVED, "primary");
    expect(result.loadedCount).toBe(1);
    expect(result.errors.length).toBe(1);
    expect(result.registry.get("good")).toBeDefined();
  });

  test("reserved name produces error and is dropped", () => {
    const root = tempSkillsDir();
    writeSkill(root, "shadow", MINIMAL.replace("name: example", "name: clear"));
    writeSkill(root, "fine", MINIMAL.replace("name: example", "name: fine"));
    const result = loadSkillsSync(root, RESERVED, "primary");
    expect(result.loadedCount).toBe(1);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]!.message).toMatch(/collides with a built-in/);
    expect(result.registry.get("fine")).toBeDefined();
    expect(result.registry.get("clear")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// renderSkillTemplate
// ---------------------------------------------------------------------------

describe("renderSkillTemplate", () => {
  test("{{args}} replaced with user input", () => {
    expect(renderSkillTemplate("Hello {{args}}!", "world")).toBe("Hello world!");
  });

  test("multiple occurrences all replaced", () => {
    expect(renderSkillTemplate("{{args}} and {{args}}", "x")).toBe("x and x");
  });

  test("empty args → placeholder becomes empty", () => {
    expect(renderSkillTemplate("Body: [{{args}}]", "")).toBe("Body: []");
  });

  test("body without placeholder unchanged", () => {
    expect(renderSkillTemplate("No placeholder here.", "ignored")).toBe(
      "No placeholder here.",
    );
  });

  test("args containing special regex chars treated literally", () => {
    // No regex re-interpretation of $1 / $& etc. on the replacement side.
    expect(renderSkillTemplate("X={{args}}", "$1 $&")).toBe("X=$1 $&");
  });
});

// ---------------------------------------------------------------------------
// skillsToBotCommands
// ---------------------------------------------------------------------------

describe("skillsToBotCommands", () => {
  function fakeSkill(name: string, description: string): Skill {
    return Object.freeze({
      name,
      description,
      tier: "primary" as const,
      body: "x",
      sourcePath: "/p",
      tool: false,
    });
  }

  test("name passed through verbatim (already validated)", () => {
    const out = skillsToBotCommands([fakeSkill("pr_summary", "x")]);
    expect(out[0]!.command).toBe("pr_summary");
  });

  test("description whitespace collapsed", () => {
    const out = skillsToBotCommands([fakeSkill("x", "line1\nline2")]);
    expect(out[0]!.description).toBe("line1 line2");
  });

  test("empty input → empty output", () => {
    expect(skillsToBotCommands([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// EMPTY_SKILL_REGISTRY sanity
// ---------------------------------------------------------------------------

describe("EMPTY_SKILL_REGISTRY", () => {
  test("size is 0 and get returns undefined", () => {
    expect(EMPTY_SKILL_REGISTRY.size()).toBe(0);
    expect(EMPTY_SKILL_REGISTRY.get("anything")).toBeUndefined();
    expect(EMPTY_SKILL_REGISTRY.all.length).toBe(0);
  });
});
