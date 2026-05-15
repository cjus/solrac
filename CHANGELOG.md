# Changelog

## Unreleased — scheduler: switch to unix cron (BREAKING TASK.md format)

Replaces the three-form schedule grammar (`every <dur>` / `daily_at HH:MM` / `at <ISO8601>`) with 5-field unix cron + optional per-task `tz:` (default: `$TZ` env / host runtime tz). One grammar closes four real gaps in a single change: time-of-day windows, day-of-week filtering, local-timezone scheduling, and anchored cadence. Predicate: the live stretch trigger on 2026-05-15 ("every 30m between 12:00 and 18:00 weekdays Denver") required thirteen separate `daily_at` TASK.md files under the old grammar.

- **Frontmatter.** `schedule:` is replaced by exactly one of `cron:` (5-field unix expression) or `at:` (ISO8601 absolute, unchanged semantics). Optional `tz:` is per-task; omitting it falls back to `$TZ` env, then the host's runtime tz. Cron evaluates against `tz`'s wall-clock; `cron-parser@5.5.0` handles DST (spring-forward skipped, fall-back single fire — verified by smoke + unit tests).
- **Anchored cadence (BEHAVIOR CHANGE).** Old `every 1h` drifted from `last_run_at`; new `cron: "0 * * * *"` anchors at `:00`. A mid-window restart at 14:13 fires next at 15:00, not 15:13. Most operators want anchored; if you relied on drift, switch to something like `cron: "13 * * * *"` and pin the minute.
- **No first-deploy catch-up under cron.** Cron is anchored, not stateful. A fresh task at 14:00 with `0 9 * * *` waits until tomorrow 09:00 — not today's. Old `daily_at` would have fired today's 09:00 anchor on first boot. If you need a one-time-now fire, add a sibling `at:` task.
- **New runtime dep: `cron-parser@5.5.0` (exact-pinned).** Replaces ~150 LOC of subtle tz/DST math we'd otherwise write. Brings `luxon` transitively. Mirror the SDK pin convention: bumps are deliberate verification passes.
- **Parser strictness at our layer.** Cron-parser is permissive (accepts 4-field, 6-field, empty string, `@daily`/`@hourly`); we pre-validate to enforce one-shape grammar: exactly 5 space-separated fields, no `@`-aliases, IANA tz validated by `Intl.DateTimeFormat` before handing to the parser (cron-parser's tz error is cryptic).
- **Min-interval guard.** Inspects the next 5 fire times at load and rejects if any gap < tier floor (5min Claude, 1min Ollama). Rejects pathological `* * * * *` on Claude with a clear error pointing at the floor.
- **Migration cheat-sheet.** Lives in `docs/USAGE.md` under "Schedule grammar". Hard cutover: no dual-shape acceptance period. Old `schedule:` is rejected as an unknown frontmatter key.
- **In-repo tasks migrated.** `examples/tasks/morning-digest` → `cron: "0 9 * * 1-5"` + `tz: America/Denver`. `examples/tasks/weekly-pr-review` → `cron: "0 9 * * 1"` + `tz: America/Denver`. `tasks/stretch/TASK.md` removed entirely — it was an operator-specific example and the canonical templates now live under `examples/tasks/`.
- **Live-verification fixes.** Two bugs surfaced during the dev-loop deploy:
  - **Tick driver anchor.** `nextRunAt(task, lastRunAt=null, now)` for cron anchored on `now`, which advances every tick → `due` always future → task never fired through the natural tick path (only `/tasks run <name>` worked). Fixed by adding a `bootMs` param: cron now anchors on `lastRunAt ?? bootMs ?? now`, with the tick driver passing `bootMs = bootTime`. New regression test simulates multi-tick clock advancement and asserts two fires across two cron moments.
  - **`/tasks` web-UI rendering.** The listing constructed HTML with `\n` line breaks; the web transport tried to render that as markdown and single `\n`s collapsed → everything on one line. Refactored `runTasksList` to the dual-render pattern (`/help`, `/status`, `/context` already use it): authors markdown, sends `mdToTelegramHtml(md)` for the bot + `md` as `markdownSource` for the web. Telegram output is virtually identical; web UI now gets proper `<ul>`/`<br>` rendering.
- **Tests.** 72 scheduler tests pass (was 60); coverage adds tz handling, weekday filter, DST spring-forward + fall-back, min-interval guard, both-cron-and-at rejected, invalid IANA tz rejected, full-weekday integration (`*/30 12-18 * * 1-5` Denver → 14 fires/Mon, 0 fires/Sat), and the multi-tick regression test for the tick-driver anchor.
- **Docs.** `docs/USAGE.md` (scheduled-tasks section + cheat sheet), `docs/ARCHITECTURE.md` (grammar paragraph + catch-up policy), `docs/GLOSSARY.md` (new `cron expression` entry), `docs/CONFIG.md` (`TZ` env var entry), `docs/OPERATIONS.md` (systemd `Environment=TZ=` snippet), `docs/ROADMAP.md` (OQ#12 closeout).

No SDK pin bump. Reverses one anti-goal-adjacent design call (the "no cron in v1, kept the parser ~30 LOC" line in `docs/ARCHITECTURE.md`) — see the dep-justification block in `PLAN.md § Adding cron-parser as a runtime dep`.

## Unreleased — Notion query truncation defenses

Live `/clear ollama` verification under gemma4:e4b surfaced a tool-result overflow: a "list my in-progress tickets" query against the PNX projects database returned 7 rows but the 7th rendered with `(null)` for every property except title because `notion_query_database`'s JSON payload exceeded the 8 KB `TOOL_RESULT_MAX_LEN` cap and got cut mid-object. The model honestly narrated the gap; the cap had been chosen in the abstract before any integration emitted real volume, and the most useful Notion read overflowed on a single call. See `solrac-dev/PLAN-B.md` §1.

- **`TOOL_RESULT_MAX_LEN`: 8192 → 16384** (`src/ollama-tools.ts`). 16 KB ≈ 4k tokens — comfortable headroom for mid-size structured responses while still keeping multi-iteration tool-loop budgets bounded. Bumping was strictly preferable to per-tool caps for the volume we observed; if a future tool genuinely needs to stay smaller, that's a localized override, not a global tuning.
- **Length-aware truncation marker.** The trailing `…` becomes `…[truncated: <shown>/<total> bytes shown]` so the model can paginate or narrow the query rather than guessing how much was lost. Final string length still equals `TOOL_RESULT_MAX_LEN` exactly (head is sized to fit), so callers relying on the length invariant are unaffected.
- **`notion_query_database` page_size default: 25 → 10** (`src/integrations-builtin/notion/index.ts`). Localized via a new `QUERY_DATABASE_DEFAULT_PAGE_SIZE` constant — the shared `DEFAULT_PAGE_SIZE = 25` stays put for `notion_search`, `notion_list_databases`, `notion_list_users` (slim summaries that don't truncate). Per-row property serialization in `query_database` is heavier than the other read tools and was the actual overflow source. Tool's `page_size` describe text updated so the model knows it can opt up to 25/100 when rows are slim.
- **Tests.** Updated `src/ollama-tools.test.ts` truncation test to assert the structured `shown/total` marker and length invariant. Added two `src/integrations-builtin/notion/index.test.ts` tests asserting the new query_database default (10) and that caller-provided `page_size` still wins.

No anti-goal reversal. No SDK pin bump. PLAN-B §2 (web-UI bold-markdown artifacts) deferred pending DevTools verification.

## Unreleased — `/clear ollama` (per-chat Ollama context cutoff)

Closes a long-standing UX hole: `/clear` previously did nothing for Ollama. The dispatcher only touched `sessions` (Claude SDK session ids + summaries), but Ollama's per-turn history is reconstructed from `audit` via `db.recentChatTurns` — so the operator-visible "🧹 Cleared … session state. Next turn starts fresh." reply was a lie for the `>` prefix. Symptom in the wild: a chain of failed Notion lookups under gemma4:e4b kept poisoning subsequent Ollama turns even after `/clear`, eventually causing the model to skip tool calls entirely and fabricate a "persistent API client error" narrative.

- **Schema.** New `sessions.ollama_cutoff_ms INTEGER` column (idempotent ALTER, nullable). Per-chat ms timestamp; NULL = never cleared.
- **`/clear ollama` (alias `/clear >`).** Sets the cutoff to `Date.now()` for the current chat. `/clear all` now iterates `[primary, secondary, ollama]` instead of just the two Claude tiers; the reply text composes the same way (e.g. `Cleared <b>primary</b> + <b>ollama</b>`). Dirty check for the ollama tier asks `db.hasOllamaTurnsSince(chatId, currentCutoff)` so back-to-back `/clear ollama` honestly returns "Already clean."
- **Decision B (cutoff is source-of-truth).** Both `db.recentChatTurns` (Ollama's history reconstruction, both single-shot and tool-loop variants in `ollama.ts`) AND `db.outOfBandForEngine` (Claude's cross-engine bridge in `agent.ts`) honor the cutoff. So `/clear ollama` truly hides the cleared turns from every engine, not just Ollama itself — otherwise an operator would clear Ollama, then `@ ...` and watch Sonnet recite the freshly-cleared turns out of the bridge.
- **Audit-log untouched.** Operator queries against `audit` (and the web client's chat view) still see every row. The cutoff filters at read time only; the audit log remains append-only.
- **`/compact` and `/context` reject `ollama`.** Ollama has no SDK session to summarize or inspect. The parser surfaces `unknown` so the user gets a clear error.
- **Tests.** 14 new tests across `db.test.ts` (cutoff filtering on both helpers, `hasOllamaTurnsSince` predicate, migration idempotency), `session.test.ts` (cutoff CRUD + UPSERT-on-cold-start), `commands.test.ts` (parser tier tokens, runClear ollama-tier behavior, back-to-back already-clean, `/clear all` includes ollama, `/compact ollama` rejection, `/context ollama` rejection).
- **Docs.** `docs/USAGE.md` slash-commands subsection updated with the new tier and cutoff semantics; `docs/CONFIG.md` cross-links from `OLLAMA_HISTORY_LIMIT`; `docs/ARCHITECTURE.md` updated.

No anti-goal reversal. No SDK pin bump.

## Unreleased — `notion` built-in integration

Adds a blessed in-process Notion integration: 10 tools (6 reads `auto`, 4 writes `confirm`), single `NOTION_API_KEY` env var (no OAuth dance), reachable from both Claude tiers (`@`, `!`) and the local Ollama tool loop (`OLLAMA_TOOLS_ENABLED=true`). Patterned after `gmail/` but lighter (no per-account state, no MIME handling).

- **Tools.** `notion_search`, `notion_list_databases`, `notion_get_page`, `notion_query_database`, `notion_get_database_schema`, `notion_list_users` (auto tier — no Telegram prompt; cost cap + loop detector still apply via `PreToolUse`); `notion_create_page`, `notion_update_page_properties`, `notion_append_blocks`, `notion_archive_page` (confirm tier — Telegram prompt). `notion_archive_page` additionally requires `confirm: true` body field — belt-and-suspenders alongside the user's approval. (`notion_list_databases` was added late in Phase 4 after live testing showed weak tool-callers like gemma4:e4b can't reliably combine `notion_search` with the `filter:database` argument; the dedicated tool gives them an obvious discovery path.)
- **Notion API version pinned to `2022-06-28`.** `@notionhq/client` v5 defaults to `2025-09-03`, which introduced the multi-source-database model and renamed the search filter `value:"database"` to `value:"data_source"`. Without pinning, every `notion_list_databases` call (and `notion_search(filter:"database")`) returns `validation_error`. The pin keeps our request shapes valid; if/when we adopt multi-source databases, the upgrade is opt-in.
- **`databases.query` bypasses the SDK** — `@notionhq/client` v5 *removed* `client.databases.query` (it lives at `client.dataSources.query` under the new model). The version pin only changes the wire format, not the SDK's method names. We hit `POST /v1/databases/{id}/query` with raw `fetch` (helper: `client.ts::queryDatabase`) so we keep the legacy result shape our formatters expect. All other SDK methods we use still exist in v5 and are kept as-is.
- **Filter coercion against the cached schema.** `notion_query_database` walks the model-supplied filter (incl. `and`/`or` composition), and for each leaf `{property, <typeKey>: …}` rewrites `<typeKey>` to match the property's actual type from the schema cache. Small tool-callers (gemma4:e4b) routinely send `select` for `status`-typed properties despite the `filter_template` we surface in `notion_get_database_schema`. Successful coercion is logged (`integrations.notion.filter_coerced`) and surfaced in the response envelope (`filter_coerced: ["Status: select -> status"]`) so operators can see when it kicks in.
- **`notion_get_database_schema` returns `filter_template` per property** — a worked filter shape the model copies and substitutes the value into. Combined with coercion, this hardens the query path against gemma4's discriminator-key drift.
- **Token security.** `NOTION_API_KEY` is added to `agent.ts::sanitizedSubprocessEnv`'s deny-list so the SDK-spawned `claude` subprocess cannot read it. Without the scrub, an auto-allowed `Bash(echo $NOTION_API_KEY)` call (per `policy.ts BASH_SAFE_PREFIXES`) lets a compromised model exfiltrate the secret in plaintext. Future integrations adding their own tokens MUST mirror this pattern.
- **Self-gating boot.** Three gates in order: `@notionhq/client` operator-installed? → `NOTION_API_KEY` set? → `GET /v1/users/me` succeeds within 3s? Each gate logs once (`integrations.notion.{deps_missing,disabled,token_invalid,loaded}`) and registers zero tools on failure; solrac boots normally either way.
- **Property DSL.** Model writes shorthand (`{Status: "Done", Tags: ["a","b"]}`); the integration translates to Notion's typed update shape using a per-database schema cache. On `400`/`validation_error`, schema cache invalidates and the call retries once before surfacing failure (handles the "operator just renamed a select option" case).
- **Block depth cap.** `notion_get_page` walks up to 3 nested levels of children; deeper blocks render with `truncated: true` so the model knows to drill down with another call. Documented in `docs/USAGE.md`.
- **Append chunking.** `notion_append_blocks` auto-splits at Notion's 100-block-per-call limit. Partial-failure envelope reports `{blocksAppended, chunks, lastError}` so the caller can decide whether to retry remaining chunks.
- **New runtime dep: `@notionhq/client`.** Added to solrac's `dependencies` so a fresh `npm ci` populates everything Notion needs. The integration still dynamic-imports it via `loadNotionModule()` so a broken `node_modules` (or a deliberate uninstall) degrades gracefully via the `deps_missing` gate rather than crashing boot. Gmail's `googleapis` posture is unchanged (devDep — production deploys add `--save` if they want Gmail).
- **Docs.** New `docs/USAGE.md#notion` setup walkthrough (incl. integration sharing reminder — Notion's most common operator footgun); `NOTION_API_KEY` row in `docs/CONFIG.md`; built-in integration listing in `docs/ARCHITECTURE.md`.
- **Tests.** 78 new pure-logic tests across `client.test.ts` (probe + cache), `formatters.test.ts` (per-type DSL + chunking), `index.test.ts` (setup gates, tier map, archive body-gate, error envelope mapping, schema invalidate-and-retry, append chunking + partial failure).

No anti-goal reversal. No SDK pin bump.

## Unreleased — recent additions (PRs #1–#5)

Anchor for what shipped recently. PR #5 (default-engine inversion) has a deeper migration section below.

### PR #1 — optional browser web UI; markdown rendering on both transports

- Optional `Bun.serve` web transport alongside Telegram. Off by default; enable with `SOLRAC_WEB_ENABLED=true` + token.
- Five new env vars: `SOLRAC_WEB_ENABLED`, `SOLRAC_WEB_HOST` (default `127.0.0.1`), `SOLRAC_WEB_PORT` (default `8080`), `SOLRAC_WEB_TOKEN` (required when enabled, even on loopback), `SOLRAC_WEB_CHAT_ID` (default `-1000`, must be negative).
- One new runtime dep: `marked`. Server-side it converts model markdown to Telegram's HTML subset (`src/markdown.ts`); browser-side it ships at `/static/marked.min.js`. Fallback to `htmlEscapeText` on any parser glitch.
- Telegram users now see proper formatting (headers, lists, fenced code) instead of literal `**bold**` characters.
- SSE via raw `ReadableStream`; `idleTimeout: 0` on the web `Bun.serve` to keep streams alive.
- Slash commands (`/help`, `/status`, `/context`, `/compact`) authored in markdown.

### PR #2 — operator-authored integrations (in-process MCP, Claude tiers)

- Operators drop a TypeScript module under `$SOLRAC_INTEGRATIONS_DIR/<name>/index.ts`; agent gains `mcp__solrac__<tool>` calls via the SDK's in-process `createSdkMcpServer`. No second process, no HTTP layer.
- Two new env vars: `SOLRAC_INTEGRATIONS_ENABLED` (default `false`), `SOLRAC_INTEGRATIONS_DIR`.
- Blessed integrations ship under `src/integrations-builtin/`: `time` (educational reference), `gmail` (real reference, ported from utcp-tools).
- Examples ship under `examples/integrations/`: `echo` (minimal), `linear` (multi-file pattern reference).
- Every integration tool flows through the existing `policy.ts` gate: `PreToolUse` hook covers cost cap + loop detector regardless of tier; `canUseTool` covers Telegram-confirm UX for `tier:"confirm"` tools.
- New direct runtime dep: `zod` (was transitive via SDK; the SDK's `tool()` signature requires it).
- `googleapis` + `google-auth-library` are devDeps only — operators wanting Gmail run `npm install --save googleapis google-auth-library` once.
- Claude tiers (`@`, `!`) at this stage. Ollama integration support follows in PR #4.

### PR #3 — drop errored SDK session ids on next turn (PNX-170)

- Mid-turn API errors (429, timeout, `error_max_turns`) leave the SDK session in partial state; resuming poisons the next turn's narration (model claimed a successful tool call was *"blocked by a permission error"* because the resumed history showed a prior denial-shaped failure).
- Fix: gate `setSessionId` on `!isError` in `agent.ts`. Both Claude tiers covered via the shared call site (`primary_session_id`, `secondary_session_id`).
- Operators no longer need to remember `/clear` after every visible `❌ error` — recovery is automatic on the next message.
- New entry in `docs/ARCHITECTURE.md#tricky-seams` covers the session-resume contract.

### PR #4 — Ollama tool-calling behind `OLLAMA_TOOLS_ENABLED`

- Local Ollama models (e.g. `gemma4:e4b`) can invoke the same `mcp__solrac__*` integration tools the Claude tiers see. Multi-round driver in `src/ollama-tools.ts` reuses `policy.ts`'s classifier, loop detector, and confirmation broker — no policy duplication.
- Two new env vars: `OLLAMA_TOOLS_ENABLED` (default `false`), `OLLAMA_MAX_TOOL_ITERATIONS` (default `8`).
- `OLLAMA_TIMEOUT_MS` default bumps `60000 → 120000` when `OLLAMA_TOOLS_ENABLED=true`; explicit operator value still wins.
- Boot fails loud on `OLLAMA_TOOLS_ENABLED=true && SOLRAC_INTEGRATIONS_ENABLED=false` — no silent "tools-on but zero tools loaded" surprise.
- Engine routing **untouched** in this PR (no-prefix still routed to primary Claude, `>` still routed to Ollama). Routing is inverted in PR #5 below.
- Footgun for first-time enablers on existing chats: `recentChatTurns` replays earlier "I have no tools" Ollama assistant turns; gemma4 in-context-learns to refuse. Mitigation: the SQL flip in PR #5's history-pollution section, or transient `OLLAMA_HISTORY_LIMIT=1`.

### PR #5 — default-engine inversion + `>` prefix removal (PR-B)

- `>` prefix removed. Default engine selectable via `SOLRAC_DEFAULT_ENGINE=ollama|primary|secondary`.
- Recommended: `SOLRAC_DEFAULT_ENGINE=ollama` + `OLLAMA_TOOLS_ENABLED=true` (local-first, tools-on).
- Boot validation refuses to start on misconfiguration; one-cycle `solrac.default_engine_implicit` warning if `SOLRAC_DEFAULT_ENGINE` is unset.
- Full migration steps, validation rules, history-pollution mitigation, and capability-note matrix: see the **PR-B: default-engine inversion + `>` removal** section directly below.

## Unreleased — PR-B: default-engine inversion + `>` removal

### Breaking changes

**Solrac now requires a local Ollama daemon by default.** Existing deployments must either install Ollama and pull a model, OR set `SOLRAC_DEFAULT_ENGINE=primary` to keep Anthropic Claude as the default. Boot-time validation refuses to start otherwise — there is no silent behaviour change.

Recommended model: **`gemma4:e4b`** (native function-calling, ~9.6GB, 128K context).

The `>` prefix has been **removed**. A leading `>` is now literal user text routed via the new default-engine setting.

### Migration

For Ollama-default deploys (recommended):

```sh
# Install Ollama and pull the model on the host:
ollama pull gemma4:e4b

# In .env:
SOLRAC_DEFAULT_ENGINE=ollama          # new — no-prefix routes to local
OLLAMA_ENABLED=true
OLLAMA_MODEL=gemma4:e4b
OLLAMA_TOOLS_ENABLED=true             # local model uses operator integrations
SOLRAC_INTEGRATIONS_ENABLED=true      # precondition for OLLAMA_TOOLS_ENABLED
```

For Claude-only deploys (no Ollama):

```sh
SOLRAC_DEFAULT_ENGINE=primary         # no-prefix routes to Sonnet
OLLAMA_ENABLED=false
OLLAMA_TOOLS_ENABLED=false
```

Boot validation throws actionable errors on misconfiguration:

- `SOLRAC_DEFAULT_ENGINE=ollama && !OLLAMA_ENABLED` → throw with hint
- `SOLRAC_DEFAULT_ENGINE!=ollama && OLLAMA_TOOLS_ENABLED=true` → throw (unreachable since `>` is gone)

When `SOLRAC_DEFAULT_ENGINE` isn't set explicitly, a `solrac.default_engine_implicit` warn fires on every boot for one minor release cycle so the inversion never lands silently.

### History-pollution warning

First-time enablers of `OLLAMA_TOOLS_ENABLED` (or this release's tools-on default) should clear chat history if the engine had earlier failure-shaped turns — local models in-context-learn from their own past refusals. Quick mitigation: `OLLAMA_HISTORY_LIMIT=1` for one turn to bypass. SQL flip:

```sql
UPDATE audit SET status='error'
WHERE chat_id=? AND model LIKE 'ollama:%' AND status='ok' AND id < <pivot>;
```

### Other changes

- **Web UI** — engine pills reordered: default → `@` → `!`. The default-pill label is server-injected so the user sees `default (ollama)` or `default (primary Claude)` matching the deploy. The `>` button was removed.
- **Capability notes** — `agent.ts::buildClaudeCapabilityNote` and `ollama.ts::buildOllamaCapabilityNote` replace the static `CLAUDE_CAPABILITY_NOTE` / `OLLAMA_CAPABILITY_NOTE` constants. Notes now adapt to whether the engine is the default vs. an explicit escalation. (See [PLAN.md §3c](../PLAN.md) for the full matrix.)
- **`/help`** — engine section is dynamic; renders the live `defaultEngine` × `OLLAMA_TOOLS_ENABLED` cell.
- **`/status`** — Claude session lines render only when a session exists; new `ollama turns (24h)` bullet appears when applicable.
- **`/context` and `/compact`** — bare-arg invocations now reject with a usage hint. Pre-PR-B silently defaulted to `primary`, which would summarize an empty Claude session post-inversion. Operators must specify `@` or `!`.
- **Boot-time Ollama health probe** — when `defaultEngine=ollama`, fires a single `GET /api/tags` at boot. Non-fatal warn on failure (daemon may come up after Solrac under systemd).
- **`OLLAMA_TIMEOUT_MS`** — defaults to `120000` when `OLLAMA_TOOLS_ENABLED=true` (was `60000`); explicit operator value still wins.

### Anti-goals reaffirmed

PR-B does not reverse any [anti-goals](./docs/ARCHITECTURE.md#anti-goals). No new dependencies, no SDK pin bump.
