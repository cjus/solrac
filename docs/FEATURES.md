# Features

The complete feature list, grouped by theme. See [../README.md](../README.md) for the project overview, motivations, and quick-start instructions.

## Engines & routing

- **Local-first engine routing** — *Claude only when explicitly requested.* No-prefix messages route to the local engine (free) by default; `@` escalates to Sonnet, `!` escalates to Opus. Pinable via `SOLRAC_DEFAULT_ENGINE` (`local` | `primary` | `secondary`) for Claude-only deploys. Boot validation rejects unreachable combinations.
- **Multi-backend local engine with tool support** — `LOCAL_BACKEND` selects the wire protocol: `ollama` (NDJSON `/api/chat`) or `lmstudio` (SSE `/v1/chat/completions`). When `LOCAL_TOOLS_ENABLED=true`, the local model (e.g. `gemma4:e4b`, `qwen2.5-7b`) calls the same `mcp__solrac__*` integrations the Claude tiers see. Multi-round tool loop with shared loop detector, broker UX, and iteration cap (`LOCAL_MAX_TOOL_ITERATIONS=8`). Cross-engine context bridge means switching between local and Claude preserves the conversation thread.
- **Dual-Claude tier routing** — `@` → primary tier (Sonnet by default), `!` → secondary tier (Opus by default). Each tier keeps its own SDK session id so prompt caching survives same-tier turns. Per-tier thinking-stub emoji (💻 local / 🙂 primary / 🤔 secondary) makes the routing visible in chat.

## Persona, commands & extensions

- **Customizable persona via `SOUL.md` + `SOLRAC.md`** — two operator-editable markdown files at the launch directory. `SOUL.md` (voice, stance, safety) ships with the package and is read once at boot. `SOLRAC.md` (operator overlay: who runs it, channel posture, project context) is re-read every turn so live edits land on the next message without a restart. See [USAGE.md#customizing-solrac-soulmd-and-solracmd](./USAGE.md#customizing-solrac-soulmd-and-solracmd).
- **Slash commands** — `/help`, `/status`, `/context`, `/clear`, `/compact` give the operator visibility and control over conversation context, spend, and session state without leaving Telegram. Both `/cmd` and `:cmd` invoke the same handler (`:` avoids Telegram's auto-link on bold text).
- **Operator-defined skills** — drop a `SKILL.md` into `$SOLRAC_SKILLS_DIR/<name>/` and that filename becomes a slash command on the next boot. `{{args}}` templating; per-skill `max_turns` (1–10) so a single-shot text transform stays bounded while an agentic skill (e.g. `notion_search` → `notion_create_page`) gets headroom; the body runs with the same Claude Code tool preset (Claude tiers) or integrations MCP catalog (local tier) as a normal turn, under the same three-tier policy, cost cap, and loop detector. Optional `requires:` frontmatter gates a skill on named integrations being loaded at boot — missing deps → skill skipped, never appears in `/help` or autocomplete. Optional `tool: true` exposes the skill as a callable MCP tool to the local agent (Phase 1: `tier: local` only) so natural-language requests can route through your prompts. Off by default; enable with `SOLRAC_SKILLS_ENABLED=true`.
- **Scheduled tasks** — drop a `TASK.md` into `$SOLRAC_TASKS_DIR/<name>/` and the prompt fires on its configured schedule (`every 1h`, `daily_at 09:00`, `at 2026-05-15T13:00:00Z`) into a configured chat. Engine inheritance (defaults to `config.defaultEngine`), per-task `max_cost_usd`, boot catch-up jitter; fires synthesize updates through the same turn queue so all existing safety machinery applies. `/tasks` lists loaded tasks with last + next fire; `/tasks run <name>` triggers on demand. Off by default; enable with `SOLRAC_TASKS_ENABLED=true`. See [USAGE.md#scheduled-tasks](./USAGE.md#scheduled-tasks).

## Transport

- **Optional browser web UI** — a second `Bun.serve` instance on a configurable port serves a minimal vanilla-JS chat interface with the same agent loop, slash commands, engine routing, and tool-confirm UX as Telegram. Full markdown rendering (headers, lists, tables, fenced code) on both transports — Claude and local responses get a server-side markdown→HTML pass for Telegram and the raw markdown to the browser. Off by default; enable with `SOLRAC_WEB_ENABLED=true` plus a token. See [USAGE.md#web-ui-browser-interface](./USAGE.md#web-ui-browser-interface).
- **Multi-user, multi-chat** — gated by per-`from.id` allowlist.

## Safety & audit

- **Three-tier permission policy** — auto-allow / auto-deny / Telegram-inline-keyboard-confirm. Configurable rule tables.
- **Per-chat hourly cost cap** — sliding 60-minute window over the audit log. Default $1.00/chat/hour.
- **Loop detector** — denies the third call to the same `(toolName, input)` within a turn. Order-insensitive over JSON keys.
- **Persistent audit trail** — every turn (allowed, denied, queue-full) writes a SQLite row with prompt, response, tool calls, cost, tokens, session id, status, **and engine** (`claude:primary:<modelId>` / `claude:secondary:<modelId>` / `local:<backend>:<modelId>`).
- **Session resume across restarts** — SDK session ids persisted per chat **and per tier**; conversations survive process death.
- **Inline-keyboard confirm UX** — 60-second timeout, fail-closed on send failure, verdict stamped into chat history after tap.
- **Sub-agent default-deny** — `Agent`/`Task` tools disabled at SDK + policy layers.
- **DB-pollution defenses** — denial throttle (1 row per `from.id` per minute under flood), per-chat queue depth cap, prompt truncation with surrogate-pair safety.

## Operations

- **Bearer-gated `/stats` endpoint** — RSS, in-flight turns, 24h spend; `node:crypto.timingSafeEqual` constant-time auth.
- **Daily cost report** — DM'd to allowlist's first entry; idempotent via meta-key check; UTC midnight window.
- **Graceful shutdown** — SIGINT/SIGTERM aborts polling, drains in-flight turns (60s cap), checkpoints WAL, removes PID file, exits cleanly.
- **Weekly auto-bounce** — systemd timer mitigates Bun long-uptime memory drift.
- **Concurrency primitives** — per-chat `KeyedMutex`, global `Semaphore`, drain-aware `TurnTracker`.
- **No HTTP framework, no Telegram framework runtime, no queue server, no Docker** — focused TypeScript, no hidden middleware.
