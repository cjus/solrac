# Changelog

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
