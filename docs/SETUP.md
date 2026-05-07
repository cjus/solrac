# Setup

Getting Solrac running from a fresh clone to a Telegram bot replying on your machine.

Total time: ~20 minutes if you don't already have a Telegram bot or Anthropic API key. ~5 minutes if you do.

## 1. Prerequisites

| Tool | Version | Why |
|------|---------|-----|
| **Bun** | ≥1.3.0 | Runtime. Solrac uses `Bun.serve`, `Bun.write`, `bun:sqlite`, `bun:test`. Required — there is no Node fallback. |
| **npm** | bundled with Node | Package manager. The repo's lockfile is `package-lock.json`. |
| **Node** | ≥18 (only for npm and TypeScript tooling) | npm and TypeScript run on Node; the runtime itself is Bun. |
| **A POSIX shell** | bash/zsh | systemd deploy steps assume Linux; dev works on macOS too. |

### Install Bun

macOS / Linux:

```sh
curl -fsSL https://bun.sh/install | bash
bun --version   # should be ≥1.3.0
```

### Install dependencies

```sh
git clone https://github.com/cjus/solrac.git
cd solrac
npm install
```

## 2. Create a Telegram bot

Solrac expects a dedicated bot token. Don't reuse a personal-account bot — Telegram limits per-bot rate; sharing creates contention.

