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
 *     `systemPrompt.append` and Ollama's first `system` message. Per-engine
 *     capability deltas ("you have tools" / "you don't") stay in code next to
 *     each engine's wiring (see `agent.ts::buildClaudeCapabilityNote` and
 *     `ollama.ts::buildOllamaCapabilityNote`) so SOUL.md stays portable.
 *
 *   - `SOLRAC.md` — operator overlay (operator name, channel posture, project
 *     hints). Re-read per turn via `readInstanceMd` so live edits take effect
 *     without restart. Soft-warn if missing — Solrac runs vanilla without it.
 *     Injected as a `<solrac-md>...</solrac-md>` block in the user-message
 *     envelope (Claude path: prepended in `buildAugmentedPrompt`; Ollama path:
 *     a second `system` message).
 *
 * Both files ship in the package root (the repo root) as canonical defaults.
 * On boot, if the runtime cwd lacks them, `bootstrapInstanceFiles` copies the
 * defaults into cwd so the operator has a customizable copy. Reads thereafter
 * always come from cwd; the package copies are a one-time seed.
 *
 * Why bootstrap into cwd instead of always reading from the package:
 *   The whole point of externalization is operator customization. If we read
 *   from the package install dir, edits get clobbered on update. Bootstrap
 *   once into cwd, read from cwd onwards.
 *
 * Position in the dependency graph:
 *   log → instance → consumed by main, agent, ollama
 *
 * Exports:
 *   - `INSTANCE_FILE_NAMES` — `{ SOUL: "SOUL.md", SOLRAC: "SOLRAC.md" }`.
 *   - `packageDir()` — resolves the package root (where canonical defaults live).
 *   - `bootstrapInstanceFiles(cwd, pkgDir)` — copy missing files from pkgDir → cwd.
 *   - `loadSoul(cwd)` — read SOUL.md once; throws on missing/empty.
 *   - `readInstanceMd(path)` — read SOLRAC.md per turn; null if missing or
 *     comment-only (unedited template).
 *   - `instanceMdPath(cwd)` — `join(cwd, "SOLRAC.md")` helper.
 *
 * Key invariants:
 *   - `loadSoul` is the only hard-fail path. SOLRAC.md missing or empty is
 *     ALWAYS a soft-warn; the operator may not want a per-instance overlay.
 *   - `readInstanceMd` strips HTML comments before checking emptiness AND
 *     before returning content. The shipped SOLRAC.md template is all
 *     comments — that means a fresh install injects nothing until the
 *     operator edits real content into the file.
 *   - Bootstrap is idempotent. An existing file in cwd is never overwritten,
 *     so repeated boots don't clobber operator edits.
 *
 * Cross-references:
 *   - SOUL.md — canonical default voice
 *   - SOLRAC.md — operator overlay template
 *   - agent.ts::runAgent — Claude path consumer
 *   - ollama.ts::runOllamaTurn — Ollama path consumer
 *   - main.ts — boot wires bootstrap + load
 */

import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./log.ts";

export const INSTANCE_FILE_NAMES = {
  SOUL: "SOUL.md",
  SOLRAC: "SOLRAC.md",
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

/**
 * Matches a line that contains *only* the unedited-marker HTML comment, with
 * any leading/trailing whitespace. The body of the comment may include extra
 * descriptive text after the marker (e.g., "— delete this line to activate")
 * but must NOT contain `>` characters before the closing `-->` (so other HTML
 * comments on the same line don't false-match).
 */
const UNEDITED_MARKER_LINE_RE =
  /^[ \t]*<!--[ \t]*solrac-md:unedited\b[^>]*-->[ \t]*$/m;

/**
 * Resolve the package directory (where the canonical SOUL.md and SOLRAC.md
 * default copies live). In dev: `src/instance.ts` → the repo root. The
 * function is called once at boot from `main.ts`; nothing in the hot path
 * depends on it.
 *
 * TODO(solrac-bun-packaging): when Solrac ships as a single-file Bun bundle,
 * `import.meta.url` resolves into the bundle's virtual filesystem and the
 * `../..` traversal no longer points at a directory containing SOUL.md /
 * SOLRAC.md. The deferred packaging effort needs to either embed the defaults
 * via `with { type: "text" }` imports or ship sidecar resource files keyed by
 * `dirname(process.execPath)` / `$SOLRAC_PACKAGE_DIR`. Failure mode today is
 * loud — `loadSoul` throws on boot — but the next person on this surface
 * should grep for this TODO before refactoring.
 * See: https://www.notion.so/357a52efd130810cb587d2db8d234c58
 */
export function packageDir(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

export interface BootstrapResult {
  soulCreated: boolean;
  solracCreated: boolean;
}

/**
 * If `cwd` lacks SOUL.md or SOLRAC.md, copy the canonical default from
 * `pkgDir`. Idempotent — existing files are never touched. Caller is expected
 * to log the result so first-run users see what happened.
 */
export function bootstrapInstanceFiles(cwd: string, pkgDir: string): BootstrapResult {
  const result: BootstrapResult = { soulCreated: false, solracCreated: false };
  const targets = [
    { name: INSTANCE_FILE_NAMES.SOUL, key: "soulCreated" as const },
    { name: INSTANCE_FILE_NAMES.SOLRAC, key: "solracCreated" as const },
  ];
  for (const t of targets) {
    const dest = join(cwd, t.name);
    if (existsSync(dest)) continue;
    const src = join(pkgDir, t.name);
    if (!existsSync(src)) {
      // Package template missing. SOUL.md absence is fatal but surfaces later
      // via `loadSoul`; SOLRAC.md absence is fine (soft-warn).
      continue;
    }
    copyFileSync(src, dest);
    result[t.key] = true;
  }
  return result;
}

/**
 * Read SOUL.md from `cwd`. Hard-fails if the file is missing, unreadable, or
 * empty after trimming. Solrac without identity is broken — boot should die
 * loudly rather than silently fall back to a default.
 */
export function loadSoul(cwd: string): string {
  const path = join(cwd, INSTANCE_FILE_NAMES.SOUL);
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

/** `join(cwd, "SOLRAC.md")` — kept here so callers don't repeat the constant. */
export function instanceMdPath(cwd: string): string {
  return join(cwd, INSTANCE_FILE_NAMES.SOLRAC);
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
 * appear in their cwd. Subsequent boots log nothing (idempotent).
 */
export function logBootstrapResult(cwd: string, r: BootstrapResult): void {
  if (r.soulCreated) {
    log.info("instance.soul_md_created", { path: join(cwd, INSTANCE_FILE_NAMES.SOUL) });
  }
  if (r.solracCreated) {
    log.info("instance.solrac_md_created", { path: join(cwd, INSTANCE_FILE_NAMES.SOLRAC) });
  }
}
