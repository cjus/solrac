/**
 * @fileoverview Drain-aware tracking set for in-flight turns.
 * @purpose Let lifecycle's SIGTERM handler wait for all queued/running turns
 *          to finish before closing the database. Also surface the count for
 *          `/stats.pendingTurns`.
 *
 * The queue runs turns via `void work()` (the "float-and-track" pattern from
 * docs/ARCHITECTURE.md#concurrency-model) — the poll handler returns
 * immediately, work runs in the background. Without something tracking the
 * background work, a shutdown can't tell when it's safe to close the database.
 *
 * Symbols, not numeric IDs, because they're opaque (can't be confused with a
 * chat id, a turn id, or anything else) and equality is identity.
 *
 * Position in the dependency graph:
 *   (no internal deps) → turn-tracker → queue, lifecycle
 *
 * Exports:
 *   - `TurnTracker` — class with `begin(): symbol`, `end(tag)`, `count`,
 *     `drain(): Promise<void>`.
 *
 * Concurrency:
 *   - `begin()` runs synchronously inside `queue.enqueue` so the post-enqueue
 *     drain immediately sees the new turn. If `begin` deferred via setImmediate,
 *     a SIGTERM right after enqueue would race past the still-unregistered turn.
 *   - `drain()` resolves once `count` hits 0. Waiters are awoken from a fresh
 *     copy of the array; `end` swapping it out before iteration prevents
 *     re-entrancy bugs if a waker schedules another `end`.
 *   - `end(tag)` is idempotent — calling with an unknown tag is a no-op.
 *
 * Key invariants:
 *   - `active.size === 0` ⇔ all `drain()` waiters have been resolved.
 *   - The tag returned by `begin()` MUST be passed to `end()` exactly once.
 *     Losing the tag stalls `drain()` forever.
 *
 * Gotchas:
 *   - If a caller forgets to call `end(tag)` (e.g. forgot to put it in
 *     `finally`), shutdown will hang for the full drain timeout, then exit 1.
 *     Always wrap `runTurn` calls in try/finally.
 *   - `count` getter returns `active.size`; not safe to use as a strict
 *     upper bound from outside the queue (turns may end between read and act).
 *
 * Cross-references:
 *   - queue.ts::createTurnQueue — composes begin/end with the mutex+sema
 *   - lifecycle.ts::installShutdown — calls drain() during graceful shutdown
 *   - docs/ARCHITECTURE.md#concurrency-model
 */

export class TurnTracker {
  private readonly active = new Set<symbol>();
  private waiters: Array<() => void> = [];

  begin(): symbol {
    const tag = Symbol();
    this.active.add(tag);
    return tag;
  }

  end(tag: symbol): void {
    if (!this.active.delete(tag)) return;
    if (this.active.size === 0) {
      const w = this.waiters;
      this.waiters = [];
      for (const r of w) r();
    }
  }

  get count(): number {
    return this.active.size;
  }

  drain(): Promise<void> {
    if (this.active.size === 0) return Promise.resolve();
    return new Promise((r) => this.waiters.push(r));
  }
}
