/**
 * @fileoverview Unit tests for instance.ts: SOUL.md + SOLRAC.md externalization.
 * @proves Bootstrap copies templates from pkgDir → cwd when cwd lacks them
 *         and is idempotent across repeat boots; `loadSoul` hard-fails on
 *         missing/empty SOUL.md; `readInstanceMd` returns null on missing or
 *         comment-only content and strips comments from real content; the
 *         per-turn re-read picks up live edits.
 *
 * Mock surface: none. Uses real fs + tmpdir for both cwd and pkgDir.
 *
 * Cross-references:
 *   - instance.ts — implementation under test
 *   - SOUL.md — canonical default content (asserted shape, not bytes)
 *   - SOLRAC.md — canonical template content
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INSTANCE_FILE_NAMES,
  SOLRAC_MD_UNEDITED_MARKER,
  bootstrapInstanceFiles,
  instanceMdPath,
  loadSoul,
  readInstanceMd,
  wrapInstanceMd,
} from "./instance.ts";

const dirs: string[] = [];

function newDir(): string {
  const d = mkdtempSync(join(tmpdir(), "solrac-instance-"));
  dirs.push(d);
  return d;
}

beforeEach(() => {
  dirs.length = 0;
});

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("bootstrapInstanceFiles", () => {
  test("copies both templates from pkgDir → cwd when cwd is empty", () => {
    const cwd = newDir();
    const pkg = newDir();
    writeFileSync(join(pkg, INSTANCE_FILE_NAMES.SOUL), "soul template", "utf8");
    writeFileSync(join(pkg, INSTANCE_FILE_NAMES.SOLRAC), "solrac template", "utf8");
    const r = bootstrapInstanceFiles(cwd, pkg);
    expect(r.soulCreated).toBe(true);
    expect(r.solracCreated).toBe(true);
    expect(readFileSync(join(cwd, INSTANCE_FILE_NAMES.SOUL), "utf8")).toBe("soul template");
    expect(readFileSync(join(cwd, INSTANCE_FILE_NAMES.SOLRAC), "utf8")).toBe("solrac template");
  });

  test("does not overwrite existing SOUL.md or SOLRAC.md in cwd", () => {
    const cwd = newDir();
    const pkg = newDir();
    writeFileSync(join(pkg, INSTANCE_FILE_NAMES.SOUL), "DEFAULT_SOUL", "utf8");
    writeFileSync(join(pkg, INSTANCE_FILE_NAMES.SOLRAC), "DEFAULT_SOLRAC", "utf8");
    writeFileSync(join(cwd, INSTANCE_FILE_NAMES.SOUL), "OPERATOR_SOUL", "utf8");
    writeFileSync(join(cwd, INSTANCE_FILE_NAMES.SOLRAC), "OPERATOR_SOLRAC", "utf8");
    const r = bootstrapInstanceFiles(cwd, pkg);
    expect(r.soulCreated).toBe(false);
    expect(r.solracCreated).toBe(false);
    expect(readFileSync(join(cwd, INSTANCE_FILE_NAMES.SOUL), "utf8")).toBe("OPERATOR_SOUL");
    expect(readFileSync(join(cwd, INSTANCE_FILE_NAMES.SOLRAC), "utf8")).toBe("OPERATOR_SOLRAC");
  });

  test("creates only SOLRAC.md when only SOUL.md exists in cwd", () => {
    const cwd = newDir();
    const pkg = newDir();
    writeFileSync(join(pkg, INSTANCE_FILE_NAMES.SOUL), "ds", "utf8");
    writeFileSync(join(pkg, INSTANCE_FILE_NAMES.SOLRAC), "dr", "utf8");
    writeFileSync(join(cwd, INSTANCE_FILE_NAMES.SOUL), "operator", "utf8");
    const r = bootstrapInstanceFiles(cwd, pkg);
    expect(r.soulCreated).toBe(false);
    expect(r.solracCreated).toBe(true);
    expect(readFileSync(join(cwd, INSTANCE_FILE_NAMES.SOUL), "utf8")).toBe("operator");
    expect(readFileSync(join(cwd, INSTANCE_FILE_NAMES.SOLRAC), "utf8")).toBe("dr");
  });

  test("is idempotent — second call after both exist creates nothing", () => {
    const cwd = newDir();
    const pkg = newDir();
    writeFileSync(join(pkg, INSTANCE_FILE_NAMES.SOUL), "s", "utf8");
    writeFileSync(join(pkg, INSTANCE_FILE_NAMES.SOLRAC), "r", "utf8");
    bootstrapInstanceFiles(cwd, pkg);
    const r = bootstrapInstanceFiles(cwd, pkg);
    expect(r).toEqual({ soulCreated: false, solracCreated: false });
  });

  test("silently skips a missing pkgDir entry instead of throwing", () => {
    const cwd = newDir();
    const pkg = newDir();
    // pkg has SOLRAC but not SOUL — a degraded install. bootstrap shouldn't
    // throw; the missing SOUL surfaces later via loadSoul instead.
    writeFileSync(join(pkg, INSTANCE_FILE_NAMES.SOLRAC), "r", "utf8");
    const r = bootstrapInstanceFiles(cwd, pkg);
    expect(r.soulCreated).toBe(false);
    expect(r.solracCreated).toBe(true);
  });
});

describe("loadSoul", () => {
  test("returns the trimmed file content", () => {
    const cwd = newDir();
    writeFileSync(join(cwd, INSTANCE_FILE_NAMES.SOUL), "  hello soul\n\n", "utf8");
    expect(loadSoul(cwd)).toBe("hello soul");
  });

  test("throws when SOUL.md is missing", () => {
    const cwd = newDir();
    expect(() => loadSoul(cwd)).toThrow(/SOUL\.md not found/);
  });

  test("throws when SOUL.md is empty after trimming", () => {
    const cwd = newDir();
    writeFileSync(join(cwd, INSTANCE_FILE_NAMES.SOUL), "   \n  \n", "utf8");
    expect(() => loadSoul(cwd)).toThrow(/empty/);
  });

  test("preserves embedded HTML comments (SOUL is not stripped)", () => {
    const cwd = newDir();
    writeFileSync(
      join(cwd, INSTANCE_FILE_NAMES.SOUL),
      "voice line\n<!-- maintainer note -->\nstance line",
      "utf8",
    );
    const out = loadSoul(cwd);
    expect(out).toContain("<!-- maintainer note -->");
    expect(out).toContain("voice line");
    expect(out).toContain("stance line");
  });
});

describe("readInstanceMd", () => {
  test("returns null when the file is missing", () => {
    const cwd = newDir();
    expect(readInstanceMd(instanceMdPath(cwd))).toBeNull();
  });

  test("returns null when the unedited-template marker is present", () => {
    const cwd = newDir();
    writeFileSync(
      instanceMdPath(cwd),
      `<!-- ${SOLRAC_MD_UNEDITED_MARKER} -->\n# Operator: Carlos\nReal content here.`,
      "utf8",
    );
    expect(readInstanceMd(instanceMdPath(cwd))).toBeNull();
  });

  test("returns content once the unedited marker is removed", () => {
    const cwd = newDir();
    writeFileSync(
      instanceMdPath(cwd),
      "# Operator: Carlos\nReal content here.",
      "utf8",
    );
    const out = readInstanceMd(instanceMdPath(cwd));
    expect(out).not.toBeNull();
    expect(out).toContain("Operator: Carlos");
  });

  test("does NOT suppress when the marker string appears only inside body content", () => {
    // Self-documenting SOLRAC.md: operator references the activation flag in
    // their own prose. The marker line is gone but the string remains. Must
    // not regress to the old substring-based suppression.
    const cwd = newDir();
    writeFileSync(
      instanceMdPath(cwd),
      "# Operator: Carlos\nNote: this file activates once the solrac-md:unedited line is removed.",
      "utf8",
    );
    const out = readInstanceMd(instanceMdPath(cwd));
    expect(out).not.toBeNull();
    expect(out).toContain("solrac-md:unedited");
  });

  test("does NOT suppress when the marker appears inside an arbitrary comment block (not on its own line)", () => {
    const cwd = newDir();
    writeFileSync(
      instanceMdPath(cwd),
      "<!-- maintainer note: see solrac-md:unedited flag in instance.ts -->\n# Operator: Carlos",
      "utf8",
    );
    const out = readInstanceMd(instanceMdPath(cwd));
    expect(out).not.toBeNull();
    expect(out).toContain("Operator: Carlos");
  });

  test("returns null when stripping comments leaves only whitespace", () => {
    const cwd = newDir();
    writeFileSync(
      instanceMdPath(cwd),
      "<!-- a -->\n   \n<!-- b -->\n",
      "utf8",
    );
    expect(readInstanceMd(instanceMdPath(cwd))).toBeNull();
  });

  test("strips HTML comments from returned content", () => {
    const cwd = newDir();
    writeFileSync(
      instanceMdPath(cwd),
      "Operator: Carlos\n<!-- private note -->\nTimezone: MST",
      "utf8",
    );
    const out = readInstanceMd(instanceMdPath(cwd));
    expect(out).not.toContain("private note");
    expect(out).not.toContain("<!--");
    expect(out).toContain("Operator: Carlos");
    expect(out).toContain("Timezone: MST");
  });

  test("picks up live edits on subsequent reads", () => {
    const cwd = newDir();
    const path = instanceMdPath(cwd);
    writeFileSync(path, "version one", "utf8");
    expect(readInstanceMd(path)).toBe("version one");
    writeFileSync(path, "version two", "utf8");
    expect(readInstanceMd(path)).toBe("version two");
  });
});

describe("wrapInstanceMd", () => {
  test("wraps body in solrac-md tags with newlines", () => {
    expect(wrapInstanceMd("hello")).toBe("<solrac-md>\nhello\n</solrac-md>");
  });
});

describe("packaged defaults", () => {
  test("SOUL.md exists with non-empty content", () => {
    // Validates that the canonical default SOUL.md is present in the repo.
    // This is the file `bootstrapInstanceFiles` will copy into the operator's
    // cwd on first boot. If this test fails, the package is broken.
    const path = join(import.meta.dir, "..", INSTANCE_FILE_NAMES.SOUL);
    const content = readFileSync(path, "utf8").trim();
    expect(content.length).toBeGreaterThan(0);
    expect(content).toMatch(/Solrac/i);
  });

  test("SOLRAC.md ships with the unedited-template marker so a fresh install injects nothing", () => {
    const path = join(import.meta.dir, "..", INSTANCE_FILE_NAMES.SOLRAC);
    const content = readFileSync(path, "utf8");
    expect(content.length).toBeGreaterThan(0);
    expect(content).toContain(SOLRAC_MD_UNEDITED_MARKER);
    // End-to-end: pointing readInstanceMd at the shipped template returns null
    // (operator hasn't activated it yet).
    expect(readInstanceMd(path)).toBeNull();
  });
});
