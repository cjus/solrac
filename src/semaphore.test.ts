/**
 * @fileoverview Unit tests for Semaphore (counting global concurrency cap).
 * @proves Concurrent holders never exceed the limit; waiters resume FIFO;
 *         release is idempotent; constructor rejects bad limits.
 *
 * Scenarios covered:
 *   - Limit enforcement: 5 contenders × limit-2 → peak active count is 2.
 *   - FIFO ordering: two waiters resume in submission order after the first
 *     holder releases.
 *   - Idempotent release: calling the release function twice is safe and
 *     does NOT over-release a slot.
 *   - Constructor validation: 0, -1, and 1.5 throw at construction (not at
 *     first acquire).
 *
 * Not covered (intentional):
 *   - Cancellation of a pending waiter (no acquire-with-AbortSignal in v1).
 *   - Priority inversion (FIFO is the only ordering policy).
 *
 * Cross-references:
 *   - semaphore.ts — implementation
 *   - queue.test.ts — composition with KeyedMutex + TurnTracker
 */

import { describe, expect, test } from "bun:test";
import { Semaphore } from "./semaphore.ts";

describe("Semaphore", () => {
  test("limits concurrent holders", async () => {
    const s = new Semaphore(2);
    let active = 0;
    let peak = 0;
    const work = async () => {
      const release = await s.acquire();
      active++;
      peak = Math.max(peak, active);
      await Bun.sleep(20);
      active--;
      release();
    };
    await Promise.all([work(), work(), work(), work(), work()]);
    expect(peak).toBe(2);
    expect(s.inFlight).toBe(0);
    expect(s.waiting).toBe(0);
  });

  test("waiters resume in FIFO order", async () => {
    const s = new Semaphore(1);
    const r1 = await s.acquire();
    const order: number[] = [];
    const t2 = (async () => {
      const r = await s.acquire();
      order.push(2);
      r();
    })();
    const t3 = (async () => {
      const r = await s.acquire();
      order.push(3);
      r();
    })();
    await Bun.sleep(10);
    expect(s.waiting).toBe(2);
    r1();
    await Promise.all([t2, t3]);
    expect(order).toEqual([2, 3]);
  });

  test("release is idempotent", async () => {
    const s = new Semaphore(1);
    const r = await s.acquire();
    r();
    r();
    expect(s.inFlight).toBe(0);
    const r2 = await s.acquire();
    expect(s.inFlight).toBe(1);
    r2();
  });

  test("rejects bad limits", () => {
    expect(() => new Semaphore(0)).toThrow();
    expect(() => new Semaphore(-1)).toThrow();
    expect(() => new Semaphore(1.5)).toThrow();
  });
});
