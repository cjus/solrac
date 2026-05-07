# Slash Commands Design — PNX-167

Status: design (no code yet)
Owner: carlos@pnxstudios.com
Scope: four user-facing Telegram slash commands — `/clear`, `/compact`, `/status`, `/help`.

---

## 1. Summary

- New `src/commands.ts` module owns parsing + dispatch. `policy.ts` (~770 LOC, see `src/policy.ts:1`) is not touched.
- Slash-command parsing runs **after** allowlist gating + `claimUpdate`, **before** `parseEnginePrefix` engine routing in `makeRunTurn` (`src/main.ts:121`).
- All four commands write a `model='system'` audit row (matches the existing convention for non-engine turns; see `main.ts:293`, `main.ts:332`). `/clear`/`/status`/`/help` finish synchronously with `cost_usd=NULL, status='ok'`. `/compact` runs a real Claude turn so it costs money and counts toward caps.
- `/compact` is **summarize-and-restart**: a one-shot Claude call produces a summary that's persisted in two new `sessions` columns (`<tier>_summary`, `<tier>_summary_at`), the per-tier session id is dropped, and the next user turn for that tier prepends the summary into a fresh SDK session.
- The on-the-next-turn injection is layered ON TOP of the existing OOB bridge (`agent.ts::buildOutOfBandPrompt`, `agent.ts:477`): `[summary] + [OOB block, if any] + [user prompt]`. Both blocks are consumed once and cleared.

---

## 2. Command parser

New file `src/commands.ts`. Pure function — no I/O.

### Signature

```ts
export type SolracCommand =
  | { kind: "clear"; tier: TierArg }
  | { kind: "compact"; tier: TierArgSingle }
  | { kind: "status" }
  | { kind: "help" }
  | { kind: "unknown"; raw: string }
  | { kind: "empty" };               // user typed "/" or "/@bot" alone

export type TierArg = "primary" | "secondary" | "all";   // /clear default = "all"
export type TierArgSingle = "primary" | "secondary";     // /compact default = "primary"

export interface ParseCommandDeps {
  botUsername: string | null;        // cached at boot from getMe(); lowercased
}

export type ParseCommandResult =
  | { isCommand: true; cmd: SolracCommand }
  | { isCommand: false };            // text is not a command; engine routing takes over

export function parseCommand(text: string, deps: ParseCommandDeps): ParseCommandResult;
```

### Recognition rule

A message is a command iff after trimming leading whitespace its first character is `/`. We do **not** accept Telegram's deep-link `start` payload, dotted commands, or any non-leading-slash variant.

### Regex

Single regex, anchored, case-insensitive on the command name only:

```
/^\s*\/([A-Za-z0-9_]{1,32})(?:@([A-Za-z0-9_]{1,32}))?(?:\s+(.+))?\s*$/
```

- Group 1: command name (lowercased before matching).
- Group 2: optional `@bot` suffix (Telegram allows command targeting in groups).
- Group 3: optional argument string (anything after one or more whitespace chars).

Telegram's command syntax allows `[a-z0-9_]` in command names up to 32 chars. The regex follows the same shape; case-insensitivity on the command name is friendly (`/Help` works).

### Group-chat targeting

If group 2 is present, lowercase it and compare to `deps.botUsername` (cached at boot via `tg.getMe()`). If they don't match, return `{ isCommand: false }` — the command targets a different bot and must fall through. (Note: in DMs Telegram clients never include `@bot`. Group chats may or may not include it depending on whether the user picked from autocomplete vs. typed it manually; we accept both.)

