/**
 * @fileoverview SOUL.md + SOLRAC.md externalization: persona file + per-instance overlay.
 * @purpose Replace the in-source `SOLRAC_SYSTEM_PROMPT_APPEND` and
 *          `OLLAMA_SYSTEM_PROMPT` constants with two operator-editable
 *          markdown files. Mirrors OpenClaw's SOUL/AGENTS split (voice vs
 *          operating rules) and Claude Code's CLAUDE.md memory model.
 *
 * Two files, two lifecycles:
 *
 *   - `SOUL.md` — voice, stance, safety. Read once at boot via `loadSoul`;
 *     hard-fails if missing or empty. Joined into Claude's
 *     `systemPrompt.append` and the local engine's first `system` message.
 *     Per-engine capability deltas ("you have tools" / "you don't") stay in
 *     code next to each engine's wiring (see `agent.ts::buildClaudeCapabilityNote`
 *     and `local.ts::buildLocalCapabilityNote`) so SOUL.md stays portable.
 *
 *   - `SOLRAC.md` — operator overlay (operator name, channel posture, project
 *     hints). Re-read per turn via `readInstanceMd` so live edits take effect
 *     without restart. Soft-warn if missing — Solrac runs vanilla without it.
 *     Injected as a `<solrac-md>...</solrac-md>` block in the user-message
 *     envelope (Claude path: prepended in `buildAugmentedPrompt`; local path:
 *     a second `system` message).
 *
 * Both files ship as **embedded text** inside the compiled Bun binary via
 * text imports of the canonical copies in the repo root. On boot,
 * `bootstrapInstanceFiles(home)` writes the embedded defaults to `home`
 * (typically `~/.solrac/`) if the operator doesn't already have copies.
 * Reads thereafter always come from disk; the embedded copies are a one-time
 * seed plus an upgrade-path signal (see SOUL.md.new behaviour below).
 *
 * Why embed-then-bootstrap instead of always reading from the binary:
 *   The whole point of externalization is operator customization. If we read
 *   from the embedded string, edits would never take effect. Bootstrap once
 *   to disk, read from disk onwards, and surface upgraded defaults via
 *   SOUL.md.new — which the operator can diff/merge manually without losing
 *   their voice edits.
 *
 * Position in the dependency graph:
 *   log → instance → consumed by main, agent, local
 *
 * Exports:
 *   - `INSTANCE_FILE_NAMES` — `{ SOUL: "SOUL.md", SOLRAC: "SOLRAC.md" }`.
 *   - `EMBEDDED_DEFAULTS` — `{ SOUL, SOLRAC }` text content baked into the binary.
 *   - `bootstrapInstanceFiles(home)` — write missing files; emit SOUL.md.new on diff.
 *   - `loadSoul(home)` — read SOUL.md once; throws on missing/empty.
 *   - `readInstanceMd(path)` — read SOLRAC.md per turn; null if missing or
 *     comment-only (unedited template).
 *   - `instanceMdPath(home)` — `join(home, "SOLRAC.md")` helper.
 *
 * Key invariants:
 *   - `loadSoul` is the only hard-fail path. SOLRAC.md missing or empty is
 *     ALWAYS a soft-warn; the operator may not want a per-instance overlay.
 *   - `readInstanceMd` strips HTML comments before checking emptiness AND
 *     before returning content. The shipped SOLRAC.md template is all
 *     comments — that means a fresh install injects nothing until the
 *     operator edits real content into the file.
 *   - Bootstrap is idempotent. An existing file in `home` is never overwritten,
 *     so repeated boots don't clobber operator edits. When the embedded
 *     default differs from the on-disk SOUL.md, a SOUL.md.new sidecar is
 *     written for manual merge — and only if no SOUL.md.new is already there
 *     (don't clobber a pending merge).
 *
 * Cross-references:
 *   - SOUL.md — canonical default voice (embedded into the binary)
 *   - SOLRAC.md — operator overlay template (embedded into the binary)
 *   - agent.ts::runAgent — Claude path consumer
 *   - local.ts::runLocalTurn — local path consumer
 *   - main.ts — boot wires bootstrap + load
 *   - text-modules.d.ts — ambient string type for `*.md` text imports
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "./log.ts";

import EMBEDDED_SOUL_MD from "../SOUL.md" with { type: "text" };
import EMBEDDED_SOLRAC_MD from "../SOLRAC.md" with { type: "text" };

export const INSTANCE_FILE_NAMES = {
  SOUL: "SOUL.md",
  SOLRAC: "SOLRAC.md",
} as const;

/**
 * Embedded canonical defaults. These ship inside the compiled Bun binary via
 * text imports. In dev (`bun src/main.ts` from the repo root) they resolve
 * to the checked-in copies at build/start time. In a packaged binary they're
 * baked-in string constants — no source tree required.
 */
export const EMBEDDED_DEFAULTS = {
  SOUL: EMBEDDED_SOUL_MD,
  SOLRAC: EMBEDDED_SOLRAC_MD,
} as const;

/**
 * Sentinel string the shipped SOLRAC.md template carries on its first line,
 * inside a standalone HTML comment. The operator activates their overlay by
 * deleting that comment line.
 *
 * Match is line-anchored against `UNEDITED_MARKER_LINE_RE`: only a line that
 * is *exclusively* the marker comment (modulo whitespace) suppresses the
 * overlay. An operator who legitimately mentions the string `solrac-md:unedited`
 * inside their own content (e.g., self-documenting comments referencing the
 * activation flag) does NOT accidentally suppress their own file.
 */
export const SOLRAC_MD_UNEDITED_MARKER = "solrac-md:unedited";

