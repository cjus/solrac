# Solrac

> A self-hosted personal Agent you can configure, hack, and **converse with**. Reach it by text from Telegram or a browser, or by voice (ElevenLabs STT + TTS) on either transport. Free local LLM (Ollama / LMStudio) or remote (OpenRouter) by default; escalate to Anthropic's Claude Sonnet (`@`) or Opus (`!`) only when you mean it. Own every audit row, permission rule, and budget cap.

<image src="./docs/solrac.png" width="300px" />

## Why Solrac

Solrac is a single-process agent that bridges Telegram and a browser UI to a **bring-your-own-model engine slot** — local (Ollama / LMStudio) or remote (OpenRouter) — escalating to Claude Sonnet (`@`) or Opus (`!`) only when you explicitly ask. It was built as part of [PNXStudios.com](https://pnxstudios.com) to manage that complex monorepo from anywhere — and, in doing so, to explore the mechanics of building a personal agent from first principles while enforcing hard cost controls and behavior auditing on every turn.

It's deliberately smaller and narrower than other personal-assistant projects:

- **[OpenClaw](https://github.com/openclaw/openclaw)** — Node/TypeScript "Gateway" daemon with macOS/iOS/Android companion apps, Voice Wake, Live Canvas, and ~25 inbound channels.
- **[Hermes Agent](https://github.com/NousResearch/hermes-agent)** (Nous Research) — Python, multi-provider, self-improving agent with seven execution backends and broad transport (Telegram/Discord/Slack/WhatsApp/Signal/Email/CLI).

Both are broader and better-resourced. **Solrac's distinct value:**

- **BYO-model engine slot.** No-prefix messages route to whichever model source you wire — free on-host (Ollama / LMStudio) or pay-per-token remote (OpenRouter). `@` (Sonnet) and `!` (Opus) are paid Claude escalations only on operator intent.
- **Cost enforcement, not just visibility.** Sliding per-chat and global hourly USD caps that *deny* turns when hit — they sum every `cost_usd` row (Claude or OpenRouter), so remote-mode burn is gated by the same ceilings without extra configuration. Plus a daily cost-report DM. Voice spend (ElevenLabs STT + TTS, when enabled) rides a **second** independent cost-cap axis with its own per-chat + global ceilings.
- **Voice on every transport.** Telegram voice notes get transcribed; the web UI has a mic button and per-message speak buttons. `/voice on` turns on terse audio replies. ~120 lines of `fetch` against ElevenLabs — no SDK, no realtime WebSocket. Off by default.
- **Audit-before-acting.** Every update (allowed, denied, queue-full) writes a row to one append-only SQLite table, tagged with the engine that served it (`local:ollama:...`, `remote:openrouter:...`, `claude:primary:...`). Voice gets a parallel `voice_events` log — every STT/TTS attempt (allowed, capped, denied, errored) is recorded.
- **Single-process minimalism.** No HTTP framework, no Telegram framework runtime, no queue server, no Docker, no sub-agents. A few thousand lines of TypeScript you can read in an afternoon and fork.

If you need multi-tenancy, always-listening voice wake, mobile companions, or 25 chat platforms, use OpenClaw or Hermes. If you want a small, cost-capped, fully audited foundation — with optional speech-to-text and text-to-speech on Telegram and the browser — that you can bend to your shape, Solrac fits.

## Quick start

**Packaged binary** (macOS/Linux):

```sh
curl -fsSL https://cjus.dev/solrac/install.sh | sh
```

**From source** (Bun required):

```sh
git clone https://github.com/cjus/solrac.git
cd solrac && npm install && cp .env.example .env
npm run dev
```

Need help with Bun, a Telegram bot, or an Anthropic API key? See [docs/SETUP.md](./docs/SETUP.md) (~20 min walkthrough). Full install reference at [docs/INSTALL.md](./docs/INSTALL.md).

## Documentation

| Doc | Audience | What it covers |
|-----|----------|---------------|
| [docs/FEATURES.md](./docs/FEATURES.md) | Everyone | Complete feature list, grouped by theme |
| [docs/INSTALL.md](./docs/INSTALL.md) | Operators | curl-pipe install, `~/.solrac/` layout, upgrade & uninstall |
| [docs/SETUP.md](./docs/SETUP.md) | First-time users | Bun, Telegram bot, `from.id`, Anthropic key, first boot |
| [docs/USAGE.md](./docs/USAGE.md) | Daily users | Concepts, interaction patterns, permission UX, cost cap, loop detector |
| [docs/CONFIG.md](./docs/CONFIG.md) | Operators | Full env-var reference |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | Developers | Module map, data flow, concurrency, schema, policy, threat model, philosophy, anti-goals |
| [docs/OPERATIONS.md](./docs/OPERATIONS.md) | Operators | systemd deploy, `/health` & `/stats`, daily report, audit queries |
| [docs/SCHEMA.md](./docs/SCHEMA.md) | Operators / debuggers | SQLite schema + query cookbook |
| [docs/RUNBOOK.md](./docs/RUNBOOK.md) | On-call | Incident recovery: cost runaway, drain timeout, db corruption, … |
| [docs/GLOSSARY.md](./docs/GLOSSARY.md) | Everyone | Solrac-specific terms |
| [docs/ROADMAP.md](./docs/ROADMAP.md) | Maintainers | Open questions, deferred enhancements |

## Contact

Open issues against this repository. Project owner: [@cjus](https://github.com/cjus).
