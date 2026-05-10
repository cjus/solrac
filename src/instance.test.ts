/**
 * @fileoverview Unit tests for instance.ts: SOUL.md + SOLRAC.md externalization.
 * @proves Bootstrap writes embedded SOUL/SOLRAC into `home` when missing,
 *         is idempotent across repeat boots, never overwrites operator edits,
 *         and emits SOUL.md.new when the embedded default diverges from the
 *         on-disk SOUL.md (binary upgrade signal). `loadSoul` hard-fails on
 *         missing/empty SOUL.md; `readInstanceMd` returns null on missing or
 *         comment-only content and strips comments from real content; the
 *         per-turn re-read picks up live edits.
 *
 * Mock surface: none. Uses real fs + tmpdir; embedded constants come from
 * the actual repo SOUL.md/SOLRAC.md text imports.
 *
 * Cross-references:
 *   - instance.ts — implementation under test
 *   - SOUL.md — canonical default voice (text-imported into the binary)
 *   - SOLRAC.md — canonical template content (text-imported into the binary)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EMBEDDED_DEFAULTS,
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

describe("EMBEDDED_DEFAULTS", () => {
  test("SOUL is non-empty and mentions Solrac (sanity-check the text import)", () => {
    expect(EMBEDDED_DEFAULTS.SOUL.length).toBeGreaterThan(0);
    expect(EMBEDDED_DEFAULTS.SOUL).toMatch(/Solrac/i);
  });

  test("SOLRAC ships with the unedited-template marker so a fresh install injects nothing", () => {
    expect(EMBEDDED_DEFAULTS.SOLRAC.length).toBeGreaterThan(0);
    expect(EMBEDDED_DEFAULTS.SOLRAC).toContain(SOLRAC_MD_UNEDITED_MARKER);
  });
});

describe("bootstrapInstanceFiles", () => {
  test("writes both embedded defaults to home when home is empty", () => {
    const home = newDir();
    const r = bootstrapInstanceFiles(home);
    expect(r.soulCreated).toBe(true);
    expect(r.solracCreated).toBe(true);
    expect(r.soulNewWritten).toBe(false);
    expect(readFileSync(join(home, INSTANCE_FILE_NAMES.SOUL), "utf8")).toBe(EMBEDDED_DEFAULTS.SOUL);
    expect(readFileSync(join(home, INSTANCE_FILE_NAMES.SOLRAC), "utf8")).toBe(EMBEDDED_DEFAULTS.SOLRAC);
  });

  test("creates `home` recursively if it doesn't exist", () => {
    // Packaged binary first run on a machine without ~/.solrac/ should not
    // need a separate mkdir step — bootstrap should mint the dir itself.
    const parent = newDir();
    const home = join(parent, "nested", "solrac-home");
    expect(existsSync(home)).toBe(false);
    const r = bootstrapInstanceFiles(home);
    expect(r.soulCreated).toBe(true);
    expect(existsSync(home)).toBe(true);
  });

  test("does not overwrite existing operator-edited SOUL.md or SOLRAC.md", () => {
    const home = newDir();
    writeFileSync(join(home, INSTANCE_FILE_NAMES.SOUL), "OPERATOR_SOUL", "utf8");
    writeFileSync(join(home, INSTANCE_FILE_NAMES.SOLRAC), "OPERATOR_SOLRAC", "utf8");
    const r = bootstrapInstanceFiles(home);
    expect(r.soulCreated).toBe(false);
    expect(r.solracCreated).toBe(false);
    expect(readFileSync(join(home, INSTANCE_FILE_NAMES.SOUL), "utf8")).toBe("OPERATOR_SOUL");
    expect(readFileSync(join(home, INSTANCE_FILE_NAMES.SOLRAC), "utf8")).toBe("OPERATOR_SOLRAC");
  });

  test("creates only SOLRAC.md when only SOUL.md exists in home", () => {
    const home = newDir();
    writeFileSync(join(home, INSTANCE_FILE_NAMES.SOUL), "operator", "utf8");
    const r = bootstrapInstanceFiles(home);
    expect(r.soulCreated).toBe(false);
    expect(r.solracCreated).toBe(true);
    expect(readFileSync(join(home, INSTANCE_FILE_NAMES.SOUL), "utf8")).toBe("operator");
    expect(readFileSync(join(home, INSTANCE_FILE_NAMES.SOLRAC), "utf8")).toBe(EMBEDDED_DEFAULTS.SOLRAC);
  });

  test("is idempotent — second call after both exist creates nothing", () => {
    const home = newDir();
    bootstrapInstanceFiles(home);
    const r = bootstrapInstanceFiles(home);
    expect(r).toEqual({ soulCreated: false, solracCreated: false, soulNewWritten: false });
  });

  test("emits SOUL.md.new when on-disk SOUL diverges from embedded default (binary upgrade signal)", () => {
    const home = newDir();
    writeFileSync(join(home, INSTANCE_FILE_NAMES.SOUL), "OPERATOR_EDITED_SOUL", "utf8");
    const r = bootstrapInstanceFiles(home);
    expect(r.soulNewWritten).toBe(true);
    expect(readFileSync(join(home, INSTANCE_FILE_NAMES.SOUL), "utf8")).toBe("OPERATOR_EDITED_SOUL");
    expect(readFileSync(join(home, `${INSTANCE_FILE_NAMES.SOUL}.new`), "utf8")).toBe(EMBEDDED_DEFAULTS.SOUL);
  });

  test("does not emit SOUL.md.new when on-disk SOUL matches embedded default", () => {
    const home = newDir();
    writeFileSync(join(home, INSTANCE_FILE_NAMES.SOUL), EMBEDDED_DEFAULTS.SOUL, "utf8");
    const r = bootstrapInstanceFiles(home);
    expect(r.soulNewWritten).toBe(false);
    expect(existsSync(join(home, `${INSTANCE_FILE_NAMES.SOUL}.new`))).toBe(false);
  });

  test("does not clobber an existing SOUL.md.new on repeat boot (preserves a pending merge)", () => {
    const home = newDir();
    writeFileSync(join(home, INSTANCE_FILE_NAMES.SOUL), "OPERATOR_EDITED", "utf8");
    writeFileSync(join(home, `${INSTANCE_FILE_NAMES.SOUL}.new`), "STALE_PENDING_MERGE", "utf8");
    const r = bootstrapInstanceFiles(home);
    expect(r.soulNewWritten).toBe(false);
    expect(readFileSync(join(home, `${INSTANCE_FILE_NAMES.SOUL}.new`), "utf8")).toBe("STALE_PENDING_MERGE");
  });
});

describe("loadSoul", () => {
  test("returns the trimmed file content", () => {
    const home = newDir();
    writeFileSync(join(home, INSTANCE_FILE_NAMES.SOUL), "  hello soul\n\n", "utf8");
    expect(loadSoul(home)).toBe("hello soul");
  });

  test("throws when SOUL.md is missing", () => {
    const home = newDir();
    expect(() => loadSoul(home)).toThrow(/SOUL\.md not found/);
  });

  test("throws when SOUL.md is empty after trimming", () => {
    const home = newDir();
    writeFileSync(join(home, INSTANCE_FILE_NAMES.SOUL), "   \n  \n", "utf8");
    expect(() => loadSoul(home)).toThrow(/empty/);
  });

  test("preserves embedded HTML comments (SOUL is not stripped)", () => {
    const home = newDir();
    writeFileSync(
      join(home, INSTANCE_FILE_NAMES.SOUL),
      "voice line\n<!-- maintainer note -->\nstance line",
      "utf8",
    );
    const out = loadSoul(home);
    expect(out).toContain("<!-- maintainer note -->");
    expect(out).toContain("voice line");
    expect(out).toContain("stance line");
  });
});

describe("readInstanceMd", () => {
  test("returns null when the file is missing", () => {
    const home = newDir();
    expect(readInstanceMd(instanceMdPath(home))).toBeNull();
  });

  test("returns null when the unedited-template marker is present", () => {
    const home = newDir();
    writeFileSync(
      instanceMdPath(home),
      `<!-- ${SOLRAC_MD_UNEDITED_MARKER} -->\n# Operator: Carlos\nReal content here.`,
      "utf8",
    );
    expect(readInstanceMd(instanceMdPath(home))).toBeNull();
  });

  test("returns content once the unedited marker is removed", () => {
    const home = newDir();
    writeFileSync(
      instanceMdPath(home),
      "# Operator: Carlos\nReal content here.",
      "utf8",
    );
    const out = readInstanceMd(instanceMdPath(home));
    expect(out).not.toBeNull();
    expect(out).toContain("Operator: Carlos");
  });

  test("does NOT suppress when the marker string appears only inside body content", () => {
    // Self-documenting SOLRAC.md: operator references the activation flag in
    // their own prose. The marker line is gone but the string remains. Must
    // not regress to the old substring-based suppression.
    const home = newDir();
    writeFileSync(
      instanceMdPath(home),
      "# Operator: Carlos\nNote: this file activates once the solrac-md:unedited line is removed.",
      "utf8",
    );
    const out = readInstanceMd(instanceMdPath(home));
    expect(out).not.toBeNull();
    expect(out).toContain("solrac-md:unedited");
  });

  test("does NOT suppress when the marker appears inside an arbitrary comment block (not on its own line)", () => {
    const home = newDir();
    writeFileSync(
      instanceMdPath(home),
      "<!-- maintainer note: see solrac-md:unedited flag in instance.ts -->\n# Operator: Carlos",
      "utf8",
    );
    const out = readInstanceMd(instanceMdPath(home));
    expect(out).not.toBeNull();
    expect(out).toContain("Operator: Carlos");
  });

  test("returns null when stripping comments leaves only whitespace", () => {
    const home = newDir();
    writeFileSync(
      instanceMdPath(home),
      "<!-- a -->\n   \n<!-- b -->\n",
      "utf8",
    );
    expect(readInstanceMd(instanceMdPath(home))).toBeNull();
  });

  test("strips HTML comments from returned content", () => {
    const home = newDir();
    writeFileSync(
      instanceMdPath(home),
      "Operator: Carlos\n<!-- private note -->\nTimezone: MST",
      "utf8",
    );
    const out = readInstanceMd(instanceMdPath(home));
    expect(out).not.toContain("private note");
    expect(out).not.toContain("<!--");
    expect(out).toContain("Operator: Carlos");
    expect(out).toContain("Timezone: MST");
  });

  test("picks up live edits on subsequent reads", () => {
    const home = newDir();
    const path = instanceMdPath(home);
    writeFileSync(path, "version one", "utf8");
    expect(readInstanceMd(path)).toBe("version one");
    writeFileSync(path, "version two", "utf8");
    expect(readInstanceMd(path)).toBe("version two");
  });

  test("end-to-end: pointing readInstanceMd at the embedded SOLRAC default returns null", () => {
    // The shipped template carries the unedited marker — operators activate
    // by deleting the marker line. A fresh install therefore injects nothing.
    const home = newDir();
    writeFileSync(instanceMdPath(home), EMBEDDED_DEFAULTS.SOLRAC, "utf8");
    expect(readInstanceMd(instanceMdPath(home))).toBeNull();
  });
});

describe("wrapInstanceMd", () => {
  test("wraps body in solrac-md tags with newlines", () => {
    expect(wrapInstanceMd("hello")).toBe("<solrac-md>\nhello\n</solrac-md>");
  });
});
