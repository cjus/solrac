# Configuration reference

Every Solrac knob is an environment variable, validated and frozen at boot by `src/config.ts`. Missing required vars fail boot with the **full** missing-key list (not just the first one). Defaults shown below match `config.ts` source.

## Variables

| Name | Required | Default | Type | Notes |
|------|----------|---------|------|-------|
| `ANTHROPIC_API_KEY` | yes | — | string | Direct Anthropic auth. **No Bedrock/Vertex in v1.** |
| `TELEGRAM_BOT_TOKEN` | yes | — | string | From [BotFather](https://t.me/BotFather). One bot per environment (dev/prod). |
| `ALLOWLIST_BOOTSTRAP` | yes | — | comma-sep ints | Telegram `from.id` values to seed the allowlist on every boot. |
| `SOLRAC_DEFAULT_ENGINE` | no | `ollama` | `ollama` \| `primary` \| `secondary` | Engine for messages with no `@`/`!` prefix. `ollama` (the default) requires `OLLAMA_ENABLED=true`. `primary`/`secondary` is the Claude-only-deploy fallback. Ollama is reachable only as the default engine — there is no `>`-style escape prefix. Boot rejects mismatches (e.g. `default=ollama && !ollamaEnabled`, or `default!=ollama && ollamaToolsEnabled`). |
| `SOLRAC_TRANSPORT` | no | `poll` | `poll` \| `webhook` | `webhook` requires `TG_WEBHOOK_SECRET ≥32 chars`; v1 ships poll only. |
| `PORT` | no | `8443` | positive int | `Bun.serve` port (`/health`, `/stats`). Webhook would also bind here. |
| `DATA_DIR` | no | `./data` | path | sqlite db, WAL, PID file, workspaces. Must be writable. |
| `HOURLY_COST_CAP_USD` | no | `1.00` | positive float | **Per-chat** sliding-hour spend ceiling (fairness — every chat gets its own budget). |
| `GLOBAL_HOURLY_COST_CAP_USD` | no | `HOURLY_COST_CAP_USD × MAX_CONCURRENT_TURNS` (computed) | positive float | **Cross-chat** sliding-hour spend ceiling (absolute safety — total Anthropic burn across ALL chats). Default scales with the per-chat cap and concurrency; override to anything stricter or laxer. See [ARCHITECTURE.md#cost-caps](./ARCHITECTURE.md#cost-caps). |
| `MAX_CONCURRENT_TURNS` | no | `4` | positive int | Global Semaphore limit. |
| `SOLRAC_PRIMARY_MODEL` | no | `claude-sonnet-4-6` | model id | Claude **primary** tier (`@` prefix). Reachable via explicit `@`, or by setting `SOLRAC_DEFAULT_ENGINE=primary` for Claude-only deploys. Passed straight to the SDK. |
| `SOLRAC_SECONDARY_MODEL` | no | `claude-opus-4-7` | model id | Claude **secondary** tier (`!` prefix — "escalate"). The heavyweight tier — Opus when extra horsepower is needed. Passed straight to the SDK. |
| `STATS_BEARER_TOKEN` | no | — | string | Required only when `/stats` is hit; absent → `/stats` returns 503. |
| `TG_WEBHOOK_SECRET` | webhook only | — | string ≥32 chars | Set as Telegram's `secret_token` and verified via `X-Telegram-Bot-Api-Secret-Token`. |
| `OLLAMA_ENABLED` | no | `false` | boolean | Master switch for the local Ollama path. When `true`, `OLLAMA_MODEL` MUST be set. **Required `true` when `SOLRAC_DEFAULT_ENGINE=ollama` (the default).** Ollama is reached via the default-engine setting; there is no `>`-style escape prefix. |
| `OLLAMA_URL` | no | `http://localhost:11434` | url | Ollama base URL. Trailing slash stripped at boot. Boot probes `GET /api/tags` once when Ollama is the default engine — non-fatal warn if unreachable or model missing. |
| `OLLAMA_MODEL` | when `OLLAMA_ENABLED=true` | — | string | No default — explicit choice forced at boot. **Recommended: `gemma4:e4b`** (native function-calling, ~9.6GB, 128K context). Alternatives: `gemma4`, `qwen2.5`, `llama3.2`. Pull on the host first: `ollama pull <model>`. |
| `OLLAMA_TIMEOUT_MS` | no | `60000` (or `120000` when `OLLAMA_TOOLS_ENABLED=true`) | positive int | Total turn timeout (model + tool execution loop). Default bumps to 120s when tools are on, since one mid-loop confirm prompt can consume 60s alone. Explicit value always wins. Aborted turns surface as `❌ ollama timed out`. |
| `OLLAMA_HISTORY_LIMIT` | no | `6` | positive int | Last N successful turns reconstructed as conversation context per chat (cross-engine: includes Claude turns). At 256-char prompts × 6 turns ≈ ~3k tokens worst case. **History-pollution mitigation:** if you flip `OLLAMA_TOOLS_ENABLED` off→on on an existing chat, prior "I do not have tools" turns get replayed and the model learns to refuse — set this to `1` for one turn or clear chat history. |
| `OLLAMA_TOOLS_ENABLED` | no | `false` | boolean | Local model can call the same `mcp__solrac__*` integration tools the Claude tiers see. Requires `SOLRAC_INTEGRATIONS_ENABLED=true` AND `SOLRAC_DEFAULT_ENGINE=ollama` (boot rejects the unreachable `default!=ollama && tools=on` combo). Recommended `true` for Ollama-default deploys. |
| `OLLAMA_MAX_TOOL_ITERATIONS` | no | `8` | positive int | Hard ceiling on tool-loop rounds per turn. Loop detector fires earlier on duplicate calls; this is the runaway-loop backstop. Iteration cap surfaces as `⚠️ stopped after N tool iterations`. |
| `SOLRAC_SKILLS_ENABLED` | no | `false` | boolean | Master switch for operator-defined skills. When `true`, Solrac discovers `SKILL.md` files under `SOLRAC_SKILLS_DIR` at boot and exposes each as a `/<name>` slash command. |
| `SOLRAC_SKILLS_DIR` | no | `./skills` | path | Directory scanned for `<name>/SKILL.md` files. Resolved relative to launch cwd. Loaded ONCE at boot — edit files and restart. See [USAGE.md#skills-operator-defined-commands](./USAGE.md#skills-operator-defined-commands). |
| `SOLRAC_INTEGRATIONS_ENABLED` | no | `false` | boolean | Master switch for operator + blessed integrations. When `true`, Solrac discovers `<name>/index.ts` modules under `src/integrations-builtin/` (always) and `SOLRAC_INTEGRATIONS_DIR` (operator-owned) at boot, and registers each one's tools as `mcp__solrac__<tool>`. **Effective for both Claude tiers (`@`, `!`) and Ollama (when `OLLAMA_TOOLS_ENABLED=true`).** Required `true` when `OLLAMA_TOOLS_ENABLED=true`. See [USAGE.md#integrations](./USAGE.md#integrations). |
| `SOLRAC_INTEGRATIONS_DIR` | no | `./integrations` | path | Directory scanned for operator-authored `<name>/index.ts` integration modules. Resolved relative to launch cwd; can also be absolute (e.g. `~/.solrac/integrations`). Loaded ONCE at boot — edit files and restart. |
| `NOTION_API_KEY` | when `notion` integration in use | — | string | Notion internal-integration secret (`secret_…`). Consumed by the blessed `notion` integration only — not validated in `config.ts`. Boot probes `GET /v1/users/me` (3s timeout); failure → integration self-gates to zero tools, solrac boots normally. **Scrubbed** from the SDK-spawned `claude` subprocess env by `agent.ts::sanitizedSubprocessEnv` (the integration handler runs in solrac's main process; the subprocess never needs the token). See [USAGE.md#notion-single-token-notion-workspace-opt-in-dep](./USAGE.md#notion--single-token-notion-workspace-opt-in-dep). |
| `SOLRAC_WEB_ENABLED` | no | `false` | boolean | Master switch for the browser web UI. When `true`, Solrac binds a second `Bun.serve` instance to `SOLRAC_WEB_HOST:SOLRAC_WEB_PORT`. `SOLRAC_WEB_TOKEN` becomes required. |
| `SOLRAC_WEB_HOST` | no | `127.0.0.1` | string | Bind address for the web UI. `127.0.0.1`/`localhost` = loopback only. `0.0.0.0` = all interfaces (LAN/Tailscale/public — pair with a strong token). |
| `SOLRAC_WEB_PORT` | no | `8080` | positive int | Port for the web UI. Must differ from `PORT` (which serves `/health` & `/stats`). |
| `SOLRAC_WEB_TOKEN` | when `SOLRAC_WEB_ENABLED=true` | — | string | Login secret. **Required even on `127.0.0.1`** — a co-tenant on a shared host could otherwise reach the unauthenticated UI. Generate with `openssl rand -hex 32`. Cookie set after login is HttpOnly + SameSite=Strict + Path=/ + Max-Age=24h. |
| `SOLRAC_WEB_CHAT_ID` | no | `-1000` | negative int | Synthetic chat id all web traffic shares. One session per Claude tier, one cost-cap bucket, one `/clear` scope. Negative to avoid collision with real Telegram chat ids. |

## Validation rules

`config.ts` parses with explicit error messages, not silent coercion:

- **Required vars** must be set and non-blank. Missing required vars throw `Missing required env vars: A, B, C` (full list).
- **`ALLOWLIST_BOOTSTRAP`** parses comma-separated positive integers. A non-integer entry throws `ALLOWLIST_BOOTSTRAP entry is not a positive integer: "<x>"`.
- **`SOLRAC_TRANSPORT`** must be exactly `poll` or `webhook`. Anything else throws.
- **`PORT`**, **`MAX_CONCURRENT_TURNS`** must parse as positive integers. Non-integer floats throw.
- **`HOURLY_COST_CAP_USD`** and **`GLOBAL_HOURLY_COST_CAP_USD`** must parse as positive numbers (float allowed). The global cap defaults to `HOURLY_COST_CAP_USD × MAX_CONCURRENT_TURNS` if unset, so bumping `MAX_CONCURRENT_TURNS` auto-tracks unless you've explicitly overridden the global. Set both explicitly for production if you want the cap independent from concurrency.
- **Webhook constraint:** when `SOLRAC_TRANSPORT=webhook`, `TG_WEBHOOK_SECRET` must be set and ≥32 characters.
- **Default-engine constraints:**
  - `SOLRAC_DEFAULT_ENGINE=ollama` requires `OLLAMA_ENABLED=true`. Boot throws with the actionable hint to either enable Ollama or pick a different default.
  - `SOLRAC_DEFAULT_ENGINE=primary|secondary` with `OLLAMA_TOOLS_ENABLED=true` is **unreachable** — Ollama only runs as the default engine, so this combination would load tools no engine can call. Boot throws.
  - When `SOLRAC_DEFAULT_ENGINE` is unset, a `solrac.default_engine_implicit` warn fires at boot so deployments never run on an implicit default. Set the variable explicitly (even to `ollama`) to silence the warning.
- **Ollama constraint:** when `OLLAMA_ENABLED=true`, `OLLAMA_MODEL` must be set and non-blank. `OLLAMA_TIMEOUT_MS`, `OLLAMA_HISTORY_LIMIT`, and `OLLAMA_MAX_TOOL_ITERATIONS` must parse as positive integers if provided. `OLLAMA_URL` has its trailing slash stripped at boot.
- **Ollama tools constraint:** `OLLAMA_TOOLS_ENABLED=true` requires `SOLRAC_INTEGRATIONS_ENABLED=true` (else there are no tools to expose; boot throws).
- **Web UI constraint:** when `SOLRAC_WEB_ENABLED=true`, `SOLRAC_WEB_TOKEN` must be set (any value; ≥32 chars recommended). `SOLRAC_WEB_PORT` must differ from `PORT`. `SOLRAC_WEB_CHAT_ID` must be a negative integer.

The returned `Config` object is `Object.freeze`d; `allowlistBootstrap` is also frozen. There's no runtime mutation path.

## Defensive constants

These are exported from `config.ts` but not env-tunable in v1 — they're security-policy constants, not operator knobs:

| Name | Value | Defense |
|------|-------|---------|
| `MAX_AUDIT_PROMPT_LEN` | 256 | Truncate `prompt` text persisted to `audit` so a flooder can't grow rows by megabytes. |
| `MAX_CHAT_QUEUE_DEPTH` | 10 | Max in-chain `KeyedMutex` depth before `enqueue()` returns `dropped_queue_full`. |

If you need to bump these, edit the constant — and update the threat-model section in [ARCHITECTURE.md](./ARCHITECTURE.md#db-pollution-defenses) so the rationale stays current.

## Anthropic rate-limit considerations

Solrac's per-turn input is dominated by the SDK's `claude_code` system-prompt preset, plus the `SOUL.md`/`SOLRAC.md` overlays, the cross-engine bridge block, and — when `SOLRAC_INTEGRATIONS_ENABLED=true` — every loaded integration's tool schema. With the two blessed integrations enabled, observed primary-Claude turns send **~24K input tokens** each (mostly served from prompt cache after the first turn warms it).

This collides with Anthropic's per-model **input tokens per minute (ITPM)** rate limit, which scales with your plan tier (see [Anthropic rate-limits](https://docs.claude.com/en/api/rate-limits)). Two practical implications:

- If your Sonnet ITPM is below ~25K, every cold turn 429s — single-turn input already exceeds the cap. `MAX_CONCURRENT_TURNS` does not help; the problem is per-turn size, not concurrency.
- Disabling integrations only saves per-tool schema overhead, not the bulk — most of the ~24K is the SDK preset itself.

If you see `429 · This request would exceed your organization's rate limit of N input tokens per minute`, raise your Anthropic plan tier rather than tuning Solrac. Routing heavy turns through the secondary tier (`!` prefix → Opus) uses a separate ITPM bucket and may unblock you in the short term.

## Example `.env`

```sh
# Required
ANTHROPIC_API_KEY=sk-ant-…
TELEGRAM_BOT_TOKEN=8123456789:AA…
ALLOWLIST_BOOTSTRAP=123456789

# Engine routing — default is ollama; `@` → primary Claude, `!` → secondary Claude
SOLRAC_DEFAULT_ENGINE=ollama          # `ollama` | `primary` | `secondary`
SOLRAC_PRIMARY_MODEL=claude-sonnet-4-6   # `@` prefix
SOLRAC_SECONDARY_MODEL=claude-opus-4-7   # `!` prefix (escalate)

# Ollama (required when SOLRAC_DEFAULT_ENGINE=ollama)
OLLAMA_ENABLED=true
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=gemma4:e4b               # native function-calling, ~9.6GB
OLLAMA_TIMEOUT_MS=60000               # bumps to 120000 when tools-on
OLLAMA_HISTORY_LIMIT=6
OLLAMA_TOOLS_ENABLED=true             # requires SOLRAC_INTEGRATIONS_ENABLED=true
OLLAMA_MAX_TOOL_ITERATIONS=8

# Integrations (precondition for OLLAMA_TOOLS_ENABLED=true)
SOLRAC_INTEGRATIONS_ENABLED=true
SOLRAC_INTEGRATIONS_DIR=./integrations

# Operational
SOLRAC_TRANSPORT=poll
PORT=8443
DATA_DIR=./data
HOURLY_COST_CAP_USD=1.00
GLOBAL_HOURLY_COST_CAP_USD=4.00       # default = HOURLY_COST_CAP_USD × MAX_CONCURRENT_TURNS
MAX_CONCURRENT_TURNS=4

# Optional (only required when used)
STATS_BEARER_TOKEN=               # leave blank to disable /stats (returns 503)
TG_WEBHOOK_SECRET=                # set when SOLRAC_TRANSPORT=webhook

# Operator-defined skills. Off by default.
SOLRAC_SKILLS_ENABLED=false       # set to true to load $SOLRAC_SKILLS_DIR/<name>/SKILL.md at boot
SOLRAC_SKILLS_DIR=./skills        # cwd-relative; edit + restart to pick up changes

# Web UI. Off by default. When SOLRAC_WEB_ENABLED=true, SOLRAC_WEB_TOKEN is required.
SOLRAC_WEB_ENABLED=false
SOLRAC_WEB_HOST=127.0.0.1         # 0.0.0.0 to expose on LAN/Tailscale/public
SOLRAC_WEB_PORT=8080              # must differ from PORT
SOLRAC_WEB_TOKEN=                 # required when enabled; generate: openssl rand -hex 32
# SOLRAC_WEB_CHAT_ID=-1000        # synthetic shared chat id for the web transport
```

### Claude-only deploy

For hosts that can't run Ollama:

```sh
SOLRAC_DEFAULT_ENGINE=primary     # no-prefix → Anthropic Sonnet
OLLAMA_ENABLED=false
OLLAMA_TOOLS_ENABLED=false
SOLRAC_INTEGRATIONS_ENABLED=true  # still useful for Claude tiers
```

## Sensitive-secret handling

The SDK spawns a `claude` subprocess that **inherits parent env**. Solrac scrubs Telegram-related and operator-only secrets before that spawn (see `agent.ts::sanitizedSubprocessEnv`):

- `TELEGRAM_*` (any prefix)
- `TG_*` (any prefix)
- `STATS_BEARER_TOKEN`
- `ALLOWLIST_BOOTSTRAP`

`ANTHROPIC_API_KEY`, `SOLRAC_PRIMARY_MODEL`, and `SOLRAC_SECONDARY_MODEL` are passed through (the agent needs them).

If you add a new operator-only secret to `.env`, add a matching scrub rule in `sanitizedSubprocessEnv()`. If the secret is supposed to reach the agent's tools (e.g. a paid third-party API key the agent should use), pass it through and add a corresponding [auto-deny rule](./ARCHITECTURE.md#bash-rule-tables) in `policy.ts` if the CLI form would burn budget outside the cap.

## Reload behavior

Solrac doesn't hot-reload `.env`. Any change to environment variables requires a process restart (`systemctl restart solrac.service`). This is intentional — config drift between processes is a worse failure mode than a 2-second restart.

`SOLRAC.md` is the exception: it is re-read per turn so operator-instance edits (channel posture, project hints) take effect on the next message without a restart. `SOUL.md` is read once at boot and changes there require a restart.

## SOUL.md and SOLRAC.md

Two operator-editable markdown files at the **launch cwd** (the directory `solrac` is run from):

| File | Purpose | Lifecycle | Failure mode |
|---|---|---|---|
| `SOUL.md` | Voice, stance, untrusted-content safety clause. Shared across engines. | Read once at boot. Joined with an engine-specific capability note and shipped as `systemPrompt.append` (Claude) or first `system` message (Ollama). | Hard-fail: boot exits 1 if missing or empty. |
| `SOLRAC.md` | Operator-specific overlay: operator name, channel posture, project hints. | Re-read per turn. Wrapped in `<solrac-md>...</solrac-md>` and injected at the top of the user-message envelope (Claude) or as a second `system` message (Ollama). | Soft-warn: missing or unedited-template state injects nothing; Solrac runs vanilla. |

Both ship in the package as canonical defaults (`SOUL.md`, `SOLRAC.md`). On first boot, if the launch cwd lacks them, `instance.ts::bootstrapInstanceFiles` copies the defaults into cwd so the operator has a customizable copy. Subsequent boots read from cwd; the package copies are a one-time seed.

The shipped `SOLRAC.md` carries a `<!-- solrac-md:unedited -->` marker on its first line. While that line is present, Solrac treats the file as an unedited template and injects nothing. Delete the marker line to activate the overlay.

To start over from the canonical defaults: delete `SOUL.md` and/or `SOLRAC.md` from cwd and restart Solrac.

## Boot logging

On boot, `solrac.boot` is logged with the non-secret summary:

```json
{
  "ts": "...",
  "level": "info",
  "msg": "solrac.boot",
  "transport": "poll",
  "defaultEngine": "ollama",
  "primaryModel": "claude-sonnet-4-6",
  "secondaryModel": "claude-opus-4-7",
  "port": 8443,
  "dataDir": "./data",
  "allowlistSize": 1,
  "maxConcurrentTurns": 4,
  "hourlyCostCapUsd": 1,
  "globalHourlyCostCapUsd": 4,
  "ollamaEnabled": true,
  "ollamaModel": "gemma4:e4b",
  "ollamaUrl": "http://localhost:11434"
}
```

Tokens, API keys, and bearer secrets are never logged. If you see a value that looks redacted-able showing up in a log line, file it as a leak.

## Related docs

- [SETUP.md](./SETUP.md) — getting an `.env` from zero
- [OPERATIONS.md](./OPERATIONS.md) — `/stats` bearer use
- [ARCHITECTURE.md](./ARCHITECTURE.md) — why each constant exists
