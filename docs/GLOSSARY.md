# Glossary

Terms that recur across Solrac's codebase and docs. Alphabetical.

---

**agent (lowercase)** — Claude Agent SDK's `query()` invocation: a single conversational thread that can call tools, accept input, stream output. Solrac runs one agent per turn, resumed per chat.

**Agent / Task tools (capitalized)** — Sub-agent fan-out tools surfaced by the SDK. **Disabled in Solrac v1** at two layers: `disallowedTools: ["Agent", "Task"]` in `agent.ts:113` and an additional deny rule in `policy.ts::classifyTool` (`policy.ts:166`). Re-enabling is tracked in [Open Question #8](./ROADMAP.md#oq8-sub-agent-enablement).

**allowlist** — The set of `from.id` values permitted to interact with the bot. Stored in the `allowlist` SQLite table; bootstrapped from the `ALLOWLIST_BOOTSTRAP` env var on every boot. Enforced in `policy.ts::gateUpdate` and `main.ts::gateAndAuditDenied`. Note: gates on **user**, not chat.

**audit row** — One row in the `audit` SQLite table per attempted turn (allowed, denied, or queue-full). Carries `prompt`, `response`, `tool_calls`, token counts, `cost_usd`, `agent_session_id`, `status` (`ok | error | denied`), `error_message`, `started_at`, `ended_at`, plus future-proof `tree_id` / `parent_turn_id`. Written even on denial — drop in audit log = silent failure.

**bearer token** — Static secret in `STATS_BEARER_TOKEN`. Required in the `Authorization: Bearer <token>` header to access `/stats`. Compared in constant time via `node:crypto.timingSafeEqual`.

**broker** (confirmation broker) — Per-process `Map<id, { resolve, timer }>` that holds the `Promise` returned to `canUseTool` while waiting for a Telegram inline-keyboard tap. See `policy.ts::createConfirmationBroker`. Fail-closed (deny on send failure) with a 60-second default timeout.

**callback query** — Telegram's term for a button tap on an inline keyboard. Arrives as `update.callback_query` with a `data` field carrying our `cb:<uuid>:a|d` payload.

**`canUseTool`** — SDK option: a per-turn function the SDK calls before tools its internal classifier considers "non-trivial." Solrac uses this for the Telegram-confirm tier. Trivial tools (Read, Bash(date), etc.) bypass it — that's why `PreToolUse` exists.

**`chat.id`** — Telegram chat identifier. For private DMs equal to `from.id`; in groups it's a different (negative) number. Solrac uses `chat.id` to scope sessions, workspaces, queues, and cost cap. **But not allowlists** — those gate on `from.id`.

**claim (an update)** — Inserting `update_id` into the `handled_updates` SQLite table via `INSERT OR IGNORE`. Used as an idempotency guard so a poll-loop restart mid-handler doesn't reprocess the same update.

**confirm tier** — One of three `classifyTool` outcomes (`allow | deny | confirm`). Triggers a Telegram inline-keyboard prompt via the broker.

**cost cap** — Per-chat sliding-hour spend ceiling (`HOURLY_COST_CAP_USD`, default $1.00). Sums `cost_usd` from `audit` rows in the trailing 60 minutes. Enforced inside the `PreToolUse` hook so SDK-auto-approved tools (Read, Bash(date)) can't bypass it. See `policy.ts::createCostCapGuard`.

**denial throttle** — Per-`from.id` rate limit on `audit` writes for denied updates: at most one row per minute per user (`policy.ts::createDenialThrottle`). Bounds `audit` table growth under a flood from non-allowlisted accounts. **Skips do not extend the window** — sustained floods get exactly one row per minute.

**drain** — `TurnTracker.drain()`: a `Promise` that resolves when all in-flight turns have ended. Used by lifecycle's SIGTERM path to wait for active work before closing the database.

**edit (Telegram)** — `editMessageText` API call. Solrac edits its 🤔 stub message rather than sending many small ones. Throttled to 1.5s between edits (`agent.ts:19`).

**from.id** — Telegram user identifier. The user who actually sent a message. Differs from `chat.id` in groups and forwarded messages.

**handled_updates** — SQLite table holding all claimed `update_id`s. Idempotency surface for the poll loop; pruned by a future janitor (deferred to a follow-up).

**KeyedMutex** — Per-chat serial queue (`mutex.ts`). Tasks for the same key (chat) chain and run one at a time; tasks for different keys run independently. Also exposes `depth(key)` for the queue-depth cap.

**lifecycle** — `lifecycle.ts::installShutdown`: the SIGINT/SIGTERM handler that aborts the poll loop, stops `Bun.serve`, drains the `TurnTracker` (60s cap), checkpoints WAL, closes the db, removes the PID file, and exits.

**loop detector** — Per-turn guard (`policy.ts::createLoopDetector`) that denies the third (default `LOOP_THRESHOLD = 3`) call to the same `(toolName, input)` pair within a turn. Order-insensitive over JSON keys; arrays preserve order. Lives inside the `PreToolUse` hook.

**mutex** — See **KeyedMutex**.

**offset** — Telegram long-poll cursor. The `update_id + 1` of the most-recently seen update. Persisted in `meta.poll_offset`.

**Engine routing** — first non-whitespace character of a Telegram message picks the engine: `@` → primary Claude (`SOLRAC_PRIMARY_MODEL`), `!` → secondary Claude (`SOLRAC_SECONDARY_MODEL`, "escalate"), no prefix → the configured default engine (`SOLRAC_DEFAULT_ENGINE`, ships as `ollama`). There is no `>`-style escape prefix; a leading `>` is literal user text. See `policy.ts::parseEnginePrefix`, [ARCHITECTURE.md#engine-routing](./ARCHITECTURE.md#engine-routing). All three engines share the chat thread via cross-engine context bridging (`db.outOfBandForEngine` + `db.recentChatTurns`).

**Ollama routing** — When `SOLRAC_DEFAULT_ENGINE=ollama` (the default), no-prefix messages route to a local Ollama HTTP API (`OLLAMA_URL`, default `http://localhost:11434`) instead of Claude. See `ollama.ts::runOllamaTurn`, [ARCHITECTURE.md#ollama-routing](./ARCHITECTURE.md#ollama-routing). Inference is single-shot by default; with `OLLAMA_TOOLS_ENABLED=true` (precondition: `SOLRAC_INTEGRATIONS_ENABLED=true`), the local model can call the same `mcp__solrac__*` integration tools the Claude tiers see via the multi-round driver in `ollama-tools.ts`. Requires `OLLAMA_ENABLED=true` and `OLLAMA_MODEL=<pulled-model>`.

**out-of-band context (OOB)** — Cross-engine bridge. When a Claude tier runs after one or more turns from another engine (the other Claude tier and/or Ollama) happened in the same chat, those turns are prepended to the prompt as a labeled context block. `db.outOfBandForEngine(chatId, currentEnginePrefix, limit)` returns the rows; the prefix names the calling engine (`'claude:primary:%'`, `'claude:secondary:%'`, etc.). Window naturally narrows after this engine consumes it. Symmetric direction: Ollama always pulls all chat turns via `db.recentChatTurns`, regardless of engine.

**Open Question (OQ)** — Numbered design uncertainty in [ROADMAP.md](./ROADMAP.md). Each OQ either resolves into a planned feature or stays as an explicit anti-goal.

**`parent_turn_id`** — `audit.parent_turn_id` (nullable). Reserved for sub-agent fan-out: a child turn would set this to its parent's `audit.id`. v1 leaves it null.

**permission mode** — SDK option (`'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'`). Solrac runs `'default'`, which routes "non-trivial" tools through `canUseTool`.

**PID file** — `data/solrac.pid`. Written on boot by `poll.ts::acquirePidFile`. Stale-PID detection via `kill -0`. Removed by lifecycle on graceful shutdown. The defense against the "zombie poller" bug from previous architectures.

**poll** — One of two transports (`SOLRAC_TRANSPORT=poll`, the default). Long-`getUpdates` loop (`timeout=30`) against Telegram. The other is `webhook`, deferred (see [ROADMAP.md](./ROADMAP.md#webhook-transport)).

**`PreToolUse` hook** — SDK hook that fires for every tool call, including ones the SDK auto-approves under `permissionMode:'default'`. Solrac uses it for cost cap + loop detector — defenses that must apply to every tool, not just non-trivial ones.

**queue** — `queue.ts::createTurnQueue`: combines a per-chat `KeyedMutex` with a global `Semaphore`. Enforces serial execution per chat, capped global concurrency (`MAX_CONCURRENT_TURNS`, default 4), and per-chat depth cap (`MAX_CHAT_QUEUE_DEPTH`, default 10).

**resume (SDK)** — `Options.resume`: a previously-returned `session_id` that re-attaches the next `query()` to the prior conversation. Solrac persists the SDK's session id in the `sessions` table so each chat keeps history across restarts.

**Semaphore** — Global counting concurrency limit (`semaphore.ts`). Caps the number of turns running anywhere at once. Default 4 via `MAX_CONCURRENT_TURNS`.

**session** — Two-layered:
- **Solrac session**: row in `sessions(chat_id, agent_session_id, …)` that maps a chat to the SDK's most recent session id.
- **SDK session**: opaque UUID tracked by the Claude Agent SDK; surfaced via `result.session_id` and consumed by `Options.resume`.

**skill** — User-level Claude Code skill in `.claude/skills/<name>/SKILL.md`. Available to the agent via the SDK's preset systemPrompt + tool routing. v1 doesn't enumerate skills explicitly in the systemPrompt — that's [OQ#11](./ROADMAP.md#oq11-skill-router).

**Solrac skill (operator-defined)** — Distinct from the Claude Code skill above. A `SKILL.md` file under `$SOLRAC_SKILLS_DIR/<name>/` that defines a Telegram slash command (`/<name>`) without code changes. Loaded ONCE at boot by `skills.ts::loadSkillsSync`; runs as a single tool-less turn (`runSkill` in `commands.ts`). Tier defaults to `SOLRAC_DEFAULT_ENGINE` so an Ollama-default deploy gets free skills automatically. Optional `tool: true` frontmatter additionally exposes the skill as a callable MCP tool to the Ollama agent — see **skill tool**. Disabled by default (`SOLRAC_SKILLS_ENABLED=false`). See [USAGE.md#skills-operator-defined-commands](./USAGE.md#skills-operator-defined-commands).

**skill tool** — A Solrac skill with `tool: true` frontmatter, exposed to the Ollama agent's tool catalog as `mcp__solrac__skills__<name>` (wire format on Ollama: `skills__<name>`). The model decides when to call it from natural language; the tool description is `skill.description`; input schema is `{ args: string }`. Phase 1 restriction: requires `tier: ollama` (free, no cross-engine cost surprises). Auto-allow permission tier; cost cap is the backstop. Built by `skill-tools.ts::buildSkillTools`. Per-turn context (chatId, fromId, updateId, parentAuditId) propagates via `node:async_hooks::AsyncLocalStorage` (`skillToolCtx`) — the SDK tool-handler signature `(args, extra)` leaves no slot for chat context, and concurrent turns require race-free isolation. Audit row tagged `origin='tool_call'` to distinguish from operator-typed slash invocations.

**scheduled task (operator-defined)** — A `TASK.md` file under `$SOLRAC_TASKS_DIR/<name>/` that fires a prompt on a schedule (`every <dur>`, `daily_at HH:MM`, `at <ISO8601>`) into a configured chat. Loaded ONCE at boot by `scheduler.ts::loadTasksSync`; tick driver runs `setInterval(60_000)`. Synthesizes `Update` objects with negative `update_id`s that ride the existing turn queue, so cost caps + allowlist + policy hooks all apply uniformly. Audit row tagged `origin='scheduled'` with `task_name=<name>`. Persisted state (`last_run_at`, `one_off_consumed`) lives in the `scheduled_tasks` table. Disabled by default (`SOLRAC_TASKS_ENABLED=false`). See [USAGE.md#scheduled-tasks](./USAGE.md#scheduled-tasks).

**audit `origin`** — Column on the `audit` table distinguishing the source of a row: `'user'` (operator typed), `'scheduled'` (scheduler fired), `'tool_call'` (Ollama agent invoked a tool-eligible skill), or `'system'` (rejection / queue-full row). All four share the table; `WHERE origin IN (...)` is the surface-aware filter. See [SCHEMA.md#audit](./SCHEMA.md#audit).

**stub** — The `🤔 thinking…` placeholder message Solrac sends at turn start, then edits with progress. Final state is the same message edited to the answer + footer (`<i>✅ N turns · $X.XXXX</i>`). No separate "final" message — that's intentional (see ARCHITECTURE.md "No-op-edit guard").

**SOUL.md** — Operator-editable persona file at the launch cwd's root. Contains voice, stance, and the `<untrusted-content>` safety clause. Read once at boot via `instance.ts::loadSoul`; joined with an engine-specific capability note and shipped as `systemPrompt.append` (Claude path) or as the first `system` message (Ollama path). Hard-fails at boot if missing or empty. Mirrors OpenClaw's SOUL concept (voice, not operating rules).

**SOLRAC.md** — Operator-editable instance overlay at the launch cwd's root. Contains operator-specific operating rules (operator name, channel posture, project hints). Re-read per turn so live edits take effect immediately. Wrapped in `<solrac-md>...</solrac-md>` and injected at the top of the user-message envelope (Claude path) or as a second `system` message (Ollama path). Soft-warn if missing — Solrac runs vanilla without it. Carries a `solrac-md:unedited` sentinel marker on first install so a fresh template injects nothing until the operator activates the overlay. Analogous to a per-project CLAUDE.md.

**system prompt** — SDK option. Solrac assembles `${soul}\n\n${CLAUDE_CAPABILITY_NOTE}` (or `${OLLAMA_CAPABILITY_NOTE}`) at runtime; the Claude path passes that as `systemPrompt.append` on top of the `claude_code` preset so the SDK's tool guidance is preserved. See `agent.ts::runAgent` and `ollama.ts::runOllamaTurn`.

**three-tier policy** — `policy.ts::classifyTool`: every tool falls into `allow | deny | confirm`. Confirm requests fan out to the broker.

**tree_id** — `audit.tree_id`. v1 always equals `audit.id` for top-level turns. Future sub-agent children would inherit the parent's `tree_id`. Used so a future tree-wide cost cap can sum `WHERE tree_id = ?`.

**turn** — One round-trip: a user message → an SDK `query()` invocation → a final reply. May involve many tool calls. Each turn writes exactly one `audit` row (plus zero or more `audit` rows for denied attempts).

**TurnTracker** — `turn-tracker.ts`. Symbol-keyed `Set<symbol>` tracking active turns. `count` for `/stats`; `drain()` for shutdown.

**`tree_id`** — see above.

**untrusted-content wrapper** — `policy.ts::wrapUntrustedContent(text, source)` returns `<untrusted-content source="…">text</untrusted-content>`. Paired with a system-prompt clause that tells the agent to treat such blocks as data, never instructions. v1 has no inbound-attachment intake yet, so the wrapper is wired but unused.

**`update_id`** — Monotonically increasing Telegram update identifier. Solrac uses it as the primary key of `handled_updates` for idempotency.

**verdict** — The user's tap on a confirm prompt: `"allow" | "deny" | "timeout"`. Surfaced from the broker as a `ConfirmDecision`.

**WAL** — SQLite Write-Ahead Log mode (`PRAGMA journal_mode = WAL`). Concurrent readers + a single writer; checkpointed to truncate on graceful shutdown (`PRAGMA wal_checkpoint(TRUNCATE)` in `lifecycle.ts`).

**web transport** — Optional second transport: a `Bun.serve` instance on `SOLRAC_WEB_HOST:SOLRAC_WEB_PORT` that hosts a browser chat UI. All web traffic shares one synthetic `chat.id` (default `-1000`, settable via `SOLRAC_WEB_CHAT_ID`). Token-gated login (`SOLRAC_WEB_TOKEN`) → HttpOnly + SameSite=Strict cookie. The `WebClient` (`src/web-client.ts`) implements the same `TelegramClient` interface as the bot path, publishing to an in-process bus consumed by SSE. Off by default; see [SETUP.md#11-optional-enable-the-browser-web-ui](./SETUP.md#11-optional-enable-the-browser-web-ui).

**WebClient** — `src/web-client.ts::createWebClient`. A `TelegramClient`-shaped sink whose `sendMessage` / `editMessageText` / `setMessageReaction` publish events to an in-process bus instead of calling Telegram's API. Lets `agent.ts`, `ollama.ts`, `commands.ts`, and the confirmation broker run unmodified against the web transport.

**markdownSource** — Optional sidecar field on `SendMessageOpts` carrying the raw markdown text alongside the Telegram-HTML body. The real Telegram client strips it before the wire (it's not a Telegram API field); the WebClient reads it preferentially so the browser renders full markdown via `marked` + the allowlist sanitizer.

**mdToTelegramHtml** — `src/markdown.ts::mdToTelegramHtml(md)`. Converts markdown to the small HTML subset Telegram's `parse_mode: HTML` accepts (no `<h1>`, no `<ul>`, no `<table>`). Headers collapse to `<b>`, lists flatten to `• item` lines, tables render as ASCII inside `<pre>`. Wrapped in try/catch with fallback to `htmlEscapeText` so a parser glitch can't break the existing Telegram path.

**workspace** — Per-chat directory at `<dataDir>/workspaces/<chatId>/` used as the agent's `cwd`. Idempotently created by `agent.ts::runAgent`. Accumulates files from agent shell calls; janitor is deferred (see [OQ#4](./ROADMAP.md#oq4-workspace-janitor)).

**zombie poller** — Anti-pattern from previous architecture: a process kept polling Telegram after the user thought it was dead, racing a fresh instance. Solrac defends with the PID file (`poll.ts::acquirePidFile`) and 409-on-conflict fast exit.
