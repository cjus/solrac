/**
 * @fileoverview Unit tests for KeyedMutex (per-key serial mutex).
 * @proves Same-key tasks run in submission order; different keys run in
 *         parallel; thrown tasks don't break the chain; the chain self-empties
 *         when drained; `depth(key)` is sync-incremented and resets correctly.
 *
 * Scenarios covered:
 *   - Submission-order serialization on a single key.
 *   - Cross-key parallelism (the second key's task runs while the first is asleep).
 *   - A throwing task does not poison the chain; the next task runs and gets
 *     its own resolution.
 *   - Empty key cleanup: keys disappear from the map after their chain drains.
 *   - `depth(key)` increments synchronously inside `run()` (before any await),
 *     making it safe for the queue's pre-enqueue depth check.
 *   - `depth` decrements even on thrown tasks (the `finally` is load-bearing).
 *
 * Not covered (intentional):
 *   - Memory pressure under millions of keys (bounded by sqlite + queue caps
 *     upstream).
 *   - Concurrent re-entrancy from inside a task into the same key (would
 *     deadlock; not a supported pattern).
 *
 * Cross-references:
 *   - mutex.ts — implementation
 *   - queue.test.ts — composition with Semaphore + TurnTracker
 */

import { describe, expect, test } from "bun:test";
import { KeyedMutex } from "./mutex.ts";

describe("KeyedMutex", () => {
  test("serializes tasks per key in submission order", async () => {
    const m = new KeyedMutex<string>();
    const order: number[] = [];
    const t1 = m.run("a", async () => {
      await Bun.sleep(20);
      order.push(1);
    });
    const t2 = m.run("a", async () => {
      order.push(2);
    });
    const t3 = m.run("a", async () => {
      order.push(3);
    });
    await Promise.all([t1, t2, t3]);
    expect(order).toEqual([1, 2, 3]);
  });

  test("runs different keys in parallel", async () => {
    const m = new KeyedMutex<string>();
    const order: string[] = [];
    const a = m.run("a", async () => {
      await Bun.sleep(40);
      order.push("a");
    });
    const b = m.run("b", async () => {
      await Bun.sleep(10);
      order.push("b");
    });
    await Promise.all([a, b]);
    expect(order).toEqual(["b", "a"]);
  });

  test("a thrown task does not break the chain", async () => {
    const m = new KeyedMutex<string>();
    const t1 = m.run("a", async () => {
      throw new Error("boom");
    });
    const t2 = m.run("a", async () => "ok");
    await expect(t1).rejects.toThrow("boom");
    expect(await t2).toBe("ok");
  });

  test("releases keys when their chain drains", async () => {
    const m = new KeyedMutex<string>();
    await m.run("a", async () => {});
    await m.run("b", async () => {});
    expect(m.size()).toBe(0);
  });

  test("depth(key) reports the current chain length and resets to 0", async () => {
    const m = new KeyedMutex<string>();
    expect(m.depth("a")).toBe(0);
    let releaseT1!: () => void;
    const gate = new Promise<void>((r) => {
      releaseT1 = r;
    });
    const t1 = m.run("a", async () => {
      await gate;
    });
    // run() increments synchronously before the first await.
    expect(m.depth("a")).toBe(1);
    const t2 = m.run("a", async () => {});
    const t3 = m.run("a", async () => {});
    expect(m.depth("a")).toBe(3);
    // Different key is independent.
    expect(m.depth("b")).toBe(0);
    const t4 = m.run("b", async () => {});
    expect(m.depth("b")).toBe(1);
    expect(m.depth("a")).toBe(3);
    releaseT1();
    await Promise.all([t1, t2, t3, t4]);
    expect(m.depth("a")).toBe(0);
    expect(m.depth("b")).toBe(0);
  });

  test("depth decrements even when a task throws", async () => {
    const m = new KeyedMutex<string>();
    const t = m.run("a", async () => {
      throw new Error("boom");
    });
    expect(m.depth("a")).toBe(1);
    await expect(t).rejects.toThrow("boom");
    expect(m.depth("a")).toBe(0);
  });
});
