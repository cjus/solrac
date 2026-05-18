# Setup

Getting Solrac running from a fresh clone to a Telegram bot replying on your machine.

Total time: ~20 minutes if you don't already have a Telegram bot or Anthropic API key. ~5 minutes if you do.

## 1. Prerequisites: runtime

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

## 2. Prerequisites: engine-slot backend + model (recommended)

The recommended Solrac config sets `SOLRAC_DEFAULT_ENGINE=local` (the "engine slot"), which makes a backend a hard boot requirement. No-prefix Telegram messages route to the engine slot; `@`/`!` reach Anthropic Sonnet/Opus.

You have three paths — pick one:

1. **Local on-host backend (§2 below — this section)** — Ollama or LMStudio running on the same machine. Free; needs a GPU or decent CPU.
2. **Remote OpenRouter backend (§2-remote)** — hosted models via OpenRouter. Per-token cost; no on-host GPU required. Same runtime UX as local mode.
3. **Claude-only deploy (§2-alt)** — no engine slot at all; every no-prefix message hits Anthropic Sonnet directly.

This section walks through path 1. For OpenRouter, skip to §2-remote. For Claude-only, skip to §2-alt.

For path 1, pick a backend via `LOCAL_BACKEND`:
- **`ollama`** ([ollama.com](https://ollama.com)) — daemon + CLI; default URL `:11434`; NDJSON wire format.
- **`lmstudio`** ([lmstudio.ai](https://lmstudio.ai)) — desktop app with a built-in server; default URL `:1234`; OpenAI-compatible SSE wire format.

### 2.1 Install your chosen backend

**Ollama:**

| Platform | Install |
|---|---|
| macOS | `brew install ollama` |
| Linux | `curl -fsSL https://ollama.com/install.sh \| sh` |
| Docker | `docker run -d -v ollama:/root/.ollama -p 11434:11434 --name ollama ollama/ollama` |

**LMStudio:** download the desktop app from [lmstudio.ai](https://lmstudio.ai). Enable the local server (Developer tab → "Start Server", default port 1234). Optional CLI: `lms` ships with the app.

### 2.2 Start the backend

- **Ollama:** `brew install` typically auto-starts. Otherwise `ollama serve &` (or `systemctl start ollama` on Linux). Default URL: `http://localhost:11434`.
- **LMStudio:** open the app and click "Start Server" in the Developer tab, or `lms server start` from the CLI. Default URL: `http://localhost:1234`.

### 2.3 Pull (Ollama) or load (LMStudio) a tools-capable model

**Recommended: `gemma4:e4b`** — native function-calling, ~9.6GB on disk, 128K context. Matches the operator's reference config.

```sh
# Ollama
ollama pull gemma4:e4b

# LMStudio (CLI)
lms load lmstudio-community/gemma-3-4b-it     # or load via the GUI search
```

Alternatives: `qwen2.5:7b` / `qwen2.5-7b-instruct` (~4.7GB), `llama3.2:3b` / `llama-3.2-3b-instruct` (~2.0GB). Hardware notes:

| Model | Disk | Min RAM | Tools |
|---|---|---|---|
| `gemma4:e2b` | 7.2GB | 8GB | yes |
| `gemma4:e4b` | 9.6GB | 16GB | yes (recommended) |
| `qwen2.5:7b` | 4.7GB | 8GB | yes |
| `llama3.2:3b` | 2.0GB | 6GB | yes |

### 2.4 Verify

```sh
# Ollama
ollama list                                    # should show your pulled model
curl -s http://localhost:11434/api/tags | jq   # daemon HTTP probe

# LMStudio
lms ls                                         # should show your loaded model
curl -s http://localhost:1234/v1/models | jq   # server HTTP probe
```

If both succeed, the backend is ready.

## 2-alt. Claude-only deploy (skip if you completed §2)

If you can't run a local backend (no GPU/RAM, or air-gapped from local model hosting), pin Claude as the default engine. Add this to your `.env` later:

```sh
SOLRAC_DEFAULT_ENGINE=primary    # no-prefix → Anthropic Sonnet
LOCAL_ENABLED=false
REMOTE_ENABLED=false
LOCAL_TOOLS_ENABLED=false
```

You'll lose the free local default path; every no-prefix message is an Anthropic call. `@` and `!` work as documented. The rest of this guide still applies.

## 2-remote. Remote deploy via OpenRouter (skip if you completed §2 or §2-alt)

If you can't run a local backend but want a non-Claude default engine, point the engine slot at OpenRouter. The runtime UX is identical to local mode (no-prefix routing, `/clear local` semantics, capability note) but per-token cost is captured into `audit.cost_usd` so the existing hourly caps gate burn.

1. Get an OpenRouter API key at https://openrouter.ai/keys (the key prefix is typically `sk-or-`).
2. Pick a model slug from https://openrouter.ai/models — e.g. `openai/gpt-4o-mini` (cheap chat), `anthropic/claude-3.5-sonnet` (parity with the `@` tier), or `meta-llama/llama-3.3-70b-instruct`.
3. Add to your `.env`:

```sh
SOLRAC_DEFAULT_ENGINE=local       # the engine slot, served by OpenRouter
LOCAL_ENABLED=false               # mutually exclusive with REMOTE_ENABLED
REMOTE_ENABLED=true
REMOTE_BACKEND=openrouter
REMOTE_MODEL=openai/gpt-4o-mini
REMOTE_API_KEY=sk-or-…
```

Boot logs the `remote (openrouter)` engine label and probes `GET /models` once with bearer auth — a bad API key surfaces as `auth_failed` at startup. The `@` (Sonnet) and `!` (Opus) prefixes still escalate to Claude tiers as in the local-mode deploy. The rest of this guide still applies.

## 3. Install Solrac

```sh
git clone https://github.com/cjus/solrac.git
cd solrac
npm install
```

## 4. Create a Telegram bot

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

## 5. Find your Telegram `from.id`

The allowlist gates on user id, not chat id (so group forwards still resolve to the actual sender). To find yours:

1. DM [@userinfobot](https://t.me/userinfobot).
2. It replies with your `Id`. That number is your `from.id`. **This is `ALLOWLIST_BOOTSTRAP`** (or one entry of a comma-separated list).

## 6. Mint an Anthropic API key

Use a **scoped** key — not your account-level key. If a tool call leaks env (it shouldn't, but defense-in-depth), revoking a scoped key can't break unrelated services.

1. Go to https://console.anthropic.com/settings/keys.
2. **Create Key** → name it `solrac-dev` (or `solrac-prod`).
3. Copy the value. **This is `ANTHROPIC_API_KEY`.**

Solrac authenticates via `ANTHROPIC_API_KEY` only. Bedrock and Vertex auth are explicit anti-goals in v1 (see [ARCHITECTURE.md](./ARCHITECTURE.md#anti-goals)).

## 7. Write your `.env`

Copy the template:

```sh
cp .env.example .env
```

Open `.env` and fill in the three required values:

```sh
ANTHROPIC_API_KEY=sk-ant-…             # from §6
TELEGRAM_BOT_TOKEN=8123456789:AA…      # from §4
ALLOWLIST_BOOTSTRAP=123456789           # from §5 (your from.id)
```

The template ships with the recommended local-default values pre-set:

```sh
SOLRAC_DEFAULT_ENGINE=local
LOCAL_ENABLED=true
LOCAL_BACKEND=ollama                # or `lmstudio`
LOCAL_MODEL=gemma4:e4b
LOCAL_TOOLS_ENABLED=true
SOLRAC_INTEGRATIONS_ENABLED=true
```

> Set `LOCAL_BACKEND` to match whichever backend you set up in §2. `LOCAL_URL` defaults to the backend's standard port (`:11434` for Ollama, `:1234` for LMStudio); set it explicitly only if you moved the server.

If you went with §2-alt (Claude-only deploy), edit those lines per the snippet there. Full reference: [CONFIG.md](./CONFIG.md).

`.gitignore` excludes `.env`. Don't commit it.

## 8. First boot

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

## 9. Smoke-test on Telegram

Open a DM with your bot in Telegram and send any message — e.g. `what time is it?`.

Expected behavior:

1. Within ~1 second, the bot edits a `🤔 thinking…` placeholder.
2. As the agent runs, the placeholder edits with progress (tool name, partial output).
3. Final state is the same message, edited to the answer + `<i>✅ N turns · $0.0XXX</i>` footer.

If a tool call requires confirmation (e.g. `git status` is auto-allowed; `Write file.txt` triggers a prompt), an inline keyboard appears with `✅ Allow` / `❌ Deny`. See [USAGE.md](./USAGE.md#permission-ux) for the full picture.

## 10. Verify the audit trail

Quick check: every turn writes a row to the `audit` table.

```sh
sqlite3 data/solrac.sqlite \
  "SELECT id, chat_id, status, cost_usd, started_at FROM audit ORDER BY id DESC LIMIT 5"
```

For deeper queries, see [OPERATIONS.md](./OPERATIONS.md#audit-queries).

## 11. (Optional) Enable `/stats`

To enable the `/stats` endpoint, set:

```sh
STATS_BEARER_TOKEN=$(openssl rand -hex 32)
```

Restart Solrac. Then:

```sh
curl -H "Authorization: Bearer $STATS_BEARER_TOKEN" http://localhost:8443/stats
```

You'll get RSS, uptime, in-flight turn counts, and 24h spend.

## 12. (Optional) Tune the local engine

The recommended config already enables the local engine (§2 + §7). Knobs that may matter for non-standard deploys:

| Env | Default | When to override |
|---|---|---|
| `LOCAL_URL` | backend-aware (`:11434` ollama, `:1234` lmstudio) | Backend on a remote host or non-standard port. |
| `LOCAL_TIMEOUT_MS` | `60000` (`120000` when tools-on) | Slower hardware needs more headroom for multi-round tool loops. |
| `LOCAL_HISTORY_LIMIT` | `6` | Smaller context windows on 3B models; or `1` to bypass history pollution after flipping `LOCAL_TOOLS_ENABLED` on an existing chat. |
| `LOCAL_MAX_TOOL_ITERATIONS` | `8` | Lower if a model loops; raise only with caution. |

Cross-engine context flows in **both** directions: Claude follow-ups see prior local-model exchanges (auto-injected as out-of-band context), and local follow-ups see prior Claude responses. The user's mental model is "single chat thread."

For the live-smoke harness against your local backend: `LOCAL_BACKEND=ollama npm run smoke:local` (or `LOCAL_BACKEND=lmstudio npm run smoke:local`). Set `LOCAL_TOOLS_ENABLED=true` to also exercise the tool-loop path.

## 13. (Optional) Enable the browser web UI

Solrac can run a second `Bun.serve` instance that hosts a minimal vanilla-JS chat interface alongside the Telegram bot. Same agent loop, same slash commands, same engine routing, same audit log — different transport. Useful when Telegram is unavailable, on a desk monitor, or for richer markdown rendering than Telegram's HTML mode supports.

1. Pick a port (must differ from `PORT`). Default `8080`.
2. Generate a strong token: `openssl rand -hex 32`.
3. Add to `.env`:

   ```sh
   SOLRAC_WEB_ENABLED=true
   SOLRAC_WEB_HOST=127.0.0.1               # 0.0.0.0 to expose on LAN/Tailnet
   SOLRAC_WEB_PORT=8080                    # must differ from PORT
   SOLRAC_WEB_TOKEN=<paste-the-hex-here>   # required even on 127.0.0.1
   # SOLRAC_WEB_CHAT_ID=-1000              # synthetic shared chat id (negative)
   ```

4. Restart Solrac. The boot log gains a `web.listening` line:

   ```json
   {"level":"info","msg":"web.listening","host":"127.0.0.1","port":8080,"bound_zero":false}
   ```

5. Browse to `http://127.0.0.1:8080`. The login page accepts your token; on success a `solrac_web` cookie is set (`HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`) and the chat UI loads.

6. Try it: send `**hello in bold**` — the browser renders proper bold; Telegram (if you also DM the bot) shows the same with `<b>` HTML. Try ` ```py\nprint(1)\n``` ` — the browser shows a syntax-class code block; Telegram shows a `<pre><code class="language-py">` block. Both transports get the right formatting on their respective clients.

**Security notes:**
- The token is **required** even on `127.0.0.1` — a co-tenant on a shared host could otherwise reach the unauthenticated UI.
- When `SOLRAC_WEB_HOST=0.0.0.0`, the UI is reachable on every interface. Pair with a strong token (32+ hex chars).
- Sessions are stored in process memory; restarting Solrac signs out all browsers (operator must log in again).
- File uploads are not supported (Telegram's photo flow is). Out of scope for v1.

**Reaching Solrac over HTTPS (needed for the mic button).** The browser's `getUserMedia` API is undefined on any HTTP origin that isn't `localhost` / `127.0.0.1`. If you plan to access the UI from your phone, another laptop, or anywhere else on your LAN, you want TLS termination. The simplest path for a single-tenant deploy is **Tailscale serve**:

1. One-time setup in the Tailscale admin console (https://login.tailscale.com/admin/dns): MagicDNS on, HTTPS Certificates on.
2. Bind Solrac to localhost only — keep `SOLRAC_WEB_HOST=127.0.0.1`.
3. Front it with Tailscale's built-in proxy (auto-provisions a Let's Encrypt cert for your MagicDNS hostname, auto-renews):
   ```sh
   tailscale serve --bg http://localhost:8080
   tailscale serve status   # confirms https://<host>.<tailnet>.ts.net → localhost:8080
   ```
4. Open `https://<host>.<tailnet>.ts.net/` from any device on your tailnet.

Alternatives: Caddy with auto-TLS in front of `127.0.0.1:8080`, or nginx + Let's Encrypt. Without TLS, mic input fails silently — the speak buttons still work. See [USAGE.md#web-ui-voice-surface](./USAGE.md#web-ui-voice-surface) for the symptom + full recovery options and [RUNBOOK.md#web-ui-mic-error](./RUNBOOK.md#web-ui-mic-error) for the diagnosis flow.

For the full env reference, see [CONFIG.md](./CONFIG.md#variables); for the architecture and security posture see [ARCHITECTURE.md#web-ui-transport-optional](./ARCHITECTURE.md#web-ui-transport-optional); for daily-use feature parity with Telegram see [USAGE.md#web-ui-browser-interface](./USAGE.md#web-ui-browser-interface).

## 14. (Optional) Production deploy

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
