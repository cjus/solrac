# Solrac

> A self-hosted, transparent, hackable Claude-Code-style agent that lives in a Bun process, listens to Telegram, and uses Anthropic's Claude Agent SDK for thinking and tool use. Think of it as your own open Claude — on your machine, with your filesystem, your MCP servers, your tools, your audit log.

<image src="./docs/solrac.png" width="300px" />

## Is this for you?

Solrac fits if **all** of the following are true:

- You want a chat-driven agent that can read your code, run shell, and edit files — but you want to own every piece of the stack.
- You're willing to trade convenience (no plug-and-play hosting, no UI) for transparency (~2K lines of TypeScript, four moving parts, full audit trail).
- You're operating at one-user-or-few scale. If you need multi-tenancy or a UI, look elsewhere.

If you'd rather use Claude Code's official Telegram plugin, that's a perfectly good choice — it's actively maintained and zero-setup. Solrac exists because we wanted custom permission rules, per-chat budget caps, an audit log we control, and a foundation extensible to email/Slack/scheduled jobs.

**Operational dependencies:**

- Bun ≥1.3.0 (runtime).
- A Telegram bot token + your `from.id`.
- An Anthropic API key (`@`/`!` paths).
- A local **Ollama daemon + tools-capable model** for the recommended PR-B default config (no-prefix routes to local). For Claude-only deploys, set `SOLRAC_DEFAULT_ENGINE=primary` instead.

## Features

