# Installing Solrac

There are two ways to run Solrac: install the **packaged binary** (recommended for operators) or run from a **git checkout** (recommended for developers and contributors).

## Quick install — packaged binary

Single command, on macOS or Linux:

```sh
curl -fsSL https://cjus.dev/solrac/install.sh | sh
```

What it does, step by step:

1. Detects your platform via `uname` (`darwin-arm64`, `darwin-x64`, `linux-x64`, or `linux-arm64`). Refuses anything else.
2. Downloads the matching `solrac-<target>.tar.gz` from GitHub Releases.
3. Verifies the SHA256 against the published `solrac-<target>.tar.gz.sha256` sidecar.
4. Extracts the binary to `~/.solrac/bin/solrac` and sets it executable.
5. Creates a symlink at `/usr/local/bin/solrac` so the binary is on your PATH (uses `sudo` if `/usr/local/bin` isn't writable; falls back to a "add `~/.solrac/bin` to PATH" hint if you decline).

Verify:

```sh
which solrac        # /usr/local/bin/solrac
solrac --version    # not yet implemented; for now `solrac` boots into help/exit on missing config
```

### What it does NOT do

`install.sh` writes only the binary. It never touches `~/.solrac/SOUL.md`, `~/.solrac/SOLRAC.md`, `~/.solrac/.env`, or `~/.solrac/data/`. **Reinstalling is safe** — your operator-customized files are not touched.

## First boot

The packaged binary uses `~/.solrac/` as its data home (override with `SOLRAC_HOME`). On first boot the binary writes:

| File | Source | Behavior |
|------|--------|----------|
| `~/.solrac/SOUL.md` | embedded canonical default (text-imported into the binary) | written if missing; never overwritten |
| `~/.solrac/SOLRAC.md` | embedded operator-overlay template (carries the `solrac-md:unedited` marker) | written if missing; never overwritten |
| `~/.solrac/data/` | (mkdir) | sqlite db, WAL, PID file, per-chat workspaces |

You also need to create your `.env` before the first boot:

```sh
$EDITOR ~/.solrac/.env
```

Minimum required values:

```ini
ANTHROPIC_API_KEY=sk-ant-...
TELEGRAM_BOT_TOKEN=123456:abc...
ALLOWLIST_BOOTSTRAP=<your numeric Telegram from.id>
```

See [`docs/CONFIG.md`](./CONFIG.md) for the full env reference and [`docs/SETUP.md`](./SETUP.md) for help getting a bot token and finding your `from.id`.

Then run:

```sh
solrac
```

You should see structured JSON log lines on stdout. DM your bot — the first message should produce a 🤔 / 💻 / 🙂 thinking stub within a second.

## CLI subcommands

The binary supports a small set of subcommands beyond the default server boot:

| Command | Purpose |
|---------|---------|
| `solrac` | Boot the server (default). |
| `solrac gmail-auth <alias>` | One-time OAuth bootstrap for a Gmail account. Opens the browser, captures the redirect, and writes tokens to `$SOLRAC_HOME/integrations/gmail/<alias>.json`. See [`docs/USAGE.md`](./USAGE.md) → Gmail integration for the full setup. |

Subcommands do **not** require `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, or `ALLOWLIST_BOOTSTRAP` to be set — they run before solrac's full env validation, so a fresh install can authenticate Gmail accounts before configuring the bot.

## Upgrading

Just rerun the install command:

```sh
curl -fsSL https://cjus.dev/solrac/install.sh | sh
```

The binary is replaced. Your `SOUL.md`, `SOLRAC.md`, `.env`, and `data/` are not touched.

If a new release ships a different default `SOUL.md` than the one currently on disk, the binary detects the divergence on next boot and writes `~/.solrac/SOUL.md.new` alongside your customized copy. Diff/merge manually:

```sh
diff ~/.solrac/SOUL.md ~/.solrac/SOUL.md.new
# merge the bits you want, then:
rm ~/.solrac/SOUL.md.new
```

`SOLRAC.md` does NOT get a `.new` companion — it's an operator-overlay template by design, so divergence is the point.

## Pinning a version

By default the install script grabs `latest` from GitHub Releases. To pin:

```sh
curl -fsSL https://cjus.dev/solrac/install.sh | SOLRAC_VERSION=v0.3.0 sh
```

Reproducible installs are the recommended default for production hosts. Bump the version deliberately, on a schedule.

## Uninstall

```sh
rm -rf ~/.solrac /usr/local/bin/solrac
```

That's everything — Solrac stores no state outside `~/.solrac/`.

## Operational dependencies (not embedded in the binary)

- **`claude` CLI** must be on PATH for the `@` (primary) and `!` (secondary) Claude tiers. Solrac shells out to it via the Anthropic Agent SDK. The binary does not embed Anthropic's CLI.
- **Local-model backend** must be reachable on `LOCAL_URL` for the no-prefix default-engine path. `LOCAL_BACKEND=ollama` (default port `:11434`, NDJSON `/api/chat`) or `LOCAL_BACKEND=lmstudio` (default port `:1234`, SSE `/v1/chat/completions`). With `LOCAL_ENABLED=false` you can skip the backend entirely; set `SOLRAC_DEFAULT_ENGINE=primary` to make Sonnet the no-prefix default.

## Supported platforms

| Target | Binary id |
|--------|-----------|
| macOS Apple Silicon | `solrac-darwin-arm64` |
| macOS Intel | `solrac-darwin-x64` |
| Linux x86_64 | `solrac-linux-x64` |
| Linux aarch64 | `solrac-linux-arm64` |

Other platforms must run from a git checkout.

## Running from a git checkout (developers)

```sh
git clone https://github.com/cjus/solrac.git
cd solrac
npm install
cp .env.example .env
$EDITOR .env
npm run dev
```

The dev workflow auto-detects the source tree: `SOLRAC_HOME` defaults to the repo root because `SOUL.md` is checked in there. Data lands at `solrac/data/` (gitignored). No `~/.solrac/` is created.

## Building binaries locally

```sh
npm run build:bin                   # all four targets
bun scripts/build.ts darwin-arm64   # one target
```

Output lands in `dist/`:

```
dist/
├── solrac-darwin-arm64                   # raw binary
├── solrac-darwin-arm64.tar.gz            # packed for distribution
└── solrac-darwin-arm64.tar.gz.sha256     # verification sidecar
```

To smoke-test a freshly-built binary in isolation:

```sh
SOLRAC_HOME=/tmp/solrac-test ./dist/solrac-darwin-arm64
```

`bun build --compile` snapshots the Bun runtime that ran the build — your local Bun version becomes the binary's effective runtime. CI-published releases use a pinned Bun (see `bun-version` in `.github/workflows/release.yml`).

## Cutting a release (maintainers)

Releases are tag-triggered; merge-to-main does NOT publish. The workflow lives at `.github/workflows/release.yml` and runs entirely on a single Linux runner — Bun cross-compiles all four targets without a per-OS matrix.

```sh
# from a clean main with the version bumped in package.json:
git tag v0.3.0
git push --tags
```

CI then:
1. Runs `npm run typecheck` + `bun test` (don't ship a broken binary).
2. Builds `dist/solrac-{darwin-arm64,darwin-x64,linux-x64,linux-arm64}.tar.gz` plus matching `.sha256` sidecars.
3. Creates a GitHub Release named after the tag with auto-generated notes from the commit log.

Once the release is published, `https://github.com/cjus/solrac/releases/latest/download/solrac-<target>.tar.gz` resolves to the new tarballs and `curl -fsSL https://cjus.dev/solrac/install.sh | sh` immediately picks them up.

To pin a specific Bun version for the release runtime, edit `bun-version` in `.github/workflows/release.yml`. Keep it in sync with `bun-types` in `package.json` so the dev test surface and the released binary share a runtime.
