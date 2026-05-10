# tasks/

Operator-authored prompts that fire on a schedule. The default for `SOLRAC_TASKS_DIR`; matches the path declared in `.env.example`.

## How to add a task

1. Create a subdirectory: `tasks/<name>/TASK.md`.
2. Write the file with frontmatter (`name`, `description`, `schedule`, optional `chat_id` / `engine` / `catch_up` / `enabled` / `max_cost_usd` / `boot_catch_up_jitter_s`) plus a prompt body. See [`examples/tasks/`](../examples/tasks/) for ready-to-edit templates and [`docs/USAGE.md#scheduled-tasks`](../docs/USAGE.md#scheduled-tasks) for the full reference.
3. Set `SOLRAC_TASKS_ENABLED=true` in `.env`.
4. Restart Solrac. The task fires on its configured schedule.

## Schedule grammar

| Form | Example |
|------|---------|
| `every <N><unit>` | `every 1h`, `every 24h`, `every 30m` |
| `daily_at HH:MM` (UTC) | `daily_at 09:00` |
| `at <ISO8601>` (one-off) | `at 2026-05-15T13:00:00Z` |

Minimum interval for `every`: 5 min for Claude tiers, 1 min for Ollama.

## Operator commands

- `/tasks` — list every loaded task with last + next fire.
- `/tasks run <name>` — fire a task on demand.

## Why this folder is committed empty

The folder needs to exist so `SOLRAC_TASKS_ENABLED=true` works on first boot without an `mkdir`. Tasks you author here are operator-specific; consider a separate private repo (or `.gitignore` additions) before committing them upstream.
