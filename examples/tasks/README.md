# Scheduled tasks

Operator-authored prompts that fire on a schedule into a chat. Each task is one `TASK.md` file with a YAML-ish frontmatter block (metadata) plus a markdown body (the prompt).

## Layout

```
$SOLRAC_TASKS_DIR/
├── morning-digest/
│   └── TASK.md
├── weekly-pr-review/
│   └── TASK.md
└── one-off-2026-05-15/
    └── TASK.md
```

`$SOLRAC_TASKS_DIR` defaults to `./tasks` (launch-cwd-relative). Override via env. Loader walks one level deep — flat layouts (`tasks/morning-digest.md`) are not supported; the per-task subdirectory is reserved for future companion files.

## Enabling

```sh
export SOLRAC_TASKS_ENABLED=true
# Optional — defaults to ./tasks
export SOLRAC_TASKS_DIR=./tasks
```

Tasks load at boot. Edit a TASK.md → restart Solrac to pick up changes (matches the skills/integrations contract; no hot-reload).

## Frontmatter schema

```yaml
---
name: morning-digest                # required; [a-z0-9_]{1,32}
description: One-line description.  # required; ≤256 chars
schedule: daily_at 09:00            # required; one of "every <dur>", "daily_at HH:MM", "at <ISO8601>"
chat_id: 123456789                  # optional; defaults to operator's first allowlist entry
engine: ollama                      # optional; primary | secondary | ollama; defaults to SOLRAC_DEFAULT_ENGINE
catch_up: true                      # optional; default: true for periodic, false for one-off
enabled: true                       # optional; default: true
max_cost_usd: 0.10                  # optional; per-task hourly cap (Claude tiers only — silently ignored for ollama)
boot_catch_up_jitter_s: 30          # optional; default: 0; staggers boot fires by random(0, N) seconds
---

Prompt body goes here. The body is sent to the configured engine on every fire.
```

### Schedule grammar

- `every <N><unit>` — interval from `last_run_at`. Units: `s`, `m`, `h`, `d`. **Minimum 5 minutes for Claude tiers** (cost-runaway guard); minimum 1 minute for Ollama.
- `daily_at HH:MM` — anchored daily fire in **UTC**. The fire happens once per UTC day at the anchor time; if Solrac was down at the anchor and `catch_up` is true, it fires once on next boot.
- `at <ISO8601>` — single fire at an absolute time. Must include a timezone (`Z` or `+HH:MM`); naive strings are rejected.

### Catch-up

- Periodic tasks (`every`, `daily_at`) default to `catch_up: true`. If Solrac was down through a missed window, the task fires once on next boot (not N times for N missed windows).
- One-off tasks (`at`) default to `catch_up: false`. If the `at` timestamp is in the past at boot, the task is marked consumed without firing — set `catch_up: true` to fire-late instead.
- `boot_catch_up_jitter_s` smears boot fires across a random window so 12 daily tasks don't all hit the model at once.

### Engine

- Defaults to `config.defaultEngine` (whatever `SOLRAC_DEFAULT_ENGINE` resolves to). On a deploy where `SOLRAC_DEFAULT_ENGINE=ollama`, omitting `engine:` runs free on local inference.
- Explicit `engine: primary` or `engine: secondary` escalates to a Claude tier — same shape as a user typing `@` or `!` in chat. The cost rolls into the per-chat hourly cap.
- `engine: ollama` is rejected at parse if `SOLRAC_DEFAULT_ENGINE` isn't `ollama` (PR-B removed the `>` prefix; Ollama is reachable only as the deploy default).

### `chat_id`

Where the task's reply lands. Defaults to the operator's first allowlist entry (DM-to-self). Set explicitly to route into a group chat (negative integer) or a different operator-managed channel. The chat must already be reachable by Solrac — there's no auto-join.

### `max_cost_usd`

Pre-flight check, **Claude tiers only**. At fire time the scheduler queries `SUM(cost_usd)` for this task's audit rows in the past hour; if the sum is at or above `max_cost_usd`, the fire is skipped and a denial audit row is written with `error_message = "task_cost_cap: …"`. The per-chat hourly cap (`HOURLY_COST_CAP_USD`) still applies on top.

The cap is **inter-fire**: a single fire's cost is never aborted mid-turn. For a hard per-fire abort, lower `HOURLY_COST_CAP_USD` instead.

## Visibility

- Every fire writes one `audit` row tagged `origin='scheduled'` with `task_name=<name>`. Query the audit log directly to see what fired:
  ```sh
  sqlite3 data/solrac.sqlite "SELECT started_at, task_name, status, cost_usd FROM audit WHERE origin='scheduled' ORDER BY started_at DESC LIMIT 20;"
  ```
- The `scheduled_tasks` table tracks `last_run_at`, `last_status`, `last_audit_id`, and `one_off_consumed` per task.
- Phase 2 ships a `/tasks` slash command for operator-friendly listing.

## Safety notes

- Scheduled fires share the same turn queue as user-typed messages, so `MAX_CONCURRENT_TURNS` and the per-chat / global hourly cost caps all apply automatically.
- A task that fires while a user is mid-conversation in the same chat waits behind the user (KeyedMutex serializes per chat). Pick a `chat_id` the user isn't actively typing in if you need deterministic timing.
- Tier-3 tools (Telegram-confirm) called from a scheduled fire prompt for confirmation as usual; without an operator at the keyboard the broker times out at 60s and fail-closes. Write your TASK.md body with this in mind — prefer tools that auto-allow.

## Examples

See `morning-digest/TASK.md` and `weekly-pr-review/TASK.md` in this directory.
