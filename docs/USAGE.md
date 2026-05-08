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

The first non-whitespace character of your message picks the engine:

| Prefix | Engine | Default model | Use when |
|--------|--------|---------------|----------|
| (none) | Primary Claude | `SOLRAC_PRIMARY_MODEL` (default `claude-sonnet-4-6`) | The cheap default. Sonnet handles 90 % of turns at ~⅕ of Opus's cost. |
| `@` | Primary Claude (explicit) | same as above | When you want to spell out "this is a primary turn" — useful in shared chats. |
| `!` | Secondary Claude (escalate) | `SOLRAC_SECONDARY_MODEL` (default `claude-opus-4-7`) | When the task needs Opus-level reasoning. Costs more per turn. Mnemonic: `!` = "important". |
| `>` | Local Ollama | `OLLAMA_MODEL` (must be set) | Casual chat, offline / privacy-sensitive prompts, or when Anthropic is unreachable. |

Examples:

```
hello                          → primary Sonnet
@hello                         → primary Sonnet (explicit)
!hard architectural question   → secondary Opus
> what's the capital of france? → local Ollama
```

**Cross-engine context.** All three engines share the same conversation thread for a chat: switching tiers mid-conversation injects an "out-of-band" block of recent other-engine turns into the next prompt so each model sees what the user has been discussing. You can switch freely.

The `!` / `@` / `>` and one optional space are stripped from the start of the message. To send a literal `!` / `@` / `>` as the first character of your prompt, double it (`!!literal` produces `!literal`).

### Primary vs secondary Claude

Both tiers run through the same SDK preset (`claude_code`), the same tools, the same `canUseTool` policy, and the same `<untrusted-content>` clause. Only the model id differs:
- Primary defaults to Sonnet — fast, cheap, good for most things.
- Secondary defaults to Opus — slower, ~5× pricier per token, deeper reasoning.

Each tier keeps its own SDK session id, so prompt caching survives across same-tier turns. When you switch from primary to secondary (or vice versa), the new tier doesn't share the SDK session — but the bot prepends the other tier's recent turns as out-of-band context so it picks up the thread anyway.

Failure modes specific to Claude tiers:

| Condition | What you see |
|-----------|--------------|
| `@` or `!` alone with no payload | `usage: @<prompt> — sends to primary Claude (model: <model>)` (or `!<prompt> — secondary Claude`) |

### Routing to local Ollama (`>` prefix)

If `OLLAMA_ENABLED=true` is set in the deployment, prefixing a message with `>` routes it to a local Ollama model instead of Claude. Useful for casual chat where Claude's tool-using horsepower is overkill, or when you want a prompt that never leaves the box.

> `> what's the capital of france?`
>
> `>summarize what we just discussed in two bullets`

What's the same as the Claude path:
- Allowlist gating, denial throttle, queue, per-chat sequencing.
- Streaming UX: same 🦙 stub → throttled edits → final-edit footer.
- Audit row written for each turn.
- **Cross-engine context** — sees prior Claude turns (both tiers) the same way Claude tiers see prior Ollama turns.

What's different:
- **No tools** — pure inference. The local model can't read files, run shell, or call APIs.
- **Free** — `cost_usd = 0` in the audit row; the per-chat and global cost caps don't apply.
- **Footer** — `<i>✅ ollama:llama3.2 · 1.2s</i>` shows model + wall time instead of turns + dollars.

Failure modes:

| Condition | What you see |
|-----------|--------------|
| `OLLAMA_ENABLED=false` and you sent `> ...` | "ollama disabled in this deployment" |
| `>` alone with no payload | `usage: > <prompt> — sends to local Ollama (model: <model>)` |
| Ollama not running | `❌ ollama unreachable: http://localhost:11434` |
| Model not pulled on the host | `❌ ollama model not found: <model> — pull with 'ollama pull <model>' on the host` |
| Inference exceeds `OLLAMA_TIMEOUT_MS` | `❌ ollama timed out after 60s` |

See [CONFIG.md](./CONFIG.md) for the full env list (`OLLAMA_ENABLED`, `OLLAMA_URL`, `OLLAMA_MODEL`, `OLLAMA_TIMEOUT_MS`, `OLLAMA_HISTORY_LIMIT`).

## Slash commands

Slash commands give you control over conversation context and visibility into spend without querying the database. Both `/cmd` and `:cmd` invoke the same handler — `/cmd` enables Telegram's autocomplete (registered via `setMyCommands` at boot); `:cmd` is a non-auto-linked alias the help card uses for visual cleanliness. They're equivalent.

