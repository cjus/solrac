/**
 * @fileoverview Per-key serial mutex with depth tracking.
 * @purpose Serialize tasks for the same key (chat) while letting tasks for
 *          different keys run independently. Surfaces `depth(key)` so the
 *          turn queue can enforce a per-chat backpressure cap.
 *
 * This is the spine of Solrac's per-chat ordering guarantee: when the same
 * user sends two messages quickly, the second waits for the first. Without
 * this, a slow turn could be lapped by a faster follow-up — the SDK session
 * would receive turns out of order.
 *
 * The implementation is intentionally tiny (~25 logical lines). The trick is
 * the "tail Promise" pattern: each `run()` call captures the current tail,
 * installs a new tail (the `next` Promise), awaits the old tail, runs the
 * task, then resolves `next` so the following caller can proceed. When the
 * map's value for a key matches the tail we just resolved, we delete the
 * entry — keeps the map bounded under churn.
 *
 * Position in the dependency graph:
 *   (no internal deps) → mutex → queue
 *
 * Exports:
 *   - `KeyedMutex<K>` — class with `run(key, task)`, `size()`, `depth(key)`.
 *
 * Concurrency:
 *   - Serialized PER key. Different keys are fully independent.
 *   - `depth(key)` is sync-incremented BEFORE any await so a caller doing
 *     `mutex.run(...)` immediately followed by `mutex.depth(key)` sees the
 *     updated count without a microtask flush. Load-bearing for the queue's
 *     pre-enqueue depth check.
 *   - The `finally` decrements depth and resolves `next` whether or not the
 *     task threw — a thrown task does NOT break the chain. Subsequent tasks
 *     for the same key still run.
 *
 * Key invariants:
 *   - `tails.get(key)` is the Promise the next caller must await before its
 *     task runs. Replacing the tail before installing the new one would race.
 *   - `counts.get(key) === undefined` ↔ `tails.get(key) === undefined` once
 *     the chain drains — the deletes are coupled.
 *
 * Gotchas:
 *   - The "task threw" path still resolves `next` and decrements depth. If
 *     you refactor and forget the `finally`, you'll deadlock the chain.
 *   - `size()` counts active keys, not total queued tasks. Use `depth(key)`
 *     for per-key chain length.
 *
 * Cross-references:
 *   - queue.ts — only consumer; uses `run` and `depth`.
 *   - docs/ARCHITECTURE.md#concurrency-model — composition rationale
 */

export class KeyedMutex<K> {
  private readonly tails = new Map<K, Promise<void>>();
  private readonly counts = new Map<K, number>();

  async run<T>(key: K, task: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let resolveNext!: () => void;
    const next = new Promise<void>((r) => {
      resolveNext = r;
    });
    this.tails.set(key, next);
    // Increment runs synchronously before any await, so a caller that does
    // `mutex.run(...)` followed immediately by `mutex.depth(key)` sees the
    // updated count without a microtask flush.
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    try {
      await prev;
      return await task();
    } finally {
      const c = (this.counts.get(key) ?? 1) - 1;
      if (c <= 0) this.counts.delete(key);
      else this.counts.set(key, c);
      resolveNext();
      if (this.tails.get(key) === next) this.tails.delete(key);
    }
  }

  size(): number {
    return this.tails.size;
  }

  depth(key: K): number {
    return this.counts.get(key) ?? 0;
  }
}
