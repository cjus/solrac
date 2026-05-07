/**
 * @fileoverview Per-chat serial + global concurrency turn queue.
 * @purpose Compose the three concurrency primitives (KeyedMutex, Semaphore,
 *          TurnTracker) into a single `enqueue(update)` that:
 *            1. drops the update if the per-chat chain is at depth cap;
 *            2. tracks the turn for shutdown drain;
 *            3. serializes per-chat (so messages from one user run in order);
 *            4. caps global concurrency (so the host doesn't OOM).
 *
 * `enqueue()` is intentionally SYNCHRONOUS — it returns an `EnqueueResult`
 * immediately and floats the actual work via `void`. This is the
 * "float-and-track" pattern from docs/ARCHITECTURE.md#concurrency-model. The
 * poll handler can return without blocking, advancing the offset for the next
 * `getUpdates`. The drain is on the tracker, not the offset.
 *
 * Why a depth cap: an allowed user pasting a 1000-line script could otherwise
 * queue 1000 turns. Cap at `MAX_CHAT_QUEUE_DEPTH` (default 10) and write a
 * `status='error', error_message='queue_full'` audit row for the dropped
 * updates. Tunable via the config constant; tested in queue.test.ts.
 *
 * Position in the dependency graph:
 *   mutex + semaphore + turn-tracker + config + log → queue → consumed by main
 *
 * Exports:
 *   - `createTurnQueue(deps)` — factory; returns a `TurnQueue`.
 *   - `TurnQueue` — interface with `enqueue`, `inFlight`, `waiting`, `pending`,
 *     `depth(key)`.
 *   - `EnqueueResult` — `{ kind: "enqueued" }` |
 *     `{ kind: "dropped_queue_full"; depth; key }`.
 *   - `RunTurn` — the user-supplied `(update) => Promise<void>` to run per turn.
 *
 * Concurrency:
 *   - Per-chat ordering: same-chat messages run serially via KeyedMutex.
 *   - Global cap: at most `maxConcurrentTurns` turns running anywhere via Semaphore.
 *   - Tracker.begin happens BEFORE any await so a SIGTERM right after enqueue
 *     sees the new turn during drain.
 *   - On exception in `runTurn`, the `finally` always releases the semaphore
 *     and ends the tracker — the chain doesn't deadlock.
 *
 * Key invariants:
 *   - The order of these synchronous steps matters:
 *       1. mutex.depth(key) check
 *       2. tracker.begin() (after the depth check passes)
 *       3. void mutex.run(key, work)
 *     Reordering 1 and 2 would over-track dropped turns. Reordering 2 and 3
 *     would let the tracker miss tasks dropped at the mutex layer.
 *   - `defaultChatKey` extracts the chat id from message / callback_query /
 *     edited_message updates. `undefined` skips the per-key chain (parallel),
 *     which is the right behavior for non-chat updates.
 *
 * Gotchas:
 *   - Returns sync — the poll handler does NOT await turn completion.
 *   - The `runTurn` callback's exception handling is a `log.error("turn.error",
 *     …)`, NOT a re-throw. Otherwise the finally chain wouldn't run.
 *   - `pending()` reads `tracker.count`; that's "all turns the queue knows
 *     about" (waiting + running). `inFlight()` is just running.
 *   - **`dropped_queue_full` is the queue's exit signal, not the user's.** The
 *     queue itself doesn't speak Telegram — it returns the discriminated
 *     `EnqueueResult` and `main.ts::auditQueueFull` is responsible for both
 *     the audit row AND the user-facing "queue full, please slow down" ack.
 *     Without that ack, a dropped update looks like silence to the user (the
 *     update was claimed, the offset advanced, no agent ran). If you add a
 *     new caller of `enqueue`, it must also handle the drop disposition —
 *     either send its own ack or document the silent-drop explicitly.
 *
 * Cross-references:
 *   - docs/ARCHITECTURE.md#concurrency-model — float-and-track rationale
 *   - main.ts — wires `runTurn = makeRunTurn(...)` and supplies `maxConcurrentTurns`
 *   - queue.test.ts — depth-cap and chain-drain scenarios
 */

import type { Update } from "@grammyjs/types";
import { MAX_CHAT_QUEUE_DEPTH } from "./config.ts";
import { log } from "./log.ts";
import { KeyedMutex } from "./mutex.ts";
import { Semaphore } from "./semaphore.ts";
import type { TurnTracker } from "./turn-tracker.ts";

export type RunTurn = (update: Update) => Promise<void>;

export type EnqueueResult =
  | { kind: "enqueued" }
  | { kind: "dropped_queue_full"; depth: number; key: number | string };

export interface TurnQueue {
  enqueue: (update: Update) => EnqueueResult;
  inFlight: () => number;
  waiting: () => number;
  pending: () => number;
  depth: (key: number | string) => number;
}

export interface TurnQueueDeps {
  runTurn: RunTurn;
  maxConcurrentTurns: number;
  tracker: TurnTracker;
  keyOf?: (update: Update) => number | string | undefined;
  maxChainDepth?: number;
}

export function createTurnQueue(deps: TurnQueueDeps): TurnQueue {
  const sem = new Semaphore(deps.maxConcurrentTurns);
  const mutex = new KeyedMutex<number | string>();
  const keyOf = deps.keyOf ?? defaultChatKey;
  const maxChainDepth = deps.maxChainDepth ?? MAX_CHAT_QUEUE_DEPTH;

  function enqueue(update: Update): EnqueueResult {
    const key = keyOf(update);
    if (key !== undefined) {
      const d = mutex.depth(key);
      if (d >= maxChainDepth) {
        return { kind: "dropped_queue_full", depth: d, key };
      }
    }
    const tag = deps.tracker.begin();
    const work = async (): Promise<void> => {
      let release: (() => void) | null = null;
      try {
        release = await sem.acquire();
        await deps.runTurn(update);
      } catch (err) {
        log.error("turn.error", {
          update_id: update.update_id,
          error: (err as Error).message,
        });
      } finally {
        release?.();
        deps.tracker.end(tag);
      }
    };
    if (key === undefined) {
      void work();
    } else {
      void mutex.run(key, work);
    }
    return { kind: "enqueued" };
  }

  return {
    enqueue,
    inFlight: () => sem.inFlight,
    waiting: () => sem.waiting,
    pending: () => deps.tracker.count,
    depth: (key) => mutex.depth(key),
  };
}

function defaultChatKey(update: Update): number | undefined {
  return (
    update.message?.chat.id ??
    update.callback_query?.message?.chat.id ??
    update.edited_message?.chat.id
  );
}
