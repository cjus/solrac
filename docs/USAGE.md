# Usage

How to interact with Solrac once it's running. If you haven't booted yet, start at [SETUP.md](./SETUP.md).

## Concepts you need

### Turn

One round-trip: a user message → an SDK `query()` invocation → a final reply. Each turn writes exactly one `audit` row (with `status='ok'` or `'error'`). A single turn may chain many tool calls under the hood.

### Session

Each chat has its own SDK session id, persisted in the `sessions` SQLite table and replayed via `Options.resume` on every subsequent turn. **Sessions survive restarts.** When you reboot Solrac, your conversation continues where it left off.

To start a fresh session for a chat, delete the row:

```sh
sqlite3 data/solrac.sqlite \
  "DELETE FROM sessions WHERE chat_id = <your-chat-id>"
```

### `from.id` vs `chat.id`

Two different Telegram identifiers:

- **`from.id`** — the user who sent the message. The allowlist gates on this.
- **`chat.id`** — the conversation. In a private DM, equals `from.id`. In groups, it's a separate (negative) number.

Solrac uses `from.id` for security (allowlist) and `chat.id` for state (sessions, workspaces, queue, cost cap). This split matters: if you forward a message from a non-allowlisted contact into your DM with the bot, the **forwarder's** `from.id` is what Solrac sees, not the original author's.

### Audit row