If `deps.botUsername` is `null` (boot-time `getMe` failed), accept commands without a `@bot` suffix and treat any `@bot` suffix as a non-match (fail closed — better to misclassify a stray command in a group than to spam another bot's chat).

### Argument parsing — tier flag

For `/clear` and `/compact`, the argument may be `primary` | `secondary` | `all` (`/clear` only) | one of `@`, `!`, `*` (`*` for all in `/clear`). Anything else → reply with usage hint.

| Token | Maps to |
|-------|---------|
| (none) | `/clear` → `all`; `/compact` → `primary` |
| `primary`, `p`, `@` | `primary` |
| `secondary`, `s`, `!` | `secondary` |
| `all`, `*` | `all` (only valid for `/clear`) |

Tokens are case-insensitive, leading whitespace tolerated, single-token only — no quoted args, no flags.

### Edge-case table

| Input | Result | Notes |
|-------|--------|-------|
| `hi` | `{ isCommand: false }` | not a command |
| `   /clear` | `{ kind: "clear", tier: "all" }` | leading whitespace OK |
| `/clear` | `{ kind: "clear", tier: "all" }` | default tier |
| `/clear @` | `{ kind: "clear", tier: "primary" }` | `@` token disambiguates from engine prefix routing |
| `/clear all` | `{ kind: "clear", tier: "all" }` | |
| `/Clear` | `{ kind: "clear", tier: "all" }` | command name case-insensitive |
| `/CLEAR all` | `{ kind: "clear", tier: "all" }` | |
| `/compact` | `{ kind: "compact", tier: "primary" }` | default tier |
| `/compact !` | `{ kind: "compact", tier: "secondary" }` | |
| `/compact all` | `{ kind: "unknown", raw: "/compact all" }` | `all` invalid for compact; usage hint |
| `/clear@solrac_dev_bot` | `{ kind: "clear", tier: "all" }` | matched bot username |
| `/clear@otherbot` | `{ isCommand: false }` | not us; main.ts ignores entirely |
| `/foo` | `{ kind: "unknown", raw: "/foo" }` | reply "Unknown command. Try /help" |
| `/` | `{ kind: "empty" }` | render `/help` body |
| `/ ` | `{ kind: "empty" }` | same |
| `/@solrac_dev_bot` | `{ kind: "empty" }` | matched bot but no command — same as `/` |
| `/@otherbot` | `{ isCommand: false }` | not us |
| `/help extra arg` | `{ kind: "help" }` | extra args ignored for /help and /status |

---

## 3. Dispatch flow

The new branch lives at the very top of `makeRunTurn` (`src/main.ts:121`), after the `msg.text` guard and after `log.info("turn.start", ...)`. Pseudocode:

```ts
function makeRunTurn(deps: RunTurnDeps): (Update) => Promise<void> {
  return async (update) => {
    const msg = update.message;
    if (!msg || !msg.text || !msg.from) {
      log.debug("turn.ignored", { update_id, kind: "non-text-or-no-from" });
      return;
    }
    log.info("turn.start", { ... });

    // NEW BRANCH — slash commands intercept before engine-prefix routing.
    const parsedCmd = parseCommand(msg.text, { botUsername: deps.botUsername });
    if (parsedCmd.isCommand) {
      await runCommand(deps, msg, parsedCmd.cmd);   // never throws past here
      log.info("turn.done", { update_id, chat_id: msg.chat.id, route: `cmd:${parsedCmd.cmd.kind}` });
      return;
    }

    // Existing flow unchanged.
    const parsed = parseEnginePrefix(msg.text);
    // ... ollama branch, claude branch, runAgent ...
  };
}
```

Flow position for the four-stage update lifecycle:

| Stage | Owner | Command behavior |
|-------|-------|------------------|
| 1. Allowlist gate + denial throttle | `gateAndAuditDenied` (main.ts:261) | Same as today. Non-allowlisted users never reach the command parser. |
| 2. Update dedupe | `db.claimUpdate` (poll.ts:194) | Same — commands are claimed/deduped just like normal turns. |
| 3. Queue enqueue | `queue.enqueue` (main.ts:469) | Commands go through the same queue. `/help`/`/status` finish in <50ms but they share the per-chat KeyedMutex serialization, which is correct: a user sending `/clear` immediately followed by a question must see the `/clear` take effect first. |
| 4. Slash command parse | NEW — top of `makeRunTurn` | First action inside the queued worker. |
| 5. Engine prefix routing | `parseEnginePrefix` | Skipped for commands. |

### Why through the queue (and not via a fast-path bypass)

- `/clear` mutates session/summary state. If the user sent a question and then `/clear` back-to-back, both updates land in the per-chat KeyedMutex chain. Bypassing the queue for the command would let `/clear` race ahead and drop the session id while a turn is mid-flight, leaving the running turn writing a session id to a row that just got cleared. Easier to keep the serialization invariant intact.
- `/status` reads from audit + sessions; reading mid-write is benign but the write order in the chat needs to feel sequential to the user.
- The cost of running through the queue is nothing — `/help` returns in ~one Telegram round-trip.

### Audit-row policy for commands

Every command writes one audit row, tagged `model='system'` (matches `auditQueueFull`'s convention at `main.ts:332`):

| Command | `prompt` | `response` | `cost_usd` | `status` | `error_message` |
|---------|----------|------------|------------|----------|----------------|
| `/clear` | truncated raw text | `"cleared: {tiers}"` | NULL | `ok` | NULL |
| `/compact` (success) | truncated raw text | first 200 chars of summary | non-null | `ok` | NULL |
| `/compact` (rejected by cap) | truncated raw text | NULL | NULL | `error` | `cost_cap_pre_check_failed` |
| `/compact` (Claude error) | truncated raw text | NULL | maybe non-null | `error` | err msg |
| `/status` | truncated raw text | one-line summary | NULL | `ok` | NULL |
| `/help` | truncated raw text | `"help shown"` | NULL | `ok` | NULL |
| unknown / empty | truncated raw text | `"unknown_command"` | NULL | `ok` | NULL |

The audit row is written by a small helper `writeSystemAudit(db, ...)` in commands.ts that mirrors the `insertAudit` + `updateAuditEnd` pair from `main.ts:285`–`main.ts:306`.

---

## 4. Per-command spec

### 4.1 `/clear` — drop session and pending summary

**Behavior.** For each targeted tier (default `all`):

1. `UPDATE sessions SET <tier>_session_id = NULL, <tier>_summary = NULL, <tier>_summary_at = NULL, updated_at = ? WHERE chat_id = ?`
2. Reply with which tiers were cleared.

The OOB bridge (`db.outOfBandForEngine`, db.ts:202) is **not** touched — it's a derived view over the audit table, not stored state. After `/clear`, the next turn for the cleared tier still sees other-engine turns since this tier's last successful row, which is the right behavior (the user didn't ask to forget the cross-engine thread, only this engine's own session). Audit rows remain (Solrac never deletes audit; see CLAUDE.md / the file header at `db.ts:1`).

**Reply (HTML).**

```
🧹 Cleared <b>primary</b> + <b>secondary</b> session state. Next turn starts fresh.
```

Single-tier variant:

```
🧹 Cleared <b>primary</b> session state. Next turn starts fresh.
```

When there was nothing to clear (no `sessions` row, no summary):

```
🧹 Already clean — no <b>primary</b> session to drop.
```

**DB writes.** One UPSERT per tier targeted (or `'all'` = both). Plus the `system` audit row.

**Cost.** Free. No Claude call.

**Error paths.**

- DB error → log `cmd.clear_failed`; reply `❌ couldn't clear session state (see logs)`. Audit row written with `status='error'`.

**Edge cases.**

- Fresh chat, no `sessions` row: `getSession` returns `null`; treat as "already clean". Don't insert just to clear. Reply: `🧹 Already clean — no session to drop.`
- `/clear` mid-flight on the same chat: the per-chat KeyedMutex serializes; `/clear` can't run until the in-flight turn completes (and its `setSessionId` write has landed). `/clear` then drops the just-written session id. This is the documented behavior.
- `/clear secondary` when only primary has a session: clear secondary (no-op), report `🧹 Already clean — no secondary session to drop.`

### 4.2 `/compact` — summarize and restart

**Behavior.**

1. **Pre-flight cap check.** Before running the Claude call:
   - `costGuard.check(chatId)` (per-chat hourly).
   - `globalCostGuard.check()` (global hourly).
   - If either is exceeded → reply with the cap message, write a `status='error'` audit row, return without running Claude.
2. **Read source material.** Get the most recent N successful turns for this chat + this tier from audit. Reuse `db.recentChatTurns(chatId, limit)` (`db.ts:187`) but filter callers's tier inside the helper (a small new method `recentChatTurnsForEngine(chatId, enginePrefix, limit)` is cleaner — see DB section below). Tier defaults to `primary`. Empty result → no summary to make; reply `📭 nothing to compact for <b>primary</b>`.
3. **Run a one-shot Claude turn** via a new `runCompactTurn` helper (sketch in §7). It reuses `query()` from the SDK with:
   - `model = primaryModel` if `tier=primary`, else `secondaryModel`.
   - **No `resume`** — the summarizer is a fresh, isolated turn. We don't want it to inherit the conversation it's summarizing (which would double the context cost and risk the model thinking the summary should also extend the conversation).
   - `maxTurns: 1` (no tool calls expected; we don't want any tool use).
   - `disallowedTools` set to deny everything noticeable (Bash, Write, Edit, WebFetch, WebSearch, Agent, Task) — the summarizer is read-only-on-its-own-input.
   - The `PreToolUse` hook is still installed so any sneaky tool fire still hits the cost cap. (Should be a no-op given `disallowedTools` covers it.)
   - The exact summarization prompt is in §5.
4. **Persist.** On success:
   - `sessions.setSummary(chatId, tier, summary, now)` — writes `<tier>_summary` + `<tier>_summary_at` + `updated_at`.
   - `sessions.setSessionId(chatId, tier, NULL)` — drops the SDK session id so the next turn starts fresh. (Need a new `clearSessionId` method — current `setSessionId` types `string`, not `string | null`.)
5. **Reply** (default — header only, see open-question recommendation in §11):
   ```
   ✅ <b>Compacted</b> N turns for <b>primary</b> · ~M tokens · $0.0123
   ```
   Where N = number of source turns, M = output token count from the summarizer, $ = cost. The summary text itself is NOT echoed in the chat by default.

**DB writes.** One UPDATE on `sessions`. One audit row tagged `model='claude:primary:<id>'` (or secondary) — yes, this row uses the engine's model tag, not `'system'`, because a real Claude call ran and we want the cost accounting to roll up correctly under the per-chat hourly cap on subsequent queries. The compact audit row's `prompt` is the user's literal `/compact ...` text (truncated). The `response` is the first 200 chars of the summary plus an ellipsis, so operator dumps see what was summarized without bloating the audit row.

**Cost.** Real Claude call. Counts toward both per-chat and global hourly caps via the existing `audit.cost_usd` query path.

**Error paths.**

- Pre-flight cap exceeded: `❌ cost cap reached for compact: $X.XXXX ≥ $Y.YY/hr — try again later`. `status='error'`, `error_message='cost_cap_pre_check_failed'`. No Claude call made.
- Claude returns error: `❌ compact failed: <reason>` with the SDK's err msg. Session id NOT dropped. Summary NOT stored. `status='error'`, `error_message=<sdk msg>`.
- DB write fails after a successful summary: log `cmd.compact_persist_failed`. The summary is lost and the user sees `❌ compact succeeded but couldn't save summary — session unchanged`. Session id NOT dropped (better to keep the working session than to lose it after a failure).

**Edge cases.**

- **Fresh chat, no session yet.** `recentChatTurnsForEngine` returns empty → reply `📭 nothing to compact for <b>primary</b>` and no Claude call. No audit row noise — write a single `system` audit row with `response="nothing_to_compact"`.
- **`/compact` after `/compact` (no new turns since).** Same as above — empty source → `📭 nothing to compact`. (The previous compact dropped the session id, so the next `/compact` finds no successful turns past the previous compact's audit row. We need to filter the source query by `started_at >= previous compact's started_at` to avoid re-summarizing the same window — see §6.)
- **`/compact !` when secondary has no session.** Same handling — empty → `📭 nothing to compact for <b>secondary</b>`.
- **Stale summary.** If the user `/compact`s, then `/clear`s, the summary is wiped. If they `/compact` then never sends another message, the summary stays in the DB until next turn or next `/compact`/`/clear`. Acceptable.
- **OOB bridge interaction.** Already-pending OOB turns (from other engines, since this tier's last successful row) remain in scope. The next turn after `/compact` will see `[summary block] + [OOB block] + [user prompt]`. Both summary and OOB are consumed once.

### 4.3 `/status` — chat + global state snapshot

**Behavior.** Read-only. Pulls from sessions, audit, and the cost-cap helpers; renders into a single HTML block.

**Reply (HTML).** Recommended content for v1 — minimal, debuggable:

```
📊 <b>Solrac status</b>

<b>This chat</b>
• primary session: a4f8…  (12 turns · last 14:32 UTC)
• secondary session: <i>none</i>
• pending summary: <i>none</i>
• spent (1h): $0.1342 / $1.00
• spent (24h): $1.842

<b>Global</b>
• spent (1h): $0.412 / $4.00
• in-flight turns: 1 · waiting: 0
• allowlist size: 2
• uptime: 4h 12m
```

Field sources:

| Field | Source |
|-------|--------|
| primary/secondary session | `sessions.getSession(chatId)` (session.ts:111). Show first 4 chars + `…` + last 4 of session id. |
| turn count for this chat+tier | New `db.countChatTurnsForEngine(chatId, enginePrefix)` — single COUNT query. |
| last timestamp | New `db.lastSuccessfulTurnAt(chatId, enginePrefix)` — MAX(started_at). |
| pending summary | `sessions.getSummary(chatId, tier)` — non-null → `present`. Show timestamp + char count if you want; v1 keeps it boolean. |
| spent (1h) chat | `db.sumChatCostSince(chatId, since)` (existing). |
| spent (24h) chat | New `db.sumChatCostSince(chatId, since)` with a 24h window — the existing method already accepts arbitrary `sinceMs`. Just compute `Date.now() - 24*60*60*1000`. |
| spent (1h) global | `db.sumCostSince(since)` (existing, db.ts:179). |
| in-flight / waiting | These live on the queue. Either pass the queue handle into `RunTurnDeps`, or reuse the snapshot pattern — pass a `getQueueSnapshot: () => { inFlight, waiting }` closure into deps. Recommendation: closure (smaller blast radius). |
| allowlist size | `allowlist.size()` if exposed; if not, `db.raw.query("SELECT COUNT(*) ...")`. v1: cheap to add an `allowlist.size()` method. |
| uptime | `(Date.now() - startedAt) / 1000`. Pass `startedAt` into deps. |

**Cost.** Free. No Claude call. Uses the same SQL paths the cost cap already hits (`sumChatCostSince`, `sumCostSince`).

**Error paths.** DB read errors are unlikely; if any throw, fall back to `❌ status query failed (see logs)`.

**Edge cases.**

- Fresh chat: all per-chat fields show `<i>none</i>` / `0 turns` / `$0.0000`.
- Mid-turn: one row of audit for this chat shows `status='in_progress'`. Don't filter on status — count all rows (matching `sumChatCostSince`'s behavior). Or expose two counts (`12 turns · 1 in flight`); v1 uses the simpler one-count form.

**Cache-token telemetry — defer.** The plan flags `cache_creation_input_tokens` / `cache_read_input_tokens` as a possible add (capturing them in audit). This is a small change but it changes the audit-row shape and the cost arithmetic. **Recommendation: defer to a follow-up.** v1 ships with the existing `input_tokens`/`output_tokens` capture (`agent.ts:316-317`). Cache telemetry is a v1.1 — see §11.

### 4.4 `/help` — refresher card

**Behavior.** Static text. No DB read except the audit-row write.

**Reply (HTML).**

```
🤖 <b>Solrac help</b>

<b>Engines</b> (first character of your message):
• plain text or <code>@</code> → primary Claude (Sonnet)
• <code>!</code> → secondary Claude (Opus, costs more)
• <code>&gt;</code> → local Ollama (free, no tools)

<b>Commands</b>:
• <code>/clear</code> [primary|secondary|all] — drop session state. Default: all.
• <code>/compact</code> [primary|secondary] — summarize + restart session. Costs one Claude turn. Default: primary.
• <code>/status</code> — show session + spend snapshot for this chat.
• <code>/help</code> — this card.

Send <code>!!literal</code> to start a message with a literal <code>!</code>.
```

**Cost.** Free.

**Edge cases.**

- Mid-flight: `/help` queues behind any in-flight turn for this chat. After it runs it sends the help text. If the user wants the help card immediately during a long-running turn they're out of luck in v1; this matches every other slash command's serialization.

---

## 5. `/compact` summarization details

### Summarization prompt (exact wording)

The user-facing `prompt` to `query()`:

```
You are summarizing a conversation between a user and Solrac, a Telegram-based agent. Below is the recent transcript. Produce a compact summary that preserves:

1. The user's stated goals or projects in this thread.
2. Open questions or in-flight tasks (mention status: started / blocked / done).
3. Concrete decisions and named entities (file paths, ticket IDs, URLs, people).
4. Anything the user asked you to remember.

Compress everything else aggressively. Drop pleasantries, redundant phrasing, and step-by-step reasoning that's no longer relevant. Aim for under 500 tokens (≈2000 chars).

Output ONLY the summary as a single block of prose with at most three short paragraphs or a bulleted list — no preamble, no apology, no header like "Summary:".

Transcript:

[User]: <prompt 1>
[Solrac]: <response 1>
[User]: <prompt 2>
[Solrac]: <response 2>
…
```

The `[User]:` / `[Solrac]:` rows come from `recentChatTurnsForEngine` — same shape `recentChatTurns` already returns (`db.ts:165`), each row carrying `prompt`, `response`, `model`. We don't print `[Solrac primary]:` vs `[Solrac secondary]:` — the summarizer gets confused by the metadata more often than it gets value from it. Single label.

### Token budget

- Input cap: at most `COMPACT_SOURCE_LIMIT = 50` source turns (configurable later; not env-tunable for v1). At ~256-char prompts (truncated by `MAX_AUDIT_PROMPT_LEN`) and unbounded responses, 50 turns × ~2KB = ~100KB worst case. Sonnet handles this in one shot well within its context window.
- Output cap: model is asked for ≤500 tokens. We don't enforce it numerically (no SDK option for output cap that I can see in [SDK_NOTES.md](./SDK_NOTES.md)); the prompt instructs the model. Real-world we'll see 200–600 tokens.
- Cost: ~$0.001–0.005 per `/compact` on Sonnet, ~$0.005–0.025 on Opus. Cheap relative to a full turn with tool calls.

### Storage

```
sessions
├─ chat_id (PK)
├─ primary_session_id  (existing)
├─ secondary_session_id (existing)
├─ primary_summary           NEW  TEXT NULLABLE
├─ primary_summary_at        NEW  INTEGER NULLABLE
├─ secondary_summary         NEW  TEXT NULLABLE
├─ secondary_summary_at      NEW  INTEGER NULLABLE
├─ created_at
└─ updated_at
```

### Lifecycle: when consumed, when cleared

- **Stored** on a successful `/compact` for tier T. Tier T's session id is also dropped at the same UPSERT.
- **Consumed** at the start of the next `runAgent` call for tier T:
  1. Read summary via `sessions.getSummary(chatId, tier)`.
  2. If non-null, prepend it to the prompt **before** the OOB block (see §5 prompt-building section below).
  3. After the SDK call returns successfully (`isError === false`), call `sessions.clearSummary(chatId, tier)` in the same UPDATE that writes the new session id (one round-trip, one statement).
  4. If the call errors, leave the summary alone — the retry should still benefit from it.
- **Cleared** explicitly by `/clear`.
- **Stale** summaries are tolerated. The `summary_at` timestamp is informational; we don't auto-expire.

### Interaction with the existing OOB bridge

The OOB bridge (`agent.ts:252-273`, helper at `agent.ts:477`) prepends turns from OTHER engines that happened after this engine's last successful row. The summary is for THIS engine's own past, condensed.

Both can apply on the same turn:

- The user `/compact`s primary at T1.
- Between T1 and T2, they have several `>` Ollama turns.
- At T2 the user sends primary again.

The new prompt-building order:

```
[Compaction summary block] (if present)

[Out-of-band block] (if present)

[Current user prompt]
```

The summary represents the user's history with this engine BEFORE T1. The OOB block represents activity on OTHER engines BETWEEN T1 and now. Both are coherent context with no overlap.

Concretely, the new prompt-building lives in `agent.ts::runAgent` around line 261. Pseudocode:

```ts
const summary = deps.sessions.getSummary(input.chatId, input.engine);
const oobTurns = deps.db.outOfBandForEngine(input.chatId, enginePrefix, OUT_OF_BAND_LIMIT);

let promptToSend = input.prompt;
if (oobTurns.length > 0 || summary !== null) {
  promptToSend = buildAugmentedPrompt({ summary, oobTurns, currentPrompt: input.prompt });
}
```

`buildAugmentedPrompt` is a small refactor of the existing `buildOutOfBandPrompt` (`agent.ts:477`). Output shape:

```
[Compaction summary: this thread was condensed at <timestamp>. The points to remember:]

<summary text here>

[End of compaction summary.]

[Out-of-band context: ...]
User: ...
Other engine (...): ...
[End of out-of-band context. The user's current message:]

<current prompt>
```

When only the summary is present, the OOB block is omitted (and vice versa). When both are absent, the prompt is sent as-is — same as today.

After the SDK call returns successfully, `clearSummary` runs alongside `setSessionId` in `agent.ts:362`. If the call errors, we skip both writes (matches today: errored turns don't update the session id either).

---

## 6. DB changes

All changes are additive ALTERs in `openDb` (`db.ts:210`), matching the existing migration pattern at `db.ts:218-272`.

### Schema migration

```sql
-- Run inside openDb after the existing per-tier session ALTERs.
ALTER TABLE sessions ADD COLUMN primary_summary TEXT;
ALTER TABLE sessions ADD COLUMN primary_summary_at INTEGER;
ALTER TABLE sessions ADD COLUMN secondary_summary TEXT;
ALTER TABLE sessions ADD COLUMN secondary_summary_at INTEGER;
```

Each ALTER is guarded by the same `PRAGMA table_info(sessions)` check pattern already used at `db.ts:237-244` — runs once on upgrade, no-op afterward.

### New SessionStore methods

In `session.ts` (`src/session.ts:63`), extend the interface:

```ts
export interface SessionStore {
  getSessionId: (chatId: number, tier: SessionTier) => string | null;
  setSessionId: (chatId: number, tier: SessionTier, sessionId: string) => void;
  clearSessionId: (chatId: number, tier: SessionTier) => void;          // NEW
  getSession: (chatId: number) => SessionRow | null;                    // existing
  getSummary: (chatId: number, tier: SessionTier) => SessionSummary | null;  // NEW
  setSummary: (chatId: number, tier: SessionTier, text: string, at: number) => void;  // NEW
  clearSummary: (chatId: number, tier: SessionTier) => void;            // NEW
  // Convenience: clear both id and summary in one statement, used by /clear.
  clearAll: (chatId: number, tier: SessionTier) => void;                // NEW
}

export interface SessionSummary {
  text: string;
  at: number;
}
```

Each method is a small prepared-statement closure following the existing pattern (`session.ts:81-94`). Two prepared statements per write (one for primary, one for secondary) — same reason as the existing `stUpsertPrimary` / `stUpsertSecondary` split: SQLite can't parameterize column names. Internal enum-driven, so type-safe.

### New helpers on `SolracDb`

For `/status` and `/compact`:

```ts
// Number of rows for chat+engine where this engine ran successfully.
countChatTurnsForEngine: (chatId: number, enginePrefix: string) => number;

// MAX(started_at) for chat+engine, status='ok'. Returns null if no rows.
lastSuccessfulTurnAt: (chatId: number, enginePrefix: string) => number | null;

// Source material for /compact: most recent N successful turns for chat+engine,
// chronological order, since the previous compact (or all time if no previous).
// Filters status='ok', prompt/response IS NOT NULL, model LIKE enginePrefix.
recentChatTurnsForEngine: (
  chatId: number,
  enginePrefix: string,
  limit: number,
  sinceMs: number,                // pass `previous summary_at` or 0
) => ChatHistoryRow[];
```

The `sinceMs` parameter on `recentChatTurnsForEngine` is what prevents re-summarizing on a back-to-back `/compact`: pass `getSummary(chatId, tier)?.at ?? 0` and the query filters out turns we already condensed.

### Migration ordering

Append the four new ALTERs after the existing block at `db.ts:237-245`. Index changes: none required — the queries above hit the existing `idx_audit_chat_model_started` index (`db.ts:272`).

---

## 7. `runCompactTurn` implementation sketch

A standalone function in `commands.ts`. Reuses `query()` directly rather than `runAgent` because:

- `runAgent` writes its own audit row for a normal turn — we want a different audit row shape.
- `runAgent` does streaming Telegram edits (the 🤔 stub flow at `agent.ts:199-203`); for `/compact` we want a single result, then a single reply.
- `runAgent` consumes session resume; the summarizer is intentionally fresh.

The shared bits we DO want from `runAgent`: workspace cwd creation, `sanitizedSubprocessEnv()`, the `PreToolUse` hook with cost cap. All small enough to lift via copy or a new shared helper. Recommendation: extract `buildSdkOptions(...)` from `runAgent` so both runners build options consistently. Out of scope to relitigate the current `runAgent` shape; just add `runCompactTurn` next to it.

```ts
// In src/commands.ts (or a new src/compact.ts if commands.ts grows)
export interface RunCompactDeps {
  tg: TelegramClient;
  db: SolracDb;
  sessions: SessionStore;
  dataDir: string;
  primaryModel: string;
  secondaryModel: string;
  costGuard: CostCapGuard;
  globalCostGuard: GlobalCostCapGuard;
}

export interface RunCompactInput {
  chatId: number;
  fromId: number;
  updateId: number;
  tier: SessionTier;
}

export interface CompactResult {
  ok: boolean;
  summary?: string;
  numSourceTurns?: number;
  outputTokens?: number | null;
  costUsd?: number | null;
  errorMessage?: string;
}

export async function runCompactTurn(
  deps: RunCompactDeps,
  input: RunCompactInput,
): Promise<CompactResult> {
  // 1. Pre-flight cost cap (per-chat + global).
  const chatCap = deps.costGuard.check(input.chatId);
  if (chatCap.exceeded) return { ok: false, errorMessage: `chat_cost_cap: $${chatCap.spentUsd.toFixed(4)} ≥ $${chatCap.capUsd.toFixed(2)}/hr` };
  const globalCap = deps.globalCostGuard.check();
  if (globalCap.exceeded) return { ok: false, errorMessage: `global_cost_cap: $${globalCap.spentUsd.toFixed(4)} ≥ $${globalCap.capUsd.toFixed(2)}/hr` };

  // 2. Read source turns. `sinceMs` excludes already-summarized window.
  const prevSummary = deps.sessions.getSummary(input.chatId, input.tier);
  const enginePrefix = `claude:${input.tier}:%`;
  const turns = deps.db.recentChatTurnsForEngine(
    input.chatId,
    enginePrefix,
    COMPACT_SOURCE_LIMIT,
    prevSummary?.at ?? 0,
  );
  if (turns.length === 0) return { ok: false, errorMessage: "nothing_to_compact" };

  // 3. Build prompt + run query with no resume, no tools.
  const prompt = buildSummaryPrompt(turns);
  const modelId = input.tier === "primary" ? deps.primaryModel : deps.secondaryModel;
  const cwd = join(deps.dataDir, "workspaces", String(input.chatId));
  await mkdir(cwd, { recursive: true });

  // (Cost-cap PreToolUse hook installed defensively even though disallowedTools
  // covers the same surface — same belt-and-suspenders pattern as runAgent.)
  // Iterate result; capture summary text + tokens + cost.
  // ... (see runAgent's loop for the shape)

  // 4. Persist on success: setSummary + clearSessionId in one UPSERT.
  // 5. Return CompactResult with the bits the caller needs to render the reply.
}
```

The caller (the command dispatcher) writes the audit row, sends the chat reply, and updates the session.

---

## 8. Telegram integration

### `setMyCommands` payload

Called once at boot, after `createTelegramClient(...)` (`main.ts:399`) and before `startPolling`:

```ts
await tg.call("setMyCommands", {
  commands: [
    { command: "clear", description: "Drop session state for this chat" },
    { command: "compact", description: "Summarize + restart current session" },
    { command: "status", description: "Show session and spend snapshot" },
    { command: "help", description: "Show command help" },
  ],
}).catch((err) => log.warn("telegram.set_commands_failed", { error: (err as Error).message }));
```

Failure here is non-fatal — autocomplete falling back is a UX nicety, not a correctness issue.

### `getMe` boot caching

```ts
const me = await tg.call<{ username?: string }>("getMe").catch((err) => {
  log.warn("telegram.get_me_failed", { error: (err as Error).message });
  return null;
});
const botUsername = me?.username?.toLowerCase() ?? null;
```

`botUsername` is passed into `RunTurnDeps` and threaded through `parseCommand`'s `deps`.

### New helpers on `TelegramClient`

We don't strictly need new typed helpers — `tg.call(...)` covers `setMyCommands` and `getMe`. But for cleanliness add typed shims to `telegram.ts`:

```ts
setMyCommands: (commands: ReadonlyArray<{ command: string; description: string }>) => Promise<true>;
getMe: () => Promise<{ id: number; is_bot: boolean; username?: string; first_name: string }>;
```

Both implemented as one-line wrappers around `call(...)`. Optional — keep the surface minimal if you prefer; just call `tg.call` directly from `main.ts`.

---

## 9. File-by-file diff inventory

### New files

| File | Purpose | Rough LOC |
|------|---------|-----------|
| `src/commands.ts` | Parser, dispatcher, four command handlers, `runCompactTurn`. | ~350–450 |
| `src/commands.test.ts` | Parser unit tests + per-command unit tests against fake tg/db. | ~400–500 |

If `runCompactTurn` grows, split into `src/compact.ts` (~150 LOC) and shrink `commands.ts` correspondingly.

### Modified files

| File | Changes | Rough LOC delta |
|------|---------|-----------------|
| `src/main.ts` | Boot: call `getMe`, call `setMyCommands`. Wire `botUsername` + `getQueueSnapshot` + `startedAt` into `RunTurnDeps`. Insert command-parser branch at top of `makeRunTurn`. | +30 |
| `src/db.ts` | Three new interface methods (`countChatTurnsForEngine`, `lastSuccessfulTurnAt`, `recentChatTurnsForEngine`). Their prepared statements + closure bodies. Four new ALTERs in `openDb`. | +60 |
| `src/db.test.ts` | New test cases for the three new helpers + the four new columns being added on migration. | +80 |
| `src/session.ts` | Add `clearSessionId`, `getSummary`, `setSummary`, `clearSummary`, `clearAll`, plus the `SessionSummary` type. New prepared statements per tier. | +80 |
| `src/session.test.ts` | New test cases for summary CRUD and clear behavior. | +60 |
| `src/agent.ts` | Replace `buildOutOfBandPrompt` call site with a `buildAugmentedPrompt` that consumes both summary + OOB. Read summary via `getSummary` before the SDK call. Clear summary on success in `updateAuditEnd`-adjacent path (one statement after the `setSessionId` write at `agent.ts:362`). | +30 |
| `src/telegram.ts` | (Optional) Add typed `setMyCommands` and `getMe` shims. | +12 |
| `docs/USAGE.md` | New section: "Slash commands" — same shape as the existing engine-routing section. Update the line at `USAGE.md:261` claiming `/start` and other commands aren't implemented. | +60 |
| `docs/ARCHITECTURE.md` | Add a "slash commands" subsection under "End-to-end data flow". | +40 |

### Total

~750–900 LOC added (incl. tests), ~30 LOC modified. No deletions.

---

## 10. Test plan

### `src/commands.test.ts` — parser (≈25 cases)

All pure function calls, no DB, no async.

- Recognition: every shape in the edge-case table in §2.
- Group-chat targeting: matched/mismatched `@bot` suffix.
- Boot fallback: `botUsername=null` accepts plain command, rejects `@bot` suffix.
- Tier flags: `primary` / `p` / `@`, `secondary` / `s` / `!`, `all` / `*`, default for `/clear` and `/compact`, invalid token returns `unknown`.
- Case insensitivity on command name.
- Leading whitespace tolerated.
- Length cap (>32 chars in command name) → not a command.

### `src/commands.test.ts` — dispatcher (≈10 cases)

Fakes for `db`, `sessions`, `tg`. Tests the audit-row shape for each command.

- `/clear` writes UPDATE for both tiers (default `all`).
- `/clear @` writes UPDATE only for primary.
- `/clear` on fresh chat → "already clean" reply, no UPDATE.
- `/help` reply text contains the engine table.
- `/status` reply renders the spend numbers from the fake db.
- `/compact` pre-flight rejects when `costGuard.exceeded=true`.
- `/compact` on empty source replies "nothing to compact".
- `/compact` happy path stores summary + drops session id.
- `/compact` Claude-error path leaves session id alone.
- Unknown command writes audit row + replies "Unknown command. Try /help".

### `src/db.test.ts` — schema migration + new helpers (≈8 cases)

Existing pattern (db.test.ts:1) extended:

- Pre-Step-167 → current: four new `sessions` summary columns added; existing rows survive with NULL.
- Idempotent on second boot.
- `countChatTurnsForEngine` matches the existing `idx_audit_chat_model_started` plan; returns 0 for unknown chat.
- `lastSuccessfulTurnAt` returns null when no rows match; ignores `status='error'`.
- `recentChatTurnsForEngine` returns chronological order, respects `sinceMs`, filters by enginePrefix.

### `src/session.test.ts` — new methods (≈8 cases)

- `setSummary` then `getSummary` round-trips.
- `setSummary` per-tier independence.
- `clearSummary` is idempotent on a fresh chat.
- `clearAll` drops both id and summary in one go.
- `getSummary` on missing row returns null.
- `setSummary` updates `updated_at`.
- `clearSessionId` removes the id but leaves the summary.

### `src/main.test.ts` — boot wiring (≈3 cases)

These are covered by integration smokes today; small unit add:

- `getMe` failure → `botUsername=null`, command parser still works for plain commands.
- `setMyCommands` failure logs a warning but doesn't throw.

### Live smoke — `test/smokes/compact.ts` (manual, follows the `flood.ts` / `ollama.ts` pattern)

End-to-end against a dev bot with real `ANTHROPIC_API_KEY`:

1. Send 3 plain-text turns.
2. Send `/compact`.
3. Assert `sessions.primary_session_id IS NULL`, `sessions.primary_summary IS NOT NULL`.
4. Send a 4th turn referencing the earlier conversation ("what did we just discuss?").
5. Assert the response references prior content; `agent.oob_injected` log has the summary fingerprint.

Ship as a script under `test/smokes/`, not part of `bun test` (live, costs real API).

### Test count summary

- New unit cases: ~50 (parser ~25, dispatcher ~10, db ~8, session ~8, main ~3, agent prompt-building ~5).
- New live smoke: 1 script, manual.

---

## 11. Open questions / deferrals

### Resolved (recommended defaults)

| Question | v1 default | Alternative (deferred) |
|----------|------------|------------------------|
| `/clear` no-arg tier | `all` | Could default to `primary` only — less surprise but two clears needed when user wants both. |
| `/compact` no-arg tier | `primary` | Could default to "whichever tier has more recent turns" — too clever for v1. |
| `/compact` chat output | header only (`✅ compacted N turns · ~M tokens · $X.XXXX`) | Show full summary text. Less noise vs. less debugging. **Resolution: header by default; expose full text via a future `/compact verbose` or via the audit row.** |
| Summary storage location | new `sessions` columns | New `compactions` table (one row per compact). v1 doesn't need history; YAGNI. |
| Cache-token telemetry in `/status` | omit | Capture `cache_creation_input_tokens` + `cache_read_input_tokens` in audit + show on `/status`. Cheap to add, but changes the audit-insert shape. **Defer to v1.1.** |

### Deferred

- **`/help verbose` for full command syntax including tier flags.** v1 keeps `/help` terse.
- **`/cancel` for in-flight turns.** Mid-flight turn cancellation is a meaningfully different design (signal propagation through the SDK is non-trivial). Out of scope for PNX-167.
- **`/whoami` showing `from.id` + chat.id.** Useful for debugging allowlist setup but not user-facing. Add later if it bites.
- **Confirmation prompt for `/clear`.** v1 has no confirmation — allowlist already filters bad actors. Revisit if a user reports an accidental clear.
- **Per-chat `/help` localization.** v1 is English-only.
- **Programmatic command discovery.** A future `/help json` returning machine-readable docs would let an external tool (e.g. a docs site) stay in sync. Not v1.

### Truly unresolved

- **Should `/compact` use the secondary tier (Opus) by default?** Higher-quality summary, ~5× cost. Default-to-cheap (primary/Sonnet) feels right; revisit if summaries are visibly poor.
- **Token estimate for `/status`.** Showing per-tier token totals would be informative but requires either summing audit columns (cheap) or capturing cache tokens separately (small change). Defer with the cache-token decision.
- **Per-command per-chat rate limit.** A user could spam `/compact` to burn through caps faster. The hourly cap will catch them after a few iterations, so v1 doesn't bother. If it bites, add a 5-min cooldown.

---

## 12. Risks & rollback

### Risks

| Risk | Likelihood | Severity | Mitigation |
|------|------------|----------|------------|
| Parser misclassifies a normal message as a command | Low | Medium (user's text vanishes into "unknown command" reply) | Strict regex anchored to `^\s*\/`. Plain text starting with `/` is rare in Solrac usage. |
| `/clear` race with in-flight turn drops a session id mid-write | Low | Medium (next turn starts fresh; user-visible only as "wait, why did you forget?") | Per-chat KeyedMutex serializes — `/clear` can't run until prior turn finishes. Documented. |
| `/compact` summary persists across `/clear` | Low | Low | `/clear` explicitly clears summary too (see §4.1). |
| `/compact` output is bad and overwrites useful state | Medium | Medium | Source turns + audit rows are NEVER deleted — operator can manually re-summarize from audit. Old session id is gone but the new SDK session will rebuild context as the user continues. |
| `setMyCommands` API change | Very low | Very low | Wrapped in `.catch` — failure is non-fatal. |
| `getMe` is rate-limited at boot | Very low | Low | Cached at boot once. If rate-limited we proceed with `botUsername=null` and accept commands without `@bot` suffix. |
| Schema migration ALTER fails on a corrupt sqlite | Very low | High | Existing pattern in `db.ts:218-272` is already exercised. Rollback = revert migration; ALTERs are additive so the columns just stay there if we revert app code. |
| Audit-row bloat from per-command rows | Low | Low | Each command writes one row, same as today's normal turns. No multiplier. |

### Rollback plan

- **App-level**: revert the PR. The four new `sessions` columns stay in the DB — they're nullable additive ALTERs and don't affect the pre-PR code path. Old code reads `agent_session_id`, `primary_session_id`, `secondary_session_id` and ignores the new columns.
- **Data-level**: a rollback never needs to drop columns. If a future re-add is required, the existing PRAGMA-guarded migration is idempotent.
- **Partial rollback**: if `/compact` specifically misbehaves, ship a one-line patch that disables it (return "feature off" reply) without touching `/clear`/`/status`/`/help`. The summary state stays in the DB harmlessly until consumed.

---

## Open questions (extremely concise)

- `/compact` default tier — primary (cheap) confirmed, but if Carlos's usage skews secondary, revisit.
- `/compact` chat output — header only is the v1 default; alternative (echo full summary) is one if-branch away.
- Cache-token telemetry — defer to v1.1.

---

## References

- `src/main.ts:121` — `makeRunTurn` (insertion point).
- `src/policy.ts:194` — `parseEnginePrefix` (runs after command parser).
- `src/agent.ts:178` — `runAgent` (pattern for `runCompactTurn`).
- `src/agent.ts:252-273` — OOB bridge call site (where summary injection layers in).
- `src/agent.ts:477` — `buildOutOfBandPrompt` (refactor target → `buildAugmentedPrompt`).
- `src/db.ts:210` — `openDb` (migration block).
- `src/db.ts:332` — `stOutOfBandOther` (template for the new `recentChatTurnsForEngine` query).
- `src/session.ts:77` — `createSessionStore` (extension point).
- `src/policy.ts:370` — `createCostCapGuard` (`/compact` pre-flight reuses this).
- `src/policy.ts:398` — `createGlobalCostCapGuard` (same).
- `src/telegram.ts:115` — `TelegramClient` interface.
- `docs/SDK_NOTES.md` — verified SDK options for `runCompactTurn`.
- `docs/USAGE.md:261` — line claiming slash commands aren't implemented (will be updated).