- **Customizable persona via `SOUL.md` + `SOLRAC.md`** — two operator-editable markdown files at the launch directory. `SOUL.md` (voice, stance, safety) ships with the package and is read once at boot. `SOLRAC.md` (operator overlay: who runs it, channel posture, project context) is re-read every turn so live edits land on the next message without a restart. See [docs/USAGE.md#customizing-solrac-soulmd-and-solracmd](./docs/USAGE.md#customizing-solrac-soulmd-and-solracmd).
- **Slash commands** — `/help`, `/status`, `/context`, `/clear`, `/compact` give the operator visibility and control over conversation context, spend, and session state without leaving Telegram. Both `/cmd` and `:cmd` invoke the same handler (`:` avoids Telegram's auto-link on bold text).
- **Operator-defined skills** — drop a `SKILL.md` into `$SOLRAC_SKILLS_DIR/<name>/` and that filename becomes a slash command on the next boot. Tool-less single-turn prompts with `{{args}}` templating; cost-capped under the existing per-chat hourly budget. Off by default; enable with `SOLRAC_SKILLS_ENABLED=true`.
- **Multi-user, multi-chat** — gated by per-`from.id` allowlist.
- **Three-tier permission policy** — auto-allow / auto-deny / Telegram-inline-keyboard-confirm. Configurable rule tables.
- **Per-chat hourly cost cap** — sliding 60-minute window over the audit log. Default $1.00/chat/hour.
- **Loop detector** — denies the third call to the same `(toolName, input)` within a turn. Order-insensitive over JSON keys.
- **Persistent audit trail** — every turn (allowed, denied, queue-full) writes a SQLite row with prompt, response, tool calls, cost, tokens, session id, status, **and engine** (`claude:primary:<modelId>` / `claude:secondary:<modelId>` / `ollama:<name>`).
- **PR-B inverted default** — *Claude only when explicitly requested.* No-prefix routes to local Ollama (free) by default; `@` escalates to Sonnet, `!` escalates to Opus. Pinable via `SOLRAC_DEFAULT_ENGINE` for Claude-only deploys. Boot validation rejects unreachable combinations.
- **Local Ollama with tool support** — when `OLLAMA_TOOLS_ENABLED=true`, the local model (e.g. `gemma4:e4b`) calls the same `mcp__solrac__*` integrations the Claude tiers see. Multi-round tool loop with shared loop detector, broker UX, and iteration cap (`OLLAMA_MAX_TOOL_ITERATIONS=8`). Cross-engine context bridge means switching between local and Claude preserves the conversation thread.
- **Dual-Claude tier routing** — `@` → primary tier (Sonnet by default), `!` → secondary tier (Opus by default). Each tier keeps its own SDK session id so prompt caching survives same-tier turns. Per-tier thinking-stub emoji (🙂 primary / 🤔 secondary) makes the routing visible in chat.
- **Optional browser web UI** — a second `Bun.serve` instance on a configurable port serves a minimal vanilla-JS chat interface with the same agent loop, slash commands, engine routing, and tool-confirm UX as Telegram. Full markdown rendering (headers, lists, tables, fenced code) on both transports — Claude/Ollama responses get a server-side markdown→HTML pass for Telegram and the raw markdown to the browser. Off by default; enable with `SOLRAC_WEB_ENABLED=true` plus a token. See [docs/USAGE.md#web-ui-browser-interface](./docs/USAGE.md#web-ui-browser-interface).
- **Session resume across restarts** — SDK session ids persisted per chat **and per tier**; conversations survive process death.
- **Inline-keyboard confirm UX** — 60-second timeout, fail-closed on send failure, verdict stamped into chat history after tap.
- **Bearer-gated `/stats` endpoint** — RSS, in-flight turns, 24h spend; `node:crypto.timingSafeEqual` constant-time auth.
- **Daily cost report** — DM'd to allowlist's first entry; idempotent via meta-key check; UTC midnight window.
- **Graceful shutdown** — SIGINT/SIGTERM aborts polling, drains in-flight turns (60s cap), checkpoints WAL, removes PID file, exits cleanly.
- **Weekly auto-bounce** — systemd timer mitigates Bun long-uptime memory drift.
- **DB-pollution defenses** — denial throttle (1 row per `from.id` per minute under flood), per-chat queue depth cap, prompt truncation with surrogate-pair safety.
- **Sub-agent default-deny** — `Agent`/`Task` tools disabled at SDK + policy layers.
- **Concurrency primitives** — per-chat `KeyedMutex`, global `Semaphore`, drain-aware `TurnTracker`.
- **No HTTP framework, no Telegram framework runtime, no queue server, no Docker** — ~2K lines of focused TypeScript.

## Quick start

If you have Bun and a Telegram bot:

```sh
git clone https://github.com/cjus/solrac.git
cd solrac
npm install
cp .env.example .env       # then fill in 3 required values
npm run dev                # starts on PORT (default 8443)
```

Then DM your bot. You should see a 🤔 stub within a second.

If you don't have Bun, a Telegram bot, or an Anthropic API key — see [docs/SETUP.md](./docs/SETUP.md). Total walkthrough: ~20 minutes.

**Engine routing — at a glance** (with the PR-B default `SOLRAC_DEFAULT_ENGINE=ollama`):

| Prefix | Engine | Model env | Default |
|--------|--------|-----------|---------|
| (none) | Local Ollama (default) | `OLLAMA_MODEL` | `gemma4:e4b` (recommended) |
| `@` | Primary Claude — escalate | `SOLRAC_PRIMARY_MODEL` | `claude-sonnet-4-6` |
| `!` | Secondary Claude — heaviest | `SOLRAC_SECONDARY_MODEL` | `claude-opus-4-7` |

The `>` prefix was removed in PR-B; a leading `>` is now literal user text routed via the default engine. For Claude-only deploys, set `SOLRAC_DEFAULT_ENGINE=primary` (no-prefix → Sonnet) and `OLLAMA_ENABLED=false`. See [docs/USAGE.md#engine-routing-prefix-table](./docs/USAGE.md#engine-routing-prefix-table) and [docs/ARCHITECTURE.md#engine-routing](./docs/ARCHITECTURE.md#engine-routing).

**Optional — browser web UI.** Set `SOLRAC_WEB_ENABLED=true` and `SOLRAC_WEB_TOKEN=$(openssl rand -hex 32)` in `.env`; browse to `http://127.0.0.1:8080` for a chat interface with full markdown rendering. Bind `SOLRAC_WEB_HOST=0.0.0.0` to expose it on a LAN/Tailnet (token gates access). See [docs/USAGE.md#web-ui-browser-interface](./docs/USAGE.md#web-ui-browser-interface) and [docs/ARCHITECTURE.md#web-ui-transport-optional](./docs/ARCHITECTURE.md#web-ui-transport-optional).

## Documentation

| Doc | Audience | What it covers |
|-----|----------|---------------|
| [docs/SETUP.md](./docs/SETUP.md) | First-time users | Bun install, Telegram bot creation, `from.id` lookup, Anthropic key, `.env`, first boot |
| [docs/USAGE.md](./docs/USAGE.md) | Daily users | Concepts (turn / session / `from.id` vs `chat.id`), interaction patterns, permission UX, cost cap, loop detector |
| [docs/CONFIG.md](./docs/CONFIG.md) | Operators | Full env-var reference: defaults, ranges, validation, secret-scrub rules |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | Developers | Module map, data flow, SDK integration, concurrency, SQLite schema, three-tier policy, threat model, tricky seams |
| [docs/OPERATIONS.md](./docs/OPERATIONS.md) | Operators | systemd deploy, `/health` and `/stats`, daily report, log events, audit queries, backups |
| [docs/RUNBOOK.md](./docs/RUNBOOK.md) | On-call | Incident recovery: 409 conflict, drain timeout, runaway cost, OOM, db corruption, zombie poller, network drops |
| [docs/GLOSSARY.md](./docs/GLOSSARY.md) | Everyone | Alphabetical reference for Solrac-specific terms |
| [docs/ROADMAP.md](./docs/ROADMAP.md) | Maintainers | Step 9 webhook spec, 13 open questions, deferred enhancements |

Auxiliary references in the source tree:

- `docs/SDK_NOTES.md` — verified Claude Agent SDK surface, pinned to `0.2.119`
- `docs/SLASH_COMMANDS_DESIGN.md` — design notes for the `/help`, `/status`, `/context`, `/clear`, `/compact` surface
- `deploy/systemd/README.md` — install commands for the three systemd units

Web UI deep-dives are split across the existing docs:

- [SETUP.md §11](./docs/SETUP.md#11-optional-enable-the-browser-web-ui) — turning it on, security notes
- [USAGE.md "Web UI"](./docs/USAGE.md#web-ui-browser-interface) — feature parity with Telegram, markdown rendering
- [CONFIG.md](./docs/CONFIG.md#variables) — the five `SOLRAC_WEB_*` env vars
- [OPERATIONS.md "Web UI (optional)"](./docs/OPERATIONS.md#web-ui-optional) — boot verification, route reference, audit queries
- [ARCHITECTURE.md "Web UI transport"](./docs/ARCHITECTURE.md#web-ui-transport-optional) — module map, markdown sidecar, anti-goal posture
- [RUNBOOK.md "Web UI not reachable"](./docs/RUNBOOK.md#web-ui-issues) and ["streaming silent"](./docs/RUNBOOK.md#web-ui-stream-silent) — troubleshooting

## Repository layout

```
solrac/
├── README.md                        — you are here
├── SOUL.md                          — voice + safety; canonical default copied to launch cwd
├── SOLRAC.md                        — operator overlay template; copied to launch cwd
├── package.json
├── tsconfig.json
├── .env.example                     — copy to .env
│
├── src/
│   ├── log.ts                       JSON-to-stdout logger
│   ├── config.ts                    env validation
│   ├── db.ts                        bun:sqlite + prepared statements
│   ├── allowlist.ts                 isAllowed / bootstrap
│   ├── session.ts                   per-chat, per-tier session state
│   ├── mutex.ts                     KeyedMutex with depth()
│   ├── semaphore.ts                 counting global concurrency cap
│   ├── turn-tracker.ts              drain-aware in-flight set
│   ├── queue.ts                     compose mutex + semaphore + tracker
│   ├── telegram.ts                  raw fetch + tgCall + 429 retry
│   ├── poll.ts                      long-poll + PID file + dedupe
│   ├── policy.ts                    classifier, cost cap, broker, loop, hooks, engine-prefix parser
│   ├── instance.ts                  SOUL.md / SOLRAC.md bootstrap + load
│   ├── agent.ts                     Claude Agent SDK wiring (per-tier) + cross-engine bridge
│   ├── ollama.ts                    local Ollama runner (`>` prefix path)
│   ├── commands.ts                  slash command parser, dispatcher, handlers
│   ├── skills.ts                    operator-defined SKILL.md discovery
│   ├── server.ts                    /health + /stats
│   ├── lifecycle.ts                 graceful shutdown
│   ├── daily-report.ts              cost report cron
│   ├── main.ts                      transport wiring + engine dispatch
│   └── *.test.ts                    bun:test units
│
├── test/
│   └── smokes/
│       ├── harness.ts               openTestDb / mkUpdate helpers
│       ├── flood.ts                 db-pollution defense smoke
│       └── ollama.ts                live Ollama smoke
│
├── deploy/systemd/
│   ├── solrac.service               main long-running unit
│   ├── solrac-bounce.service        oneshot restart helper
│   ├── solrac-bounce.timer          weekly bounce schedule
│   └── README.md                    install + verify
│
├── docs/                            (this README's siblings)
│   ├── SETUP.md
│   ├── USAGE.md
│   ├── CONFIG.md
│   ├── ARCHITECTURE.md
│   ├── OPERATIONS.md
│   ├── RUNBOOK.md
│   ├── GLOSSARY.md
│   ├── ROADMAP.md
│   ├── SDK_NOTES.md
│   └── SLASH_COMMANDS_DESIGN.md
│
└── data/                            gitignored
    ├── solrac.sqlite                + WAL + SHM
    ├── solrac.pid                   PID file
    └── workspaces/<chatId>/         per-chat agent cwd
```

## Stack

- **Runtime:** [Bun](https://bun.sh) (≥1.3.0). Required for `bun:sqlite`, `bun:test`, and `Bun.serve`.
- **Package manager:** npm.
- **Agent SDK:** [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) `0.2.119` (pinned exact, no caret).
- **Database:** `bun:sqlite` with `journal_mode = WAL`.
- **HTTP:** `Bun.serve` `routes` (no framework).
- **Telegram client:** raw `fetch` + `tgCall` (no framework runtime; `@grammyjs/types` for types only).
- **Process supervision:** systemd (`Type=simple`, `Restart=on-failure`, `TimeoutStopSec=90`, hardening via `NoNewPrivileges` / `ProtectSystem=strict` / `ProtectHome` / `PrivateTmp`).

## Design philosophy

Three commitments that shape every decision:

1. **Own the host process.** No HTTP framework, no Telegram framework runtime, no queue server. Everything that touches a chat, a tool, or the database lives in this Bun process. We trade libraries for clarity at production-scale-of-one.
2. **Audit before acting.** Every update — allowed, denied, queue-full — writes an `audit` row. The audit log is the source of truth for "what did the bot do today?"
3. **Defense in depth.** Allowlist + three-tier classifier + cost cap + loop detector + db-pollution defenses + sub-agent default-deny. Each defense is independent.

See [docs/ARCHITECTURE.md#philosophy](./docs/ARCHITECTURE.md#philosophy) for the full discussion.

## What's intentionally not here

See [docs/ARCHITECTURE.md#anti-goals](./docs/ARCHITECTURE.md#anti-goals) for the full list. Highlights:

- No HTTP framework. No Telegram framework runtime. No queue server. No Docker.
- No MarkdownV2 outbound (HTML's three escape characters beat MarkdownV2's twenty).
- No Bedrock/Vertex auth (direct Anthropic only).
- No sub-agents ([OQ#8](./docs/ROADMAP.md#oq8-sub-agent-enablement)).
- No webhook transport ([Webhook transport](./docs/ROADMAP.md#webhook-transport)).

If you want to revisit any of these, write the case in a PR description and treat it as an explicit reversal.

## Testing

```sh
npm test               # bun test
npm run typecheck      # tsc --noEmit
npm run smoke:flood    # synthetic db-pollution defense smoke
npm run smoke:ollama   # live Ollama smoke (requires Ollama on $OLLAMA_URL)
```

For live smokes against a dev bot, see [docs/RUNBOOK.md](./docs/RUNBOOK.md).

## Origin

Solrac was built as part of the [PNXStudios.com](https://pnxstudios.com) project to manage work on a complex monorepo from anywhere — Telegram in, code edits and shell out, with full audit and per-chat budget control. It's open-sourced as a complete, hackable foundation: the same ~2K lines of TypeScript that drive a real production workflow, with the building blocks — auditable agent loop, dual-Claude tier routing, local-Ollama escape hatch, per-chat cost caps, three-tier permission policy, operator-defined skills — laid bare for anyone to read, run, fork, or extend to a different transport (email, Slack, scheduled jobs, in-house dashboards).

## Contact

Open issues against this repository. Project owner: [@cjus](https://github.com/cjus).
