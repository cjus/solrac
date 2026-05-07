# Operations

Running Solrac in production. For incident recovery, see [RUNBOOK.md](./RUNBOOK.md).

## Topics

1. [systemd deploy](#systemd-deploy)
2. [/health and /stats](#health-and-stats)
3. [Daily cost report](#daily-cost-report)
4. [Log events](#log-events)
5. [Audit queries](#audit-queries)
6. [Workspace inspection](#workspace-inspection)
7. [Backup and restore](#backup-and-restore)
8. [Observability checklist](#observability-checklist)

---

## systemd deploy

Three units in `deploy/systemd/`:

| Unit | Type | Purpose |
|------|------|---------|
| `solrac.service` | simple | Long-running Bun process |
| `solrac-bounce.service` | oneshot | `systemctl restart solrac.service` |
| `solrac-bounce.timer` | timer | Triggers bounce service weekly (Sun 04:00 + jitter) |

The bounce timer mitigates Bun's long-uptime memory drift ([OQ#2](./ROADMAP.md#oq2-bun-memory)) without a hard schedule — `Persistent=true` so a missed window catches up on next boot, `RandomizedDelaySec=300` to avoid thundering herd if multiple hosts share the schedule.

### Install

```sh
# 1. Stage the source on the host
sudo install -d -o solrac -g solrac /opt/solrac
sudo -u solrac git clone https://github.com/cjus/solrac.git /opt/solrac
sudo -u solrac --preserve-env=PATH bash -c 'cd /opt/solrac && npm install'

# 2. Stage env (mode 600, owner solrac:solrac)
sudo install -m 600 -o solrac -g solrac /opt/solrac/.env /etc/solrac/solrac.env

# 3. Install systemd units
sudo cp /opt/solrac/deploy/systemd/*.service /etc/systemd/system/
sudo cp /opt/solrac/deploy/systemd/*.timer  /etc/systemd/system/
sudo systemctl daemon-reload

# 4. Enable + start
sudo systemctl enable --now solrac.service
sudo systemctl enable --now solrac-bounce.timer
```

### Verify

```sh
systemctl status solrac.service
systemctl list-timers solrac-bounce.timer
journalctl -u solrac.service -f
```

### `solrac.service` highlights

```ini
Type=simple
Restart=on-failure
RestartSec=2
KillSignal=SIGTERM
TimeoutStopSec=90

NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/opt/solrac/data
```

- `Type=simple` — Bun stays in foreground; systemd manages the process directly.
- `Restart=on-failure` — only restarts on non-zero exit. Clean drains (`exit 0`) stay down until you explicitly `systemctl restart`. Use that semantic intentionally: if you want a bounce, do it from outside the unit.
- `TimeoutStopSec=90` — pairs with lifecycle's 60s drain budget; 30s of slack before SIGKILL.
- `ReadWritePaths` — sqlite + WAL + PID file + workspaces all live under `data/`. Everything else is read-only or denied via `ProtectSystem=strict`.

### Customizing paths

The unit assumes:

| Field | Value | If you need to change |
|-------|-------|------------------------|
| `User=` / `Group=` | `solrac` | Edit unit and `daemon-reload` |
| `WorkingDirectory=` | `/opt/solrac` | Edit unit |
| `EnvironmentFile=` | `/etc/solrac/solrac.env` | Edit unit |
| `ExecStart=` | `/usr/local/bin/bun run src/main.ts` | Edit if Bun's not at that path |
| `ReadWritePaths=` | `/opt/solrac/data` | Must include your `DATA_DIR` |

`SOUL.md` and `SOLRAC.md` are read from `WorkingDirectory=`. The repository ships both files at the repo root, so when you deploy from the repo (the shipped systemd unit's `WorkingDirectory=/opt/solrac`) the files are already in place and Solrac's first-boot bootstrap finds them — no write needed. The shipped unit's `ProtectSystem=strict` + `ReadWritePaths=…/data` keeps `WorkingDirectory` read-only at runtime, which is fine because no copy fires.

To customize the persona on a deployed host:

1. Edit `/opt/solrac/SOUL.md` and/or `/opt/solrac/SOLRAC.md` as root (or temporarily relax permissions).
2. For `SOUL.md` changes, `systemctl restart solrac.service` (read at boot only).
3. For `SOLRAC.md` changes, do nothing — the next message picks up the edit (re-read per turn).

If your deployment shape uses a **different** `WorkingDirectory` that doesn't already contain the two files (e.g., a packaged binary), you must add that directory to `ReadWritePaths=` so the first-boot bootstrap can create the templates there, OR pre-populate it during install.

For the full install README, see `deploy/systemd/README.md`.

---

## `/health` and `/stats`

`Bun.serve` exposes two routes on `PORT` (default 8443).

### `/health` — public

```sh
curl http://localhost:8443/health
# {"ok":true,"uptime":123.456}
```

No auth, no secrets. Use for liveness probes (k8s, load balancer, uptime monitor).

### `/stats` — bearer-gated

Returns counters useful for tracking the health of the bot. Three response codes:

| Status | Meaning |
|--------|---------|
| 200 | success — body is JSON |
| 401 | bearer token is set but the request didn't match (or no `Authorization` header) |
| 503 | bearer token is **not** configured at all (`STATS_BEARER_TOKEN` unset) |

The 503 is intentional: an absent bearer token means stats are explicitly disabled, not "unauthorized." Don't grep for 401s without distinguishing.

### Enable

```sh
# .env
STATS_BEARER_TOKEN=$(openssl rand -hex 32)
```

Restart Solrac.

### Use

```sh
TOKEN=$(grep STATS_BEARER_TOKEN /etc/solrac/solrac.env | cut -d= -f2)
curl -H "Authorization: Bearer $TOKEN" http://localhost:8443/stats
```

Response shape:

```json
{
  "rss": 134217728,
  "uptime": 86400.5,
  "pendingTurns": 1,
  "inFlight": 1,
  "waiting": 0,
  "spend24hUsd": 12.4231
}
```

| Field | Meaning |
|-------|---------|
| `rss` | Resident set size in bytes (host process memory) |
| `uptime` | Seconds since `solrac.boot` |
| `pendingTurns` | Tracker count: turns the queue knows about (waiting + in-flight) |
| `inFlight` | Semaphore inFlight: turns currently running |
| `waiting` | Semaphore waiting: turns blocked on the global slot |
| `spend24hUsd` | Sum of `cost_usd` across all `audit` rows started in last 24h |

### Constant-time compare

`server.ts::authorizeBearer` uses `node:crypto.timingSafeEqual` with a length check first to prevent timing-based length oracle. Don't replace with naive `===`.

---

## Daily cost report

Cron in `daily-report.ts`. On boot and every 24h thereafter, sends an HTML message to the first allowlist entry:

```
solrac · daily cost report (2026-04-27)
Total: $4.2103 across 3 chat(s)

· chat 100200300: $2.1042 (12 turns)
· chat 400500600: $1.8921 (8 turns)
· chat 700800900: $0.2140 (3 turns)
```

If yesterday saw zero turns:

```
solrac · daily cost report (2026-04-27)
No billable activity.
```

### Idempotency

The function is keyed off `meta.cost_report_last_date` (UTC date string). Once it's set to today's UTC date, subsequent calls within the same UTC day are no-ops. So:

- Process restarts mid-day → next tick is a no-op, no double-send.
- Process down at midnight → the boot-fire on next start catches up.
- Send fails (network drop) → meta key is **not** advanced; next tick retries.

### Disabling

The cron only starts when `config.allowlistBootstrap.length > 0`. To suppress reports without restarting, manually set `meta.cost_report_last_date` to a future-dated string:

```sh
sqlite3 data/solrac.sqlite \
  "INSERT OR REPLACE INTO meta(key, value, updated_at) VALUES ('cost_report_last_date', '9999-12-31', strftime('%s', 'now') * 1000)"
```

Removing the row or setting an empty value re-arms it for the next 24h tick.

### Manual fire

Currently no command — restart the process and the boot-fire will run if today's date doesn't match the meta key. (Add a `--report-now` CLI flag if this becomes a real need.)

---

## Log events

`log.ts` emits JSON. `info`/`debug` go to stdout, `warn`/`error` to stderr. systemd captures both via `StandardOutput=journal` / `StandardError=journal`.

Canonical event names:

### Boot
- `solrac.boot` — config summary; once per process
- `instance.soul_md_created` — first-boot only; default `SOUL.md` copied into launch cwd
- `instance.solrac_md_created` — first-boot only; default `SOLRAC.md` copied into launch cwd
- `instance.soul_load_failed` — fatal; SOUL.md missing or empty, **process exits 1**
- `db.opened` — sqlite path
- `pidfile.acquired` — successful PID write
- `pidfile.stale` — old PID was dead, unlinked
- `server.listening` — `/health` + `/stats` ready

### Polling
- `poll.start` — long-poll loop entered (with offset)
- `poll.aborted` — graceful exit from lifecycle
- `poll.error` — non-fatal getUpdates error (logged, retry after 1s)
- `poll.conflict` — 409 from Telegram, **process exits 1**
- `poll.handler_error` — handler throw (caught, logged, offset still advances)
- `update.received` — every update entering the loop
- `update.dedup` — `update_id` already in `handled_updates`

### Gating
- `update.no_from` — update lacked a `from` field
- `update.denied_unallowlisted` — `from.id` not in allowlist; audit row written
- `update.denied_throttled` — denial throttle skipped the audit write
- `update.dropped_queue_full` — chat's queue at depth cap

### Turn lifecycle
- `turn.start` — main.ts's per-allowed-update line
- `turn.done` — main.ts's wrap-up
- `turn.error` — queue's catch around `runTurn`

### Agent (Claude path)
- `agent.tool_use` — every tool call surfaced from the SDK
- `agent.tool_allow_all` — fallback when no `canUseTool` configured (test only)
- `agent.stub_send_failed` — couldn't send the 🤔 stub (network drop)
- `agent.edit_throttled` — edit failed (usually 400, already handled)
- `agent.edit_final_failed` — final edit failed
- `agent.error` — SDK threw
- `agent.loop_detected` — PreToolUse hook saw 3rd identical call
- `agent.oob_ollama_injected` — cross-engine bridge injected N Ollama turns into the user prompt (only fires when there are out-of-band Ollama exchanges since the last successful Claude turn)
- `agent.done` — per-turn summary (cost, turns, isError)

### Ollama (`>` prefix path)
- `ollama.stub_send_failed` — couldn't send the 🦙 stub
- `ollama.bad_frame` — NDJSON parse failure on a stream chunk (logged, line skipped, stream continues)
- `ollama.fetch_failed` — fetch to `OLLAMA_URL` threw (unreachable, abort/timeout, etc.)
- `ollama.edit_throttled` / `ollama.edit_final_failed` — Telegram edit failures
- `ollama.final_send_failed` — final fallback send (when the stub creation itself failed earlier)
- `ollama.disabled_ack_failed` / `ollama.usage_ack_failed` — couldn't reply with the disabled / usage hint
- `ollama.done` — per-turn summary (model, elapsedSec, inputTokens, outputTokens, isError)

### Policy
- `policy.auto_allow` — classifier returned allow
- `policy.auto_deny` — classifier returned deny
- `policy.confirm_request` — confirm prompt sent to user
- `policy.confirm_resolved` — user tapped or timed out
- `policy.confirm_send_failed` — couldn't send the inline keyboard; failed closed
- `policy.confirm_timeout` — broker's 60s timer fired
- `policy.cost_cap_exceeded` — PreToolUse denied due to cap

### Callback handling
- `callback.ack_failed` — couldn't dismiss the inline-keyboard spinner
- `callback.strip_keyboard_failed` — couldn't edit the prompt to remove the keyboard

### Lifecycle
- `shutdown.start` — signal received
- `shutdown.duplicate` — second signal during shutdown (no-op)
- `shutdown.server_stopped` — `Bun.serve` closed
- `shutdown.server_stop_failed` — server.stop() threw (logged, continued)
- `shutdown.drained` — tracker reached 0 within timeout
- `shutdown.drain_timeout` — tracker still > 0 at deadline
- `shutdown.wal_checkpointed` / `shutdown.wal_checkpoint_failed`
- `shutdown.db_closed` / `shutdown.db_close_failed`
- `shutdown.pidfile_removed` / `shutdown.pidfile_remove_failed`
- `shutdown.done` — final line; includes `timedOut` boolean

### Cost report
- `cost_report.sent` — DM dispatched, meta key advanced
- `cost_report.send_failed` — telegram error; meta key unchanged
- `cost_report.error` — uncaught throw (rare)

### Tracing examples

A single turn end-to-end:

```sh
journalctl -u solrac.service -o cat | jq -c 'select(.update_id == 12345)'
```

All denies in the last hour:

```sh
journalctl -u solrac.service --since '1 hour ago' -o cat \
  | jq -c 'select(.msg | startswith("policy.") and contains("deny"))'
```

Cost-cap hits:

```sh
journalctl -u solrac.service --since today -o cat \
  | jq -c 'select(.msg == "policy.cost_cap_exceeded")'
```

---

## Audit queries

`audit` is the source of truth for "what did the bot do?" Useful queries:

### Today's spend per chat

```sql
SELECT chat_id, COUNT(*) AS turns, ROUND(SUM(cost_usd), 4) AS spent
FROM audit
WHERE started_at >= strftime('%s', 'now', 'start of day') * 1000
GROUP BY chat_id
ORDER BY spent DESC;
```

### Engine breakdown for a chat

`audit.model` distinguishes engines: `'claude'` for the SDK path, `'ollama:<name>'` for the `>` prefix path, `'system'` for queue-full / denial rows that predate engine selection.

```sql
SELECT model, COUNT(*) AS turns,
       ROUND(SUM(cost_usd), 4) AS spent,
       SUM(input_tokens) AS in_toks,
       SUM(output_tokens) AS out_toks
FROM audit
WHERE chat_id = <chatId>
  AND started_at >= strftime('%s', 'now', '-7 days') * 1000
GROUP BY model
ORDER BY turns DESC;
```

### Recent Ollama turns (across all chats)

```sql
SELECT id, chat_id, datetime(started_at/1000, 'unixepoch') AS started,
       model, status, input_tokens, output_tokens,
       SUBSTR(prompt, 1, 60) AS prompt_head
FROM audit
WHERE model LIKE 'ollama:%'
ORDER BY id DESC
LIMIT 20;
```

### Turns that cost more than $0.50

```sql
SELECT id, chat_id, datetime(started_at/1000, 'unixepoch') AS started,
       ROUND(cost_usd, 4) AS cost, status, error_message
FROM audit
WHERE cost_usd > 0.50
ORDER BY cost_usd DESC
LIMIT 20;
```

### All denied turns

```sql
SELECT id, datetime(started_at/1000, 'unixepoch') AS started,
       from_id, chat_id, error_message
FROM audit
WHERE status = 'denied'
ORDER BY started_at DESC
LIMIT 20;
```

### Policy-deny rate (cost cap, loop, user-deny)

```sql
SELECT
  CASE
    WHEN error_message LIKE 'policy_deny: cost cap%' THEN 'cost_cap'
    WHEN error_message LIKE 'policy_deny: loop_detected%' THEN 'loop'
    WHEN error_message LIKE 'policy_deny: user denied%' THEN 'user_deny'
    WHEN error_message LIKE 'policy_deny: user did not respond%' THEN 'timeout'
    ELSE 'other'
  END AS deny_type,
  COUNT(*) AS n
FROM audit
WHERE error_message LIKE 'policy_deny:%'
GROUP BY deny_type
ORDER BY n DESC;
```

### Tool-use frequency

```sql
WITH tools AS (
  SELECT json_extract(value, '$.name') AS tool_name
  FROM audit, json_each(audit.tool_calls)
  WHERE tool_calls IS NOT NULL
)
SELECT tool_name, COUNT(*) AS n
FROM tools
GROUP BY tool_name
ORDER BY n DESC
LIMIT 20;
```

### Turns by token usage

```sql
SELECT id, chat_id, ROUND(cost_usd, 4) AS cost,
       input_tokens, output_tokens,
       CAST(input_tokens AS REAL) / NULLIF(output_tokens, 0) AS in_to_out_ratio
FROM audit
WHERE input_tokens IS NOT NULL
ORDER BY input_tokens DESC
LIMIT 10;
```

A high `in_to_out_ratio` (>20) usually means the agent is reading a lot and replying tersely — unusual context bloat to investigate.

### Sessions table sanity check

```sql
SELECT chat_id,
       agent_session_id,
       datetime(updated_at/1000, 'unixepoch') AS last_used
FROM sessions
ORDER BY updated_at DESC;
```

---

## Workspace inspection

Per-chat workspaces live at `<DATA_DIR>/workspaces/<chatId>/`. They accumulate files from `Write`, `Edit`, and `Bash` calls.

### Inventory

```sh
du -sh data/workspaces/*/ 2>/dev/null | sort -h
```

### Recent activity

```sh
find data/workspaces/ -type f -mtime -1
```

### Manual cleanup

There's no janitor in v1 ([OQ#4](./ROADMAP.md#oq4-workspace-janitor)). To prune stale workspaces by hand:

```sh
# Anything not touched in 30 days
find data/workspaces/ -mindepth 1 -maxdepth 1 -type d -mtime +30 -exec rm -rf {} +
```

Be careful — agents may have left git checkouts or partially-edited files. If you're unsure, list first.

---

## Backup and restore

The single source of truth is `data/solrac.sqlite` (plus `solrac.sqlite-wal` and `solrac.sqlite-shm` while running).

### Online backup (running process)

`sqlite3` supports backup via the online API:

```sh
sqlite3 data/solrac.sqlite ".backup /var/backups/solrac-$(date +%F).sqlite"
```

This copies a consistent snapshot without locking writers out (WAL mode handles concurrency).

### Offline backup (graceful shutdown first)

```sh
systemctl stop solrac.service        # drains, checkpoints WAL, closes db
cp data/solrac.sqlite /var/backups/solrac-$(date +%F).sqlite
systemctl start solrac.service
```

After a clean shutdown, the WAL and SHM files are absorbed into the main `.sqlite` file via `wal_checkpoint(TRUNCATE)`. Backing up just the `.sqlite` file is enough — but only if the process exited cleanly.

### Restore

Stop the service, copy the backup over, restart:

```sh
systemctl stop solrac.service
cp /var/backups/solrac-2026-04-26.sqlite data/solrac.sqlite
rm -f data/solrac.sqlite-{wal,shm}
systemctl start solrac.service
```

The bot will resume sessions from the backup snapshot. Updates received between the backup and the restore are lost — they were claimed in `handled_updates` of the running db, but the old offset in the backup `meta.poll_offset` will get re-fetched from Telegram (with up to ~1 day of buffered updates available) and re-claimed.

### Backup cadence

- **Daily.** Cost-attribution disputes are usually within a week.
- **30 day retention.** sqlite + WAL is small (a few MB even after months); rotate weekly.
- **Off-host.** A backup on the same disk doesn't survive a host loss.

---

## Observability checklist

Things to watch over time:

| Metric | Where | Healthy | Alarm at |
|--------|-------|---------|----------|
| `rss` (RSS bytes) | `/stats` | <500 MB | >2 GB; bounce expected weekly anyway |
| `pendingTurns` | `/stats` | <5 | >20 — queue backed up |
| `spend24hUsd` | `/stats` | per your budget | >2x daily mean |
| `audit` rows/day | sqlite | tens to low hundreds | sustained thousands → flooder |
| `policy.cost_cap_exceeded` rate | logs | <1/day | >5/day → cap tuning needed |
| `policy.confirm_timeout` rate | logs | rare | regular → user not engaged with bot |
| `poll.error` rate | logs | <1/hr | sustained → network or API problem |
| `poll.conflict` | logs | never | any → another instance running |

A simple bash + cron loop hitting `/stats` and tee'ing to a log is enough for v1. Push to Prometheus/Datadog when load justifies.

---

## Related docs

- [RUNBOOK.md](./RUNBOOK.md) — incident recovery playbook
- [ARCHITECTURE.md](./ARCHITECTURE.md) — why each defense exists
- [CONFIG.md](./CONFIG.md) — env var reference
- [USAGE.md](./USAGE.md) — what users see
- `deploy/systemd/README.md` — install instructions in source tree
