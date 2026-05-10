#!/bin/sh
# solrac install script
# ---------------------
# Detects platform, downloads the matching binary tarball from GitHub
# Releases, verifies the SHA256, extracts to ~/.solrac/bin/solrac, and
# (optionally) symlinks /usr/local/bin/solrac → ~/.solrac/bin/solrac.
#
# Usage (preferred):
#   curl -fsSL https://cjus.dev/solrac/install.sh | sh
#
# Env overrides (mostly for testing):
#   SOLRAC_RELEASE_URL_BASE   default https://github.com/cjus/solrac/releases/latest/download
#   SOLRAC_VERSION            default "latest" — pin a tag (e.g. v0.3.0) for reproducible installs
#   SOLRAC_HOME               default ~/.solrac
#   SOLRAC_NO_SYMLINK         if non-empty, skip the /usr/local/bin/solrac symlink step
#
# IMPORTANT: install.sh ONLY writes the binary. SOUL.md, SOLRAC.md, .env, and
# the data/ directory are written by the binary itself on first boot — so
# rerunning this script never clobbers operator customizations.

set -eu

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

log()  { printf 'solrac-install: %s\n' "$*"; }
warn() { printf 'solrac-install: warn: %s\n' "$*" >&2; }
die()  { printf 'solrac-install: error: %s\n' "$*" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

# Pick the first available SHA256 tool; install.sh has to run on stock macOS
# (which ships shasum) and most Linux (which ship sha256sum).
sha256_of() {
  if have sha256sum; then sha256sum "$1" | awk '{print $1}'
  elif have shasum; then shasum -a 256 "$1" | awk '{print $1}'
  else die "neither sha256sum nor shasum found — cannot verify download"
  fi
}

# ---------------------------------------------------------------------------
# Platform detection
# ---------------------------------------------------------------------------

detect_target() {
  uname_s=$(uname -s)
  uname_m=$(uname -m)
  case "$uname_s" in
    Darwin)
      case "$uname_m" in
        arm64|aarch64) echo "darwin-arm64" ;;
        x86_64)        echo "darwin-x64" ;;
        *) die "unsupported macOS arch: $uname_m" ;;
      esac
      ;;
    Linux)
      case "$uname_m" in
        x86_64)        echo "linux-x64" ;;
        aarch64|arm64) echo "linux-arm64" ;;
        *) die "unsupported Linux arch: $uname_m" ;;
      esac
      ;;
    *) die "unsupported OS: $uname_s (solrac ships darwin and linux binaries only)" ;;
  esac
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

TARGET=$(detect_target)
URL_BASE="${SOLRAC_RELEASE_URL_BASE:-https://github.com/cjus/solrac/releases/latest/download}"
VERSION="${SOLRAC_VERSION:-latest}"
if [ "$VERSION" != "latest" ] && [ -z "${SOLRAC_RELEASE_URL_BASE:-}" ]; then
  # Pin to a tagged release when SOLRAC_VERSION is set explicitly. Skip when
  # the operator overrode the URL base (custom mirror) — they own the URL.
  URL_BASE="https://github.com/cjus/solrac/releases/download/${VERSION}"
fi

TARBALL="solrac-${TARGET}.tar.gz"
SHA_FILE="${TARBALL}.sha256"
TARBALL_URL="${URL_BASE}/${TARBALL}"
SHA_URL="${URL_BASE}/${SHA_FILE}"

HOME_DIR="${SOLRAC_HOME:-$HOME/.solrac}"
BIN_DIR="${HOME_DIR}/bin"
BIN_PATH="${BIN_DIR}/solrac"

log "target=${TARGET}"
log "version=${VERSION}"
log "from=${URL_BASE}"
log "into=${HOME_DIR}"

if ! have curl; then die "curl is required (apt/brew install curl)"; fi
if ! have tar; then die "tar is required"; fi

mkdir -p "$BIN_DIR"

TMP=$(mktemp -d 2>/dev/null || mktemp -d -t solrac-install)
# shellcheck disable=SC2064
trap "rm -rf '$TMP'" EXIT INT TERM

log "downloading $TARBALL"
curl -fsSL --retry 3 --retry-delay 2 -o "${TMP}/${TARBALL}" "$TARBALL_URL" \
  || die "download failed: $TARBALL_URL"

log "downloading $SHA_FILE"
if curl -fsSL --retry 3 --retry-delay 2 -o "${TMP}/${SHA_FILE}" "$SHA_URL"; then
  expected=$(awk '{print $1}' "${TMP}/${SHA_FILE}")
  actual=$(sha256_of "${TMP}/${TARBALL}")
  if [ "$expected" != "$actual" ]; then
    die "sha256 mismatch: expected $expected, got $actual"
  fi
  log "sha256 verified: $actual"
else
  warn "sha256 sidecar not available — skipping verification (set SOLRAC_RELEASE_URL_BASE to a release that publishes ${SHA_FILE} to enable)"
fi

log "extracting to $BIN_DIR"
# Tarball ships a single file named `solrac` (build.ts renames during pack).
tar -xzf "${TMP}/${TARBALL}" -C "$BIN_DIR"
chmod +x "$BIN_PATH"

if [ ! -x "$BIN_PATH" ]; then
  die "extraction did not produce an executable at $BIN_PATH"
fi

# ---------------------------------------------------------------------------
# /usr/local/bin/solrac symlink (best effort)
# ---------------------------------------------------------------------------

if [ -z "${SOLRAC_NO_SYMLINK:-}" ]; then
  link_target="/usr/local/bin/solrac"
  link_dir=$(dirname "$link_target")
  if [ -w "$link_dir" ]; then
    ln -sf "$BIN_PATH" "$link_target"
    log "symlinked $link_target → $BIN_PATH"
  elif have sudo; then
    log "creating $link_target via sudo (you may be prompted for your password)"
    if sudo ln -sf "$BIN_PATH" "$link_target"; then
      log "symlinked $link_target → $BIN_PATH"
    else
      warn "sudo symlink failed — add ${BIN_DIR} to PATH manually"
    fi
  else
    warn "$link_dir is not writable and sudo is not available"
    warn "add this line to your shell rc (~/.zshrc, ~/.bashrc) to put solrac on PATH:"
    warn "    export PATH=\"${BIN_DIR}:\$PATH\""
  fi
fi

# ---------------------------------------------------------------------------
# First-run guidance
# ---------------------------------------------------------------------------

cat <<EOF

solrac installed.

  binary:  $BIN_PATH
  home:    $HOME_DIR

next steps:
  1. ensure the \`claude\` CLI is on PATH (solrac shells out to it for the @ and ! tiers).
     check with: which claude
     install:    https://docs.claude.com/en/docs/claude-code (or your local equivalent)

  2. create $HOME_DIR/.env with at least:
       ANTHROPIC_API_KEY=sk-ant-...
       TELEGRAM_BOT_TOKEN=...
       ALLOWLIST_BOOTSTRAP=<your telegram from.id>

  3. run \`solrac\`. SOUL.md, SOLRAC.md, and data/ will appear in $HOME_DIR
     on first boot. edits to SOUL.md/SOLRAC.md survive future reinstalls of
     this script — only the binary at $BIN_PATH is replaced on update.

reinstall:  \`curl -fsSL https://cjus.dev/solrac/install.sh | sh\`
uninstall:  \`rm -rf $HOME_DIR /usr/local/bin/solrac\`
EOF
