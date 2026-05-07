/**
 * @fileoverview Counting semaphore with FIFO waiters and idempotent release.
 * @purpose Cap global concurrent turn execution. Without this, an idle bot
 *          plus 50 quick messages from 50 chats would spawn 50 SDK
 *          subprocesses, each ~100MB — instant OOM.
 *
 * Standard counting semaphore: `acquire()` returns a Promise that resolves to
 * a `release` function once a slot is free. Waiters wake in FIFO order, so
 * messages from chat A that arrived before chat B's get processed before B
 * once concurrency frees up.
 *
 * Used by `queue.ts` keyed off `MAX_CONCURRENT_TURNS` (default 4). The
 * `inFlight` and `waiting` getters are surfaced via `/stats`.
 *
 * Position in the dependency graph:
 *   (no internal deps) → semaphore → queue
 *
 * Exports:
 *   - `Semaphore` — class with `acquire(): Promise<release>` plus `inFlight`
 *     and `waiting` getters.
 *
 * Concurrency:
 *   - FIFO. Waiters resume in submission order; no priority levels.
 *   - `release()` is idempotent: calling it twice is a no-op. This matters
 *     because the queue.ts `finally` block calls `release?.()` defensively;
 *     if any earlier path already released, the redundant call is harmless.
 *   - `acquire()` increments `inUse` synchronously when a slot is free; if
 *     not, it queues the resolver and awaits. This means `s.inFlight` after
 *     a synchronous `acquire()` reflects the new count immediately.
 *
 * Key invariants:
 *   - `inUse` ≤ `limit` at all times.
 *   - `waiters.length > 0` implies `inUse === limit` (no slots free, otherwise
 *     they'd resume).
 *   - `release()` either wakes one waiter (transferring the slot, no
 *     decrement) or decrements `inUse` (no waiter to wake).
 *
 * Gotchas:
 *   - The constructor REJECTS non-integer or non-positive limits. A typo like
 *     `new Semaphore(0)` throws at construction, not at first acquire.
 *   - The release function captures `released` via closure — calling it from
 *     multiple paths is safe (returns early on second invocation).
 *
 * Cross-references:
 *   - queue.ts — global concurrency cap composition
 *   - docs/ARCHITECTURE.md#concurrency-model
 */

export class Semaphore {
  private inUse = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error(`Semaphore limit must be a positive integer, got ${limit}`);
    }
  }

  async acquire(): Promise<() => void> {
    if (this.inUse < this.limit) {
      this.inUse++;
    } else {
      await new Promise<void>((r) => this.waiters.push(r));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.inUse--;
    };
  }

  get inFlight(): number {
    return this.inUse;
  }

  get waiting(): number {
    return this.waiters.length;
  }
}
