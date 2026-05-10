/**
 * @fileoverview Cross-target Bun-compile build script for the Solrac binary.
 * @purpose Produce one self-contained executable per target platform plus a
 *          gzipped tarball with a SHA256 sum so install.sh can verify the
 *          download. Targets are pinned in `TARGETS` below.
 *
 * Usage:
 *   bun scripts/build.ts                     # all four targets (default)
 *   bun scripts/build.ts darwin-arm64        # one specific target
 *   bun scripts/build.ts darwin-arm64 linux-x64
 *
 * Output:
 *   dist/solrac-<target>                     # raw binary (chmod +x by Bun)
 *   dist/solrac-<target>.tar.gz              # tarball (binary renamed to `solrac`)
 *   dist/solrac-<target>.tar.gz.sha256       # `<sha256>  solrac-<target>.tar.gz` line
 *
 * `bun build --compile` snapshots the Bun runtime that ran this script — the
 * binary's effective Bun version equals whichever Bun built it. CI release
 * pipelines should pin a known Bun via `engines.bun` + uses-actions/setup-bun.
 *
 * Cross-references:
 *   - install.sh — consumes the tarball + sha256 from a release URL
 *   - docs/INSTALL.md — operator-facing install reference
 *   - PNX-168 — the packaging ticket
 */

import { $ } from "bun";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";

interface Target {
  /** External name, also used in the tarball filename (`solrac-<id>.tar.gz`). */
  readonly id: string;
  /** Bun's `--target` value. */
  readonly bunTarget: string;
}

const TARGETS: ReadonlyArray<Target> = [
  { id: "darwin-arm64", bunTarget: "bun-darwin-arm64" },
  { id: "darwin-x64", bunTarget: "bun-darwin-x64" },
  { id: "linux-x64", bunTarget: "bun-linux-x64" },
  { id: "linux-arm64", bunTarget: "bun-linux-arm64" },
];

const REPO_ROOT = resolve(dirname(import.meta.dir));
const ENTRY = join(REPO_ROOT, "src", "main.ts");
const DIST = join(REPO_ROOT, "dist");

function selectedTargets(args: ReadonlyArray<string>): ReadonlyArray<Target> {
  if (args.length === 0) return TARGETS;
  const known = new Map(TARGETS.map((t) => [t.id, t]));
  const out: Target[] = [];
  for (const a of args) {
    const t = known.get(a);
    if (!t) {
      console.error(
        `unknown target: ${a}\nknown: ${TARGETS.map((x) => x.id).join(", ")}`,
      );
      process.exit(2);
    }
    out.push(t);
  }
  return out;
}

async function buildOne(t: Target): Promise<{ binary: string; tarball: string; sha: string }> {
  const binaryPath = join(DIST, `solrac-${t.id}`);
  const tarballPath = `${binaryPath}.tar.gz`;
  const shaSidecarPath = `${tarballPath}.sha256`;

  console.log(`==> building ${t.id}`);

  // `bun build --compile` produces a single executable that contains the Bun
  // runtime plus the bundled JS. `--minify` shrinks the JS payload; the Bun
  // runtime portion stays the same size.
  await $`bun build --compile --minify --target=${t.bunTarget} --outfile=${binaryPath} ${ENTRY}`;

  const sizeMb = (statSync(binaryPath).size / 1024 / 1024).toFixed(1);

  // Tarball with the binary renamed to `solrac` so install.sh extracts a
  // predictable filename regardless of which platform it's installing.
  // Use --transform so the on-disk name (e.g. solrac-darwin-arm64) becomes
  // `solrac` inside the archive without an intermediate copy step.
  await $`tar -czf ${tarballPath} -C ${DIST} --transform=s,^solrac-${t.id}$,solrac, solrac-${t.id}`;

  const sha = createHash("sha256").update(readFileSync(tarballPath)).digest("hex");
  const tarballName = `solrac-${t.id}.tar.gz`;
  await Bun.write(shaSidecarPath, `${sha}  ${tarballName}\n`);

  const tarSizeMb = (statSync(tarballPath).size / 1024 / 1024).toFixed(1);
  console.log(`    binary  ${sizeMb} MiB  ${binaryPath}`);
  console.log(`    tarball ${tarSizeMb} MiB  ${tarballPath}`);
  console.log(`    sha256  ${sha}`);

  return { binary: binaryPath, tarball: tarballPath, sha };
}

async function main(): Promise<void> {
  const targets = selectedTargets(process.argv.slice(2));

  // Fresh dist/ each run so a removed target from a prior build doesn't ship.
  if (existsSync(DIST)) rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });

  const results: Array<{ target: Target; sha: string; tarball: string }> = [];
  for (const t of targets) {
    const r = await buildOne(t);
    results.push({ target: t, sha: r.sha, tarball: r.tarball });
  }

  console.log("");
  console.log("SHA256 summary (paste into the release notes):");
  for (const r of results) {
    console.log(`  ${r.sha}  solrac-${r.target.id}.tar.gz`);
  }
}

await main();