Every attempted turn — allowed, denied, queue-full — writes one `audit` row. The audit log is append-only and serves as both observability and forensic backstop. See [OPERATIONS.md](./OPERATIONS.md#audit-queries) for queries.

### Workspace

The agent's `cwd` is `<DATA_DIR>/workspaces/<chatId>/`, created on first turn. Files the agent writes (via the `Write`, `Edit`, or `Bash` tools) land there. Workspaces accumulate over time; cleanup is currently manual (the janitor is deferred — [OQ#4](./ROADMAP.md#oq4-workspace-janitor)).

## Talking to the bot

Open a DM with your bot in Telegram and just type. Plain English works for the agent path; slash commands give you control over context and visibility (see [Slash commands](#slash-commands) below).

> what time is it?

> count the .ts files under src/

> read package.json and summarize the dependencies

> write a haiku about kubernetes to haiku.txt

The bot responds by editing a single thinking-stub message. The stub emoji tells you which engine is handling the turn (handy for visual debugging without checking logs):

| Engine | Stub |
|--------|------|
| Primary Claude (Sonnet) | `🙂 thinking…` |
| Secondary Claude (Opus) | `🤔 thinking…` |
| Ollama | `🦙 thinking…` |

You'll see it transition through:

1. `🙂 thinking…` *(or `🤔` / `🦙` per the table above)*
2. `⚙️ Bash` *(tool name appears once a tool fires)*
3. `⚙️ Bash`
   `<tool output rendered>`
4. Final state: full answer + `<i>✅ 3 turns · $0.0421</i>` footer.

The footer reports turn count and cost in USD.

## Engine routing (prefix table)

The first non-whitespace character of your message picks the engine. The
default routes to local Ollama, so Anthropic burn happens only on a
deliberate `@` or `!`; everything else stays local and free.

| Prefix | Engine | Default model | Use when |
|--------|--------|---------------|----------|
| (none) | **Default** (per `SOLRAC_DEFAULT_ENGINE`, ships as Ollama) | `OLLAMA_MODEL` (recommended `gemma4:e4b`) | The free default. Local model handles casual chat + tool-driven work via integrations. |
| `@` | Primary Claude — escalate | `SOLRAC_PRIMARY_MODEL` (default `claude-sonnet-4-6`) | When the task needs Sonnet-level reasoning, file ops, or the SDK's preset tools. Costs $$$. |
| `!` | Secondary Claude — heaviest | `SOLRAC_SECONDARY_MODEL` (default `claude-opus-4-7`) | When Sonnet isn't enough. Costs $$$$. Mnemonic: `!` = "important / hardest". |

Examples (with the recommended default `SOLRAC_DEFAULT_ENGINE=ollama`):

```
hello                          → local Ollama (default)
what's the capital of france?  → local Ollama (default)
@dive deep into this codebase  → primary Sonnet (escalate)
!hard architectural question   → secondary Opus (heaviest)
```

There is no `>`-style escape prefix. A leading `>` is literal user text
routed to the default engine like any other message.

**Escalation.** Switch tiers mid-conversation freely. All three engines share
the same audit-table thread for a chat; the bot prepends the other tier's
recent turns as an "out-of-band" block so the next message picks up the
thread regardless of which engine ran the prior turn.

The `@` / `!` and one optional space are stripped from the start of the
message. To send a literal `@` or `!` as the first character of your prompt,
double it (`!!literal` produces `!literal`).

### Escalation (when to reach for Claude)

Reach for `@` (Sonnet) when:
- The task needs structured tool use beyond the operator's integrations (file edits, web fetches, complex shell).
- You want strong code reasoning or multi-step planning the local model can't sustain.
- The conversation needs a long context window the local model truncates.

Reach for `!` (Opus) when:
- `@` already responded but missed the nuance.
- You're doing architecture review, hard math, or anything where extra cost is justified by extra correctness.

Stay on the default (Ollama) when:
- The question is casual / one-shot / self-contained.
- The operator has integrations the local model can call (`OLLAMA_TOOLS_ENABLED=true`).
- You want zero Anthropic burn.

Both Claude tiers run through the same SDK preset (`claude_code`), the same
tools, the same `canUseTool` policy, and the same `<untrusted-content>`
clause. Only the model id differs. Each tier keeps its own SDK session id, so
prompt caching survives across same-tier turns.

### Default engine details

The default-engine identity is server-resolved from `SOLRAC_DEFAULT_ENGINE`:

| `SOLRAC_DEFAULT_ENGINE` | What no-prefix routes to | Capability note tone |
|---|---|---|
| `ollama` (default) | Local Ollama (`OLLAMA_MODEL`) | "you are the default chat engine; tools when `OLLAMA_TOOLS_ENABLED=true`; escalate via `@` / `!`" |
| `primary` | Anthropic Sonnet | Same as `@` Sonnet (Claude-only deploys) |
| `secondary` | Anthropic Opus | Same as `!` Opus (Claude-only deploys) |

**Default-Ollama details:**
- **Free** — `cost_usd = 0`; the per-chat and global cost caps don't apply.
- **Footer** — `<i>✅ ollama:gemma4:e4b · 1.2s</i>` (or `· N tools · 1.2s` when tools fired).
- **Tools** — when `OLLAMA_TOOLS_ENABLED=true` and integrations are loaded, the local model can call `mcp__solrac__*` tools the same way Claude does.
- **Cross-engine context** — sees prior Claude turns (both tiers).

**Default-Ollama failure modes:**

| Condition | What you see |
|-----------|--------------|
| `@` / `!` alone with no payload | `usage: @<prompt> — sends to primary Claude (model: <model>)` |
| Ollama not running | `❌ ollama unreachable: http://localhost:11434` (boot also logs `ollama.boot_health_failed`) |
| Model not pulled on the host | `❌ ollama model not found: <model> — pull with 'ollama pull <model>' on the host` |
| Tool loop didn't converge | `⚠️ stopped after N tool iterations` |
| Inference exceeds `OLLAMA_TIMEOUT_MS` | `❌ ollama timed out after 60s` |

See [CONFIG.md](./CONFIG.md) for the full env list.

## Slash commands

Slash commands give you control over conversation context and visibility into spend without querying the database. Both `/cmd` and `:cmd` invoke the same handler — `/cmd` enables Telegram's autocomplete (registered via `setMyCommands` at boot); `:cmd` is a non-auto-linked alias the help card uses for visual cleanliness. They're equivalent.

| Command | Default | Behavior | Cost |
|---------|---------|----------|------|
| `/clear [primary\|secondary\|ollama\|all]` | `all` | For Claude tiers: drop the SDK session id and any pending compaction summary. For `ollama`: write a per-chat cutoff timestamp; both Ollama's own history reconstruction AND Claude's cross-engine bridge then hide every prior Ollama turn for this chat. Next turn for the targeted tier(s) starts fresh. | Free |
| `/compact @\|!` | **none** — tier required | Run a one-shot Claude turn that summarizes this tier's recent conversation, store the summary, drop the SDK session id. The summary is prepended into a fresh SDK session on the next user turn for that tier. **Bare `/compact` rejects** — Ollama has no SDK session to summarize. | One Claude turn (Sonnet ≈ $0.001-0.005, Opus ≈ $0.005-0.025) |
| `/context @\|!` | **none** — tier required | Show audit-table footprint (bytes), turn count, last turn's token breakdown (fresh / cache read / cache create / output), and estimated next-turn replay size. **Bare `/context` rejects** for the same reason as `/compact`. | Free |
| `/help` | — | Engine prefix table + command reference. Engine section is dynamic (renders the deploy's actual default). | Free |
| `/status` | — | Per-chat session/spend snapshot + global rollup + queue depth + uptime. Claude session lines render only when a session exists; an `ollama turns (24h): N` bullet is added when applicable. | Free |

### Tier args

For `/clear` and `/compact` and `/context`, the optional argument selects a tier. Aliases:

| Token | Maps to |
|-------|---------|
| `primary`, `p`, `@` | primary |
| `secondary`, `s`, `!` | secondary |
| `ollama`, `o`, `>` | ollama (only valid for `/clear`) |
| `all`, `*` | all three (only valid for `/clear`) |

Examples:

```
/clear              → drops all three (default = all)
/clear primary      → drops primary Claude session only
/clear !            → drops secondary Claude session only (`!` mnemonic from engine prefix)
/clear ollama       → sets Ollama context cutoff for this chat (no SDK session to drop — see below)
/clear >            → same as /clear ollama (`>` mnemonic from engine prefix)
/compact            → compacts primary
/compact !          → compacts secondary
:context            → same as /context (alternate prefix)
```

`/clear ollama` semantics differ from the Claude tiers because Ollama is stateless — there's no SDK session id to drop. Instead, the dispatcher writes `Date.now()` to `sessions.ollama_cutoff_ms` for this chat. Subsequent `recentChatTurns` lookups (Ollama's history reconstruction) and `outOfBandForEngine` lookups (Claude's cross-engine bridge) filter out Ollama rows with `started_at <= cutoff`. The audit log itself is untouched — operator queries against `audit` still show every turn. The cutoff is per-chat and survives restarts. A back-to-back `/clear ollama` with no intervening turn reports "Already clean" (the cutoff is already past every existing row).

### `/compact` semantics

- Pre-flight: per-chat hourly cap and global hourly cap are checked **before** the SDK call. If either is exceeded, the rejection is recorded as an audit row tagged with the engine model (so future cap queries see consistent rollups), no Claude call is made.
- Source data: up to 50 most recent successful turns for the chat+tier, filtered by `started_at > previous summary timestamp` so back-to-back `/compact` doesn't re-summarize the same window.
- Summarizer: a fresh `query()` call with **no `resume`**, `maxTurns: 1`, `disallowedTools: [Bash, Write, Edit, …]`, and `canUseTool: deny-all`. Tools are blocked belt-and-suspenders.
- Persistence on success: summary text + timestamp stored in `sessions.<tier>_summary` / `sessions.<tier>_summary_at`; `<tier>_session_id` cleared atomically.
- Consumption: on the next user turn for that tier, `runAgent` injects the summary as a labeled prefix block before the user's prompt and starts a fresh SDK session. After the turn succeeds, the summary is cleared. If the turn errors, the summary is left intact for retry.
- **Source quality caveat**: the `audit.prompt` column is truncated to 256 chars at insert (a defensive cap). The summary input therefore sees full Solrac responses but truncated user prompts. For long pasted briefs, the summary may underweight your original requirements. The operator-side log `compact.source_prompts_truncated` fires when ≥1 source row was truncated; consider capturing the brief externally for long sessions.

### `/context` and `/status` distinction

- `/context [tier]` — drills into ONE tier: the SDK session id, audit footprint in bytes, last turn's full token breakdown (fresh + cache_read + cache_create + output) and estimated next-turn replay size. Shows the **real on-the-wire input** on resumed sessions, not just the post-cache fresh portion.
- `/status` — chat-level summary across both tiers + global rollup. Lighter than `/context`. Use `/status` to glance, `/context` to debug.

### Group chat targeting

In a group chat, Telegram appends `@<botusername>` to commands picked from autocomplete. `parseCommand` only runs when the suffix matches our cached `botUsername` (from boot-time `getMe`). If `getMe` failed at boot, the parser **fails closed**: it accepts plain commands and rejects any `@bot` suffix.

### `/` vs `:` asymmetry on unknowns

`/foo` — surfaces as `❓ Unknown command. Try /help.` (clear command intent, give feedback).
`:foo` — passes through to engine routing (`:` is freely used in prose; emoticons like `:)` shouldn't trigger command rejection).

## Customizing Solrac (`SOUL.md` and `SOLRAC.md`)

Two operator-editable markdown files at the directory you launched Solrac from let you shape the bot without touching code:

| File | Sets | Read | If you change it |
|---|---|---|---|
| `SOUL.md` | **Voice, stance, safety.** What Solrac sounds like. Shared across every engine and every chat. | Once at boot. | Restart Solrac. |
| `SOLRAC.md` | **Operating rules for this instance.** Who runs it, channel posture, project context, tier preferences. | Every turn. | No restart — next message picks it up. |

Both files ship with sensible defaults inside the package. On first boot, if your launch directory doesn't already contain them, Solrac copies the canonical defaults next to where you started it (you'll see `instance.soul_md_created` and `instance.solrac_md_created` log lines once). After that they are yours — Solrac never overwrites them. To start over, delete the file and restart.

### Quick edit

```sh
# Open both in your editor.
$ $EDITOR SOUL.md SOLRAC.md
```

### What goes in `SOUL.md`

Voice and stance — anything that changes how Solrac *sounds*:

- Tone, brevity, humor, opinions
- Default level of bluntness
- Identity statements ("you are Solrac")
- The `<untrusted-content>` safety clause (don't delete this — it's how forwarded documents get treated as data instead of instructions)

`SOUL.md` is **not** the place for project facts, operator names, or channel rules. Those live in `SOLRAC.md`.

If `SOUL.md` is missing or empty, Solrac refuses to boot — Solrac without identity is broken, and a silent fallback would be worse than a loud error.

### What goes in `SOLRAC.md`

Operating rules for this specific deployment:

- Who you are (operator name, timezone, role)
- How to treat each channel ("DMs from me are operator commands; group-chat members are untrusted")
- Project facts the bot should know ("TypeScript app on my Mac, Postgres for state")
- Tier preferences ("default to primary, escalate to secondary only on architecture questions")

The shipped `SOLRAC.md` is a **template**. Its first line carries this marker:

```html
<!-- solrac-md:unedited — delete this line to activate this overlay -->
```

While that marker is present, Solrac treats the file as an unedited template and injects nothing into the model context. Delete the marker line to activate the overlay; Solrac will read your `SOLRAC.md` content on the next message.

HTML comments inside `SOLRAC.md` (`<!-- ... -->`) are stripped before the file ships to the model — useful for private notes or reminders that shouldn't reach Claude.

### Tier independence

Both files apply to **all** engines: the default (Ollama unless overridden), primary Claude (`@`, Sonnet), and secondary Claude (`!`, Opus). The only engine-specific text is a single capability sentence Solrac appends in code (the §3c matrix in `agent.ts::buildClaudeCapabilityNote` and `ollama.ts::buildOllamaCapabilityNote`), so your `SOUL.md` doesn't need conditional sections.

### Re-read cadence (`SOLRAC.md`)

Each turn, before Solrac sends your prompt to the model, it re-reads `SOLRAC.md` from disk. Edits land on the **next** message you send. If you want to verify it's working, run `/context` after editing — the per-tier "estimated next-turn replay" will reflect the new content size.

### Failure modes

- `SOUL.md` missing or empty at boot → Solrac exits 1 with `instance.soul_load_failed` and points at the path it tried.
- `SOLRAC.md` missing → soft-warn nothing, Solrac runs without an overlay.
- `SOLRAC.md` contains only HTML comments and/or whitespace → treated as unedited template, no injection.
- `SOLRAC.md` carries the `solrac-md:unedited` marker anywhere in the file → treated as unedited template, no injection.
- Disk read error mid-turn → that turn skips the overlay and logs `instance.solrac_md_read_failed`; the user-facing reply is unaffected.

### Worked example

You start Solrac from `~/solrac`:

```sh
~/solrac $ ls
.env  data/
~/solrac $ bun run src/main.ts
{"...":"instance.soul_md_created","path":"~/solrac/SOUL.md"}
{"...":"instance.solrac_md_created","path":"~/solrac/SOLRAC.md"}
{"...":"solrac.boot",...}
```

You activate the overlay and add operator context:

```sh
# Delete the unedited marker, fill in the Operator section.
~/solrac $ $EDITOR SOLRAC.md
```

```markdown
# Solrac — instance configuration

## Operator
<your-name> (<you@example.com>), America/Denver. Software engineer.
Prefers TypeScript, terse replies, and Claude Sonnet for everyday work.

## Project context
- Standalone TypeScript app on the operator's Mac.
- Postgres for state; S3 for blobs.
```

Send a message. The next turn ships your `SOLRAC.md` content wrapped in `<solrac-md>...</solrac-md>` ahead of your prompt. Solrac now knows who you are without you having to retype it on every conversation.

## Skills (operator-defined commands)

> Status: opt-in via `SOLRAC_SKILLS_ENABLED=true`. Disabled by default.

A **skill** is a single `SKILL.md` file under `$SOLRAC_SKILLS_DIR/<skill-name>/SKILL.md` that defines a new slash command without touching TypeScript. Skills are operator-authored, version-controlled per deployment, and discovered ONCE at boot — no hot-reload.

When enabled, every loaded skill becomes:

- A new `/<skill-name>` and `:<skill-name>` command (dispatched ahead of "unknown command" fallback).
- A row in `setMyCommands` so Telegram autocomplete shows it alongside the built-in commands.
- A line in `/help` under a **Skills** section.

### Filesystem layout

```
$SOLRAC_SKILLS_DIR/
  summarize/
    SKILL.md
  briefly/
    SKILL.md
```

The directory path comes from `SOLRAC_SKILLS_DIR` (default `./skills`, resolved relative to the working directory Solrac was launched from). Each skill lives in its own subdirectory so future companion files (examples, tests, manifests) can sit alongside without filename collisions.

### `SKILL.md` schema

```yaml
---
name: summarize           # required, [a-z0-9_]{1,32}, must not collide with built-in commands
description: Summarize the URL or pasted text in 3 bullets.   # required, ≤256 chars
tier: primary             # optional, primary|secondary|ollama, default = SOLRAC_DEFAULT_ENGINE
max_turns: 1              # optional, integer in [1,10], default 1. Model-turn budget for the skill body. Pure text-transforms want 1; agentic skills that chain tool calls (e.g. `notion_search` → `notion_create_page`) need headroom. Doubles as `maxIterations` for the Ollama tool loop.
tool: false               # optional, default false. When true, also expose this skill as a callable MCP tool to the Ollama agent (Phase 1: requires tier: ollama).
requires: notion          # optional, integration deps. Bare string OR array (`requires: [notion, gmail]`). When any name is missing from the loaded integrations at boot, the skill is skipped with a `skills.load_error` warn — it never appears in `/help` or Telegram autocomplete. Omit for unconditional load.
auto_allow: false         # optional, default false. When true, every `confirm`-tier tool the skill body calls bypasses the Telegram prompt and runs directly. The skill's purpose IS the operation (e.g. `/log` → Notion write) — re-prompting on every call hurts UX. Loop detector, hard-deny classifier, and cost cap still apply.
---
You are a concise summarizer. Produce exactly 3 bullets, no preamble.

Input:
{{args}}
```

Two required fields (`name`, `description`), five optional (`tier`, `max_turns`, `tool`, `requires`, `auto_allow`), plus a body. The body is a prompt template — `{{args}}` is the only placeholder and gets replaced with whatever the user typed after the command (e.g. `/summarize <text>` → `args = "<text>"`). The substitution is literal text-for-text; no escaping, no nested templating.

The frontmatter parser supports a YAML *subset*: `key: scalar`, `key: [a, b, c]` string arrays, single- or double-quoted strings, integers, booleans. Multi-line strings, anchors, and nested maps are NOT supported and produce a clear error pointing at the offending line.

### What skills can do

Skills run with the full tool surface their tier provides, bounded by `max_turns` (default 1):

- **Claude tiers (`primary` / `secondary`)** — the body sees the same Claude Code tool preset a normal turn does (`Bash`, `Read`, `Edit`, `Write`, `WebFetch`, `WebSearch`, plus every `mcp__solrac__*` integration tool). `Agent` and `Task` stay denied at the SDK + policy layers — no sub-agents from inside a skill.
- **Ollama tier** — when the deploy has integrations + Ollama tools enabled, the body routes through the same `runToolLoop` driver as a regular Ollama turn and sees the full MCP catalog (minus its own `skills__<self>` entry — see "Skills as tools" below). Without integrations / tools, the path falls back to a single-shot `/api/chat` round trip.

Every tool call (both tiers) flows through the same three-tier policy (auto-allow / auto-deny / Telegram-confirm), the same `PreToolUse` cost-cap + loop-detector hooks, and the same `canUseTool` interactive confirm UX as a normal turn. A skill body that calls `Bash(rm -rf /)` gets denied identically — there's no skill-specific bypass *except* `auto_allow: true`, which suppresses ONLY the interactive Telegram-confirm prompt (the loop detector, hard-deny classifier, and cost cap all still gate). Reach for `auto_allow` on skills whose entire purpose is a known operation — `/log` writing to Notion, an Ollama-tier skill appending to a Google Drive doc — where re-prompting on every call costs more than it protects.

`max_turns` is the per-skill model-turn budget. A pure text-transform (summarize, translate) wants `max_turns: 1`. An agentic skill that chains tool calls (e.g. `/log` doing `notion_search` → `notion_create_page` → return URL) needs a few more; the bound caps runaway behavior the same way the SDK's `maxTurns` does for a regular turn. Hard ceiling is 10; the cost cap is the ultimate backstop on Claude tiers, `OLLAMA_MAX_TOOL_ITERATIONS` on Ollama.

This means skills are good for:

- **Text transformations** (summarize, translate, rephrase, format) — `max_turns: 1`, no `requires:`.
- **Integration-backed actions** (append a Notion row, send a Gmail draft, fetch a URL and summarize) — `max_turns: 3–5`, `requires: notion` (or whatever).
- **Templated prompts** the operator wants to invoke quickly without retyping.

**Tier inherits the deploy default.** When `tier:` is omitted, the skill runs on whatever `SOLRAC_DEFAULT_ENGINE` resolves to (`ollama`, `primary`, or `secondary`). Override per-skill with an explicit `tier:` value. `tier: ollama` is rejected at load if `SOLRAC_DEFAULT_ENGINE != ollama` (PR-B removed the `>` prefix; Ollama is reachable only as the deploy default).

### Cost & caps

A Claude-tier skill (`primary` or `secondary`) costs real Claude turns — up to `skill.maxTurns` of them. The audit row is tagged `claude:<tier>:<model>:skill:<name>` so cost rolls up under the existing per-chat hourly cap (`HOURLY_COST_CAP_USD`) and the global cap. The pre-flight cap check fires *before* the SDK call — a cap-rejected skill costs $0. Mid-turn cap exhaustion is caught by the `PreToolUse` hook (same path as a normal turn) and stamped into the audit row as `policy_deny:cost_cap_exceeded: …`.

An Ollama-tier skill is free. The audit row is tagged `ollama:<model>:skill:<name>` with `cost_usd = 0`; the per-chat hourly cap pre-flight is skipped (a chat throttled by Claude burn shouldn't lose access to local inference). When integrations + Ollama tools are enabled the skill body routes through the same `runToolLoop` a regular Ollama turn uses, capped at `skill.maxTurns` iterations and constrained by the shared loop detector. Without those wired (e.g. `OLLAMA_TOOLS_ENABLED=false` or no integrations loaded), the body falls back to a single non-streaming `/api/chat` round trip — no history, no SOLRAC.md overlay, no tool loop, no streaming stub. Either way, no Claude burn.

### Failure modes

- **`SKILL.md` parse error** at boot: the skill is dropped, others continue, a `skills.load_error` warn line names the file. Solrac doesn't crash.
- **Name collides with a built-in** (`clear`, `compact`, `context`, `help`, `status`): rejected at load with a warn line. The built-in always wins.
- **Two skills declare the same `name`**: first-wins (filesystem sort order). Second is dropped with a warn.
- **Skills directory doesn't exist** with `SOLRAC_SKILLS_ENABLED=true`: warn line, empty registry, boot continues.
- **Empty body after frontmatter**: rejected (no prompt to send).
- **`requires:` names an unloaded integration**: skill is skipped at boot with a `skills.load_error` warn line naming the missing integration(s). Skipped skills are absent from `/help` and Telegram autocomplete entirely — there's no use-time failure to confuse the user.

### Example: `briefly`

```
mkdir -p ./skills/briefly
cat > ./skills/briefly/SKILL.md <<'EOF'
---
name: briefly
description: Rewrite the input as one sentence.
---
Rewrite the following as exactly one sentence, ≤25 words. No preamble.

Input:
{{args}}
EOF

# Restart solrac. /briefly is now in /help and Telegram autocomplete.
```

### Limits to know

- Reply text is truncated to ~3,500 chars (Telegram's per-message ceiling is 4,096; we reserve headroom for HTML escaping overhead).
- The model's output is HTML-escaped before sending — your skill body cannot produce raw `<b>` tags. If a skill author wants formatted output, that's a v1.1 conversation.
- Hot-reload is intentionally absent: edit a `SKILL.md`, restart Solrac. This matches the boot-once config story (see `docs/CONFIG.md`).

### Skills as tools (Phase 1: Ollama-only)

A skill with `tool: true` in its frontmatter is *also* exposed as a callable MCP tool to the Ollama agent. The model sees the tool in its catalog as `mcp__solrac__skills__<name>` (wire format on Ollama: `skills__<name>`) with the operator-authored `description`. When the user types something natural like *"summarize this article: ..."*, the model can decide to call `skills__tldr` with `args: "<the article>"` instead of summarizing inline.

Phase 1 restrictions (locked-in):

- **`tool: true` requires `tier: ollama`.** Tool-callable skills run on the local model, free. Cross-engine tool calls (Ollama agent → Sonnet skill) are deferred to Phase 2 to avoid cost surprises.
- **Skill tools are exposed only to the Ollama agent.** The Claude SDK's tool catalog is untouched — Claude tiers can't yet call skills as tools.
- **Tools are auto-allow.** No Telegram-confirm prompt before each call. Cost cap is the backstop (Phase 1 ollama skills are free anyway).
- **Skills can call other skills (and any other MCP tool), but never themselves directly.** The skill's own `skills__<self>` entry is filtered out of the catalog the body sees, so direct recursion (`/foo` → `skills__foo`) is structurally impossible. Indirect cycles (A → `skills__B` → `skills__A`) are bounded by `skill.maxTurns` plus the shared loop detector (third identical `(tool, input)` in a turn → deny). A test (`skill-tools.test.ts`) asserts the self-filter; a regression breaks CI.

Audit visibility: every tool-called skill writes its own `audit` row tagged `origin='tool_call'` and `model='ollama:<model>:skill:<name>'`. Operator-typed `/<skill>` invocations stay tagged `origin='user'`, so the two surfaces are distinguishable in the audit log:

```sh
sqlite3 data/solrac.sqlite "SELECT started_at, origin, model, status FROM audit WHERE model LIKE '%:skill:%' ORDER BY started_at DESC LIMIT 20;"
```

Description quality matters: the model's natural-language → tool routing depends entirely on `skill.description`. Bad descriptions → wrong tool fires or misses. Write descriptions as if you're describing a tool to a model.

Latency: a tool-called skill costs at least one extra `/api/chat` round trip mid-loop, and more if the skill body itself loops over tools (bounded by `skill.maxTurns`). With `OLLAMA_MAX_TOOL_ITERATIONS=8` and `OLLAMA_TIMEOUT_MS=60000`, two skill calls per turn is roughly the practical ceiling on a busy turn before timeout risk; setting a generous `max_turns` on the skill multiplies that. Use `max_turns: 1` for fire-and-return skills (text transforms); bump it only when the skill genuinely needs to chain calls.

Example: `skills/tldr/SKILL.md` ships with `tool: true`. Type `summarize this: <long text>` to your Ollama deploy and watch the audit log — you'll see two rows: the Ollama parent turn (`origin: user`, `model: ollama:<m>`) plus the skill tool call (`origin: tool_call`, `model: ollama:<m>:skill:tldr`).

## Scheduled tasks

> Status: opt-in via `SOLRAC_TASKS_ENABLED=true`. Disabled by default.

Scheduled tasks are operator-authored prompts that fire on a timer into a configured chat. Use them for daily digests, weekly PR reviews, one-off reminders, or any prompt you want Solrac to run without you having to type it.

Each task is a `TASK.md` file in `$SOLRAC_TASKS_DIR/<name>/` (default `./tasks`). The file has YAML-ish frontmatter (metadata) plus a markdown body (the prompt that fires).

### Minimal example

```markdown
---
name: morning_digest
description: Weekday morning Notion ticket digest.
cron: "0 9 * * 1-5"
tz: America/Denver
---

You are running as the morning digest. List any Notion tickets in "In progress"
with no update in the last 48h. If there are none, reply "All clear."
```

Drop this file at `./tasks/morning_digest/TASK.md`, set `SOLRAC_TASKS_ENABLED=true`, restart. The prompt fires every weekday at 09:00 America/Denver into the operator's DM — assuming the operator has `/start`-ed the bot. If they haven't, the DM is dropped silently by Telegram; set `chat_id:` explicitly to avoid this. See [Where the reply lands](#where-the-reply-lands) below.

### Schedule grammar

Exactly one of `cron:` or `at:` must be present.

**`cron:`** — 5-field unix cron expression: `minute hour day-of-month month day-of-week`. Standard semantics: ranges (`12-18`), lists (`0,15,30,45`), steps (`*/30`), wildcards (`*`). Day-of-week `1-5` is Mon–Fri (`0`/`7` accept as Sun). Predefined aliases (`@daily`, `@hourly`) are **not** supported — use the 5-field equivalent.

**`tz:`** — optional IANA timezone (e.g., `America/Denver`, `Europe/Berlin`, `UTC`). Cron expressions evaluate against this wall-clock and DST shifts are handled by `cron-parser`: spring-forward skips the non-existent hour to the next valid moment; fall-back fires once, not twice. Defaults to `$TZ` env var, otherwise the host's runtime tz.

| Expression | Meaning |
|---|---|
| `cron: "0 * * * *"` | Top of every hour |
| `cron: "*/30 * * * *"` | Every 30 minutes |
| `cron: "0 9 * * *"` | Daily at 09:00 (in `tz`) |
| `cron: "0 9 * * 1-5"` | Weekdays at 09:00 |
| `cron: "*/30 12-18 * * 1-5"` | Every 30 min during 12:00–18:30 weekdays (14 fires/day; cron's `12-18` is inclusive of hour 18) |
| `cron: "0 0 1 * *"` | First of every month at midnight |

**`at:`** — single absolute fire. Must be ISO8601 with a `Z` suffix or explicit `±HH:MM` offset (timezone-naive strings are rejected).

```yaml
at: 2026-06-01T09:00:00-06:00
```

**Minimum interval (Claude tiers):** 5 minutes. The parser inspects the first 5 fire times of every cron expression at load time and rejects the task if any gap falls below the tier floor. So `* * * * *` is rejected on `engine: primary` / `secondary` but accepted on `engine: ollama` (Ollama's floor is 1 minute).

**Anchored vs drifting.** Cron is anchored: `0 * * * *` always fires at `:00` regardless of when Solrac last started. A mid-window restart at 14:13 with this expression fires next at 15:00, not 15:13. This is a behavior change from the pre-cron `every 1h` grammar, which drifted from `last_run_at`.

**Cron does not "catch up" first-deploy.** A fresh task at 14:00 with `0 9 * * *` waits until tomorrow 09:00 — not today's 09:00, not now. Cron is stateless: it fires at its anchors, period. If you want a one-time-now fire, add a sibling task with `at:`. Catch-up after restart (when `last_run_at` exists) still works: a missed window fires once at the next valid moment.

### Where the reply lands

`chat_id:` is the integer Telegram chat the scheduler synthesizes its update into. Omit it and Solrac falls back to the operator's allowlisted user id — a DM to you.

**DM gotcha.** Telegram silently drops bot DMs to any account that hasn't `/start`-ed the bot at least once. If you're configuring Solrac on a new account and skip `chat_id:`, scheduled fires will appear to do nothing — the audit log shows the turn fired and replied, but Telegram swallows the outbound message. Either `/start` the bot from the operator account once, or set `chat_id:` explicitly to a chat you know the bot can reach.

**Finding a chat_id:**

For a **DM**, your `chat_id` equals your Telegram user id — the exact value already in your `.env` as `ALLOWLIST_BOOTSTRAP`. Just copy it.

```sh
grep ALLOWLIST_BOOTSTRAP .env       # your user id == your DM chat_id
```

For a **group** or channel, `chat_id` is a negative integer (e.g., `-100123456789`). Send at least one message into the target chat with the bot present, then query the audit table:

```sh
sqlite3 data/solrac.sqlite \
  "SELECT DISTINCT chat_id, from_id FROM audit ORDER BY started_at DESC LIMIT 10"
```

```yaml
chat_id: 123456789        # DM to user 123456789
chat_id: -100123456789    # group chat (note the leading minus)
```

The bot must already be in a target group; the allowlist gate matches on the *sender's* `from.id`, so any operator-id `from.id` can fire a scheduled prompt into any `chat_id` the bot has access to. Pick a chat you don't actively type in — a scheduled fire waits behind any user turn already running in the same chat (per-chat KeyedMutex), so colocating with your live conversation introduces unpredictable timing.

### Migration from `schedule:` (pre-0.5.0)

The `schedule:` field was replaced by `cron:` / `at:` in v0.5.0. Map old TASK.md files using this table:

| Old `schedule:` | New | Notes |
|---|---|---|
| `every 1m` | `cron: "* * * * *"` | Ollama only (Claude floor 5m) |
| `every 5m` | `cron: "*/5 * * * *"` | |
| `every 30m` | `cron: "*/30 * * * *"` | |
| `every 1h` | `cron: "0 * * * *"` | **Behavior change**: anchored to `:00` instead of drifting from `last_run_at` |
| `every 2h` | `cron: "0 */2 * * *"` | |
| `every 1d` | `cron: "0 0 * * *"` | |
| `daily_at 09:00` (was UTC) | `cron: "0 9 * * *"` + `tz: UTC` | `tz` required if your host tz isn't UTC |
| `daily_at 09:00` (host tz) | `cron: "0 9 * * *"` | Uses host-tz default |
| `at 2026-06-01T09:00:00Z` | `at: 2026-06-01T09:00:00Z` | Field name change only |

### Frontmatter reference

| Key | Required | Default | Notes |
|-----|----------|---------|-------|
| `name` | yes | — | `[a-z0-9_]{1,32}` (Telegram bot-command shape). Lowercased automatically. |
| `description` | yes | — | ≤256 chars. Shown in `/tasks`. |
| `cron` | one of | — | 5-field unix cron expression. Mutually exclusive with `at`. |
| `at` | one of | — | ISO8601 absolute timestamp with explicit tz suffix. Mutually exclusive with `cron`. |
| `tz` | no | `$TZ` env / host tz | IANA timezone name. Affects `cron` evaluation only. |
| `chat_id` | no | first allowlist entry | Where the reply lands. Use a negative integer for group chats. |
| `engine` | no | `config.defaultEngine` | `primary` (Sonnet, `@`), `secondary` (Opus, `!`), or `ollama` (free, default-engine deploys only). |
| `catch_up` | no | `true` for `cron`, `false` for `at` | If Solrac was down through a missed window, fire once on next boot. Set to `false` to skip catch-up fires. |
| `enabled` | no | `true` | Set `false` to pause without deleting. |
| `max_cost_usd` | no | unset | Per-task hourly cap (Claude tiers only). Pre-flight skip when `SUM(cost_usd)` for this task in past 1 hour ≥ cap. Silently ignored on Ollama. |
| `boot_catch_up_jitter_s` | no | `0` | Stagger boot catch-up fires by `random(0, N)` seconds so 12 daily tasks don't pile up simultaneously on restart. |

Unknown frontmatter keys are rejected at parse — typos surface as boot-time warnings rather than silently ignored fields.

### Operator commands

`/tasks` — list every loaded task with its schedule, engine, last fire, and last status.

`/tasks run <name>` — fire a task on demand. Bypasses the schedule clock; honors `enabled`, `one_off_consumed`, and `max_cost_usd`. Useful for debugging without waiting for the next anchor.

### Visibility

Every fire writes one `audit` row tagged `origin='scheduled'` with `task_name=<name>`. The per-task `scheduled_tasks` table tracks `last_run_at`, `last_status`, `last_audit_id`, and `one_off_consumed`. Query both directly when needed:

```sh
sqlite3 data/solrac.sqlite \
  "SELECT started_at, task_name, status, cost_usd FROM audit WHERE origin='scheduled' ORDER BY started_at DESC LIMIT 20"
```

### Safety notes

- Scheduled fires share the same turn queue as user-typed messages. The per-chat hourly cap, the global hourly cap, `MAX_CONCURRENT_TURNS`, and the policy hooks all apply automatically.
- Tier-3 tools (Telegram-confirm) called from a scheduled fire prompt for confirmation. Without an operator at the keyboard the broker times out at 60s and fail-closes — write your TASK.md body for tools that auto-allow.
- A task that fires while a user is mid-conversation in the same chat waits behind the user (per-chat KeyedMutex). Pick a `chat_id` you don't actively type in if you need deterministic timing.
- Hot-reload is intentionally absent: edit a `TASK.md`, restart Solrac. Same contract as skills/integrations.

See `examples/tasks/` for two ready-to-edit samples.

## Integrations

> Status: opt-in via `SOLRAC_INTEGRATIONS_ENABLED=true`. Disabled by default.

An **integration** is a TypeScript module under `$SOLRAC_INTEGRATIONS_DIR/<name>/index.ts` (or, for shipped reference integrations, `src/integrations-builtin/<name>/index.ts`) that adds new tools to the agent without touching solrac's source. Each module default-exports `setup(ctx)` and returns `{ apiVersion, tools, meta }`. Tools surface to the model as `mcp__solrac__<name>`.

> **Engine reach.** Integrations are reachable from both Claude tiers (`@`, `!`) and the local Ollama default — the latter when `OLLAMA_TOOLS_ENABLED=true` (precondition: `SOLRAC_INTEGRATIONS_ENABLED=true`). With Ollama tools-on, the local model gets the same `mcp__solrac__*` tool surface; `ollama.ts::buildOllamaCapabilityNote` advertises the loaded tool names so the model knows what it can call. With `OLLAMA_TOOLS_ENABLED=false`, Ollama falls back to single-shot inference and the capability note tells it to redirect tool-shaped requests to `@`/`!`. Reliability still varies by Ollama model — `gemma4:e4b` is the recommended baseline.

### Shipping model

Solrac ships the **mechanism** (loader, context, policy gate). The integration **content** is operator-owned. There are two sources, both discovered when `SOLRAC_INTEGRATIONS_ENABLED=true`:

- **Blessed integrations** at `src/integrations-builtin/<name>/` — shipped with solrac, version-controlled in the repo. Each blessed integration self-gates inside its `setup(ctx)` (e.g. `gmail` no-ops without OAuth credentials). v1 ships a small set; see the directory.
- **Operator integrations** at `$SOLRAC_INTEGRATIONS_DIR/<name>/` — operator-authored, NOT in the repo. Default `./integrations` (cwd-relative); set to `~/.solrac/integrations` or wherever else makes sense for your deployment.

`examples/integrations/*` in the source tree are **templates, not loaded**. The loader does not scan `examples/`; that directory exists only so you have something to `cp -r` into your operator dir.

### Quick start (10 minutes)

```bash
# 1. From the solrac repo root, copy the minimal example.
mkdir -p ~/.solrac/integrations
cp -r examples/integrations/echo ~/.solrac/integrations/echo

# 2. Edit your .env to enable integrations and point at your operator dir.
echo "SOLRAC_INTEGRATIONS_ENABLED=true" >> .env
echo "SOLRAC_INTEGRATIONS_DIR=$HOME/.solrac/integrations" >> .env

# 3. Restart solrac.
bun src/main.ts

# 4. Watch boot logs for the integrations.loaded event.
#    Expected: "names":["echo"], "tools":1, "errors":0.

# 5. From an allowed Telegram user (or the web UI):
#    @ use the echo_say tool with msg="hello"
#    Response: echo: hello
```

If you instead see `"integrations":0,"tools":0`, check that `$SOLRAC_INTEGRATIONS_DIR/echo/index.ts` exists. If you see a non-zero `errors` count, the boot log will name the file and the parse error.

### The `setup(ctx)` contract

```ts
// $SOLRAC_INTEGRATIONS_DIR/myservice/index.ts
import type { IntegrationContext, IntegrationModule } from "../../../src/integrations.ts"; // type-only; erased at runtime

export default function setup(ctx: IntegrationContext): IntegrationModule {
  return {
    apiVersion: 1,
    tools: [
      ctx.tool(
        "myservice_get_thing",
        "Fetch a thing from myservice. <description matters — the model reads it>",
        { id: ctx.z.string() },
        async (args) => {
          const res = await ctx.fetch(`https://api.myservice.com/things/${args.id}`, {
            headers: { Authorization: `Bearer ${ctx.env.MYSERVICE_API_KEY}` },
          });
          const data = await res.json();
          return { content: [{ type: "text", text: JSON.stringify(data) }] };
        },
        { alwaysLoad: true },
      ),
    ],
    meta: {
      tier: "auto",
      // Per-tool override beats `meta.tier`. Use for mutating ops:
      // toolTiers: { myservice_delete_thing: "confirm" },
    },
  };
}
```

`ctx` carries `{ z, tool, fetch, log, env }`. Integrations don't import zod or the SDK directly — those come through `ctx`, so you don't need to `npm install zod` next to your `index.ts`. Only third-party SDKs (e.g. `@linear/sdk`) need a local install (see "Per-integration deps" below).

**`alwaysLoad: true` (recommended for small integrations)** — the SDK normally hides MCP server tools behind `ToolSearch` discovery. With `alwaysLoad: true` the tool is visible in the model's upfront tool list every turn, costing ~50–100 tokens of schema overhead but skipping the ToolSearch round-trip. For ≤ ~10 integration tools, the math favors `alwaysLoad: true`. For very large integrations (50+ tools), keep the default to avoid bloating every turn.

### Tool tiers (`auto` vs `confirm`)

Every integration tool gets a tier:

- `"auto"` — runs without prompting the user. Use for read-only / pure-function tools that have no side effects (a time lookup, a Knowledge-Base search, an `echo`).
- `"confirm"` — Telegram inline-keyboard prompt before running. Use for anything that mutates state or calls a paid API. Default if `meta` is omitted.

Resolution order for a tool:

1. `meta.toolTiers[<short_tool_name>]` if set.
2. `meta.tier` if set.
3. `"confirm"` (default).

`policy.ts::classifyToolWithIntegrations` consults the toolTiers map captured at boot. Cost cap and loop detector run independently in `PreToolUse` regardless of tier — `tier:"auto"` does NOT skip cost-cap enforcement.

### Per-integration deps

Each integration directory is its own dependency root. If your integration needs `@linear/sdk`, drop a `package.json` next to your `index.ts` and `npm install` from inside that directory:

```bash
cd $SOLRAC_INTEGRATIONS_DIR/linear
cat > package.json <<'EOF'
{ "name": "solrac-integration-linear", "private": true, "dependencies": { "@linear/sdk": "^64.0.0" } }
EOF
npm install
```

Bun's dynamic `import()` resolves `@linear/sdk` from the integration's local `node_modules` (verified — see `examples/integrations/linear/`). Integrations cannot reach solrac's `node_modules`; that's the design — each integration is fully self-contained.

### Sharing integrations

Pattern: a community-published integration is a **git repo** (or gist) containing one integration directory. Consumers clone it into their `$SOLRAC_INTEGRATIONS_DIR/<name>/`, run `npm install` inside if a `package.json` is present, and restart solrac.

```bash
# Operator A publishes:
git init solrac-integration-shopify && cd solrac-integration-shopify
# ... index.ts + package.json + README ...
git remote add origin git@github.com:operatorA/solrac-integration-shopify.git
git push -u origin main

# Operator B consumes:
cd $SOLRAC_INTEGRATIONS_DIR
git clone git@github.com:operatorA/solrac-integration-shopify.git shopify
cd shopify && npm install
# ... configure required env vars ...
# Restart solrac. Tools surface as mcp__solrac__shopify_*.
```

No registry. No auto-update. **Pin to a commit hash for reproducibility** — `git checkout <sha>` after clone. v1 deliberately keeps the sharing story low-tech; revisit if integrations proliferate.

### API stability

Integration modules MUST declare `apiVersion: 1`. The loader rejects any other value with a clear log line — your tools simply don't register, the rest of solrac runs normally. When the contract changes (e.g. a new field in `IntegrationContext`, a different `tool()` signature), solrac will bump to `apiVersion: 2`. Modules pinned to `1` will be skipped with a warn until they migrate. This is the explicit upgrade path; we will NOT silently coerce.

Today, only `apiVersion: 1` is recognized.

### Security note

Integrations run **as solrac**, in the same process, with the same filesystem and network access solrac itself has. They are NOT sandboxed. Read this carefully:

- **You wrote the code (or vetted code you copied)**. The threat model is "untrusted *Telegram users*", NOT "untrusted *integration authors*". An integration is part of your deployment.
- Integrations have full read access to `process.env` via `ctx.env`. Don't log secrets — solrac's logger does NOT redact.
- The Telegram-user gate still applies. Even a maliciously-permissive integration (e.g. one that exposes `Bash`) can't bypass `policy.ts::classifyTool`'s catch-all confirm-tier — Telegram users will still see the inline-keyboard prompt before the tool runs.
- An integration's handler runs in solrac's parent process, NOT in the SDK's spawned `claude` subprocess. The subprocess env scrub (`agent.ts::sanitizedSubprocessEnv`) does NOT apply to integration handlers; they have full env access.

If you're sharing an integration with someone else, treat it like you would any other shared dependency: review the code, pin to a commit, and document required env vars in the integration's README.

### Built-in integrations

solrac ships a small set of blessed integrations under `src/integrations-builtin/`. They're always tried first when integrations are enabled (they win tool-name collisions over operator-authored integrations) and each self-gates: missing creds or missing optional deps → register zero tools, log a single line, boot continues normally.

#### `time` — current time + timestamp formatting (no setup)

Two tools, zero deps, no credentials. Always loads when integrations are enabled.

| Tool | Tier | Description |
|---|---|---|
| `mcp__solrac__time_now` | auto | Current ISO 8601 UTC timestamp + human rendering in a given IANA timezone. |
| `mcp__solrac__time_format` | auto | Format an existing ISO timestamp in a target timezone + locale. |

Use cases the agent answers without flinching:

- "What time is it for the team in Tokyo right now?"
- "Convert 2026-04-12T18:30:00Z to JST."
- "When does our 5pm New York standup happen in Berlin?"

This is also the file to read first when learning to write your own integration — `src/integrations-builtin/time/index.ts` is heavily commented and demonstrates `IntegrationContext`, `meta.tier`, `alwaysLoad`, and multi-tool registration end-to-end in a small focused file.

#### `gmail` — multi-account Gmail (OAuth2; opt-in deps)

11 tools spanning read, organization, and send/delete. Self-gates if `googleapis` is not installed OR no accounts are configured. Setup is a one-time bootstrap per account.

| Tool | Tier | Description |
|---|---|---|
| `gmail_list_accounts` | auto | Discover configured aliases. |
| `gmail_list_labels` | auto | All labels (system + user) for an account. |
| `gmail_search_messages` | auto | Gmail query syntax (from:, subject:, is:unread, etc.). |
| `gmail_get_message` | auto | Full message: headers, plain-text + HTML body, attachments. |
| `gmail_list_threads` | auto | Conversation groups. |
| `gmail_apply_label` | confirm | Add labels to messages. |
| `gmail_remove_label` | confirm | Remove labels (e.g. mark UNREAD off → mark read). |
| `gmail_archive_message` | confirm | Remove INBOX label. |
| `gmail_trash_message` | confirm | Move to Trash (recoverable 30 days). |
| `gmail_delete_message` | confirm | **PERMANENT** delete. Requires `confirm: true` body field too. |
| `gmail_send_message` | confirm | Send email with optional attachments + reply threading. Requires `confirm: true` body field too. |

The destructive ops (`delete`, `send`) carry **two** safeguards: solrac's Telegram-confirm prompt (you, the user, must tap ✅) AND a `confirm: true` field the model must explicitly include in its tool call (the model must intentionally assert "I want to send/delete"). Both must be satisfied; an agent can't trip-and-send.

##### Setup (~5 min one-time + ~1 min per account)

All gmail on-disk state lives under `$SOLRAC_HOME/integrations/gmail/`. With the default `$SOLRAC_HOME=~/.solrac` that's `~/.solrac/integrations/gmail/`; with a custom value (e.g. `SOLRAC_HOME=/var/solrac`) the paths follow.

```bash
# 1. Install Gmail's optional runtime deps. Run this in the same directory
#    as solrac's `package.json` (the cloned repo root, e.g. `~/code/solrac`).
#    These deps are NOT in solrac's `dependencies` (only `devDependencies`),
#    so production deploys via `npm ci --production` skip them. To enable
#    Gmail in production, install with --save (no --save-dev):
cd /path/to/solrac        # the directory with package.json
npm install --save googleapis google-auth-library

# (Skip step 1 entirely on a binary install — `solrac` ships googleapis +
#  google-auth-library bundled.)

# 2. Get an OAuth client credentials.json from Google Cloud Console:
#    - Enable Gmail API:   https://console.cloud.google.com/apis/library/gmail.googleapis.com
#    - Create OAuth client: https://console.cloud.google.com/apis/credentials
#      → Create Credentials → OAuth client ID → Desktop app
#    Save the downloaded JSON to (substitute $SOLRAC_HOME as needed):
mkdir -p ~/.solrac/integrations/gmail
mv ~/Downloads/client_secret_*.json ~/.solrac/integrations/gmail/credentials.json

# 3. Authenticate one or more accounts (opens browser per call). Works
#    identically from a source checkout (`bun src/main.ts gmail-auth …`) or
#    a curl-pipe binary install (`solrac gmail-auth …`).
solrac gmail-auth personal
solrac gmail-auth work
# Each writes $SOLRAC_HOME/integrations/gmail/<alias>.json + appends to
# accounts.json. The command prints the resolved solracHome + gmailDir on
# its first two lines so the operator sees exactly where files land.

# 4. Restart solrac. Boot log should show:
#    integrations.gmail.loaded accountCount:2 toolCount:11
```

If Gmail is unconfigured, the boot log distinguishes which precondition failed:

| Log event | Meaning |
|---|---|
| `integrations.gmail.deps_missing` | `googleapis` / `google-auth-library` not installed. Run the `npm install` above. (Source checkouts only — the binary bundles these.) |
| `integrations.gmail.disabled` | `credentials.json` not found at the path in `expectedAt`. Get it from Google Cloud Console. |
| `integrations.gmail.no_accounts` | Credentials present, but no accounts authed. Run `solrac gmail-auth <alias>`. |
| `integrations.gmail.loaded` | All set. Tool count + account count reported. |

##### Migrating from `~/.solrac/gmail/` (pre-PNX-171 layout)

Before PNX-171, gmail state lived in `~/.solrac/gmail/` regardless of `SOLRAC_HOME`. Move it once:

```bash
mkdir -p "$SOLRAC_HOME/integrations"
mv ~/.solrac/gmail "$SOLRAC_HOME/integrations/gmail"
```

If `SOLRAC_HOME` is unset and you're on the default `~/.solrac`, the move is `mv ~/.solrac/gmail ~/.solrac/integrations/gmail`. No re-auth needed — token files carry over verbatim.

##### Use cases

```
@ search my personal Gmail for unread newsletters older than a week
@ archive everything in personal Gmail labeled "promotions"
@ draft a reply to message <id> in work Gmail saying I'll respond Monday
```

The third one will require approving the send via inline-keyboard. The agent must produce the right `confirm: true` argument first; it can't accidentally trip-send.

##### Limits to know

- **`gmail_delete_message` is permanent.** Use `gmail_trash_message` (Trash, recoverable 30 days) for normal deletes. The permanent-delete tool exists for cases where you really mean it.
- **OAuth refresh** is automatic. The integration writes refreshed tokens back to `$SOLRAC_HOME/integrations/gmail/<alias>.json` whenever Google rotates them.
- **Scope is fixed** at read + modify + send + userinfo (for email-address discovery). To narrow scope, edit `src/integrations-builtin/gmail/auth-cli.ts` SCOPES and re-auth per account.
- **The `googleapis` package is ~30MB.** That's why it's an optional dep, not a runtime requirement. If you don't want Gmail, skip step 1 and Gmail self-gates on `deps_missing`.

#### `notion` — single-token Notion workspace

10 tools spanning workspace search + database discovery, database queries, page reads, and page/property/block writes. Single `NOTION_API_KEY` env var (Notion's static integration tokens — no OAuth dance). Self-gates if `@notionhq/client` cannot be loaded OR the env var is unset OR the boot probe fails.

| Tool | Tier | Description |
|---|---|---|
| `notion_search` | auto | Workspace-wide search; filter by `page` or `database`. Honors the integration's shared-resource set. |
| `notion_list_databases` | auto | List databases visible to the integration. **Use this when you don't already know a database id** (cleaner than `notion_search` for the "find my Projects DB" workflow). Optional title-substring filter. |
| `notion_get_page` | auto | Page properties + nested block tree (up to depth 3). |
| `notion_query_database` | auto | Filters + sorts. Required for project-database workflows ("tickets in progress"). |
| `notion_get_database_schema` | auto | Property names + types + select/status options. **Call this before writing.** Cached in-process. |
| `notion_list_users` | auto | Workspace members visible to the integration. Required to set `Assignee` properties (pass IDs). |
| `notion_create_page` | confirm | New row in a database. `properties` (DSL), optional initial `content` (typed blocks). |
| `notion_update_page_properties` | confirm | Patch properties on an existing database page. |
| `notion_append_blocks` | confirm | Add typed blocks to a page. Auto-chunks at 100 blocks per call. |
| `notion_archive_page` | confirm | Soft-delete (reversible). Requires `confirm: true` body field too. |

`notion_archive_page` carries **two** safeguards: solrac's Telegram-confirm prompt AND a `confirm: true` field the model must include explicitly. The archive is reversible — call `notion_update_page_properties` with `archived: false` to restore.

##### Setup (~3 min one-time, no per-account flow)

`@notionhq/client` is a runtime dependency in solrac's `package.json` — `npm ci` (or `npm install`) populates it like any other dep. No separate install step.

```bash
# 1. Create an internal integration at:
#    https://www.notion.so/my-integrations → "+ New integration".
#    Workspace: pick the workspace you want solrac to reach.
#    Type: "Internal".
#    Capabilities: Read content / Update content / Insert content (and
#    "Read user information without email" if you'll set Assignee fields).
#    Copy the "Internal Integration Secret" — that's your token.

# 2. Set the token in solrac's environment.
echo 'NOTION_API_KEY=secret_…' >> .env

# 3. Share each target page or database with the integration:
#    Open the page/database in Notion → "..." menu → "Add connections" →
#    pick your integration. The integration cannot see anything you
#    haven't shared with it. (Database-shared pages are reachable via the
#    database; you don't need to re-share each row.)

# 4. Restart solrac. Boot log should show:
#    integrations.notion.loaded user:"<bot name>" toolCount:10
```

If Notion is unconfigured, the boot log distinguishes which precondition failed:

| Log event | Meaning |
|---|---|
| `integrations.notion.deps_missing` | `@notionhq/client` could not be loaded from `node_modules`. Run `npm ci` (or `npm install`) in the solrac repo root. |
| `integrations.notion.disabled` | `NOTION_API_KEY` not set. Set it in solrac's environment. |
| `integrations.notion.token_invalid` | Token rejected by `/v1/users/me` (3s probe). Check the secret + that the integration still exists. |
| `integrations.notion.loaded` | All set. Bot name + tool count reported. |

##### Use cases

```
@ list my Solrac tickets that are still in progress
@ create a new Solrac ticket "fix WAL drain timeout" with Status: Todo, Priority: High
@ in ticket PNX-047, set Status to Done and append a "summary" heading + paragraph
@ search Notion for pages mentioning "rate limit" from the last week
```

The middle two require approving via inline-keyboard. `notion_get_database_schema` is called once per database the agent works against and the result is cached, so subsequent reads/writes against the same DB don't re-fetch.

##### Limits to know

- **`@notionhq/client` is a hard runtime dep.** Unlike Gmail's optional `googleapis`, this one ships in solrac's `dependencies` and is always installed. The `deps_missing` boot gate is a defensive remnant — it'd only fire if `node_modules` is broken or `npm install` hasn't been run yet.
- **Single workspace.** One `NOTION_API_KEY` = one workspace. Multi-workspace isn't supported in v1; run a second solrac if you need it.
- **Visibility = sharing.** The integration only sees pages and databases you've explicitly shared with it. If `notion_search` returns empty, you forgot step 4 above. 403 errors include a hint pointing back to "Settings → Connections."
- **Block depth cap is 3.** `notion_get_page` walks up to 3 levels of nested blocks (top-level + 2 children). Deeper blocks are flagged `truncated: true` so the model knows to drill down with another `notion_get_page` call passing the parent block's id. Renders stay bounded; deep tables and toggles still work.
- **Property DSL needs the schema.** Writes pass shorthand (`{Status: "Done"}`) which the integration translates to Notion's typed shape using the cached database schema. The `notion_get_database_schema` tool surfaces the property types + select/status options. If the schema changes mid-session (e.g., you rename a select option), the next write returns a `validation_error` envelope; the integration auto-invalidates the cache and retries once before surfacing the failure to the model.
- **Block input is typed-only in v1.** No markdown→blocks conversion. The model passes `[{type:"paragraph", text:"hi"}, {type:"heading_2", text:"…"}, …]`; supported types are `paragraph`, `heading_1`/`2`/`3`, `bulleted_list_item`, `numbered_list_item`, `to_do` (with `checked`), `quote`, `code` (with `language`), `divider`, `callout` (with `emoji`).
- **`files` property is unsupported.** Writes to file-typed properties return an error envelope. Notion's file upload API requires multipart endpoints out of scope for v1. Reads return `[{name}, …]` with no URLs.
- **Formula and rollup render as plain strings on read.** Fine for the model; if you need typed envelopes for downstream tooling, raise an issue.
- **Rate limit is ~3 req/s per integration.** Solrac's per-chat KeyedMutex serializes within a chat; multi-chat parallelism could hit the cap. 429 → `retryAfter: 60` envelope; no client-side throttling.
- **Append is auto-chunked at 100 blocks.** Larger payloads split into sequential `blocks.children.append` calls. On partial failure the envelope reports `{blocksAppended, chunks, lastError}`; the model decides whether to retry remaining chunks.

##### Token security

`NOTION_API_KEY` is scrubbed from the SDK-spawned `claude` subprocess env (`agent.ts::sanitizedSubprocessEnv`). The integration handler runs in solrac's main process — the subprocess never needs the token. Without the scrub, an auto-allowed `Bash(echo $NOTION_API_KEY)` could exfiltrate the secret. If you add a future integration with its own token, mirror this pattern.

### Limits to know

- **Hot-reload is intentionally absent.** Edit your `index.ts`, restart solrac. Same boot-once story as skills and config.
- **One MCP server.** All integrations share the namespace `mcp__solrac__*` — there is no per-integration MCP server. Tool name collisions across integrations are resolved first-dir-wins (blessed first, operator second), with a warn log. Pick distinctive prefixes: `linear_*`, `gmail_*`, `shopify_*`.
- **Audit + cost cap apply.** Every integration tool call writes to `audit.tool_calls` (the same column Claude tools use), and every call passes through `PreToolUse` (cost cap + loop detector). Tier-3 tools (`tier:"confirm"`) additionally route through `canUseTool` for the Telegram-confirm prompt.

## Permission UX

Solrac classifies every tool call into one of three tiers (`policy.ts::classifyTool`). You only see prompts for the third tier.

### Auto-allow (silent)

These run without asking:

- `Read`, `Glob`, `Grep`, `LS`, `WebFetch`, `WebSearch`, `TodoWrite`, `BashOutput`, `NotebookRead`
- `Bash` commands starting with safe observation tokens: `ls`, `pwd`, `cat`, `head`, `tail`, `echo`, `date`, `whoami`, `uname`, `which`, `find`, `grep`, `wc`, `git status|log|diff|show|branch|remote|rev-parse|ls-files|config --get|fetch`, `node --version`, `bun --version`, `npm/pnpm list|outdated|view|why|info`

### Auto-deny (silent block)

The agent gets a `deny` response with a reason; it'll generally pivot to a different approach. You don't see anything in chat.

- `rm -rf` on `/`, `~`, or `$HOME`
- `sudo`, `mkfs`, `dd if=`
- Fork bombs (`:(){ :|:& };:`)
- `chmod -R 777`
- Pipe-to-shell remote exec (`curl … | bash`)
- `git push -f` / `--force`
- Paid third-party CLIs by name (`claude`, `openai`, `replicate`, `anthropic`) — they'd burn budget outside Solrac's cost cap. See [OQ#5](./ROADMAP.md#oq5-cost-surprises-beyond-anthropic).
- Sub-agent dispatch (`Agent` / `Task` tools) — disabled in v1.

### Telegram-confirm (you decide)

Anything else: `Write`, `Edit`, `NotebookEdit`, non-allowlisted `Bash` commands.

You'll see a prompt like:

```
🔐 Confirm tool: Bash
{
  "command": "git push origin HEAD"
}

[ ✅ Allow ]  [ ❌ Deny ]
```

Tap one. If you ignore it, the prompt **times out after 60 seconds** and the SDK gets a deny.

After you tap, the keyboard disappears and the original prompt is edited to append the verdict (`— ✅ Allowed` / `— ❌ Denied` / `— Confirmation expired…`) so the chat history shows what was decided.

## Cost cap behavior

Each chat has a sliding-hour spend ceiling: `HOURLY_COST_CAP_USD` (default $1.00). When a turn would push the trailing-60-minutes spend ≥ the cap, the next tool call is denied with:

```
❌ error: cost cap reached: $1.0142 ≥ $1.00/hr for this chat
```

The agent stops. The audit row carries `status='ok'` (the SDK gracefully recovers) but `error_message` records `policy_deny: cost cap reached: …` for observability. The cap resets as old audit rows fall out of the trailing window.

To raise the cap permanently, edit `.env` and restart. To grant a one-off bypass, just wait the rest of the hour — the spend window slides forward.

## Loop detector

If the agent calls the same `(toolName, input)` 3 times within a single turn, the third call is denied with:

```
loop_detected: Bash called 3× with same input
```

The detector resets per turn (next user message starts fresh). Order-insensitive over JSON keys: `{a:1,b:2}` and `{b:2,a:1}` count as the same. Arrays preserve order: `[1,2]` ≠ `[2,1]`.

In practice this catches:
- Agents looping on a failing command without varying it.
- Agent retries that should fall back to a different tool.
- Bugs in MCP servers that confuse the agent into resending the same call.

Three turns of *related* but not *identical* calls don't trip — only structural-equality dupes.

## Session resume

By default each chat keeps history across restarts. Concretely:

- Solrac records the SDK's `result.session_id` in the `sessions` table at the end of every turn.
- The next turn's `query()` call passes `Options.resume = <previous session id>`.
- The SDK rebuilds context, so you can ask "what did we just do?" and it knows.

This means restarting Solrac is conversationally invisible. You'll only notice the bot was rebooted because the first message after restart takes ~1s longer to start streaming.

To check whether a chat has a session:

```sh
sqlite3 data/solrac.sqlite \
  "SELECT chat_id, agent_session_id, datetime(updated_at/1000, 'unixepoch') AS last \
   FROM sessions"
```

## Concurrency you'll notice

- **Same chat, two messages back-to-back** → second waits for the first to finish (KeyedMutex, per-chat).
- **Two chats simultaneously** → both run in parallel (up to `MAX_CONCURRENT_TURNS = 4`; further chats queue on the global Semaphore).
- **Many messages from one chat** → after the queue depth (`MAX_CHAT_QUEUE_DEPTH = 10`) is reached, additional messages are dropped with a `queue_full` audit row but no chat reply. Effectively a per-chat backpressure.

If you paste a 100-line script into the bot, only the first ~10 line groups will run; the rest are dropped. Send big tasks one at a time.

## What Solrac can do

This is the SDK's tool surface, not a Solrac-specific feature list. The bot can:

- **Read and search code** — `Read`, `Glob`, `Grep`, `LS`. Auto-allowed.
- **Run safe shell observation** — `ls`, `git status`, `find`, `wc`, etc. Auto-allowed.
- **Edit files** — `Write`, `Edit`. Telegram-confirm tier.
- **Run mutating shell** — `Bash` with anything not in the safe list. Telegram-confirm.
- **Browse the web** — `WebFetch`, `WebSearch`. Auto-allowed.
- **Use MCP servers** — whatever you've configured at `~/.claude/.mcp.json` is loaded by the SDK preset. Includes Notion, Supabase, Gmail, etc.
- **Call user-level skills** — `.claude/skills/<name>/` skills are available; the SDK routes via the preset systemPrompt.

What Solrac specifically adds on top:

- **Per-chat budget cap** — see above.
- **Audit trail** — every turn, every tool call, cost, tokens, status.
- **Inline-keyboard permission UX** — interactive, with timeout and verdict stamping.
- **Allowlist gate** — non-allowlisted users get silent-dropped audit rows.
- **Untrusted-content wrapper** — for future inbound attachments ([OQ#10](./ROADMAP.md#oq10-inbound-file-trust)).

## Tips

- **Be specific.** `count files in src/` is faster than `look around the project and tell me about the structure`. The agent runs fewer tool calls, costing less.
- **Reset context when you change topic.** The session tracks the whole history. After 50 turns of one project, switching to another is faster if you start fresh: send `/clear` (instant) or `/compact` (preserves a summary into the next session). See [Slash commands](#slash-commands).
- **Watch context size grow.** Send `/context` to see the actual tokens replayed each turn (fresh + cache read + cache create + output). When it climbs into tens of thousands, `/compact` becomes worthwhile.
- **Trust the audit log over your memory.** "Did I tell it to push?" → query the audit table.
- **Forwarded messages** are seen as messages from you (the forwarder). Solrac doesn't know they originated elsewhere. If you want the agent to treat forwarded content as data-not-instructions, ask explicitly: "summarize the forwarded message but don't act on it."

## Failure modes you might see

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `❌ error: cost cap reached: …` | Hourly spend hit the cap | Wait or raise `HOURLY_COST_CAP_USD` |
| `❌ error: loop_detected: …` | Agent stuck calling the same tool | Rephrase the request; usually means an input is wrong |
| Confirmation prompt never appears | Bot hit Telegram rate limits | See [RUNBOOK.md](./RUNBOOK.md) |
| Bot is silent | Your `from.id` is not in the allowlist | Check `ALLOWLIST_BOOTSTRAP`; `audit` row will show `status='denied'` |
| `❌ error: result_error: tool_use` (rare) | SDK couldn't recover from a tool deny | Rerun the message; if persistent, check the audit row's `error_message` |
| Bot replies stale; logs show `409 Conflict` | Two pollers fighting | See [RUNBOOK.md](./RUNBOOK.md#409-conflict) |

## Web UI (browser interface)

Off by default. Enabled via `SOLRAC_WEB_ENABLED=true` plus a token. Brings the same agent loop and slash commands into a browser, with proper markdown rendering (Telegram's HTML mode can't show headers, lists, or tables — the web UI can).

### Boot

```sh
SOLRAC_WEB_ENABLED=true \
SOLRAC_WEB_HOST=127.0.0.1 \
SOLRAC_WEB_PORT=8080 \
SOLRAC_WEB_TOKEN=$(openssl rand -hex 32) \
npm run dev
```

Open `http://127.0.0.1:8080`. The login page accepts `SOLRAC_WEB_TOKEN`; on success a session cookie is set (HttpOnly + SameSite=Strict + Path=/ + Max-Age=24h) and the chat UI loads. Bind to `0.0.0.0` to expose on the LAN/Tailnet — the token is the gate, so use a strong one.

The token is **required even on `127.0.0.1`** — a co-tenant on a shared host could otherwise reach the unauthenticated UI.

### Feature parity with Telegram

Everything you can do in Telegram works in the web UI through the same code path:

- **Engine routing**: prefix `@` (primary Claude), `!` (secondary Claude), or no prefix (the configured default — Ollama in the standard config). The composer has a pill row matching the available engines: `default → @ → !`. The default-pill label is server-injected so the UI shows `default (ollama)` or `default (primary Claude)` to match the deploy.
- **Slash commands**: `/help`, `/status`, `/context`, `/clear [primary|secondary|ollama|all]`, `/compact`, plus any operator-defined skills.
- **Tool confirmation**: when Claude wants to run a tier-3 tool (Edit, Write, Bash with non-trivial args), an inline Allow / Deny prompt appears. 60 s timeout — same as Telegram.
- **Cost caps**: per-chat (web traffic shares one synthetic chat id, default `-1000`) and global. Both apply the same way.
- **Audit log**: every web turn writes the standard audit row. Query by `chat_id = -1000` to see web-only history.

### Markdown rendering

Claude and Ollama both emit markdown. Solrac now converts markdown to Telegram-safe HTML for the bot (so headers become bold, lists become `• item`, tables become ASCII inside `<pre>`, etc.) and ships the original markdown to the web UI for full rendering (real `<h1..h6>`, `<ul>/<ol>`, `<table>`, fenced code with language classes for downstream syntax highlighting). The conversion uses [`marked`](https://github.com/markedjs/marked) on both sides; output is allowlist-sanitized in the browser before injection.

### Notes & limits (v1)

- One operator. Multiple browser tabs all share the same SSE stream and conversation — open as many as you like, they'll stay in sync.
- File uploads are not supported (Telegram's photo flow is). Out of scope for v1.
- Sessions are stored in process memory; restarting Solrac signs out all browsers (operator must log in again). The conversation history is hydrated from the audit log on next page load.
- Confirmation prompts that arrive before the operator opens the UI are silently dropped on broker timeout (60 s). Same failure mode as Telegram when the operator's phone is off.

## Related docs

- [GLOSSARY.md](./GLOSSARY.md) — terminology reference
- [ARCHITECTURE.md](./ARCHITECTURE.md) — how it actually works
- [CONFIG.md](./CONFIG.md) — env knobs
- [OPERATIONS.md](./OPERATIONS.md) — `/stats`, audit queries
- [RUNBOOK.md](./RUNBOOK.md) — when something's wrong
