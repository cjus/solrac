# skills/

Operator-defined slash commands. The default for `SOLRAC_SKILLS_DIR`; matches the path declared in `.env.example`.

## How to add a skill

1. Create a subdirectory: `skills/<name>/SKILL.md`.
2. Write the file with frontmatter + a prompt body — see [`examples/`](../examples/) for templates and [`docs/USAGE.md#skills-operator-defined-commands`](../docs/USAGE.md#skills-operator-defined-commands) for the full reference.
3. Set `SOLRAC_SKILLS_ENABLED=true` in `.env`.
4. Restart Solrac. The filename becomes a `/<name>` slash command.

## What lands here

A skill is a single-turn, tool-less Claude prompt with `{{args}}` templating. Cost rolls into the per-chat hourly cap. Hot-reload is intentionally absent — edit and restart.

## Why this folder is committed empty

The folder needs to exist so `SOLRAC_SKILLS_ENABLED=true` works on first boot without an `mkdir`. Skills you author here are operator-specific; consider a separate private repo (or `.gitignore` additions) before committing them upstream.
