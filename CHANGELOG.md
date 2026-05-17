# Changelog

## v0.9.0 — OpenRouter as a remote backend for the engine slot

Adds **OpenRouter** as a third option for the no-prefix engine slot, alongside on-host Ollama and LMStudio. New `REMOTE_ENABLED=true` flag — mutually exclusive with `LOCAL_ENABLED` at boot — points the engine slot at OpenRouter so hosts that can't run a local LLM still get a default-engine option. Per-token cost from OpenRouter's streaming `usage.cost` field is captured and written to `audit.cost_usd`, so the existing per-chat (`HOURLY_COST_CAP_USD`) and global (`GLOBAL_HOURLY_COST_CAP_USD`) hourly caps gate remote burn automatically — no new cost-cap knob needed. Claude tiers (`@`, `!`) and the `local` engine routing are unaffected.

- **New env vars** (all `REMOTE_*` namespace, provider-neutral for future vLLM/Anyscale/Together/Groq additions):
  - `REMOTE_ENABLED` — master switch. Mutually exclusive with `LOCAL_ENABLED` (boot rejects both true).
  - `REMOTE_BACKEND` — `openrouter` (only value today; type stays open for future providers).
  - `REMOTE_MODEL` — OpenRouter slug, e.g. `anthropic/claude-3.5-sonnet`, `openai/gpt-4o-mini`, `meta-llama/llama-3.3-70b-instruct`. Contains `/` — verified safe across the codebase (no parser splits on `/`).
  - `REMOTE_API_KEY` — required when `REMOTE_ENABLED=true`. Scrubbed by `sanitizedSubprocessEnv()` (prefix-match `REMOTE_*`) so the Claude SDK subprocess never sees the OpenRouter credential.
  - `REMOTE_BASE_URL` — defaults to `https://openrouter.ai/api/v1`; override for proxies/staging. URL validated at boot.
  - `REMOTE_TIMEOUT_MS` (default 60s / 120s with tools), `REMOTE_HISTORY_LIMIT` (default 6), `REMOTE_MAX_TOOL_ITERATIONS` (default 8) — mirror the `LOCAL_*` knobs.
  - `REMOTE_HTTP_REFERER` (default `https://github.com/cjus/solrac`) + `REMOTE_X_TITLE` (default `solrac`) — OpenRouter attribution headers.
