# Runbook

Incident recovery procedures. Each scenario has **symptoms → diagnosis → recovery → prevention**, in the order you need them at 2am.

For day-to-day operations, see [OPERATIONS.md](./OPERATIONS.md).

## Index

- [409 Conflict (two pollers fighting)](#409-conflict)
- [Queue full, please slow down](#queue-full)
- [Bot silent, no error in logs](#bot-silent-no-error)
- [Drain timeout on shutdown](#drain-timeout)
- [Runaway cost (cap not firing)](#runaway-cost)
- [DB corruption / lock errors](#db-corruption)
- [OOM kill / runaway memory](#oom)
- [Zombie poller / stale PID](#zombie-poller)
- [Lost messages / dedupe blocks legit updates](#lost-messages)
- [Confirmation prompt never arrives](#confirm-no-prompt)
- [Confirmation prompt arrives but tap does nothing](#confirm-tap-noop)
- [Subprocess inheriting wrong env](#subprocess-env)
- [Network drops during long-poll](#network-drops)
- [Cost report never arrives](#cost-report-missing)
- [Bot replies stale / out of date](#stale-replies)
- [Ollama errors (default engine path post PR-B)](#ollama-errors)
- [Web UI not reachable / login won't take](#web-ui-issues)
- [Web UI streaming silent / messages don't appear](#web-ui-stream-silent)

---

## 409 Conflict

### Symptoms

- Bot stops processing updates.
- `journalctl -u solrac.service` shows: `{"level":"error","msg":"poll.conflict","description":"terminated by other getUpdates request..."}`.
- systemd reports `Active: failed (Result: exit-code)`.
- After 5 restarts in 5 minutes the unit transitions to `Active: failed (Result: start-limit-hit)` and stops auto-restarting. This is the burst-limit firing (`StartLimitBurst=5`, `StartLimitIntervalSec=300` in the `[Unit]` section of `solrac.service`) — alertable signal that something needs hands-on attention.

### Diagnosis

Telegram permits **only one** `getUpdates` consumer per bot token at a time. A 409 means another process is also calling `getUpdates`. Likely culprits:

1. **A leftover dev process.** Check `ps aux | grep solrac` on every host that's ever run this token.
2. **The official `telegram@claude-plugins-official` plugin.** Look at `~/.claude/settings.json` (or wherever your Claude Code config lives). If it has a Telegram plugin entry using your bot token, that plugin is also polling.
3. **Two solrac instances on different hosts** sharing the same `TELEGRAM_BOT_TOKEN`.
4. **A webhook is registered.** Even if you're using poll mode, a stale webhook URL set via `setWebhook` will compete. Check via the Bot API:

   ```sh
   curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo" | jq
   ```

### Recovery

1. Kill the competing process. For the official plugin, remove the entry from `~/.claude/settings.json` or scrub the env (`agent.ts::sanitizedSubprocessEnv` does this for the SDK subprocess but not for user-level Claude Code outside Solrac).
2. If a webhook is registered, delete it:

   ```sh
   curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/deleteWebhook"
   ```

3. If the unit hit the start-limit (`Active: failed (Result: start-limit-hit)`) you have to clear the failure counter before systemd will retry: `sudo systemctl reset-failed solrac.service`. Then restart:

   ```sh
   sudo systemctl reset-failed solrac.service
   sudo systemctl restart solrac.service
   ```

   On a normal `on-failure` failure (not start-limit-hit) the plain restart works:

   ```sh
   sudo systemctl restart solrac.service
   ```

### Prevention

- One bot token per environment. Mint a `solrac-dev` and `solrac-prod` separately via BotFather.
- Don't reuse tokens across plugins. The official Claude Code Telegram plugin is fine for general Claude Code use; just don't attach it to the bot Solrac is using.
- The 409-fast-exit (`process.exit(1)` in `poll.ts`) is intentional: it lets systemd restart and clean up the PID file via stale-PID detection on the next boot. The 5-restarts-in-5-minutes burst cap exists so a permanent 409 (the *other* consumer is also Solrac-shaped) surfaces as a failed unit instead of an infinite log spam.

---

## Queue full

### Symptoms

- User sends a message → bot replies `queue full, please slow down` (no 🤔 stub, no agent run).
- `journalctl -u solrac.service | grep dropped_queue_full` shows entries with `update_id`, `chat_id`, `from_id`, `depth`.
- Audit row exists with `status='error'` and `error_message='queue_full'`.

### Diagnosis

The per-chat queue depth cap (`MAX_CHAT_QUEUE_DEPTH`, default `10`) fired. One chat has ≥10 turns chained on the per-chat mutex (running + waiting). Subsequent updates from that chat get dropped with the ack, an audit row, and a `update.dropped_queue_full` warn log.

Common causes:

1. **User pasted a long script.** Each newline-separated chunk became its own message and queued. Wait for the chain to drain or `/clear` the chat to abandon.
2. **An agent turn is genuinely stuck** (slow tool, large prompt, network issue). Check the topmost `audit` row for the chat with `status='in_progress'` — that's the head of the chain blocking the queue. See [Drain timeout](#drain-timeout) for stuck-turn recovery.
3. **The cap is mis-tuned.** If legitimate paste-heavy usage frequently hits the cap, raise `MAX_CHAT_QUEUE_DEPTH` in `config.ts` (it's a constant today, not env — change cautiously since memory grows linearly with the cap).

### Recovery

1. Wait for the chain to drain (check `/stats` `pendingTurns` falling).
2. If a turn is stuck > 60s, see [Drain timeout](#drain-timeout).
3. The drop is **not** retried automatically — the user must resend the dropped message after the queue clears.

### Prevention

- The 10-deep cap is an upper bound; if your usage routinely chains 5+ turns per chat, the agent's per-turn cost cap (`HOURLY_COST_CAP_USD`) is probably the dominant safety. Document that `queue_full` is "you sent faster than the agent can answer," not "the bot is broken."
- The ack is intentionally generic — don't include depth or other counters; an attacker on the allowlist could use it as a side-channel into queue state.

---

## Bot silent, no error

### Symptoms

- Send a message → no reply, no 🤔 stub, nothing.
- `/health` returns 200, `/stats` looks normal.
- No errors in logs.

### Diagnosis

Check the audit log:

```sh
sqlite3 data/solrac.sqlite \
  "SELECT id, from_id, chat_id, status, error_message FROM audit ORDER BY id DESC LIMIT 5"
```

If the latest row has `status='denied'` and `error_message='from_id not in allowlist'`, your `from.id` isn't in the allowlist.

If there's no row at all, the update didn't reach the handler — either the bot isn't polling (check `poll.start` log) or Telegram itself is delivering to a different bot token.

If there's a row with `error_message='queue_full'`, you're hitting `MAX_CHAT_QUEUE_DEPTH = 10` — back off.

### Recovery

#### Allowlist mismatch

Find your real `from.id`:

```
DM @userinfobot  → it replies with your Id
```

Compare to the bootstrap list:

```sh
grep ALLOWLIST_BOOTSTRAP /etc/solrac/solrac.env
```

If they differ, fix `.env` and restart. Or insert directly without restart:

```sh
sqlite3 data/solrac.sqlite \
  "INSERT OR IGNORE INTO allowlist(user_id, added_at) VALUES (<your-from-id>, strftime('%s','now')*1000)"
```

(The bootstrap rebuilds the table at boot; either add to env *and* restart, or insert manually as a one-off.)

#### Wrong bot

Verify you're talking to the bot whose token Solrac has. From Telegram, type `/<bot_username>` in the search bar; you should see exactly the bot you minted at BotFather.

### Prevention

- Audit row on denial is the canonical "I rejected you" signal. Always check it before assuming bugs.
- The `update.denied_unallowlisted` log line carries `from_id` — easy grep target.

---

## Drain timeout

### Symptoms

- `systemctl stop solrac.service` takes >60s.
- Log line: `{"level":"error","msg":"shutdown.drain_timeout","drainTimeoutMs":60000,"inFlight":2}`.
- Process exits with code 1 (treated as failure → systemd restarts).

### Diagnosis

A turn was still running when SIGTERM hit, and it didn't finish within 60s. Common causes:

1. **An MCP server hung the SDK.** Some MCP servers don't honor cancellation; the agent's `query()` blocks waiting for a tool that never returns.
2. **A long-running `Bash` call.** A confirmed `Bash` doing a 90-second build won't be interrupted.
3. **A network call to a slow API** that doesn't respond to abort.

### Recovery

If exit code 1 → systemd restarts → drain handler runs again on the new process eventually. The PID file is cleaned via stale-PID detection on next boot.

If you need to bring down faster, send SIGKILL:

```sh
sudo systemctl kill --signal=SIGKILL solrac.service
```

Risk: any in-flight database transaction is lost (`audit.status='in_progress'` for the current turn never updates). Use sparingly.

### Prevention

- Audit which tools your turns commonly invoke. If a Bash command takes >60s, you can either:
  - Raise `drainTimeoutMs` in `lifecycle.ts::installShutdown` (and `TimeoutStopSec` in the systemd unit accordingly).
  - Reject those commands at the policy layer.
- Watch `audit` for turns where `ended_at - started_at > 60_000` — those are at-risk if they happen during a planned restart.

---

## Runaway cost

### Symptoms

- `/stats` `spend24hUsd` jumps to a multiple of expected.
- One chat shows extremely high turn count or cost in the daily report.
- An audit row has `cost_usd` of several dollars.

### Diagnosis

Check for cost cap firing:

```sh
sqlite3 data/solrac.sqlite \
  "SELECT id, chat_id, cost_usd, error_message
   FROM audit
   WHERE error_message LIKE 'policy_deny: cost cap%'
   ORDER BY started_at DESC LIMIT 5"
```

If the cap is firing, the per-turn extra spend is bounded by one tool call — you'll see `policy_deny: cost cap reached: $X ≥ $1.00/hr`.

If the cap isn't firing on a turn over $5, possible causes:

1. **First turn of the hour was big.** The cap is `>=` after the turn. A single $5 turn can overshoot if no prior history exists in the trailing 60 minutes.
2. **`HOURLY_COST_CAP_USD` is set higher than expected.** Check `.env`.
3. **Tool deny went via `canUseTool` and got swallowed before audit captured the event.** Look for `policy.cost_cap_exceeded` log line — that's the PreToolUse hook firing.

### Recovery

Immediate stop:

```sh
sudo systemctl stop solrac.service
```

Identify the turn:

```sh
sqlite3 data/solrac.sqlite \
  "SELECT id, chat_id, prompt, tool_calls, cost_usd, status, error_message
   FROM audit
   WHERE cost_usd > 1.00
   ORDER BY started_at DESC LIMIT 5"
```

Decide whether to remove the chat's session (forces a fresh context next message):

```sh
sqlite3 data/solrac.sqlite \
  "DELETE FROM sessions WHERE chat_id = <chat>"
```

Resume:

```sh
sudo systemctl start solrac.service
```

### Prevention

- Lower `HOURLY_COST_CAP_USD` for production until usage stabilizes.
- The PreToolUse hook fires for every tool, including SDK-auto-approved ones. As long as the hook is configured (set in `agent.ts`), every tool call consults the cap before running.
- Daily report DM is your post-hoc alarm. Don't ignore it.
- See [OQ#5](./ROADMAP.md#oq5-cost-surprises-beyond-anthropic) for "cost surprises beyond Anthropic" — paid third-party CLIs are auto-denied at the bash layer (`claude`/`openai`/`replicate`/`anthropic`) but anything else is on you.

---

## DB corruption

### Symptoms

- `sqlite3` errors: `database disk image is malformed`, `database is locked`, `unable to open database file`.
- Process refuses to boot: `db.opened` log line absent.

### Diagnosis

```sh
sqlite3 data/solrac.sqlite "PRAGMA integrity_check;"
```

`ok` → fine. Any other output → corruption.

Common root causes:
1. SIGKILL during a write (rare with WAL).
2. Disk failure on the data volume.
3. Filesystem corruption (e.g. unsafe shutdown of host).

### Recovery

#### If integrity check is `ok` but you're getting "database is locked"

Another process is holding a write lock. Find it:

```sh
fuser data/solrac.sqlite
fuser data/solrac.sqlite-wal
```

Kill any unexpected processes. The most common cause is a manual `sqlite3` shell that's still inside a transaction.

#### If integrity check fails

Try to dump and rebuild:

```sh
sqlite3 data/solrac.sqlite ".dump" > /tmp/solrac.sql
sqlite3 /tmp/solrac.new.sqlite < /tmp/solrac.sql
sqlite3 /tmp/solrac.new.sqlite "PRAGMA integrity_check;"  # should be ok
mv data/solrac.sqlite data/solrac.sqlite.broken
mv /tmp/solrac.new.sqlite data/solrac.sqlite
rm -f data/solrac.sqlite-{wal,shm}
sudo systemctl start solrac.service
```

If `.dump` itself fails, you've lost data — restore from the most recent backup (see [OPERATIONS.md#backup-and-restore](./OPERATIONS.md#backup-and-restore)).

### Prevention

- Daily backups (see OPERATIONS.md).
- Don't `kill -9` the process — drain via SIGTERM checkpoints WAL into the main file safely.
- Run on a filesystem with journaling (ext4, xfs, zfs). Avoid network filesystems for `DATA_DIR`.

---

## OOM

### Symptoms

- Bot vanishes mid-turn, `/health` returns connection-refused.
- `journalctl -k | grep -i 'oom\|killed'` shows the kernel OOM-killed the process.
- systemd reports `Active: failed (Result: signal/9)`.

### Diagnosis

Bun's memory profile:

- Steady-state RSS for an idle Solrac is typically 50–150 MB.
- Each in-flight turn adds ~10–30 MB (SDK subprocess + buffers).
- Long-uptime processes drift up; weekly bounce mitigates.

If RSS is climbing without bound, possible causes:

1. **`/stats` snapshot leaking handles.** Unlikely — the handler is pure.
2. **The SDK subprocess accumulating across turns.** Check `ps -eo pid,rss,cmd | grep claude`. Each turn should leave no claude subprocess after it ends.
3. **A leaked workspace file handle.** The `Bash` tool in the SDK preset usually cleans up; rare custom MCP servers might not.
4. **Bun internal drift.** Real but slow; usually months, not days.

Watch with:

```sh
watch -n 60 'ps -p $(pgrep -f solrac.ts) -o rss,vsz | tail -1'
```

### Recovery

Restart:

```sh
sudo systemctl restart solrac.service
```

If the kernel killed it, systemd already restarted (`Restart=on-failure`).

Audit rows for the in-flight turn at OOM time will be left at `status='in_progress'` forever. Clean them:

```sql
UPDATE audit
SET status = 'error', error_message = 'OOM kill', ended_at = strftime('%s','now')*1000
WHERE status = 'in_progress';
```

(Run this only after confirming the process actually died — don't run while Solrac is up; you'd corrupt a real in-progress row.)

### Prevention

- Weekly bounce timer (`solrac-bounce.timer`) — already on.
- Watch `rss` in `/stats`. If RSS exceeds 1 GB, restart proactively.
- Cap host memory via systemd: add `MemoryMax=2G` to `solrac.service`. systemd will SIGTERM (then SIGKILL after `TimeoutStopSec=90`) before the kernel does.

---

## Zombie poller

### Symptoms

- Solrac refuses to boot: `Error: another solrac instance is running (pid=12345, ./data/solrac.pid)`.
- `ps aux | grep 12345` shows no such process.

### Diagnosis

Stale PID file. The process died without clean shutdown — SIGKILL, panic, OOM. The PID file wasn't removed because lifecycle never ran. The next boot's stale-PID detection in `poll.ts::acquirePidFile` should catch this:

```ts
if (Number.isInteger(oldPid) && oldPid > 0 && isAlive(oldPid)) {
  throw …  // refuses to start
}
log.warn("pidfile.stale", …)
unlinkSync(pidPath)  // unlinks
```

So if Solrac is **failing**, that means `isAlive(oldPid)` returned true. Either:

1. There's actually a process at PID 12345 that isn't solrac (PID reuse).
2. The PID file is being read on a network mount that's stale.

### Recovery

Inspect the PID file:

```sh
cat data/solrac.pid
```

Check if that PID is running:

```sh
ps -p $(cat data/solrac.pid) -o pid,comm
```

If it's not solrac (or doesn't exist), force-remove:

```sh
rm data/solrac.pid
sudo systemctl start solrac.service
```

If it *is* solrac, you have two pollers. See [409 Conflict](#409-conflict).

### Prevention

- The lifecycle handler removes the PID file on graceful shutdown. Anything that bypasses lifecycle (SIGKILL, kernel panic, host crash) leaves the file.
- Stale-PID detection handles 99% of these — investigate any case where it doesn't.

---

## Lost messages

### Symptoms

- A user says "I sent a message; the bot didn't reply." Audit log has no row for it.
- Or: a known-good update id is missing from `audit` and `handled_updates`.

### Diagnosis

Walk the path:

1. **Did the update reach Telegram?** Hard to verify without the user resending; assume yes if they swear they sent it.
2. **Did the poll loop see it?** Look for `update.received` with that `update_id`:

   ```sh
   journalctl -u solrac.service -o cat | jq -c 'select(.update_id == 12345)'
   ```

   If absent, the loop never got it — see [Network drops](#network-drops) or check `poll.error`.

3. **Was the update claimed?**

   ```sql
   SELECT * FROM handled_updates WHERE update_id = 12345;
   ```

   If absent: the loop saw it but didn't claim it (logically impossible; check for a partial DB write or restore). If present: see step 4.

4. **Did the handler run?** Look for `turn.start`, `update.denied_unallowlisted`, etc. If only `update.received` appears, the handler short-circuited — most likely on `update.no_from` (channel post or service message).

### Recovery

If the update is in `handled_updates` but not `audit`, the handler probably hit `update.no_from`. There's no recovery; the message wasn't a user message Solrac understands.

If the update never made it to `update.received`, it's lost — Telegram retains buffered updates for ~24 hours but if the bot was down longer, they're gone.

### Prevention

- Don't manually delete `handled_updates` rows. They're load-bearing for idempotency.
- Watch `poll.error` rate (alarms in [OPERATIONS.md](./OPERATIONS.md#observability-checklist)).

---

## Confirm no prompt

### Symptoms

- The bot starts a turn (🤔 thinking…), then silence. No allow/deny keyboard.
- The audit row stays `status='in_progress'` for >60s, then either resolves to `status='ok'` (deny via timeout) or sits indefinitely.

### Diagnosis

The broker tried to send the inline-keyboard message and failed. Look for `policy.confirm_send_failed`:

```sh
journalctl -u solrac.service -o cat | jq 'select(.msg == "policy.confirm_send_failed")'
```

Common causes:

1. **Telegram rate limit** (too many tools in a short span). The tg client retries 429s automatically; if it's failing the retry, something's wrong.
2. **Bot blocked by user.** Telegram returns 403 if the user blocked the bot.
3. **Network outage between host and Telegram API.**

### Recovery

The broker fails-closed: on send failure it resolves to `"deny"` immediately. The SDK gets the deny and the turn either errors out or pivots. The user sees an error footer.

If the broker is silently never resolving (i.e. log shows `policy.confirm_request` but no resolution), there's a bug — file an issue. Workaround: `systemctl restart solrac.service` to clear the in-process broker map.

### Prevention

- Don't block the bot in Telegram. Even temporarily.
- Watch `policy.confirm_send_failed` rate.

---

## Confirm tap noop

### Symptoms

- Inline keyboard appears.
- User taps Allow or Deny.
- Bot never responds; spinner persists.

### Diagnosis

The callback wasn't routed. Possibilities:

1. **The callback data didn't match `cb:<uuid>:a|d`.** Check `dispatchCallbackQuery`'s regex; the data was non-Solrac (e.g. from a different bot).
2. **The broker entry expired between send and tap.** The 60s timeout fired; the keyboard's still there because the strip-keyboard call is post-tap.
3. **`update.denied_unallowlisted` fired on the callback.** The user tapping wasn't the same `from.id` as the original sender.

### Recovery

Tell the user to send their original request again. The expired/foreign tap routes through the "Confirmation expired" branch (broker doesn't have the id), and we edit the prompt to append "— Confirmation expired…".

### Prevention

- Tap within 60 seconds.
- Same user that sent the request must tap.

---

## Subprocess env

### Symptoms

- Logs show "telegram@claude-plugins-official" or another plugin sending Telegram messages.
- 409 Conflict between Solrac and a Claude Code plugin running on the same host.

### Diagnosis

The SDK's `claude` subprocess inherited an env var that our scrubber missed. Read `agent.ts::sanitizedSubprocessEnv()`:

```ts
function sanitizedSubprocessEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("TELEGRAM_")) continue;
    if (key.startsWith("TG_")) continue;
    if (key === "STATS_BEARER_TOKEN") continue;
    if (key === "ALLOWLIST_BOOTSTRAP") continue;
    env[key] = value;
  }
  return env;
}
```

If your env has a non-prefixed Telegram secret (e.g. `BOT_TOKEN` instead of `TELEGRAM_BOT_TOKEN`), it'd leak.

### Recovery

Add the offending var to the scrub list:

```ts
if (key === "BOT_TOKEN") continue;
```

Restart. Verify the sub-plugin is no longer triggered.

### Prevention

- Use the `TELEGRAM_*` and `TG_*` prefixes for any Telegram secret. The scrubber catches them all.
- Don't share `~/.claude/settings.json` plugins that read env between solrac and the rest of Claude Code.
- Document any new operator-only env in [CONFIG.md](./CONFIG.md) and add to `sanitizedSubprocessEnv` in the same PR.

---

## Network drops

### Symptoms

- `poll.error` log lines fire repeatedly.
- Updates are delayed but eventually resolve.
- `/health` works (local network is fine).

### Diagnosis

`tg.getUpdates` is throwing. The error message tells you what:

- `fetch failed` → DNS or TCP-level failure.
- `Telegram 5xx` → Telegram side problem.
- `AbortError` → expected during graceful shutdown; not a problem.

### Recovery

The poll loop sleeps 1s and retries (`Bun.sleep(1000)` in the catch arm). For sustained problems:

```sh
# Verify connectivity to Telegram from the host
curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getMe" | jq
```

If that fails, fix the host's egress (DNS, firewall, IPv6 resolution).

### Prevention

- The poll loop's retry semantics are intentional — Telegram occasionally has minutes of unreachability; we want to grind through, not crash.
- IPv4 fallback on the host if IPv6 to `api.telegram.org` is flaky.
- If you'd rather hard-fail than slow-grind, add an exit-after-N-errors counter in `poll.ts` (currently not implemented).

---

## Cost report missing

### Symptoms

- The expected daily DM didn't arrive.
- `cost_report.sent` log line absent.

### Diagnosis

Several possibilities:

1. **Process was down at the 24h tick** *and* didn't catch up on next boot. Check `meta.cost_report_last_date`:

   ```sql
   SELECT value FROM meta WHERE key = 'cost_report_last_date';
   ```

   If today's date, the report was sent (somewhere). If yesterday's date, the cron didn't fire for some reason.

2. **`config.allowlistBootstrap` is empty.** The cron only starts when there's at least one allowlist entry to DM.

3. **`tg.sendMessage` failed.** Look for `cost_report.send_failed`. Common cause: bot blocked by recipient.

4. **The recipient got it but Telegram didn't notify** (rare).

### Recovery

Manually fire by clearing the meta key and restarting:

```sh
sqlite3 data/solrac.sqlite \
  "DELETE FROM meta WHERE key = 'cost_report_last_date'"
sudo systemctl restart solrac.service
```

The boot-fire on next start will run and send.

### Prevention

- Watch the chat for the report; missing it >2 days warrants a check.
- The cron is idempotent — clearing the meta key is the manual override. Don't worry about double-sends.

---

## Stale replies

### Symptoms

- Bot replies, but the answer references an outdated state of files.
- After editing a file, the agent quotes the old version.

### Diagnosis

This is almost always **stale session context** — the SDK is replaying conversation history, and the agent has cached its earlier file reads in working memory.

### Recovery

Drop the chat's session:

```sh
sqlite3 data/solrac.sqlite \
  "DELETE FROM sessions WHERE chat_id = <chatId>"
```

Send the next message. It'll start a fresh SDK session.

### Prevention

- Tell the agent to re-read files explicitly: "read the latest version of <file> and then…"
- Drop sessions after major file changes.

---

<a id="ollama-errors"></a>

## Ollama errors (default engine path post PR-B)

### Symptoms

User sends a no-prefix message (which routes to Ollama under the PR-B default `SOLRAC_DEFAULT_ENGINE=ollama`) and gets one of:

- `❌ ollama unreachable: http://localhost:11434`
- `❌ ollama model not found: <model> — pull with \`ollama pull <model>\` on the host`
- `❌ ollama timed out after 60s` (or `120s` when `OLLAMA_TOOLS_ENABLED=true`)
- `❌ ollama error: <status> <body>`
- `⚠️ stopped after N tool iterations` (tool-loop didn't converge)
- `ollama disabled in this deployment` (defensive — boot validation should have rejected this; investigate)

### Diagnosis

Each render maps to a distinct cause:

| Render | Cause | Fix |
|--------|-------|-----|
| **unreachable** | Ollama daemon not running on `OLLAMA_URL`, or the URL is wrong, or a firewall/listener mismatch | `ollama serve` (start daemon); confirm `curl -sS $OLLAMA_URL/api/tags` returns JSON. |
| **model not found** | Model name in `OLLAMA_MODEL` isn't in `ollama list` | `ollama pull <model>` on the host. Verify with `ollama list` — the name must match exactly, including any tag (`gemma4:e4b` not `gemma4`). |
| **timed out** | The model took longer than `OLLAMA_TIMEOUT_MS` (default 60s) to finish streaming | Bump `OLLAMA_TIMEOUT_MS` for slow models / cold-start hardware, or pick a smaller model. Stream timing scales with parameter count and quantization. |
| **error: 5xx** | Ollama crashed or ran out of memory mid-request | Check `ollama serve` stderr / system log. Common cause: GPU OOM (a 31B model on a 24GB GPU). Restart Ollama; downsize model. |
| **disabled in this deployment** | Defensive ack — should be unreachable since boot validation throws on `defaultEngine=ollama && !ollamaEnabled`. If you're seeing this, the boot threw a config error and the instance came up in a degraded state, OR you set `defaultEngine=primary/secondary` and somehow the parser still resolved to ollama (file a bug). | Set `OLLAMA_ENABLED=true` and `OLLAMA_MODEL=<name>` in `.env`, restart. See [SETUP.md#2-prerequisites-ollama-daemon--model-recommended](./SETUP.md). |

The audit row also captures these:

```sh
sqlite3 data/solrac.sqlite \
  "SELECT id, status, error_message FROM audit WHERE model LIKE 'ollama:%' AND status = 'error' ORDER BY id DESC LIMIT 10"
```

### Recovery

For most failures, the fix is one of: start Ollama, pull the model, bump timeout, or restart Ollama. None require a Solrac restart — the next message picks up the new state. Solrac re-queries `OLLAMA_URL` on each turn.

If `OLLAMA_MODEL` itself is wrong (typo, deprecated name), you DO need a Solrac restart — `OLLAMA_MODEL` is read at boot. Edit `.env`, restart with `systemctl restart solrac.service` or kill the dev `pnpm dev` process.

If you suspect a deeper Ollama install problem, run the live smoke harness against your local Ollama to isolate:

```sh
OLLAMA_MODEL=<model> npm run smoke:ollama
```

17 phases of streaming/audit/error checks; if those pass, the problem is between Solrac and the Telegram path, not in the Ollama integration itself.

### Prevention

- Pin Ollama to a specific version on prod hosts; new releases occasionally break NDJSON framing or add fields.
- After pulling a new model, run the smoke harness once.
- For the `model not found` class: avoid renaming or removing models on a host without rotating `OLLAMA_MODEL` first.
- Cross-engine context bridge means Claude follow-ups need **a successful Claude turn** before the bridge stops re-injecting older Ollama context. If a Claude turn errors out (cost cap, allowlist, etc.), the next Claude turn will re-inject — that's by design (the failed turn didn't consume the context).

---

<a id="web-ui-issues"></a>

## Web UI not reachable / login won't take

### Symptoms

- Browser shows "connection refused" / "site can't be reached" against `http://<host>:<port>/`.
- Login submits but always returns "invalid token" even with the right value.
- Boot fails with `SOLRAC_WEB_TOKEN is required when SOLRAC_WEB_ENABLED=true`.

### Diagnosis

Check the boot log for the `web.listening` line:

```sh
journalctl -u solrac.service -o cat | jq 'select(.msg == "web.listening")'
# {"msg":"web.listening","host":"127.0.0.1","port":8080,"bound_zero":false}
```

If the line is absent, `SOLRAC_WEB_ENABLED` isn't `true`, or boot validation rejected the config (look earlier in the log for a `config.invalid` event).

| Symptom | Cause | Fix |
|---|---|---|
| Boot exits 1 with `SOLRAC_WEB_TOKEN is required` | Web enabled but token unset | Add `SOLRAC_WEB_TOKEN=$(openssl rand -hex 32)` to `.env`. Required even on `127.0.0.1`. |
| Boot exits 1 with `SOLRAC_WEB_PORT must differ from PORT` | Both vars set to the same port | Pick a distinct port for the web UI (default `8080`; `PORT` is `8443`). |
| `connection refused` from a remote host | `SOLRAC_WEB_HOST=127.0.0.1` (loopback only) | Set `SOLRAC_WEB_HOST=0.0.0.0` to expose; pair with a strong token. |
| Login always says "invalid token" | Mismatch between the value in the form and `.env` | `grep SOLRAC_WEB_TOKEN .env` and confirm. Compare uses constant-time `timingSafeEqual` — no whitespace forgiveness. |
| `web.login_denied` repeatedly in logs | Brute-force or bad bookmark | Rotate the token; restart Solrac (sessions are in-memory, so a restart clears any older cookies). |

### Recovery

Most fixes are an `.env` edit + restart:

```sh
systemctl restart solrac.service
journalctl -u solrac.service -o cat -f | jq 'select(.msg | startswith("web."))'
```

For a forgotten token, regenerate and restart — there's no token-recovery path by design. Operators are sole-user.

### Prevention

- Use `openssl rand -hex 32` (or longer) for the token; nothing shorter.
- Keep `.env` mode 600, owner `solrac:solrac` on prod hosts.
- If exposing on `0.0.0.0`, front with Tailscale or a reverse proxy that adds TLS — Solrac itself is HTTP-only. The cookie has no `Secure` flag because v1 doesn't assume TLS termination.

---

<a id="web-ui-stream-silent"></a>

## Web UI streaming silent / messages don't appear

### Symptoms

- User sends a message in the browser, sees the prompt echoed, but no streaming reply appears.
- Audit row exists for the turn (`status='ok'`, response populated), so the agent ran.
- The conversation reappears correctly after a page reload.

### Diagnosis

Three failure modes:

1. **EventSource disconnected.** Open browser devtools → Network → confirm `/api/stream` is `pending` (live). If it's `closed` or has reconnected loops, an upstream proxy is killing the long-poll. Check the `conn-state` chip in the header: `live` (green) means SSE is healthy; `off` (red) means EventSource gave up.

2. **Bun.serve idle timeout.** Pre-`ec7669a`, Bun's default 10 s `idleTimeout` killed SSE connections silently and turns published while disconnected were lost. Confirm you're running on the post-fix branch:

   ```sh
   git -C /opt/solrac log --oneline | grep -i "idleTimeout"
   ```

   If the fix is missing, pull and restart.

3. **Reverse proxy buffering.** A proxy with response buffering (some default nginx setups) holds the SSE response until it's complete, defeating live streaming. Confirm with:

   ```sh
   curl -N -b /tmp/solrac.cookie http://localhost:8080/api/stream
   ```

   If `: connected` appears immediately but no data flows during a turn, the proxy is buffering. Direct access bypasses the proxy → fixes it.

### Recovery

For (1) reload the browser; EventSource reconnects automatically and re-subscribes to the bus. The conversation history is hydrated from the audit log via `/api/history` — your previous response is recovered.

For (2) restart Solrac on the latest branch.

For (3) on nginx, add to the SSE location block:

```
proxy_buffering off;
proxy_cache off;
proxy_read_timeout 24h;
```

Or front with Caddy / Traefik, both of which handle SSE without explicit config.

### Prevention

- Keep Solrac on the post-`ec7669a` branch (any release after 2026-05-08).
- Document the proxy SSE config alongside the systemd unit when deploying.
- The audit log is the durable record — if a streaming reply was lost, it's still in `audit.response`. Reload restores it.

---

## Related docs

- [OPERATIONS.md](./OPERATIONS.md) — normal ops
- [ARCHITECTURE.md](./ARCHITECTURE.md) — why each defense exists
- [USAGE.md](./USAGE.md) — what users see
- `deploy/systemd/README.md` — install instructions