| Command | Default | Behavior | Cost |
|---------|---------|----------|------|
| `/clear [primary\|secondary\|all]` | `all` | Drop SDK session id and any pending compaction summary for the targeted tier(s). Next turn starts fresh. | Free |
| `/compact [primary\|secondary]` | `primary` | Run a one-shot Claude turn that summarizes this tier's recent conversation, store the summary, drop the SDK session id. The summary is prepended into a fresh SDK session on the next user turn for that tier. | One Claude turn (Sonnet ≈ $0.001-0.005, Opus ≈ $0.005-0.025) |
| `/context [primary\|secondary]` | `primary` | Show audit-table footprint (bytes), turn count, last turn's token breakdown (fresh / cache read / cache create / output), and estimated next-turn replay size. | Free |
| `/help` | — | Engine prefix table + command reference. | Free |
| `/status` | — | Per-chat session/spend snapshot + global rollup + queue depth + uptime. | Free |

### Tier args

For `/clear` and `/compact` and `/context`, the optional argument selects a tier. Aliases:

| Token | Maps to |
|-------|---------|
| `primary`, `p`, `@` | primary |
| `secondary`, `s`, `!` | secondary |
| `all`, `*` | both (only valid for `/clear`) |

Examples:

```
/clear              → drops both tiers (default = all)
/clear primary      → drops primary only
/clear !            → drops secondary only (`!` mnemonic from engine prefix)
/compact            → compacts primary
/compact !          → compacts secondary
:context            → same as /context (alternate prefix)
```

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

Both files apply to **all** engines: primary Claude (Sonnet, no prefix or `!`), secondary Claude (Opus, `@`), and Ollama (`>`). The only engine-specific text is a single capability sentence Solrac appends in code ("you have tools, gated by cap" vs "you have no tools"), so your `SOUL.md` doesn't need conditional sections.

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
tier: primary             # optional, primary|secondary, default primary
---
You are a concise summarizer. Produce exactly 3 bullets, no preamble.

Input:
{{args}}
```

Three frontmatter fields, plus a body. The body is a Claude prompt — `{{args}}` is the only placeholder and gets replaced with whatever the user typed after the command (e.g. `/summarize <text>` → `args = "<text>"`). The substitution is literal text-for-text; no escaping, no nested templating.

The frontmatter parser supports a YAML *subset*: `key: scalar`, `key: [a, b, c]` string arrays, single- or double-quoted strings, integers, booleans. Multi-line strings, anchors, and nested maps are NOT supported and produce a clear error pointing at the offending line.

### What skills can do

Skills are tool-less in v1 — `Bash`, `Edit`, `Write`, `WebFetch`, `WebSearch`, `Agent`, `Task`, and `NotebookEdit` are explicitly disallowed; `canUseTool` denies everything else by default. Skills run a single Claude turn (`maxTurns: 1`, no `resume`) and reply with the model's text output verbatim (HTML-escaped).

This means skills are best for:

- **Text transformations** (summarize, translate, rephrase, format).
- **Templated prompts** the operator wants to invoke quickly without retyping.
- **Quick lookups** that don't require fetching anything (Claude's training data only).

If you need tool use, file an issue — that's a v1.1 conversation.

### Cost & caps

Skills cost a real Claude turn each. The audit row is tagged `claude:<tier>:<model>:skill:<name>` so cost rolls up under the existing per-chat hourly cap (`HOURLY_COST_CAP_USD`) and the global cap. The pre-flight cap check fires *before* the SDK call — a cap-rejected skill costs $0.

### Failure modes

- **`SKILL.md` parse error** at boot: the skill is dropped, others continue, a `skills.load_error` warn line names the file. Solrac doesn't crash.
- **Name collides with a built-in** (`clear`, `compact`, `context`, `help`, `status`): rejected at load with a warn line. The built-in always wins.
- **Two skills declare the same `name`**: first-wins (filesystem sort order). Second is dropped with a warn.
- **Skills directory doesn't exist** with `SOLRAC_SKILLS_ENABLED=true`: warn line, empty registry, boot continues.
- **Empty body after frontmatter**: rejected (no prompt to send).

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

- **Engine routing**: prefix `@` (primary), `!` (secondary), `>` (Ollama). The composer has a 3-state pill that prepends the prefix for you.
- **Slash commands**: `/help`, `/status`, `/context`, `/clear [primary|secondary|all]`, `/compact`, plus any operator-defined skills.
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
