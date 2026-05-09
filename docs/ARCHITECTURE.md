# Architecture

Developer's guide to Solrac. If you're reading source for the first time, start here.

This is the longest doc — section it by need. The "Module map" and "End-to-end data flow" sections are the floor; the rest goes deep on specific seams.

## Table of contents

1. [Philosophy](#philosophy)
2. [Module map](#module-map)
3. [End-to-end data flow](#end-to-end-data-flow)
4. [SDK integration](#sdk-integration)
5. [Concurrency model](#concurrency-model)
6. [SQLite schema](#sqlite-schema)
7. [Three-tier permission policy](#three-tier-permission-policy)
8. [Engine routing (prefix table)](#engine-routing)
9. [Ollama local-model routing](#ollama-routing)
10. [Threat model and defenses](#threat-model-and-defenses)
11. [DB-pollution defenses](#db-pollution-defenses)
12. [Tricky seams](#tricky-seams)
13. [Logging](#logging)
14. [Lifecycle](#lifecycle)
15. [Anti-goals](#anti-goals)

---

## Philosophy

Solrac is built on three commitments that shape every decision below:

1. **Own the host process.** No HTTP framework, no Telegram framework runtime, no queue server. Everything that touches a chat, a tool, or the database lives in this Bun process. We trade libraries for clarity at production-scale-of-one — when something breaks at 2am, the whole stack is read in under an hour.
2. **Audit before acting.** Every update — allowed, denied, or queue-full — writes an `audit` row. The audit log is the source of truth for "what did the bot do today?", not the chat history (which we don't own) or the SDK's session store (which is opaque).
3. **Defense in depth.** Allowlist + three-tier classifier + cost cap + loop detector + db-pollution defenses + sub-agent default-deny. Each is independent; any single failure leaves the others intact.

These commitments are why the codebase is ~2k lines split across small focused modules with explicit dependency direction, instead of one big `bot.ts`.

---

## Module map

```
src/
├── log.ts            — JSON-to-stdout logger
├── config.ts         — env validation; freezes Config
│
├── db.ts             — bun:sqlite (WAL); prepared statements
├── allowlist.ts      — isAllowed / bootstrap
├── session.ts        — upsert/get session id per chat
│
├── mutex.ts          — KeyedMutex<K> per-key serial chain
├── semaphore.ts      — global counting concurrency limit
├── turn-tracker.ts   — symbol-keyed in-flight set + drain()
├── queue.ts          — composes mutex + semaphore + tracker
│
├── telegram.ts       — raw fetch + tgCall + 429 retry
├── poll.ts           — long-poll loop + PID file + dedupe
│
├── policy.ts         — classifier, cost cap, confirmation broker,
│                       loop detector, PreToolUse hook,
│                       db-pollution defenses
│
├── markdown.ts       — markdown → Telegram-safe HTML (marked + custom renderer)
├── agent.ts          — wires Claude Agent SDK; runs one turn
│
├── server.ts         — Bun.serve: /health + /stats
├── web-client.ts     — TelegramClient sink that publishes to an in-process
│                       bus (used by the optional web UI transport)
├── web-sanitize.ts   — allowlist HTML sanitizer (server tests + browser)
├── web.ts            — second Bun.serve (login, SSE, message, confirm)
├── lifecycle.ts      — graceful shutdown
├── daily-report.ts   — cron: yesterday's per-chat spend
│
└── main.ts           — wires everything together; transport switch
```

### Dependency direction

Strict. Each file imports only from files lower in the graph:

```
log, config        →  zero internal deps
db                 →  log
allowlist, session →  db
mutex, semaphore,
turn-tracker       →  zero internal deps
queue              →  mutex + semaphore + turn-tracker + config + log
telegram           →  config + log
markdown           →  telegram (htmlEscape only)
policy             →  db + telegram + log + config
agent              →  session + policy + telegram + log + markdown
poll               →  telegram + db + log
server             →  log
web-sanitize       →  zero internal deps
web-client         →  telegram (types only)
web                →  log + web-client + web-sanitize
lifecycle          →  db + log + turn-tracker
daily-report       →  db + telegram + log
main               →  everything
```

There are no cycles. Refactor with the import graph; it's load-bearing.

---

## End-to-end data flow

Tracing a single user message through the system:

```
1. Telegram client                        (user types "hello")
        ↓
2. Telegram Bot API                        (HTTPS POST → Telegram)
        ↓
3. poll.ts::startPolling                   (long-poll loop returns the Update)
   ├── log "update.received"               (every update, before any gate)
   ├── db.claimUpdate(update_id)           (INSERT OR IGNORE; dedupe)
   └── handler(update)                     (defined in main.ts)
        ↓
4. main.ts handler
   ├── gateAndAuditDenied                  (allowlist check)
   │     └── deny → write audit row, return
   ├── if update.callback_query
   │     └── dispatchCallbackQuery → broker.resolve()  (button tap path)
   └── queue.enqueue(update)                  (text-message path)
        ↓
5. queue.ts::createTurnQueue
   ├── tracker.begin()                     (sync — visible to drain)
   ├── mutex.depth check                   (drop_queue_full if ≥10)
   ├── KeyedMutex chain (per chat.id)       (serial per chat)
   └── Semaphore acquire (global)            (cap at 4)
        ↓
6. main.ts::makeRunTurn — slash command interception
   ├── parseCommand(msg.text, { botUsername })
   │     ├── kind="ignore"       → group-chat command for another bot; drop
   │     ├── kind="run"          → runCommand(deps, msg, cmd, update_id)
   │     │     ├── /clear        → sessions.clearAll(); audit (model='system')
   │     │     ├── /compact      → runCompactTurn() → setSummary + clearSessionId
   │     │     ├── /context      → render token breakdown; audit
   │     │     ├── /status       → render snapshot; audit
   │     │     ├── /help, /      → render help; audit
   │     │     └── unknown       → "Unknown command"; audit
   │     │     return            (engine routing skipped)
   │     └── kind="passthrough"  → fall through to engine routing below
   │
6b. main.ts::makeRunTurn → engine routing → agent.ts::runAgent
   ├── parseEnginePrefix(msg.text)        (primary | secondary | ollama)
   ├── mkdir workspaces/<chatId>/
   ├── db.insertAudit (status=in_progress)
   ├── tg.sendMessage("🤔 thinking…")        (the stub)
   ├── read sessions.getSummary(chatId, engine) IFF prevSessionId === null
   ├── read db.outOfBandForEngine(chatId, prefix, 6)
   ├── if summary || OOB → buildAugmentedPrompt(summary, oobTurns, prompt)
   ├── build createPolicyHook (canUseTool)
   ├── build createPreToolUseHook (cost cap + loop)
   └── for await SDKMessage of query(opts)
        ├── assistant: append to text, edit stub (1.5s throttle)
        └── result:    finalize cost/tokens/sessionId/cache_tokens
        ↓
7. SDK spawns `claude` subprocess
   ├── env scrubbed by sanitizedSubprocessEnv()
   ├── canUseTool callbacks routed back to broker
   ├── PreToolUse hook fires for every tool
   └── final result.session_id returned to host
        ↓
8. agent.ts wrap-up
   ├── editMessageText (final answer + footer)
   ├── sessions.setSessionId(chatId, engine, sessionId)
   ├── if summary was injected and turn succeeded → sessions.clearSummary
   └── db.updateAuditEnd (status=ok|error|denied, cost, tokens, cache tokens)
        ↓
9. queue.ts work() finally
   ├── semaphore.release()
   └── tracker.end(tag)
```

Every numbered step has a structured log line. Tracing a turn end-to-end is `jq 'select(.update_id == 12345)'` over `journalctl`.

### What gets persisted

Per turn, **two database writes**:
- `INSERT INTO handled_updates (update_id, …)` — idempotency
- `INSERT INTO audit (…)` then `UPDATE audit SET … WHERE id = ?`

Plus, on completion: `INSERT OR REPLACE INTO sessions (chat_id, agent_session_id, …)`.

For denied turns: same but with `status='denied'` and no session update.

For `queue_full`: `INSERT INTO audit … status='error', error_message='queue_full'` and no completion update.

### Slash commands

`commands.ts` owns parsing + dispatch for the five user-facing commands (`/clear`, `/compact`, `/context`, `/help`, `/status`). The dispatcher branch sits at the top of `makeRunTurn`, **after** allowlist gating + queue enqueue but **before** engine-prefix routing — commands run inside the same per-chat KeyedMutex chain as engine turns, so a `/clear` sent right after a long-running turn waits for the turn to finish (and its `setSessionId` write to land) before it drops the id.

**Parser shape.** Pure regex (`^\s*([\/:])([A-Za-z0-9_]{0,32})(?:@(...))?(?:\s+(.+))?$`). Both `/` and `:` are accepted as the leading character — `/` enables Telegram's autocomplete (registered via `setMyCommands` at boot) and triggers Telegram's bot-command auto-link in client UI; `:` is a non-auto-linked alias for the help card so command names render bold without going blue. Unknowns under `/` surface as a usage hint; unknowns under `:` pass through to engine routing (`:foo` in prose is more likely natural text than a typo'd command).

**Audit-row policy.** Every command writes exactly one audit row.
- `/clear`, `/help`, `/status`, `/context`, unknown → `model='system'`, `cost_usd=NULL`.
- `/compact` (success or error) → `model='claude:<tier>:<id>'` (engine-tagged) so the cost (or NULL on rejection) rolls up under the per-chat hourly cap on subsequent queries. The `update_id` field carries the real Telegram update id — sentinels are not used.

**`/compact` summarize-and-restart.**
1. Pre-flight cap check (`costGuard.check` per-chat, `globalCostGuard.check` global). If exceeded → write error audit row, no SDK call.
2. Source query: up to 50 most recent successful turns for `(chat_id, engine_prefix)` filtered by `started_at > previous summary timestamp` so back-to-back `/compact` doesn't re-summarize.
3. SDK call: `query()` with `model = primaryModel | secondaryModel`, **no `resume`** (fresh, isolated turn), `maxTurns: 1`, `disallowedTools: ["Agent","Task","Bash","Write","Edit","NotebookEdit","WebFetch","WebSearch"]`, `canUseTool: deny-all`. Belt-and-suspenders against accidental tool use.
4. Persist: `sessions.setSummary(chatId, tier, text, at)` + `sessions.clearSessionId(chatId, tier)` — the only two state transitions.
5. Reply: `✅ Compacted N turns for primary · ~M tokens · $0.0123` (header only; full summary stored in audit `response` snippet).
6. Source-quality signal: when ≥1 source row's `audit.prompt` is at the truncation boundary (≥250 chars per `MAX_AUDIT_PROMPT_LEN=256`), the runner logs `compact.source_prompts_truncated` so the operator can tell when summary quality may degrade (Solrac's responses are full-length but user prompts are capped).

**Summary lifecycle and the no-duplication invariant.** A pending summary lives in `sessions.<tier>_summary` until consumed. On the next user turn for that tier, `runAgent` reads the summary **only if `prevSessionId === null`** — a resumed session already carries the full conversation, so injecting a summary on top would duplicate context. After the turn succeeds, `clearSummary` runs alongside `setSessionId`. If the turn errors, the summary is left intact for retry. The XOR (session-id-set ⊻ summary-pending) is enforced at the read site so any future write-side bug that leaves both populated still does the right thing.

**Cache telemetry.** `audit.cache_creation_input_tokens` and `audit.cache_read_input_tokens` are captured for every Anthropic turn (Ollama and system rows store NULL). Without these, `/context`'s "estimated next-turn replay" would dramatically under-report on resumed sessions where most input is `cache_read`.

**Group chat.** `parseCommand` only runs when an `@<bot>` suffix matches the cached `botUsername` (lowercased, from boot-time `getMe`). If `getMe` failed at boot, the parser fails closed: plain commands work, any `@bot` suffix is rejected.

### Skills — operator-defined commands

`skills.ts` adds a filesystem-discovered command surface on top of the `commands.ts` dispatcher. Skills are operator-authored `SKILL.md` files under `$SOLRAC_SKILLS_DIR/<name>/` discovered ONCE at boot (no hot-reload, matching the boot-once config story). Disabled by default (`SOLRAC_SKILLS_ENABLED=false`).

**Boot sequence (in `main.ts`).**
1. Load skills sync: `loadSkillsSync(config.skillsDir, BUILT_IN_NAMES)` — fail-soft. Each malformed `SKILL.md` adds an error to the result; valid ones populate the registry. Missing directory → empty registry + one error (NOT a crash).
2. Telegram autocomplete: `setMyCommands([...BOT_COMMAND_REGISTRY, ...skillsToBotCommands(registry.all)])` — built-ins first, skills after.
3. Plumb the registry into `commandDeps` and `parseCommand`.

**Parser hook.** After the `KNOWN_COMMANDS` check misses, `parseCommand` looks up the name in the registry. A hit returns `{ kind: "skill", skill, args }`. A miss falls through to the existing unknown-vs-passthrough logic (`/` → unknown, `:` → passthrough). Built-ins always win — even if a buggy registry returned a skill named `clear`, the built-in arm fires first.

**Frontmatter schema (3 fields).**
- `name` — required, matches `[a-z0-9_]{1,32}`, must NOT collide with built-in names (rejected at load time).
- `description` — required, ≤256 chars (used in `setMyCommands` payload + `/help` rendering).
- `tier` — optional, `primary` | `secondary`, default `primary`.

The body is a Claude prompt; `{{args}}` is the only placeholder and is replaced literally with the user's text after the command name. The frontmatter parser is a homemade YAML subset (~70 LOC in `skills.ts`) — handles `key: scalar`, `key: [a, b, c]`, quoted strings, integers, booleans. Adding `js-yaml` for a 3-key schema was disproportionate.

**Skill execution (`runSkill` in `commands.ts`).** Mirrors `runCompactTurn`'s structural pattern:
1. Pre-flight cap check (chat + global). Cap-rejected skills cost $0 — the SDK is never touched.
2. `query()` with `maxTurns: 1`, no `resume`, `disallowedTools` deny-list, `canUseTool: deny-all`. Skills are tool-less in v1.
3. Audit row tagged `claude:<tier>:<model>:skill:<name>` so cost rolls up under the existing per-chat hourly cap and operators can grep by skill name.
4. Reply: model output verbatim, HTML-escaped, truncated to ≈3,500 chars (Telegram per-message ceiling minus headroom).

**Why no factored-out one-shot helper?** `runSkill` and `runCompactTurn` share ~70% of the SDK-call boilerplate, but the post-processing differs (compact persists summary + drops session id; skills just reply). Duplicating the shape keeps each handler readable; a v1.1 extraction is cheap when a third caller arrives.

**Why no description-based routing?** Claude Code's skills are auto-loaded based on description matching. For Solrac that would mean injecting all skill descriptions into every Claude system prompt (token cost) plus a meta-LLM pre-pass to pick one. Explicit `/<name>` is simpler and matches the existing engine-prefix discipline. v1 ships explicit only.

---

## SDK integration

Solrac depends on `@anthropic-ai/claude-agent-sdk@0.2.119` (pinned exact, no caret). The full verified surface is in [SDK_NOTES.md](./SDK_NOTES.md).

### `query()` options used

`agent.ts::runAgent` builds an `Options` object:

```ts
{
  cwd: <DATA_DIR>/workspaces/<chatId>,
  // Per-tier model resolution. The runner picks one based on input.engine:
  //   'primary' → SOLRAC_PRIMARY_MODEL, 'secondary' → SOLRAC_SECONDARY_MODEL.
  model: <SOLRAC_PRIMARY_MODEL | SOLRAC_SECONDARY_MODEL>,
  maxTurns: 25,
  permissionMode: "default",
  tools: { type: "preset", preset: "claude_code" },
  systemPrompt: { type: "preset", preset: "claude_code", append: `${soul}\n\n${CLAUDE_CAPABILITY_NOTE}` },
  disallowedTools: ["Agent", "Task"],
  canUseTool: <per-turn factory>,
  env: sanitizedSubprocessEnv(),
  hooks: { PreToolUse: [{ hooks: [<per-turn hook>] }] },
  // Resume is per-tier — the SDK session id is keyed (chatId, tier) so primary
  // and secondary can each cache their own conversation independently.
  resume?: <previous tier session id>,
}
```

### Tool preset

`tools: { type: "preset", preset: "claude_code" }` gives the agent the same tool surface as Claude Code itself: `Bash`, `Read`, `Edit`, `Write`, `Glob`, `Grep`, `WebFetch`, `WebSearch`, `TodoWrite`, MCP tools, etc.

### System prompt: `preset` + `append` — externalized to `SOUL.md`

```ts
systemPrompt: {
  type: "preset",
  preset: "claude_code",
  append: `${soul}\n\n${CLAUDE_CAPABILITY_NOTE}`,
}
```

A bare string-or-array `systemPrompt` **replaces** the preset. Replacing strips the SDK's tool-use guidance, which matters for non-trivial reasoning over tools. `append` keeps the preset and tacks two pieces on:

1. **`soul`** — the contents of `SOUL.md` from the launch cwd, read once at boot via `instance.ts::loadSoul`. This is the operator-editable Solrac persona (voice, stance, untrusted-content safety clause). Mirrors OpenClaw's SOUL.md: voice, stance, and style — not operating rules.
2. **`CLAUDE_CAPABILITY_NOTE`** — a one-sentence engine-specific clause defined in `agent.ts` next to the cost-cap wiring (kept in code so the factual statement about tool-call gating travels with the enforcement).

A second, operator-editable layer — `SOLRAC.md` — is re-read per turn and injected as a `<solrac-md>...</solrac-md>` block at the top of `buildAugmentedPrompt`. SOLRAC.md is the operating-rules / instance-config layer (operator name, channel posture, project hints) and is analogous to a per-project CLAUDE.md.

See `instance.ts` for the file lifecycle (bootstrap-on-first-boot, hard-fail on missing SOUL, soft-warn on missing SOLRAC) and `agent.ts::buildAugmentedPrompt` for the per-turn injection point.

### Permission mode

`'default'` — the SDK routes "non-trivial" tools through `canUseTool` and auto-approves trivial ones (Read, Bash with safe prefixes, etc.). This is what created the "auto-approve bypass" that drove the `PreToolUse` hook. See [Tricky seams](#1-cost-cap-and-loop-detector-bypass).

### Two safety hooks per turn

- **`canUseTool`** — interactive Telegram-confirm UX. Built per-turn by `policy.ts::createPolicyHook`.
- **`PreToolUse` hook** — always-fires gate (cost cap + loop detector). Built per-turn by `policy.ts::createPreToolUseHook`.

Both are per-turn so the loop counter and audit id are correctly scoped. The factories close over `chatId` and `auditId`.

### Sub-agent disabled at two layers

Per `policy.ts` and `agent.ts:113`:

- `disallowedTools: ["Agent", "Task"]` — SDK never advertises these tools to the model.
- `policy.ts::classifyTool` returns `deny` for them — even if `disallowedTools` is somehow bypassed, the policy hook denies.

Belt and suspenders. See [OQ#8](./ROADMAP.md#oq8-sub-agent-enablement) for re-enabling.

### Streaming UX: edit, not append

Solrac does **not** send a sequence of messages as the agent thinks. Instead:

1. Send one stub message: `🤔 thinking…`
2. As `SDKAssistantMessage`s stream in, edit the stub via `editMessageText`.
3. Final state is the same message, edited to the answer + `<i>✅ N turns · $X.XXXX</i>` footer.

Throttle: 1.5s minimum between edits (`agent.ts::EDIT_THROTTLE_MS`). The first edit always happens immediately so Telegram's "..." indicator doesn't linger.

Why edit-not-append: device push notifications on edits are silent, while every new message pings. After 50 messages in a single turn, the user's lock screen would be unusable. We accept the trade-off (no completion ping) and expect attentive users to glance at the chat.

The "no-op edit" guard tracks `lastEditedContent` so we don't send `editMessageText` with the same body — Telegram returns `400 Bad Request: message is not modified` for those.

### Subprocess env scrubbing

The SDK's `query()` spawns a `claude` subprocess that **inherits parent env**. That's a vulnerability: a user-level Claude Code plugin (e.g. the official `telegram@claude-plugins-official`) reads `TELEGRAM_BOT_TOKEN` from env and starts polling, racing our own poller.

`agent.ts::sanitizedSubprocessEnv()` scrubs:

- `TELEGRAM_*`
- `TG_*`
- `STATS_BEARER_TOKEN`
- `ALLOWLIST_BOOTSTRAP`

Pass-through for everything else (the agent legitimately needs `ANTHROPIC_API_KEY`, `PATH`, etc.). If you add a new operator-only secret, add a scrub line. If you add a third-party API key meant for the agent's tools, leave it pass-through and consider adding an [auto-deny rule](#bash-rule-tables) for the corresponding CLI to keep budget under the cap.

### Integrations: in-process MCP server

Operators can extend the Claude tiers' tool surface by dropping TypeScript modules under `src/integrations-builtin/<name>/index.ts` (blessed, shipped with solrac) or `$SOLRAC_INTEGRATIONS_DIR/<name>/index.ts` (operator-authored). Each module default-exports `setup(ctx) → { apiVersion: 1, tools, meta? }`. At boot, `main.ts` invokes `loadIntegrations([builtinDir, operatorDir], ctx)`, collects every tool, and passes them through a single `createSdkMcpServer({ name: "solrac", tools })` to the SDK as `options.mcpServers = { solrac }`.

Tools surface to the model as `mcp__solrac__<name>`. The full picture:

- **Loader.** `src/integrations.ts` — fail-soft per-integration error handling, first-dir-wins on tool-name collisions (so a stale operator copy can't shadow a blessed integration), boot-only (no hot-reload, matches skills loader semantics).
- **Context.** `IntegrationContext` carries `{ z, tool, fetch, log, env }`. Integrations don't import zod or the SDK directly; they receive solrac's instances. Each integration directory IS its own dependency root — Bun's dynamic `import()` resolves bare specifiers from the integration's location upward, so `npm install @linear/sdk` next to `index.ts` works without polluting solrac's `node_modules`.
- **Policy gating.** Integration tools default to `"confirm"` (Telegram inline-keyboard) via `policy.ts::classifyTool`'s catch-all. An integration may declare `meta.tier: "auto"` or `meta.toolTiers: { tool_name: "auto" }` to bypass the prompt for safe operations. `classifyToolWithIntegrations(toolName, input, toolTiers)` is the integration-aware shim — `classifyTool` itself stays pure.
- **Cost cap + loop detector** apply identically to integration tools — every `mcp__solrac__*` call passes through the same `PreToolUse` hook that gates Claude's preset tools, so `policy.cost_cap_exceeded` fires the same way regardless of source.
- **Heavy deps optional.** Blessed integrations (e.g. `gmail`) may dynamic-import packages like `googleapis` and gracefully no-op when absent. Solrac's direct dependencies remain SDK + `marked` + `zod`. Operators who want Gmail run `npm install googleapis google-auth-library` from the solrac root once.

### Ollama scope

`runOllamaTurn` in `ollama.ts` branches on `OLLAMA_TOOLS_ENABLED`:

- **Tools off (default for Claude-only deploys):** single-shot streaming via `/api/chat`. No tools exposed; `audit.tool_calls` is `null`. The capability note (`ollama.ts::buildOllamaCapabilityNote`) tells the model it has no tools and nudges users toward `@`/`!` for tool-shaped requests.
- **Tools on (recommended for the Ollama-default deploy; precondition: `SOLRAC_INTEGRATIONS_ENABLED=true`):** multi-round tool loop in `src/ollama-tools.ts::runToolLoop`. The local model receives the same `mcp__solrac__*` integration tools the Claude tiers see, with per-call gating reused from `policy.ts` (`classifyToolWithIntegrations`, the `LoopDetector`, the `ConfirmationBroker`). `OLLAMA_MAX_TOOL_ITERATIONS` (default 8) backstops a single shared `AbortSignal` covering every fetch in the turn. `audit.tool_calls` records the executed calls. The capability note advertises the loaded tool names so the model knows what it can call.

Both paths share the audit row format, the streaming stub UX, the cost-cap-doesn't-apply rule (`cost_usd = 0`), the cross-engine context bridge, and the `disallowedTools` belt-and-suspenders (`OLLAMA_DENY_TOOLS` mirrors `agent.ts`'s SDK-level `disallowedTools: ["Agent","Task"]`). Reliability of Ollama tool-calling varies sharply by model — `gemma4:e4b` is the recommended baseline.

---

## Concurrency model

Solrac runs everything in a single Bun process. Concurrency comes from three composed primitives.

### `KeyedMutex<K>` — `mutex.ts`

Per-key serial chain. Tasks for the same key chain to a tail Promise; tasks for different keys are independent. Exposes:

- `run(key, work)` — appends `work()` to the key's chain.
- `depth(key)` — current chain length, including the running task. Sync-incremented before any await so post-`run()` depth reads are consistent.
- `size()` — number of active keys.

Used by `queue.ts` keyed on `chat.id`: same-chat messages run serially; different chats are independent.

### `Semaphore` — `semaphore.ts`

Counting global concurrency limit. FIFO waiters. Idempotent release. Validates positive-integer limit at construction.

`MAX_CONCURRENT_TURNS` (default 4) is the global cap. Set per env via `MAX_CONCURRENT_TURNS`.

### `TurnTracker` — `turn-tracker.ts`

Symbol-keyed `Set<symbol>` plus a list of waiters. Used by lifecycle's drain on shutdown.

- `begin()` — returns a fresh symbol; called sync inside `queue.enqueue`.
- `end(tag)` — removes the symbol; when set hits 0, resolves all `drain()` waiters.
- `count` — current size; surfaced via `/stats`.
- `drain()` — `Promise<void>` that resolves when count reaches 0.

### `createTurnQueue` — `queue.ts`

Composes the three:

```ts
function enqueue(update) {
  const key = update.message?.chat.id ?? ...;        // chat key
  if (mutex.depth(key) >= maxChainDepth)
    return { kind: "dropped_queue_full", depth, key };
  const tag = tracker.begin();                       // sync — drain sees it immediately
  const work = async () => {
    const release = await sem.acquire();              // wait for global slot
    try   { await runTurn(update); }
    catch { log "turn.error"; }
    finally { release(); tracker.end(tag); }
  };
  if (key === undefined) void work();
  else                   void mutex.run(key, work);
  return { kind: "enqueued" };
}
```

Importantly: `enqueue()` is **sync**. The poll loop's handler doesn't await turn completion — it returns immediately so the next `getUpdates` call can fire. Long-running turns float on `void work()` and are tracked via `TurnTracker`.

This pattern is sometimes called "float-and-track" — the work is in-flight but not awaited at the call site.

### Re-entrancy

Multiple things can run concurrently inside one process:

- The poll loop's `for await` over `getUpdates`.
- Any number of in-flight turns (capped by Semaphore).
- The SDK's parallel tool-call fan-out within a turn (each tool call may invoke `canUseTool` concurrently).
- The Telegram callback-query handler resolving a broker pending-confirmation.

`policy.ts::createLoopDetector` and `policy.ts::createCostCapGuard` are re-entrant safe: the loop detector's read-modify-write happens in a single sync expression on a `Map`; cost-cap is a single sync SQL read. The `ConfirmationBroker.pending` map is touched by `setTimeout`, `dispatchCallbackQuery`, and the broker's own `request` — all single-key writes, no compound mutations.

---

## SQLite schema

`db.ts` defines five tables. WAL mode, `busy_timeout = 5000`, `foreign_keys = ON`. For a column-by-column reference, the index list, and a task-oriented query cookbook (forensics, performance, cross-engine, migration sanity), see [SCHEMA.md](./SCHEMA.md).

### `meta`

Key-value store for offsets and "sent today" markers.

```sql
meta(key TEXT PK, value TEXT, updated_at INTEGER)
```

Keys in use: `poll_offset`, `cost_report_last_date`.

### `allowlist`

Bootstrap-on-startup list of permitted `from.id`s.

```sql
allowlist(user_id INTEGER PK, added_at INTEGER)
```

### `handled_updates`

Idempotency surface: every Telegram `update_id` we've claimed.

```sql
handled_updates(update_id INTEGER PK, handled_at INTEGER)
```

`INSERT OR IGNORE` is the dedupe primitive in `poll.ts`.

### `sessions`

Per-chat, per-tier SDK session state for resume.

```sql
sessions(
  chat_id INTEGER PK,
  agent_session_id TEXT,        -- DEPRECATED; pre-tier column, kept for rollback compat
  primary_session_id TEXT,      -- SDK session id for the primary tier (Sonnet)
  secondary_session_id TEXT,    -- SDK session id for the secondary tier (Opus)
  primary_summary TEXT,         -- pending /compact summary for primary tier
  primary_summary_at INTEGER,   -- ms timestamp of the compact (cutoff for re-compact)
  secondary_summary TEXT,       -- pending /compact summary for secondary tier
  secondary_summary_at INTEGER, -- ms timestamp
  created_at INTEGER,
  updated_at INTEGER
)
```

The Anthropic SDK sessions are model-bound, so each Claude tier needs its own persisted session id. The legacy `agent_session_id` column stays in the schema for rollback compatibility (SQLite ALTER doesn't drop columns cleanly pre-3.35). New writes only touch the per-tier columns.

The summary columns hold a pending `/compact` summary until the next user turn for that tier consumes it. Lifecycle: written on `/compact` success; read by `runAgent` when `prevSessionId === null`; cleared after a successful turn. `<tier>_summary_at` is the cutoff passed to `recentChatTurnsForEngine` so back-to-back `/compact` doesn't re-summarize already-condensed turns.

### `audit`

The big one. One row per attempted turn (allowed, denied, or queue-full).

```sql
audit(
  id INTEGER PK AUTOINCREMENT,
  tree_id INTEGER NOT NULL,
  parent_turn_id INTEGER REFERENCES audit(id),
  chat_id INTEGER,
  from_id INTEGER,
  update_id INTEGER,
  agent_session_id TEXT,
  prompt TEXT,
  response TEXT,
  tool_calls TEXT,            -- JSON [{name, input}, …]
  input_tokens INTEGER,           -- post-cache fresh input only (Anthropic API)
  output_tokens INTEGER,
  cache_creation_input_tokens INTEGER,  -- tokens written to cache this turn
  cache_read_input_tokens INTEGER,      -- tokens read from cache (cheap)
  cost_usd REAL,
  status TEXT NOT NULL DEFAULT 'in_progress',  -- 'ok' | 'error' | 'denied'
  error_message TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
)

CREATE INDEX idx_audit_tree         ON audit(tree_id);
CREATE INDEX idx_audit_chat_started ON audit(chat_id, started_at);
```

The `tree_id` / `parent_turn_id` columns are reserved for sub-agent fan-out ([OQ#8](./ROADMAP.md#oq8-sub-agent-enablement)). v1 always sets `tree_id = own row id, parent_turn_id = NULL`. The columns exist now so a future enable-sub-agents PR doesn't have to migrate.

The `idx_audit_chat_started` index is the one used by `db.sumChatCostSince` (cost-cap query) — every cost-cap check is one indexed lookup.

**Token columns.** The Anthropic API returns four token counts per turn (`BetaUsage`): `input_tokens` (fresh, post-cache), `output_tokens`, `cache_creation_input_tokens` (paying to populate the cache), `cache_read_input_tokens` (cheap reads from cache). For a *resumed* SDK session most of the actual on-the-wire input lives in `cache_read_input_tokens` — without capturing it, the audit log would dramatically under-report context size. `/context` renders the full breakdown; estimated next-turn replay is `input + cache_read + cache_create + output`. Ollama and `system` rows have all four set to NULL.

### Why these aren't separate audit tables

You might expect separate tables for "allowed turns" and "denied attempts" — they have different shapes. We use one table with a `status` column because:

1. The audit log is a unified observability surface; one query gives "everything that happened today."
2. Schema migrations are easier with fewer tables.
3. Disk waste for null columns is negligible at our row counts.

---

## Three-tier permission policy

Every tool call is classified into one of three tiers (`policy.ts::classifyTool`):

```
ToolDecision = { kind: "allow" }
             | { kind: "deny", message: string }
             | { kind: "confirm" }
```

### Tier 1 — auto-allow

`policy.ts::READ_ONLY_TOOLS` contains: `Read`, `Glob`, `Grep`, `LS`, `WebFetch`, `WebSearch`, `TodoWrite`, `BashOutput`, `NotebookRead`.

Plus, for `Bash`, leading-token allowlist (`policy.ts::BASH_SAFE_PREFIXES`):

`ls`, `pwd`, `cat`, `head`, `tail`, `echo`, `date`, `whoami`, `uname`, `which`, `find`, `grep`, `wc`, `git status|log|diff|show|branch|remote|rev-parse|ls-files|config --get|fetch`, `node --version`, `bun --version`, `npm/pnpm list|outdated|view|why|info`.

These run without prompting the user. The agent is also free to fail — that's not an error, just a deny from the OS.

### Tier 2 — auto-deny

`policy.ts::SUBAGENT_DENY_TOOLS`: `Agent`, `Task`. Sub-agents disabled.

`policy.ts::BASH_DANGEROUS_PATTERNS`:

| Pattern | Reason |
|---------|--------|
| `\brm\s+-[rRf]+\s+(\/|~|\$HOME)(\s|$)` | rm -rf on root or home |
| `\bsudo\b` | sudo elevation |
| `\bmkfs\b` | filesystem format |
| `\bdd\s+if=` | raw disk dd |
| `:\(\)\{\s*:\s*\|\s*:&\s*\};:` | fork bomb |
| `\bchmod\s+-R\s+777` | world-writable chmod -R |
| `\b(curl\|wget)\b[^\|]*\|\s*(bash\|sh\|zsh)\b` | pipe-to-shell remote exec |
| `\bgit\s+push\s+(\S+\s+)*-{1,2}f(orce)?\b` | force push |
| `\b(claude\|openai\|replicate\|anthropic)\b` | paid third-party CLI ([OQ#5](./ROADMAP.md#oq5-cost-surprises-beyond-anthropic)) |

Returns `{ behavior: "deny", message }` to the SDK. The agent typically pivots to a different approach.

#### Bash rule tables

The dangerous patterns above use `(\s|$)` rather than `\b` after non-word characters like `/` or `~`. `\b` is a word-boundary; between two non-word chars there *is* no boundary, so `rm -rf /` would not match `rm\s+-rf\s+/\b` (there's no word char after `/`). `(\s|$)` works for both `/` and `/.cache/file`.

### Tier 3 — telegram-confirm

Everything else — `Write`, `Edit`, `NotebookEdit`, non-allowlisted `Bash`. Falls through to `policy.ts::createConfirmationBroker`, which:

1. Generates a UUID `cb:<uuid>:a|d` callback id.
2. Sends an inline-keyboard message via `tg.sendMessage`.
3. Stores `{ resolve, timer }` in a per-process `Map<id, …>`.
4. Returns a `Promise<ConfirmDecision>` — `"allow" | "deny" | "timeout"`.
5. `dispatchCallbackQuery` resolves the entry on a button tap; `setTimeout(60s)` resolves it as `"timeout"` if the user ignores it.

**Fail-closed**: if `tg.sendMessage` throws (network drop, rate limit, etc.), the broker resolves to `"deny"` immediately so the SDK turn doesn't hang.

### Cost-cap pre-emption

`createPolicyHook` checks the cost cap **before** running the classifier. If the cap is exceeded, every tool call denies — even read-only ones. This avoids burning a turn on free reads when the budget is gone.

<a id="cost-caps"></a>

### Cost caps: per-chat (fairness) AND global (absolute safety)

Solrac runs **two** independent cost caps. They coexist by design — different threats, different scopes.

| Cap | Scope | Default | Env | Failure mode it prevents |
|-----|-------|---------|-----|--------------------------|
| **Per-chat** | One chat over a sliding hour | `$1.00/hr` | `HOURLY_COST_CAP_USD` | One user (or one runaway turn) burns the whole hourly budget — other allowlisted users get fairness. |
| **Global** | All chats summed over a sliding hour | `HOURLY_COST_CAP_USD × MAX_CONCURRENT_TURNS` (`$4.00/hr` with defaults) | `GLOBAL_HOURLY_COST_CAP_USD` | N concurrent chats each at their per-chat cap → host-wide spend = N×cap. The global cap is the absolute ceiling on Anthropic burn from this process. |

**Order of evaluation in the PreToolUse hook (`policy.ts::createPreToolUseHook`):**

1. Global cap → deny with `policy.global_cost_cap_exceeded` if over.
2. Per-chat cap → deny with `policy.cost_cap_exceeded` if over.
3. Loop detector → deny if same `(toolName, toolInput)` 3× in this turn.

Global is checked first because if the host is over its absolute budget, every chat is blocked uniformly — checking per-chat first would mask the global hit under "this chat is fine."

**Tuning guidance:**

- Default global = per-chat × concurrency. If you bump `MAX_CONCURRENT_TURNS`, the global default auto-tracks unless you've set `GLOBAL_HOURLY_COST_CAP_USD` explicitly.
- For production: set both explicitly so a future concurrency bump can't quietly raise the spend ceiling. `HOURLY_COST_CAP_USD=1.00 GLOBAL_HOURLY_COST_CAP_USD=4.00`.
- For dev: the defaults are fine; the audit log will show `error_message='policy_deny: ...cap reached: ...'` when either fires.

**v1 limitation:** both caps measure Anthropic API spend only. Tools that call paid third-party APIs (e.g. a `replicate` CLI) aren't measured; auto-deny rules in the classifier are the v1 mitigation. See [`ROADMAP.md` OQ#5 — cost surprises beyond Anthropic](./ROADMAP.md#oq5-cost-surprises-beyond-anthropic).

**Ollama tool calls are NOT gated by either cost cap.** Ollama is free; the cap exists to bound Anthropic spend. The `OLLAMA_MAX_TOOL_ITERATIONS` ceiling and the per-turn loop detector are the runaway-loop defenses for the local path. Confirm-tier tools still go through the same `ConfirmationBroker` regardless of engine.

---

<a id="engine-routing"></a>

## Engine routing (prefix table)

The first non-whitespace character of `msg.text` picks the engine; with no prefix, `SOLRAC_DEFAULT_ENGINE` (default `ollama`) decides. The default routes no-prefix messages to the local Ollama path, so Anthropic burn happens only on a deliberate `@` (Sonnet) or `!` (Opus).

| Prefix | Engine label | Model | Tools | Audit `model` value |
|--------|--------------|-------|-------|---------------------|
| (none) | depends on `SOLRAC_DEFAULT_ENGINE` (`ollama` by default) | `OLLAMA_MODEL` for default-Ollama; otherwise the matching tier model | integrations only on Ollama (when `OLLAMA_TOOLS_ENABLED=true`); `claude_code` preset + integrations on Claude | matches the resolved engine |
| `@` | `primary` (Claude) — escalation | `SOLRAC_PRIMARY_MODEL` (default `claude-sonnet-4-6`) | `claude_code` preset + integrations | `claude:primary:<modelId>` |
| `!` | `secondary` (Claude) — heaviest | `SOLRAC_SECONDARY_MODEL` (default `claude-opus-4-7`) | `claude_code` preset + integrations | `claude:secondary:<modelId>` |

There is no `>`-style escape prefix. A leading `>` is literal user text routed via no-prefix → `defaultEngine`. The local Ollama path is reached only when it is the default engine.

`policy.ts::parseEnginePrefix(text, defaultEngine)` returns `{ engine, explicit, prompt }`. `explicit` is true only when an actual prefix character (`@` or `!`) was consumed; `main.ts` uses it to render usage hints on empty explicit-prefix payloads.

**Design rationale.** *Claude only when explicitly requested.* Anthropic burn happens on a deliberate `@` or `!`; everything else stays local and free. The integration surface (operator-authored + blessed `mcp__solrac__*` tools) is shared across all three engines — Ollama gets it via `OLLAMA_TOOLS_ENABLED=true`, both Claude tiers get it via the `claude_code` preset.

**Boot validation enforces reachability:**

- `defaultEngine === "ollama" && !ollamaEnabled` → throw (the default would error every turn).
- `defaultEngine !== "ollama" && ollamaToolsEnabled` → throw (Ollama runs only as the default; tools-on without it being the default would load tool schemas no engine can call).

When `defaultEngine === "ollama"`, boot fires a one-shot `GET /api/tags` health probe; failures are logged (`ollama.boot_health_failed`) but non-fatal — daemon may come up after Solrac under systemd, and we don't want to crash the unit on a transient.

```
poll → gate → throttle → queue.enqueue
                          └─ runTurn (queued)
                              ├─ engine === 'ollama'    → runOllamaTurn
                              └─ 'primary' | 'secondary' → runAgent({engine, ...})
```

The dispatch happens **inside the queued worker** so per-chat sequencing (`KeyedMutex`), global concurrency (`Semaphore`), tracker drain on SIGTERM, and queue-full backpressure all apply unchanged across every engine.

### Per-tier SDK sessions

Both Claude tiers share the SDK preset, tools, hooks, MCP, `disallowedTools`, and policy classifier — they only differ in the `model` field passed to `query()`. Each tier persists its own `agent_session_id` in the `sessions` table (`primary_session_id` / `secondary_session_id`), so prompt caching survives same-tier conversation boundaries. The Anthropic SDK sessions are model-bound: switching tiers can't reuse the other tier's session, so we don't try.

### Cross-engine context bridge

The architectural challenge of multi-engine routing: each engine's "view" of the chat history differs. Claude tiers resume via SDK session; Ollama is stateless. If a user mixes engines in one chat, each engine's narrow history would diverge from the user's mental model of "single thread."

Solution — `db.outOfBandForEngine(chatId, currentEnginePrefix, limit)`:

```sql
SELECT prompt, response, model FROM audit
WHERE chat_id = ? AND model NOT LIKE ? AND status = 'ok'
  AND prompt IS NOT NULL AND response IS NOT NULL
  AND started_at > COALESCE(
    (SELECT MAX(started_at) FROM audit WHERE chat_id = ? AND model LIKE ? AND status = 'ok'),
    0
  )
ORDER BY started_at ASC LIMIT ?
```

Caller passes its own engine's prefix (e.g. `'claude:primary:%'`, `'ollama:%'`). Returns turns from OTHER engines whose `started_at` exceeds this engine's most recent successful turn — i.e. exchanges this engine missed. Both Claude tiers prepend those rows to the user prompt as a self-describing context block before calling the SDK; Ollama uses the simpler `recentChatTurns` (which sees every engine without filtering) since it rebuilds its full history every turn anyway.

```
[Out-of-band context: the user had the following exchange(s) in this chat with another engine since I last spoke...]

User: tell me about MATLAB
Other engine (ollama:gemma4:e4b): MATLAB is a paid software...

[End of out-of-band context. The user's current message:]

can you see the context here about MATLAB?
```

The window naturally narrows after this engine consumes the context — the next turn for the same engine has an advanced cutoff `MAX(started_at)` and the same query returns fewer rows (or none). The audit row records the *original* user prompt, not the augmented one, so operator dumps show what the user actually typed.

Default `OUT_OF_BAND_LIMIT=6` (in `agent.ts`) bounds the per-turn token cost: 256-char prompts × 6 turns ≈ ~3k tokens worst case.

### Audit `model` format

Three-segment shape (`engine:tier:modelId`) keeps tier identity stable across model-id bumps. A future env bump from `claude-sonnet-4-6` to `claude-sonnet-4-8` doesn't fragment primary's history — the `LIKE 'claude:primary:%'` pattern still matches.

| Source | Format | Example |
|--------|--------|---------|
| Claude primary | `claude:primary:<modelId>` | `claude:primary:claude-sonnet-4-6` |
| Claude secondary | `claude:secondary:<modelId>` | `claude:secondary:claude-opus-4-7` |
| Ollama | `ollama:<modelId>` | `ollama:llama3.2` |
| Denial / queue-full | `system` | `system` |
| Legacy (single-tier era) | `claude` | retagged at first boot to `claude:secondary:claude-opus-4-7` |

The retag migration is an idempotent `UPDATE audit SET model = 'claude:secondary:claude-opus-4-7' WHERE model = 'claude'` in `db.ts::openDb`. Pre-tier rows ran on the then-default `SOLRAC_MODEL=claude-opus-4-7`, which is now the secondary tier; retagging keeps cross-tier OOB queries honest about historical turns.

---

<a id="ollama-routing"></a>

## Ollama local-model routing

Ollama is the default engine in the recommended config (`SOLRAC_DEFAULT_ENGINE=ollama`). No-prefix messages route here; Claude tiers are reached via explicit `@` / `!`. There is no `>`-style escape prefix — Ollama runs only as the default, so an extra prefix character would be redundant.

Motivation: (1) most casual chat doesn't need Claude's reasoning, so the free local path becomes the workhorse; (2) when `OLLAMA_TOOLS_ENABLED=true`, the local model can call the same `mcp__solrac__*` integrations Claude does — the operator's tool surface is what makes default-Ollama useful for tool-driven work.

### What's the same as Claude

- **Allowlist + denial throttle**: gate happens before queue, every engine falls through the same gate.
- **Audit row**: same `audit` table; the `model` column distinguishes engines (`ollama:llama3.2` vs `claude:primary:claude-sonnet-4-6` vs `claude:secondary:claude-opus-4-7` etc — see [engine routing](#engine-routing) for the full format).
- **Per-chat workspace**: not used — the Ollama path has no shell/filesystem tools (no `claude_code` preset). With `OLLAMA_TOOLS_ENABLED=true`, integration tools execute as in-process TS handlers and don't need a working directory.
- **Streaming UX**: 🦙 stub → throttled `editMessageText` (same `EDIT_THROTTLE_MS = 1500` constant) → final edit with footer. The no-op-edit guard applies; the footer (`<i>✅ ollama:<model> · Ns</i>`) is load-bearing for the same reason.

### What's different

- **No `canUseTool` / `PreToolUse` SDK hooks**: the SDK isn't in the loop. With `OLLAMA_TOOLS_ENABLED=true`, the same gates run inside `runToolLoop` (cost cap doesn't apply since cost is zero, but `LoopDetector` and `ConfirmationBroker` do). With tools off, no gates run at all — there are no tool calls to gate.
- **No `SessionStore` resume**: Ollama's `/api/chat` is stateless per call. Conversation continuity comes from history reconstruction, not session IDs.
- **No `claude_code` system-prompt preset**: Ollama doesn't know it. The first `system` message is `${soul}\n\n${capabilityNote}` — the operator-editable `SOUL.md` text plus a one-line engine-specific clause built by `ollama.ts::buildOllamaCapabilityNote` (which adapts based on whether tools are on, and whether Ollama is the default engine vs. an explicit escalation target). When `SOLRAC.md` is present and activated, its content ships as a second `system` message wrapped in `<solrac-md>` (a separate turn rather than concatenated, since local models lack RLHF on instruction hierarchy).
- **`cost_usd = 0`** in audit rows. Cost-cap queries sum over all rows so Ollama doesn't pollute the cap window — the per-chat and global cost caps are unaffected.
- **`agent_session_id = null`** and **`tool_calls = null`** in audit rows.

### Stateful conversation history

`db.recentChatTurns(chatId, limit)` returns the last N successful turns for this chat **regardless of which engine produced them**, in chronological order. The query carries no `model` filter — the `prompt IS NOT NULL AND response IS NOT NULL` predicate already excludes denial / queue-full rows, and successful turns from any engine flow through. The `model` field on each row tags origin so the consumer can render an origin label.

For the Claude tiers' reverse direction (Claude follow-up to a prior Ollama or other-tier exchange), the SDK session resume only knows about same-tier turns. The cross-engine bridge (`db.outOfBandForEngine`) is documented under [Engine routing](#engine-routing) — same pattern, parameterized on the calling engine's prefix.

Default `OLLAMA_HISTORY_LIMIT=6` = 3 round-trips. At 256-char truncated prompts × 6 turns, worst-case context is ~3k tokens — fine for any modern Ollama default. The Claude-side out-of-band cap (`OUT_OF_BAND_LIMIT` in `agent.ts`) is also 6, so the per-turn token cost is bounded.

`recentChatTurns` is keyed by the `idx_audit_chat_model_started` composite index. Pre-multi-engine databases get the `model` column added via `ALTER TABLE` at first boot; legacy rows tagged `'claude'` are retagged to `'claude:secondary:claude-opus-4-7'` (see retag migration in [engine routing](#engine-routing)). Both migrations are idempotent (`PRAGMA table_info` / `WHERE model='claude'` guards).

### Error handling

| Condition | Render | Audit |
|-----------|--------|-------|
| Ollama unreachable | `❌ ollama unreachable: <url>` | `status='error', error_message='ollama unreachable: ...'` |
| Model not pulled | `❌ ollama model not found: <model> — pull with \`ollama pull <model>\` on the host` | `status='error', error_message='...'` |
| Stream timeout (`OLLAMA_TIMEOUT_MS`) | `❌ ollama timed out after Ns` | `status='error'` |
| Other HTTP failure | `❌ ollama error: <status> <body-slice>` | `status='error'` |

### Empty-prompt + misconfiguration paths

- `@` or `!` alone (or with only whitespace after) → renders a one-line usage hint naming the target tier; no audit row, no enqueue.
- `SOLRAC_DEFAULT_ENGINE=ollama` with `OLLAMA_ENABLED=false` is rejected at **boot** (`config.ts` throws), not per-turn — the daemon-down case lands as `❌ ollama unreachable: <url>` per the [Error handling](#error-handling) table when `OLLAMA_ENABLED=true` but the daemon is down.

### Limitations / open questions

- **OQ-A**: history is per-chat across all Ollama models. If we later add `>llama3.2 ...` vs `>qwen2.5 ...` model selection, the query needs `AND model = ?`.
- **OQ-B**: history is capped by *count*, not tokens. A 2k-context model will silently truncate.
- **OQ-C**: per-Ollama concurrency cap. Today Ollama shares the global `MAX_CONCURRENT_TURNS=4` semaphore with Claude. Local inference is GPU-bound; 4 simultaneous Ollama streams thrash a single GPU. Add a separate `MAX_CONCURRENT_OLLAMA_TURNS` semaphore in front of the Ollama path if measured.
- **OQ-D**: no inference-budget cap. Ollama is free, but a flooder could pin the GPU. Allowlist gates strangers.

---

## Threat model and defenses

The threat surface for v1:

| Threat | Mitigation | Where |
|--------|-----------|-------|
| Stranger flips the bot | Allowlist on `from.id` | `main.ts::gateAndAuditDenied` |
| Allowed user sends `rm -rf /` | Tier-2 auto-deny | `policy.ts::BASH_DANGEROUS_PATTERNS` |
| Allowed user runs unknown shell | Tier-3 confirm via Telegram | `policy.ts::createConfirmationBroker` |
| Runaway agent burns budget (one chat) | Per-chat hourly cost cap | `policy.ts::createCostCapGuard` (in PreToolUse hook) |
| Aggregate burn across all chats exceeds N×cap | Global hourly cost cap | `policy.ts::createGlobalCostCapGuard` (checked first in PreToolUse hook) |
| Agent stuck in tool-call loop | Loop detector | `policy.ts::createLoopDetector` (in PreToolUse hook) |
| Sub-agent fan-out blows budget | `Agent`/`Task` disabled at SDK + policy layer | `agent.ts:113` + `policy.ts::SUBAGENT_DENY_TOOLS` |
| Subprocess inherits Telegram secrets | `sanitizedSubprocessEnv` | `agent.ts::sanitizedSubprocessEnv` |
| Forwarded message contains injection | `<untrusted-content>` wrapper + system-prompt clause | `policy.ts::wrapUntrustedContent` (wired but unused in v1) |
| Flooder writes million `audit` rows | Truncate prompt + per-fromId throttle + queue depth cap | `policy.ts::truncateAuditPrompt` + `createDenialThrottle` + queue maxChainDepth |
| Two pollers race | PID file + 409-on-conflict fast exit | `poll.ts::acquirePidFile` + `TelegramConflictError` |
| `/stats` leaks ops data | Bearer auth + constant-time compare | `server.ts::authorizeBearer` |

Each defense has unit tests; live smokes live under `test/smokes/` (`npm run smoke:flood`, `npm run smoke:ollama`, `npm run smoke:integrations`).

### Allowlist gates on `from.id`, not `chat.id`

`policy.ts::extractFromId` reads:

```ts
update.message?.from?.id
  ?? update.callback_query?.from.id
  ?? update.edited_message?.from?.id
```

`from.id` is the user who sent the message; `chat.id` is the conversation. In groups they differ. If we gated on `chat.id`, anyone could DM the bot (allowed user's chat with the bot has `chat.id` ≠ stranger's chat with the bot). With `from.id`, only specific users pass.

### What the audit log tells you

The audit log is the answer to "did the bot do anything weird today?" Specifically:

- `SELECT … WHERE status = 'denied'` → silent drops (most are non-allowlisted strangers; some are throttled)
- `SELECT … WHERE error_message LIKE 'policy_deny:%'` → policy hits (cost cap, loop detector, user denial)
- `SELECT … WHERE error_message = 'queue_full'` → queue-depth-cap drops
- `SELECT … WHERE status = 'error'` → SDK errors, network drops, etc.
- `SELECT chat_id, SUM(cost_usd) FROM audit WHERE … GROUP BY chat_id` → cost attribution

See [OPERATIONS.md#audit-queries](./OPERATIONS.md#audit-queries) for canned queries.

### What the audit log doesn't tell you

The audit log doesn't capture:

- Tool **outputs** (the agent reads files; we don't log file contents).
- The full assistant text (truncated to first 256 chars of `prompt`, full `response`).
- MCP server interactions (the SDK handles those internally).

If you need to see what the agent *read*, look at the workspace directory.

---

## DB-pollution defenses

Three defenses against allowlist-bypass-doesn't-help-disk-fill scenarios:

### 1. Prompt truncation — `policy.ts::truncateAuditPrompt`

A flooder sending 100k-char strings would otherwise grow `audit.prompt` linearly. Truncate to `MAX_AUDIT_PROMPT_LEN = 256`. Surrogate-pair-safe (UTF-16 split would write an orphaned high surrogate that round-trips as U+FFFD).

```ts
truncateAuditPrompt(s: string, max = 256): string {
  if (s.length <= max) return s;
  const cut = max - 1;
  const lead = s.charCodeAt(cut - 1);
  const safeCut = lead >= 0xd800 && lead <= 0xdbff ? cut - 1 : cut;
  return s.slice(0, safeCut) + "…";
}
```

Last char is "…" so truncation is visible in dumps.

### 2. Denial throttle — `policy.ts::createDenialThrottle`

Without this, a non-allowlisted flooder (10 sock-puppet accounts × 30 msg/s = 300 audit rows/s × 256 bytes = ~77 KB/s) would bloat the database forever.

The throttle records at most one row per `from.id` per minute. Sustained floods get exactly one row per minute per attacker. Sock-puppet expansion → linear in account count, not message rate.

Critical detail: **skips do not extend the window**. A naive implementation that updates `lastSeen` on every check (record or skip) would let a flooder keep its window open forever. Solrac only updates `lastRecordedAt` on `record`.

Memory: opportunistic prune above `maxEntries = 1024` of entries older than `2 * windowMs`. Bounds memory under sustained flood from many distinct ids.

### 3. Queue depth cap — `KeyedMutex.depth` + `MAX_CHAT_QUEUE_DEPTH`

Without this, an *allowed* user pasting a 1000-line script would queue 1000 turns, each running for ~$0.05. Cap at 10 chained turns per chat; further enqueues return `dropped_queue_full` with depth + key.

`KeyedMutex.depth(key)` is sync-incremented before any await so the read at the top of `enqueue()` is stable. The audit row written for `dropped_queue_full` carries `error_message='queue_full'`.

### Live verification

Run the synthetic flood smoke:

```sh
npm run smoke:flood
```

4 phases:
1. 50-message burst from one non-allowlisted user → 1 audit row + 49 throttled.
2. Clock-advance past window → 2nd row records.
3. 5 distinct flooders → 5 rows.
4. Allowlisted user passes the gate.

---

## Tricky seams

Places where the code is doing something subtle. Read these before refactoring.

### 1. Cost cap and loop detector bypass

**Problem.** Under `permissionMode: "default"`, the SDK's internal classifier auto-approves "trivial" tools (`Read`, `Glob`, `Grep`, `Bash(date)`, etc.) without consulting `canUseTool`. If cost cap and loop detector lived only in `canUseTool`, a runaway loop on `Bash(date)` could chew through unlimited budget.

**Solution.** Cost cap and loop detector live in a `PreToolUse` SDK hook (`policy.ts::createPreToolUseHook`), which fires for **every** tool call regardless of trust. `canUseTool` keeps the interactive-confirm UX for the third tier; the hook is the always-fires gate.

**Live verification.** A logging-only hook against `Bash(date)` confirmed the hook fires even for SDK-auto-approved tools.

### 2. `canUseTool` ↔ `resume` mutual exclusion (resolved)

**Problem.** Earlier reading of `sdk.d.ts` line 1177 suggested `canUseTool` and `resume` were mutually exclusive. That would force a `forkSession()` call on every turn or drop the policy hook on resumes.

**Resolution.** Misread. The "Mutually exclusive with `resume`" JSDoc applies to **`continue?: boolean`** at line 1179, not `canUseTool` at line 1174. `canUseTool` has its own JSDoc ("Custom permission handler...") at lines 1170–1173.

**Implication.** `agent.ts::runAgent` uses `resume` + `canUseTool` directly, no fork plumbing.

See [SDK_NOTES.md](./SDK_NOTES.md) for the full correction note.

### 3. No-op-edit guard

**Problem.** Telegram's `editMessageText` rejects edits where the new text matches the current text exactly — `400 Bad Request: message is not modified`.

**Solution.** `agent.ts` tracks `lastEditedContent` and skips `editMessageText` calls where `next === lastEditedContent`. This matters at turn end: the streaming UX may have already rendered the final answer state via a throttled edit; the post-loop "final" edit then has nothing to change.

The footer (`<i>✅ N turns · $X.XXXX</i>`) guarantees the last edit differs, even if streaming ended on the same text.

### 4. Stable JSON for loop detector

**Problem.** `JSON.stringify({a:1, b:2})` and `JSON.stringify({b:2, a:1})` produce different strings. The loop detector keys on tool input — different key orders would slip past.

**Solution.** `policy.ts::stableStringify` sorts object keys before serialization (recursively for nested objects). Arrays preserve order (JSON arrays *are* ordered). Primitives `JSON.stringify` directly.

### 5. PID file vs lifecycle drain

**Problem.** Where does the PID file get deleted on shutdown?

**Resolution.** `main.ts` calls `acquirePidFile(dataDir)` early, captures the path, and passes it to `installShutdown({ pidPath, … })`. Lifecycle's drain handler unlinks. If the process exits via `process.exit(1)` (e.g. 409 conflict path in `poll.ts`), the PID file is **not** removed — but the next start's stale-PID detection (`isAlive(pid)` via `kill -0`) sees an `ESRCH` on the dead PID and unlinks the stale file. So forced exits don't permanently break.

### 6. Confirmation broker survival across restarts

**Problem.** Pending confirmations live in a process-local `Map`. If the bot restarts mid-confirmation, the in-flight `Promise` is gone and the user's pending tap goes nowhere.

**Mitigation.** The SDK call that was blocked on `canUseTool` is also gone (the bot was killed; the SDK process died too). On restart, the user's next message starts a fresh turn. Stale taps from the old confirmation route through `dispatchCallbackQuery`, hit the "expired" branch (broker doesn't have the id), and we `editMessageText` to append "— Confirmation expired…" so the user knows.

This is acceptable because:
- Restarts are rare (systemd `Restart=on-failure`, weekly bounce).
- Mid-confirmation interruptions are rarer.
- The user re-sending the original message is a low-friction recovery.

Persisting pending confirmations to disk would let restarts unblock in-flight SDK calls — but the SDK itself is dead, so there's no caller to unblock.

### 7. Float-and-track ordering

**Problem.** The poll loop's per-update flow:

```
1. claimUpdate(update_id)        ← INSERT OR IGNORE
2. handler(update)               ← may async-fire turn into queue
3. setMeta('poll_offset', n)     ← persist offset for resume
```

If we reordered (offset before claim), a crash between steps 2 and 3 would re-process the update on next boot. As-is: the claim is idempotent, so re-processing is just a `dedup` log.

**Implication.** `enqueue()` returning sync (not awaiting turn completion) is load-bearing. The drain happens via the tracker, not the offset.

### 8. Session-resume contract: only resume clean turns

**Problem.** A mid-turn API error (429, network blip, model timeout) leaves the SDK session in a partially-failed state — interrupted `tool_use` without a matching `tool_result`, partial assistant text, or a stuck `error_max_turns` loop. All four `SDKResultError.subtype` values (`error_during_execution`, `error_max_turns`, `error_max_budget_usd`, `error_max_structured_output_retries`) carry a non-null `session_id` (see `sdk.d.ts:3050-3066`), so the SDK happily hands back a resumable id even on failure. If we resume that id, the model's next-turn narration conflates the prior failed attempt with the present one — observed live as the model claiming a present-and-successful tool call was "blocked by a permission error" because the resumed session history showed a prior denial-shaped failure.

**Solution.** `agent.ts` gates the `setSessionId` write on `!isError`. Errored turns drop the session id silently; the next inbound message starts a fresh SDK session. Mirrors the existing `!isError` gate on summary clearing two lines below. Both Claude tiers (`primary_session_id`, `secondary_session_id`) inherit the gate via the shared call site — no per-tier duplication.

**Implication.** `/clear` remains the explicit operator escape hatch (semantics unchanged), but operators no longer need to remember to run it after every visible `❌ error` — recovery is automatic on the next message. There is no operator-facing surface change beyond the absence of contaminated narration.

**See also.** PNX-170 ticket for the original repro with a 429-driven `error_during_execution`.

---

## Logging

`log.ts` emits one JSON line per event to stdout (info/debug) or stderr (warn/error). No log levels via env in v1 — all levels print.

### Field conventions

- `update_id`, `chat_id`, `from_id`, `audit_id` — primary keys.
- `error.message` — never `error.stack` (too verbose for a structured line); the message goes inline.
- Sensitive values (tokens, API keys) — never logged.

### Trace a turn

```sh
journalctl -u solrac.service -o cat | jq 'select(.update_id == 12345)'
```

Logs that fire per turn:

1. `update.received` (poll.ts; every update before any gate)
2. `turn.start` (main.ts; only allowed text messages)
3. `agent.tool_use` (per tool call)
4. `policy.confirm_request` / `policy.confirm_resolved` (third-tier path)
5. `policy.cost_cap_exceeded` / `agent.loop_detected` (PreToolUse hook denials)
6. `agent.done` (per-turn summary: cost, turns, error?)
7. `turn.done` (main.ts wrap-up)

### Full event reference

See [OPERATIONS.md#log-events](./OPERATIONS.md#log-events) for the canonical list.

---

## Lifecycle

`lifecycle.ts::installShutdown` is the SIGINT/SIGTERM handler.

```ts
installShutdown({
  tracker,            // TurnTracker — drain in-flight turns
  db,                 // SolracDb — WAL checkpoint + close
  pidPath,            // string — unlink on exit
  pollAbort,          // AbortController — signal poll loop to stop
  server,             // Bun.serve handle — server.stop()
  drainTimeoutMs,     // default 60_000
  exit?, signals?, registerSignal?,  // injectable for tests
});
```

Sequence:

1. **Idempotent guard.** Second signal returns the same in-flight `Promise`; doesn't double-drain.
2. `pollAbort.abort()` — `tg.getUpdates` rejects with `AbortError` on next iteration.
3. `server.stop()` — closes `/health` and `/stats`.
4. `tracker.drain()` raced against `setTimeout(drainTimeoutMs)`. If timeout, exit code is 1.
5. `PRAGMA wal_checkpoint(TRUNCATE)` — collapse WAL into the main db file.
6. `db.close()` — release file handles.
7. Unlink PID file.
8. `process.exit(timedOut ? 1 : 0)`.

The 60s drain budget pairs with systemd's `TimeoutStopSec=90` — 30s of slack before SIGKILL.

See `deploy/systemd/solrac.service`.

---

## Web UI transport (optional)

Off by default. Enabled via `SOLRAC_WEB_ENABLED=true` plus a token. Brings a browser-based chat UI alongside the Telegram bot, sharing the same agent loop, audit log, queue, cost caps, and policy hooks.

### What ships

| Module | Role |
|---|---|
| `src/web-client.ts::createWebClient` | `TelegramClient`-shaped sink. Methods publish events to an in-process bus instead of calling Telegram's API. |
| `src/web.ts::startWebServer` | Second `Bun.serve` instance bound to `SOLRAC_WEB_HOST:SOLRAC_WEB_PORT`. Routes: `/`, `/static/:file`, `/api/login`, `/api/logout`, `/api/message`, `/api/stream` (SSE), `/api/confirm`, `/api/history`. |
| `src/web-sanitize.ts::sanitizeHtml` | Allowlist HTML sanitizer used both server-side (boundary scrub of the html-fallback in SSE events) and browser-side (after `marked.parse`). Single source of truth — transpiled to JS at server boot via `Bun.Transpiler` and served as `/static/sanitize.js`. |
| `src/markdown.ts::mdToTelegramHtml` | Converts Claude/Ollama markdown to Telegram-safe HTML for the bot. Same `marked` library; different renderer overrides. |
| `public/index.html` + `public/app.js` + `public/style.css` | Vanilla-JS UI. No framework, no build step. Loads `marked` from `/static/marked.min.js` (served from `node_modules/marked/lib/marked.umd.js`) and `sanitizeHtml` from `/static/sanitize.js`. |

### How it preserves the existing path

`agent.ts` and `ollama.ts` already accept any `TelegramClient`. main.ts builds a parallel `WebClient`, a parallel `commandDeps` (with `tg = webClient`), a parallel `OllamaRunDeps`, and a parallel `ConfirmationBroker` (also pointed at `webClient`). The single turn queue's `runTurn` dispatches to the web variants when the synthetic `webChatId` is on the update; otherwise the Telegram path runs unchanged.

```
Browser ──HTTP──▶ web.ts (Bun.serve, separate port)
   │                  │
   │ SSE              │ POST /api/message
   │ /api/stream      │   ↓
   │                  │ synthetic Update {chat.id = webChatId, from.id = webChatId}
   │                  │   ↓
   │                  │ queue.enqueue(update)  (same queue Telegram uses)
   │                  │   ↓
   │                  │ runTurn dispatches by chatId → webRunTurn / tgRunTurn
   ◀──events────  WebClient (TelegramClient impl)
                       │
                       └─▶ runAgent / runOllamaTurn (tg = webClient)
                              audit row written, cost cap, policy hooks — all unchanged
```

### Markdown sidecar (`markdownSource`)

Telegram's HTML parse_mode supports a small subset (`<b> <i> <s> <a> <code> <pre> <blockquote>`). `agent.ts:495` previously emitted `htmlEscapeText(text)` on Claude's body, which preserved markdown syntax as literal characters in Telegram. The fix:

- `agent.ts` and `ollama.ts` now run the response body through `mdToTelegramHtml(text)` for Telegram (proper bold, italic, code blocks; lists flattened to `• item`; headers to `<b>`; tables to ASCII inside `<pre>`).
- `SendMessageOpts` and `EditMessageTextOpts` carry an optional `markdownSource: string` sidecar. The real Telegram client (`telegram.ts:205-215`) destructures-and-drops it before `tgCall` — never hits the wire.
- `WebClient` reads `markdownSource` preferentially; consumer (browser) renders it with `marked` + `sanitizeHtml`. If absent, the html-fallback (already sanitized at the SSE boundary) is used.

The conversion is wrapped in try/catch with fallback to `htmlEscapeText` so a parser glitch can't break the existing Telegram path.

### Auth

Bearer token (`SOLRAC_WEB_TOKEN`) → login page → cookie. Constant-time compare via `node:crypto.timingSafeEqual`, mirroring `server.ts::authorizeBearer`. Cookie set with `HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`. Sessions held in process memory — restarting Solrac signs out all browsers.

The token is required even when binding to `127.0.0.1`. A loopback-only shortcut would be unsafe on shared hosts (other UIDs can connect to localhost).

### SSE

`GET /api/stream` returns `text/event-stream` with a `ReadableStream` body. The handler subscribes to the `WebClient` bus; each `sendMessage` / `editMessageText` / `setMessageReaction` call publishes one event. Keepalive comments (`: keepalive\n\n`) every 25 s prevent intermediate proxies from idling out the connection. On client disconnect (request signal abort) the subscriber unregisters and the stream closes.

### Tool confirmation

The existing `policy.ts::createConfirmationBroker` is transport-agnostic — `request()` calls `tg.sendMessage(..., { reply_markup: { inline_keyboard: ... } })` and registers a Promise resolver keyed by callback id. main.ts builds a second broker with `tg = webClient` for web turns. The browser receives the inline keyboard inside the SSE event, renders Allow / Deny buttons, and posts the chosen `callback_data` to `POST /api/confirm`. The handler calls `webBroker.resolve(callbackId, decision)` — same flow as Telegram's callback_query, just with HTTP instead of polling.

### Lifecycle

`installShutdown` accepts an optional `webServer` handle and calls `webServer.stop()` right after the ops `server.stop()` and before tracker drain. SSE writers are closed first so their `req.signal.abort()` listeners fire and unsubscribe cleanly.

### Anti-goal preservation

The transport adds `web.ts`, `web-client.ts`, `web-sanitize.ts`, and `markdown.ts`. No HTTP framework, no WebSocket framework, no extra runtime dependencies beyond `marked` (used on both transports). The "no HTTP framework" anti-goal is honored — `Bun.serve` `routes` and `fetch` only, same shape as `server.ts`.

## Anti-goals

Decisions deliberately not made. Don't relitigate without strong justification.

- **No HTTP framework.** `Bun.serve` `routes` only. No Hono, Express, Elysia. The HTTP surface is two routes (`/health`, `/stats`) — a framework is overkill.
- **No Telegram framework runtime.** Raw `fetch` + `tgCall`. `@grammyjs/types` is types-only — the framework's runtime is not used. We maintain a small `telegram.ts` deliberately; a framework would be a black box of equivalent size.
- **No queue server.** In-process `KeyedMutex` + `Semaphore`. No BullMQ, Redis. The queue's role is per-chat ordering, not durability — no need for an external store.
- **No Docker for v1.** `bun run` under systemd, period. Docker buys isolation we don't need (single-tenant) and slows iteration. The systemd hardening (`NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`) covers most container-shaped concerns.
- **No MarkdownV2 outbound.** HTML parse mode for outbound messages — three escape characters (`< > &`) instead of MarkdownV2's twenty-some.
- **No Bedrock/Vertex auth.** Direct `ANTHROPIC_API_KEY`. Multi-cloud auth is yagni for v1.
- **No tests for HTTP/Telegram surfaces.** `bun:test` for pure logic only — `mutex`, `semaphore`, HTML escape, policy rules, cost-cap query, lifecycle composition. Telegram surface verified manually + via the synthetic flood smoke.
- **No sub-agents.** `Agent`/`Task` disabled. See [OQ#8](./ROADMAP.md#oq8-sub-agent-enablement).
- **No webhook transport.** Long-poll only. Deferred until a public host is provisioned. See [ROADMAP.md](./ROADMAP.md#webhook-transport).
- **No web framework.** When `SOLRAC_WEB_ENABLED=true`, the second `Bun.serve` instance for the browser UI uses raw routes and SSE (`ReadableStream` body) — no Hono, no Express, no WebSocket framework. See [Web UI transport](#web-ui-transport-optional) above.

If you find yourself wanting to add one of these, write the case in the PR description and tag it as an explicit re-evaluation. Anti-goals can be reversed; they just can't be drifted past silently.

---

## Related docs

- [USAGE.md](./USAGE.md) — what users see
- [OPERATIONS.md](./OPERATIONS.md) — running it in prod
- [RUNBOOK.md](./RUNBOOK.md) — when something breaks
- [ROADMAP.md](./ROADMAP.md) — open questions and deferred work
- [GLOSSARY.md](./GLOSSARY.md) — terminology
- [SDK_NOTES.md](./SDK_NOTES.md) — verified SDK surface