1. Open a chat with [@BotFather](https://t.me/BotFather) in Telegram.
2. Send `/newbot`.
3. Pick a display name (e.g. `Solrac Dev`).
4. Pick a username ending in `bot` (e.g. `solrac_dev_bot` — must be unique on Telegram).
5. BotFather replies with an HTTP API token (`8123456789:AA…`). **This is `TELEGRAM_BOT_TOKEN`.** Treat it like a password.

Recommended bot settings (set via BotFather → `/mybots` → your bot → "Bot Settings"):

- **Allow Groups?** → Disable. Solrac is designed for DMs in v1; group support is untested.
- **Group Privacy** → Enable (only matters if you reverse the previous step).
- **Inline Mode** → Disable (Solrac doesn't use inline queries).

For production, mint a separate bot (`@solrac_prod_bot`) with the same procedure. Switching is an env flip; no code changes.

## 3. Find your Telegram `from.id`

The allowlist gates on user id, not chat id (so group forwards still resolve to the actual sender). To find yours:

1. DM [@userinfobot](https://t.me/userinfobot).
2. It replies with your `Id`. That number is your `from.id`. **This is `ALLOWLIST_BOOTSTRAP`** (or one entry of a comma-separated list).

## 4. Mint an Anthropic API key

Use a **scoped** key — not your account-level key. If a tool call leaks env (it shouldn't, but defense-in-depth), revoking a scoped key can't break unrelated services.

1. Go to https://console.anthropic.com/settings/keys.
2. **Create Key** → name it `solrac-dev` (or `solrac-prod`).
3. Copy the value. **This is `ANTHROPIC_API_KEY`.**

Solrac authenticates via `ANTHROPIC_API_KEY` only. Bedrock and Vertex auth are explicit anti-goals in v1 (see [ARCHITECTURE.md](./ARCHITECTURE.md#anti-goals)).

## 5. Write your `.env`

Copy the template:

```sh
cp .env.example .env
```

Open `.env` and fill in the three required values:

```sh
ANTHROPIC_API_KEY=sk-ant-…             # from step 4
TELEGRAM_BOT_TOKEN=8123456789:AA…      # from step 2
ALLOWLIST_BOOTSTRAP=123456789           # from step 3 (your from.id)
```

Defaults are fine for local dev. Full reference: [CONFIG.md](./CONFIG.md).

`.gitignore` excludes `.env`. Don't commit it.

## 6. First boot

From the repo root:

```sh
npm run dev
```

You should see structured logs:

```json
{"level":"info","msg":"instance.soul_md_created","path":"…/SOUL.md"}
{"level":"info","msg":"instance.solrac_md_created","path":"…/SOLRAC.md"}
{"level":"info","msg":"solrac.boot","transport":"poll",…}
{"level":"info","msg":"db.opened","dbPath":"./data/solrac.sqlite"}
{"level":"info","msg":"server.listening","port":8443,"statsEnabled":false}
{"level":"info","msg":"pidfile.acquired","pidPath":"./data/solrac.pid","pid":12345}
{"level":"info","msg":"poll.start","offset":0,"resumed":false}
```

If `solrac.boot` doesn't appear, the validator caught an env problem — read the `config.invalid` line for the exact key.

The `instance.soul_md_created` / `instance.solrac_md_created` lines appear only on first boot. They mean Solrac copied its canonical `SOUL.md` (voice + safety) and `SOLRAC.md` (operator overlay template) into your launch directory so you can customize them. Subsequent boots skip the copy and log nothing for those files. Open both in your editor when you have a minute — the [USAGE.md "Customizing Solrac" section](./USAGE.md#customizing-solrac-soulmd-and-solracmd) explains what each one is for. You don't need to edit them to use Solrac; the defaults work.

In another terminal, hit `/health`:

```sh
curl http://localhost:8443/health
# → {"ok":true,"uptime":3.421}
```

## 7. Smoke-test on Telegram

Open a DM with your bot in Telegram and send any message — e.g. `what time is it?`.

Expected behavior:

1. Within ~1 second, the bot edits a `🤔 thinking…` placeholder.
2. As the agent runs, the placeholder edits with progress (tool name, partial output).
3. Final state is the same message, edited to the answer + `<i>✅ N turns · $0.0XXX</i>` footer.

If a tool call requires confirmation (e.g. `git status` is auto-allowed; `Write file.txt` triggers a prompt), an inline keyboard appears with `✅ Allow` / `❌ Deny`. See [USAGE.md](./USAGE.md#permission-ux) for the full picture.

## 8. Verify the audit trail

Quick check: every turn writes a row to the `audit` table.

```sh
sqlite3 data/solrac.sqlite \
  "SELECT id, chat_id, status, cost_usd, started_at FROM audit ORDER BY id DESC LIMIT 5"
```

For deeper queries, see [OPERATIONS.md](./OPERATIONS.md#audit-queries).

## 9. (Optional) Enable `/stats`

To enable the `/stats` endpoint, set:

```sh
STATS_BEARER_TOKEN=$(openssl rand -hex 32)
```

Restart Solrac. Then:

```sh
curl -H "Authorization: Bearer $STATS_BEARER_TOKEN" http://localhost:8443/stats
```

You'll get RSS, uptime, in-flight turn counts, and 24h spend.

## 10. (Optional) Enable local-Ollama routing

Solrac can route Telegram messages prefixed with `>` to a local [Ollama](https://ollama.com) instance instead of Claude. Useful for cheap/offline chat and prompts you want to keep on the box. The feature is off by default; turning it on is two env-var flips.

1. Install Ollama on the host: `brew install ollama` (macOS) or `curl -fsSL https://ollama.com/install.sh | sh` (Linux).
2. Start the daemon (typically auto-started; otherwise `ollama serve &`).
3. Pull a model: `ollama pull llama3.2` (or `qwen2.5`, `gemma4:e4b`, etc.).
4. Add to `.env`:

   ```sh
   OLLAMA_ENABLED=true
   OLLAMA_MODEL=llama3.2          # exact name from `ollama list`
   # OLLAMA_URL=http://localhost:11434   # default, override only if non-standard
   # OLLAMA_TIMEOUT_MS=60000             # streaming-fetch abort threshold
   # OLLAMA_HISTORY_LIMIT=6              # last N chat turns reconstructed as context
   ```

5. Restart Solrac. The boot log will show `"ollamaEnabled":true,"ollamaModel":"llama3.2",...`.
6. From Telegram: send `> what is 2+2?`. The bot replies with a 🦙 stub, streams the answer, and finalizes with `<i>✅ ollama:llama3.2 · 1.2s</i>`.

Cross-engine context flows in **both** directions: Claude follow-ups see prior `>` exchanges (auto-injected as out-of-band context), and Ollama follow-ups see prior Claude responses. The user's mental model is "single chat thread."

If you don't have Ollama or don't enable the flag, `>`-prefixed messages get a one-line "ollama disabled in this deployment" reply.

For the full env reference and constraints, see [CONFIG.md](./CONFIG.md). For the live-smoke harness against your local Ollama, run `npm run smoke:ollama`.

## 11. (Optional) Production deploy

For systemd-managed deploys see [OPERATIONS.md](./OPERATIONS.md#systemd-deploy). The rough shape:

1. `git clone` the repo into `/opt/solrac/`.
2. `npm install` on the host.
3. Copy `.env` into `/etc/solrac/solrac.env` (mode 600, owner `solrac:solrac`).
4. Install the three units from `deploy/systemd/`.
5. `systemctl enable --now solrac.service solrac-bounce.timer`.

## Common setup pitfalls

**409 Conflict on first boot**
Another instance of the bot is running somewhere — usually a rogue `npm run dev` from a previous session, or the official `telegram@claude-plugins-official` plugin attached to your `~/.claude/settings.json`. See [RUNBOOK.md](./RUNBOOK.md#409-conflict).

**The bot doesn't reply, no error in logs**
Most likely: your `from.id` isn't in `ALLOWLIST_BOOTSTRAP` (typo, wrong digit count). Check the audit row — denied updates still write a row with `status='denied'`. See [RUNBOOK.md](./RUNBOOK.md#bot-silent-no-error).

**`config.invalid: Missing required env vars: ALLOWLIST_BOOTSTRAP`**
You created `.env` but didn't `export` it (or didn't run from the repo root). `npm run dev` runs Bun from this directory; Bun reads `.env` automatically only when the process starts here.

**`instance.soul_load_failed: SOUL.md not found at …`**
Solrac couldn't find or read `SOUL.md` in the directory you launched from, *and* it couldn't find the canonical default to copy. Either run from a directory that already has `SOUL.md`, or run from the repo root (`SOUL.md` ships at the root). See [USAGE.md "Customizing Solrac"](./USAGE.md#customizing-solrac-soulmd-and-solracmd) for the file's role.

## Related docs

- [USAGE.md](./USAGE.md) — what to do once it's running
- [CONFIG.md](./CONFIG.md) — full env reference
- [OPERATIONS.md](./OPERATIONS.md) — production deploy
- [RUNBOOK.md](./RUNBOOK.md) — when things break
