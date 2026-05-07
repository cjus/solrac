/**
 * @fileoverview Unit tests for TurnTracker (drain-aware in-flight set).
 * @proves `count` reflects begin/end pairs; `drain()` blocks until empty
 *         then resolves; idle drain returns immediately; `end` is idempotent.
 *
 * Scenarios covered:
 *   - begin/end correctly increment/decrement count.
 *   - drain() awaits; resolves only when count hits zero.
 *   - drain() on an idle tracker resolves immediately.
 *   - end() on an unknown tag is a no-op.
 *
 * Not covered (intentional):
 *   - Multiple concurrent drain() calls (they all resolve when count hits 0).
 *   - The interaction with KeyedMutex's per-key counter (covered in queue.test.ts).
 *
 * Cross-references:
 *   - turn-tracker.ts — implementation
 *   - lifecycle.test.ts — drain semantics under timeout
 */

import { describe, expect, test } from "bun:test";
import { TurnTracker } from "./turn-tracker.ts";

describe("TurnTracker", () => {
  test("counts begin/end pairs", () => {
    const t = new TurnTracker();
    expect(t.count).toBe(0);
    const a = t.begin();
    const b = t.begin();
    expect(t.count).toBe(2);
    t.end(a);
    expect(t.count).toBe(1);
    t.end(b);
    expect(t.count).toBe(0);
  });

  test("drain resolves when count reaches zero", async () => {
    const t = new TurnTracker();
    const a = t.begin();
    const b = t.begin();
    let done = false;
    const drained = t.drain().then(() => {
      done = true;
    });
    await Bun.sleep(5);
    expect(done).toBe(false);
    t.end(a);
    await Bun.sleep(5);
    expect(done).toBe(false);
    t.end(b);
    await drained;
    expect(done).toBe(true);
  });

  test("drain on idle resolves immediately", async () => {
    const t = new TurnTracker();
    await t.drain();
  });

  test("end is idempotent", () => {
    const t = new TurnTracker();
    const a = t.begin();
    t.end(a);
    t.end(a);
    expect(t.count).toBe(0);
  });
});