const UNEDITED_MARKER_LINE_RE =
  /^[ \t]*<!--[ \t]*solrac-md:unedited\b[^>]*-->[ \t]*$/m;

export interface BootstrapResult {
  soulCreated: boolean;
  solracCreated: boolean;
  /**
   * True when an existing SOUL.md differs from the embedded default and we
   * wrote SOUL.md.new alongside. Operator can diff/merge manually so a binary
   * upgrade can ship a new default voice without clobbering operator edits.
   */
  soulNewWritten: boolean;
}

/**
 * If `home` lacks SOUL.md or SOLRAC.md, write the embedded default. Idempotent
 * — existing files are never overwritten. If an existing SOUL.md disagrees
 * with the embedded default, write `SOUL.md.new` alongside (skipping if one
 * already exists, so a pending operator merge isn't clobbered on every boot).
 *
 * SOLRAC.md does not get a `.new` because the shipped default is intentionally
 * a near-empty operator-overlay template — diverging is the point.
 *
 * `home` is created (recursive) if missing — packaged binary first run on a
 * machine without `~/.solrac/` shouldn't need a separate mkdir step.
 */
export function bootstrapInstanceFiles(home: string): BootstrapResult {
  const result: BootstrapResult = {
    soulCreated: false,
    solracCreated: false,
    soulNewWritten: false,
  };
  mkdirSync(home, { recursive: true });

  const soulDest = join(home, INSTANCE_FILE_NAMES.SOUL);
  if (!existsSync(soulDest)) {
    writeFileSync(soulDest, EMBEDDED_DEFAULTS.SOUL, "utf8");
    result.soulCreated = true;
  } else {
    const onDisk = readFileSync(soulDest, "utf8");
    if (onDisk !== EMBEDDED_DEFAULTS.SOUL) {
      const newPath = `${soulDest}.new`;
      if (!existsSync(newPath)) {
        writeFileSync(newPath, EMBEDDED_DEFAULTS.SOUL, "utf8");
        result.soulNewWritten = true;
      }
    }
  }

  const solracDest = join(home, INSTANCE_FILE_NAMES.SOLRAC);
  if (!existsSync(solracDest)) {
    writeFileSync(solracDest, EMBEDDED_DEFAULTS.SOLRAC, "utf8");
    result.solracCreated = true;
  }

  return result;
}

/**
 * Read SOUL.md from `home`. Hard-fails if the file is missing, unreadable, or
 * empty after trimming. Solrac without identity is broken — boot should die
 * loudly rather than silently fall back to a default.
 */
export function loadSoul(home: string): string {
  const path = join(home, INSTANCE_FILE_NAMES.SOUL);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`SOUL.md not found at ${path}: ${(err as Error).message}`);
  }
  const text = raw.trim();
  if (text === "") {
    throw new Error(`SOUL.md at ${path} is empty`);
  }
  return text;
}

/**
 * Read SOLRAC.md from `path`. Returns:
 *   - `null` if the file doesn't exist or is unreadable.
 *   - `null` if any line is exclusively the unedited-marker HTML comment (the
 *     shipped template carries it; operator deletes the marker line to
 *     activate the overlay).
 *   - `null` if the file's non-comment content is empty after trimming.
 *   - the trimmed content with HTML comments stripped, otherwise.
 *
 * HTML comments are stripped from the returned content too, so the operator
 * can leave private notes in `<!-- ... -->` blocks without sending them to
 * the model.
 *
 * Why a line-anchored marker check (vs. substring): a self-documenting
 * SOLRAC.md may reference the literal string `solrac-md:unedited` in its own
 * content (e.g., "the marker we look for is solrac-md:unedited"). A substring
 * check would silently suppress that file even after the real marker line was
 * deleted. The line-anchored regex requires the comment to stand alone.
 */
export function readInstanceMd(path: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  if (UNEDITED_MARKER_LINE_RE.test(raw)) return null;
  const stripped = raw.replace(/<!--[\s\S]*?-->/g, "").trim();
  if (stripped === "") return null;
  return stripped;
}

/** `join(home, "SOLRAC.md")` — kept here so callers don't repeat the constant. */
export function instanceMdPath(home: string): string {
  return join(home, INSTANCE_FILE_NAMES.SOLRAC);
}

/**
 * Wrap an instance-md body in the labeled block consumed by both engines.
 * Centralized here so the wrapping format is identical across paths and
 * tests can assert on a single shape.
 */
export function wrapInstanceMd(body: string): string {
  return `<solrac-md>\n${body}\n</solrac-md>`;
}

/**
 * Convenience: log the bootstrap outcome. Called from `main.ts` after
 * `bootstrapInstanceFiles` so the first-run operator sees the new files
 * appear in their home dir. Subsequent boots log nothing (idempotent) unless
 * a SOUL.md.new was emitted by an upgrade-on-modified-file diff.
 */
export function logBootstrapResult(home: string, r: BootstrapResult): void {
  if (r.soulCreated) {
    log.info("instance.soul_md_created", { path: join(home, INSTANCE_FILE_NAMES.SOUL) });
  }
  if (r.solracCreated) {
    log.info("instance.solrac_md_created", { path: join(home, INSTANCE_FILE_NAMES.SOLRAC) });
  }
  if (r.soulNewWritten) {
    log.warn("instance.soul_md_new_written", {
      path: `${join(home, INSTANCE_FILE_NAMES.SOUL)}.new`,
      hint: "embedded SOUL.md default differs from your edited copy; diff/merge SOUL.md.new into SOUL.md to pick up the new default voice, or delete SOUL.md.new to ignore",
    });
  }
}