- **Engine slot reuse, not a new engine.** The internal `Engine = "primary" | "secondary" | "local"` union is unchanged; each `EngineDriver` factory sets a `mode: "local" | "remote"` field (`createOllamaDriver`/`createLmstudioDriver` → `"local"`; `createOpenrouterDriver` → `"remote"`). `runEngineTurn` reads `driver.mode` directly — no parallel `mode` field on the deps. Mode drives three behaviors: audit-tag prefix (`local:` vs `remote:`), capability-note framing ("cost the operator nothing" vs "cost the operator per-token via OpenRouter, so be concise"), and the `cost_usd` write decision. No new dispatch branch — the same routing, same queue, same mutex, same `/clear local` cutoff.
- **Audit tag pattern: `remote:openrouter:<model>`.** Symmetric with `local:ollama:<model>` and `claude:primary:<model>`. The model slug's `/` flows through unmodified; no parser splits on `/` (audited via `grep -RnE "model\.(split|substring|substr|slice)" src/`).
- **Cost capture from the streaming usage chunk.** OpenRouter's trailing usage chunk includes `cost` (USD) alongside `prompt_tokens` / `completion_tokens` — and as of 2026 it's automatic (the historical `usage: { include: true }` / `stream_options: { include_usage: true }` opt-ins are deprecated and have no effect per [OpenRouter docs](https://openrouter.ai/docs/guides/administration/usage-accounting)). `EngineChatEvent.done` carries `costUsd: number | null`; `engine.ts::resolveAuditCost` picks the write:
  - `mode=local` → 0 (on-host backends are free; driver costUsd ignored).
  - `mode=remote && costUsd != null` → write the real cost.
  - `mode=remote && costUsd == null` → write `null` (NOT 0) + log `remote.cost_missing`. Writing 0 would silently bypass the cap query's `COALESCE(SUM(cost_usd), 0)`; null preserves the audit row but excludes it from the cap sum.
- **Tool-loop sums cost across rounds.** `runToolLoop` accumulates per-round `costUsd` (each round is a separate API call on a remote backend with its own billed cost), then `engine.ts::resolveAuditCost` writes the sum to `audit.cost_usd`. The `costUsdSeen` flag distinguishes "every round skipped the field" (null) from "every round was a free local round" (0).
- **Footer cost chip in remote mode.** The engine-slot Telegram footer now appends `· $X.XXXX` when running in remote mode and the driver reported a cost — e.g. `<i>✅ remote:openrouter:openai/gpt-4o-mini · 1.2s · $0.0042</i>`. Local mode is unchanged (no chip; on-host = free). The chip is gated by the same logic as the audit write (`engine.ts::formatFooterCost`) so the UI and `audit.cost_usd` agree: if `remote.cost_missing` fires, the chip is omitted rather than rendered as `$0.0000`. Mirrors the Claude-tier footer's `$X.XXXX` segment so operators get the same cost visibility on both surfaces.
- **Mutual exclusion at boot.** `LOCAL_ENABLED=true && REMOTE_ENABLED=true` throws with an actionable message. `SOLRAC_DEFAULT_ENGINE=local` now requires `LOCAL_ENABLED OR REMOTE_ENABLED`; the error message lists both paths.
- **DB cutoff triple-pattern.** `db.hasLocalTurnsSince` and `db.outOfBandForEngine` LIKE clauses extend to `local:%` OR `ollama:%` (legacy) OR `remote:%`. So `/clear local` correctly wipes the engine-slot cutoff for an OpenRouter-only deploy, and Claude's cross-engine bridge honors the local cutoff for remote turns too (otherwise `/clear local` clears Ollama but Claude still recites freshly-cleared OpenRouter turns out of the bridge).
- **Subprocess env scrub.** `sanitizedSubprocessEnv()` in `agent.ts` adds a `REMOTE_*` prefix exclusion alongside the existing `TELEGRAM_*`, `TG_*`, `LOCAL_*` scrubs. `REMOTE_API_KEY` in particular is a billed credential — exfiltration via `Bash(echo $REMOTE_API_KEY)` would let a compromised model burn operator balance.
- **Web UI + `/help` mode awareness.** `defaultEngineLabel` renders `remote (openrouter)` when remote mode is active. `/help` engine section gets an `engineSlotMode` field that swaps the cost-framing line ("free" → "per-token via OpenRouter") for the no-prefix path.
- **Boot probe.** The engine-slot health probe (`probeEngineHealth`) runs against whichever driver is wired, including the OpenRouter `GET /models` probe with bearer auth. 401 surfaces as `auth_failed` so a bad `REMOTE_API_KEY` is visible at startup, not first-turn.
- **No new runtime deps.** OpenRouter is OpenAI-compatible — no SDK needed. The driver is built on raw `fetch` like the LMStudio driver. No anti-goals reversed.
- **No SDK pin bump.** Claude Agent SDK pin stays at `0.2.119`.
- **Tests.** 10 new driver tests cover OpenRouter probe (auth header, model-present, model-absent, 401, network error), streaming (cost captured from trailing usage, cost-missing falls through as null, slash-bearing slug round-trips, auth + attribution headers on every request, 401 surfaces with REMOTE_API_KEY hint, 404 → model_missing, inline error frame terminates, tool-call SSE deltas accumulate). 13 new config tests cover the REMOTE_* validations (required field set, mutex with LOCAL_ENABLED, default-engine=local needs one mode, base URL parse). 4 new runner tests cover the cost-write matrix (local 0, remote populated, remote-null defensive, mode default back-compat) and capability-note mode framing. 3 new DB tests cover the triple-pattern LIKE extension (remote:% matches hasLocalTurnsSince, remote:% hidden by outOfBandForEngine cutoff).
- **Cleanup debt flagged.** The dual-pattern `local:% OR ollama:%` LIKE clauses (left over from v0.7.0's "removed in a follow-up release once the migration has propagated") become triple-pattern with `remote:%`. The legacy `ollama:%` clause is scheduled for removal in the next minor.

### Refactor: split `engine.ts` / `local-driver.ts` / `remote-driver.ts`

The OpenRouter work originally landed on the `local-*` files because the runner is mode-polymorphic — both modes legitimately share the same streaming + tool-loop + audit plumbing. Naming-wise that made the codebase lie ("local" hosting a remote service). This commit follows up with a structural-only refactor: clearer file names, no behavior change, no env-var change, no DB schema change.

**Files renamed (git blame preserved via `git mv`):**

| Was | Now |
|---|---|
| `src/local.ts` | `src/engine.ts` |
| `src/local-tools.ts` | `src/engine-tools.ts` |
| `src/local.test.ts` | `src/engine.test.ts` |
| `src/local-tools.test.ts` | `src/engine-tools.test.ts` |

**Files added:**

- `src/engine-driver.ts` — shared abstraction owning `EngineBackend`, `EngineDriver`, `EngineChatEvent`, `EngineDriverError`, `DriverOpts`, plus the cross-driver helpers (`stableStringify`, `maybeLogEmptyStream`).
- `src/remote-driver.ts` — OpenRouter driver moved out of `local-driver.ts`; sets `driver.mode = "remote"`. New `buildRemoteCapabilityNote` + `buildRemoteToolCapabilityNote` always frame cost as "per-token via OpenRouter".
- `src/remote-driver.test.ts` — OpenRouter test block extracted (11 tests) from `local-driver.test.ts`.

**Files updated in place:**

- `src/local-driver.ts` — Ollama + LMStudio only, both with `driver.mode = "local"`. Capability builders `buildLocalCapabilityNote` / `buildLocalToolCapabilityNote` always frame cost as "free" (no mode parameter). OpenRouter shim removed.
- `src/main.ts`, `src/commands.ts`, `src/skill-tools.ts`, `src/instance.ts`, `test/smokes/local.ts` — caller updates: imports from `./engine.ts` / `./engine-driver.ts` / `./engine-tools.ts`; `LocalSkillDeps` → `EngineSkillDeps`; `runLocalTurn` → `runEngineTurn`; `mcpToLocalTools` → `mcpToEngineTools`; `probeLocalHealth` → `probeEngineHealth`. Variable names that describe the engine *slot* (`localDeps`, `localDriver`, `localSkillDeps`) kept — the slot is still named `local` in routing.

**Type renames:**

| Was | Now |
|---|---|
| `LocalBackend` (wire-format union) | `EngineBackend` |
| `LocalChatRole`, `LocalChatMessage`, `LocalToolCallRef`, `LocalToolDef`, `LocalChatEvent`, `LocalProbeResult`, `LocalStreamChatOpts` | `Engine*` equivalents |
| `LocalDriver` | `EngineDriver` (adds `mode: "local" \| "remote"` field) |
| `LocalDriverError` | `EngineDriverError` |
| `LocalRunDeps`, `LocalRunInput` | `EngineRunDeps`, `EngineRunInput` |
| `LocalEngineMode` (discriminator type) | **deleted** — `driver.mode` is now the single source of truth |
| `LocalSkillDeps` | `EngineSkillDeps` |
| `mcpToLocalTools` | `mcpToEngineTools` |
| `LOCAL_DENY_TOOLS` | `ENGINE_DENY_TOOLS` |

Operator-config-layer types (`config.ts::LocalBackend = "ollama" \| "lmstudio"`, `config.ts::RemoteBackend = "openrouter"`) kept — they describe operator-facing env-var values, distinct from the wire-format `EngineBackend` union.

**Log event renames** (`local.*` → `engine.*` for runner events; per-backend prefixes for driver events):

| Was | Now | Source |
|---|---|---|
| `local.ollama_bad_frame` | `ollama.bad_frame` | `local-driver.ts` |
| `local.lmstudio_bad_frame` | `lmstudio.bad_frame` | `local-driver.ts` |
| `local.lmstudio_empty_stream` | `lmstudio.empty_stream` | `local-driver.ts` |
| `local.lmstudio_tool_call_deduped` | `lmstudio.tool_call_deduped` | `local-driver.ts` |
| `local.openrouter_bad_frame` | `openrouter.bad_frame` | `remote-driver.ts` |
| `local.openrouter_empty_stream` | `openrouter.empty_stream` | `remote-driver.ts` |
| `local.openrouter_tool_call_deduped` | `openrouter.tool_call_deduped` | `remote-driver.ts` |
| `local.stub_send_failed` | `engine.stub_send_failed` | `engine.ts` |
| `local.unexpected_tool_call_single_shot` | `engine.unexpected_tool_call_single_shot` | `engine.ts` |
| `local.driver_failed` | `engine.driver_failed` | `engine.ts` |
| `local.unexpected_error` | `engine.unexpected_error` | `engine.ts` |
| `local.edit_throttled` | `engine.edit_throttled` | `engine.ts` |
| `local.edit_final_failed` | `engine.edit_final_failed` | `engine.ts` |
| `local.final_send_failed` | `engine.final_send_failed` | `engine.ts` |
| `local.done` | `engine.done` | `engine.ts` |
| `local.boot` | `engine.boot` | `main.ts` |
| `local.boot_health_ok` | `engine.boot_health_ok` | `main.ts` |
| `local.boot_health_failed` | `engine.boot_health_failed` | `main.ts` |
| `local.boot_health_model_missing` | `engine.boot_health_model_missing` | `main.ts` |
| `local.disabled_ack_failed` | `engine.disabled_ack_failed` | `main.ts` |
| `local.tools_enabled_but_zero_loaded` | `engine.tools_enabled_but_zero_loaded` | `main.ts` |
| `local.tool_loop_start` / `local.tool_loop_done` / `local.tool_loop_failed` | `engine.tool_loop_*` | `engine-tools.ts` |
| `local.tool_loop_detected` / `local.tool_iteration_cap` / `local.cap_finalize_failed` | `engine.tool_*` | `engine-tools.ts` |
| `local.tool_unknown` / `local.tool_auto_allow` / `local.tool_denied_policy` / `local.tool_denied_hard` / `local.tool_hard_denied` / `local.tool_invalid_args` / `local.tool_handler_threw` / `local.tool_call_ok` | `engine.tool_*` | `engine-tools.ts` |
| `local.tool_confirm_request` / `local.tool_confirm_resolved` / `local.tool_confirm_send_failed` / `local.tool_confirm_round_cap` / `local.tool_confirm_skipped_round_cap` | `engine.tool_confirm_*` | `engine-tools.ts` |
| `local.progress_failed` | `engine.progress_failed` | `engine-tools.ts` |

`remote.cost_missing` keeps its name — it's a remote-only signal, accurately scoped already.

**Operator impact.** Any `journalctl ... | jq 'select(.event == "local.done")'` queries break against new boot logs. v0.8.0 audit rows already on disk keep the old event names — those don't change. Update grep patterns once.

**Zero behavior change** — verified by typecheck + the full test suite passing (798 tests across 31 files). Zero env-var change. Zero DB schema change. The audit-tag DB column prefix (`local:` / `remote:`) is intentionally NOT renamed — that would require an SQL migration of `audit.model`; deferred.

**Anti-goals.** No new runtime deps. No new HTTP framework. No SDK pin bump. No sub-agents enabled.

## v0.7.1 — weak-local-model hardening + docs

Four post-v0.7.0 fixes that together make LMStudio + small open-weight models (gpt-oss-20b class) usable on long-running chats. No breaking changes, no new env vars, no SDK pin bump.

### Skill-as-tool error payload: tell weak models not to retry (#24)

Live v0.7.0 dogfooding under `openai/gpt-oss-20b` on LMStudio surfaced a tool-loop pathology: when a skill-as-tool call hit `iteration_cap` (e.g. `skills__tldr` ran out of its single-iteration budget) the parent model treated the bare `{success:false, error:"iteration_cap"}` envelope as a transient failure and retried the same skill 3–4× before `local.tool_loop_detected` intervened at the loop-detector's threshold. Skill execution is deterministic for fixed `(skill, args)` — retries can't succeed; they just waste rounds, accumulate noise in the parent's context, and produce confused final answers. The fix expands the error envelope with explicit non-retry signaling that weak local models can act on.

- **New envelope shape.** Skill-tool errors now return `{success:false, error:<raw>, retryable:false, hint:"Do not call 'skills__<name>' again this turn — same input produces the same result. Continue without this skill and answer the user with whatever information you already have."}`. The error string is preserved verbatim for operator log-grepping; the `retryable` flag + plain-prose `hint` are additive fields a parent model can read.
- **Centralized payload builder.** `buildSkillErrorPayload(skillName, errorMessage)` exported from `src/skill-tools.ts` so both error sites (skill execution failure, missing `skillToolCtx` defensive path) share one shape. New unit tests pin the MCP `content` shape, the `retryable:false` invariant, the per-skill `hint` identifier, and arbitrary-error-string passthrough.

Symptom in the wild that motivated this: `auditId 220` chain under LMStudio+gpt-oss-20b — model fires `gmail_list_accounts` correctly, then unprompted `gmail_search_messages`, then 4 attempts at `skills__tldr` (each spawning a nested loop that hits its own iteration_cap), before the loop detector breaks the cycle. Final user-facing response was "I'm not sure what you'd like me to log…" — the parent's confused interpretation of repeated tldr failures rather than an answer to the actual query (`list my gmail accounts`).

### Surface LMStudio inline-error frames + empty-stream diagnostic (#25)

LMStudio sends server-side errors as HTTP 200 SSE frames (`{"error":{"message":"…"}, …}`), not error statuses. The driver parser only knew `model`/`choices`/`usage`, so these frames fell through and turns rendered as `(empty response)` with no diagnostic — operators had no idea LMStudio had told us what went wrong (e.g. context-length overruns from undersized model windows).

- **Parser now yields `kind:"error"` on `frame.error`**, mirroring Ollama's existing branch. The message propagates through `runStreamingRound` → `errorMessage` → audit row `status='error'` → rendered `❌ error: …` reply.
- **New `local.lmstudio_empty_stream` warn** as a safety net for future protocol drift. Captures up to 30 raw `data:` payloads (400 chars each) iff both text and tool-call event counters end at zero. Happy path is silent.
- **Docs across 4 files**: ARCHITECTURE Tricky Seam §10, RUNBOOK failure table (context-length + empty-stream rows), CONFIG LMStudio context-length sizing section, OPERATIONS log-events entry.

### Strip harmony-style control tokens from local-engine render (#26)

Local models (gpt-oss variants surfaced via Ollama/LMStudio) leak harmony channel markers like `<|channel>thought<channel|>` and stray `<|start|>` / `<|end|>` / `<|message|>` / `<|return|>` tokens into the user-facing Telegram/web reply.

- **`scrubLocalControlTokens(text)` in `src/local.ts`** applied at all four render touch-points (`renderStreamingStub`, `renderFinal`, `renderToolLoopStub`, `renderToolLoopFinal`). Three-pass scrubber: collapse paired `<|name>...<name|>` blocks (drops channel-header content), suppress unclosed openers at end of buffer (prevents mid-stream flicker), strip stray symmetric harmony tokens and orphan closers.
- **Display-only** — `audit.response` and `recentChatTurns` history still see the raw model output for forensics. **Local engine only** — Claude tiers untouched.

### README: mention LMStudio alongside Ollama (#27)

Landing-page tagline + "Why Solrac" paragraph + Local-LLM-first bullet all read as Ollama-only, even though the rest of the doc set has covered both backends since v0.7.0's hard cutover. Three copy edits in `README.md` to keep the surface consistent with `LOCAL_BACKEND=ollama|lmstudio`.

## v0.7.0 — local LLM backend abstraction: Ollama + LMStudio (BREAKING)

Replaces the Ollama-specific path with a generic `local` engine that supports multiple backends behind a unified driver interface (`src/local-driver.ts`). Hard cutover — every `OLLAMA_*` env var, `engine: ollama` / `tier: ollama` frontmatter value, and `/clear ollama` / `>` slash alias is rejected with a rename hint. The audit-row tag becomes three-segment `local:<backend>:<modelId>` and matches the `claude:<tier>:<modelId>` shape so cross-engine queries are symmetric. LMStudio joins Ollama as a first-class backend with its own SSE wire format, `parallel_tool_calls: false` Gemma-4 workaround, and tool-call argument-delta accumulation.

- **Env vars.** All `OLLAMA_*` → `LOCAL_*`. New `LOCAL_BACKEND` (required when `LOCAL_ENABLED=true`): `ollama` or `lmstudio`. `LOCAL_URL` default is backend-aware (Ollama → `:11434`, LMStudio → `:1234`). Boot fails loud on any legacy `OLLAMA_*` env var with the rename mapping, and on `SOLRAC_DEFAULT_ENGINE=ollama` with a hint pointing at `local` + `LOCAL_BACKEND=ollama`.
- **Audit `model` column format.** `ollama:<modelId>` → `local:<backend>:<modelId>`. Migration runs idempotent retag at boot (`UPDATE audit SET model = 'local:ollama:' || substr(model, 8) WHERE model LIKE 'ollama:%'`) BEFORE the column rename below, so a crash between steps still leaves audit queries (dual-pattern reads, see next bullet) working.
- **Dual-pattern reads for one release.** `outOfBandForEngine` and `hasLocalTurnsSince` match BOTH `local:%` and legacy `ollama:%`. Mitigates rollback / partial-migration risk. The legacy clause is removed in a follow-up release once the migration has propagated.
- **Sessions schema.** Column rename `ollama_cutoff_ms` → `local_cutoff_ms` via `ALTER TABLE ... RENAME COLUMN` (SQLite 3.25+). Idempotent: legacy column → rename, neither → add new.
- **Slash commands.** `/clear ollama` → `/clear local`. Aliases `o` and `>` dropped; `l` is the new short form. `/status` line "ollama turns (24h)" → "local turns (24h)". The "Cleared <b>ollama</b>" reply text becomes "Cleared <b>local</b>".
- **Operator-edited markdown.** `tasks/*.md` `engine: ollama` and `skills/*.md` `tier: ollama` are **hard-rejected at parse** with rename hints. Replace with `engine: local` / `tier: local` before redeploying. Same hard-reject for `SOLRAC_DEFAULT_ENGINE=ollama`.
- **Web UI pill label.** `defaultEngineLabel` returns `local (<backend>)` for the local engine (e.g. `local (ollama)`, `local (lmstudio)`) so the operator sees the backend at a glance.
- **LMStudio driver hardening.** Sends `parallel_tool_calls: false` (Gemma-4 lmstudio-bug-tracker #1756 workaround) and dedupes identical `(name, args)` tool calls within one assistant message. Accumulates `function.arguments` deltas across SSE chunks before emitting one parsed `tool_call` event. Captures `usage` chunk for `inputTokens`/`outputTokens` whether it arrives inline or on a trailing dedicated chunk.
- **LMStudio silent-substitution detection.** LMStudio's `POST /v1/chat/completions` returns HTTP 200 with the *loaded* model when the requested id isn't loaded, rather than 404'ing. Caught during the carlos/solrac-local-llm-backend smoke run: a fake-model request returned a normal completion instead of erroring. Driver now compares `chunk.model` (echoed by the OpenAI streaming protocol) against the requested model on the first chunk that carries it; mismatch throws `LocalDriverError("lmstudio", "model_missing", ...)` with the served-model id surfaced in the message + `lms load <requested>` hint. Closes the mid-session hole that `probe()` (boot-only) doesn't cover. New tests in `local-driver.test.ts`: substitution detected, exact-match passes through.
- **Test coverage.** New `local-driver.test.ts` covers NDJSON partial-line buffering, SSE multi-event-per-chunk and single-event-split, `[DONE]` terminator, optional trailing `usage` chunk, tool-call args split across deltas, dedup behavior, and 404/5xx/network/abort error paths for both backends. New `local-tools.test.ts` covers `mcpToLocalTools` converter, `stripThoughts`, and `runToolLoop` via a scripted fake driver. New `local.test.ts` covers the capability-note matrix, audit-tag invariant (verified for both `local:ollama:%` and `local:lmstudio:%`), driver-error rendering, and token capture.
- **Smoke.** `test/smokes/ollama.ts` → `test/smokes/local.ts`. `npm run smoke:ollama` → `npm run smoke:local`. Switches on `LOCAL_BACKEND` env (defaults to `ollama` for back-compat with the historical smoke target). Backend-aware pull/load hint check (`ollama pull` vs `lms load`).
- **Pre-deploy backup recommendation.** Document in operator deploy procedure: `cp data/solrac.db data/solrac.db.pre-local-migration` before service restart. Rollback SQL is commented in `src/db.ts` next to the migration.
- **No SDK pin bump.** No new runtime deps. No anti-goal reversals.

Files renamed/added:
- `src/ollama.ts` → `src/local.ts`, `src/ollama-tools.ts` → `src/local-tools.ts`, new `src/local-driver.ts`.
- `src/ollama.test.ts` + `src/ollama-tools.test.ts` → `src/local.test.ts`, `src/local-tools.test.ts`, new `src/local-driver.test.ts`.
- `test/smokes/ollama.ts` → `test/smokes/local.ts`.

## v0.8.0 — scheduler: switch to unix cron (BREAKING TASK.md format)

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
