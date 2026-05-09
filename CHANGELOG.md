# Changelog

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
