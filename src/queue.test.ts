/**
 * @fileoverview Unit tests for createTurnQueue's chain-depth cap and recovery.
 * @proves The queue rejects beyond `maxChainDepth` with `dropped_queue_full`,
 *         independent chats stay independent, and depth resets after drain.
 *
 * Scenarios covered:
 *   - 4 messages from one chat with `maxChainDepth=3` → 4th drops with
 *     `kind: "dropped_queue_full", depth: 3, key: <chat>`.
 *   - A different chat is independent of the per-key cap (always enqueues).
 *   - The dropped update never runs (`runTurn` not invoked for it).
 *   - After drain, `depth(chat)` resets to 0 and new updates enqueue again.
 *
 * Microtask-ordering note: `tracker.end` runs in `work()`'s `finally`, then
 * `mutex.run`'s OWN `finally` decrements the per-key count one tick later.
 * The "after drain" assertion uses `await Bun.sleep(5)` to flush both
 * finally blocks before reading `queue.depth`.
 *
 * Not covered (intentional):
 *   - End-to-end with the real `runAgent` (would require fixture SDK + db
 *     + telegram; covered manually via dev-bot smokes and the flood smoke).
 *   - The `defaultChatKey` derivation for `edited_message` and
 *     `callback_query` (the queue.ts function is exercised via main.ts in
 *     practice; structural test would duplicate the inline branches).
 *
 * Cross-references:
 *   - queue.ts — implementation, including `defaultChatKey`
 *   - test/smokes/flood.ts — synthetic flood smoke that exercises the cap
 *     against real sqlite + DenialThrottle in concert.
 */

import { describe, expect, test } from "bun:test";
import type { Update } from "@grammyjs/types";
import { createTurnQueue } from "./queue.ts";
import { TurnTracker } from "./turn-tracker.ts";

function msgUpdate(updateId: number, chatId = 9000): Update {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 0,
      chat: { id: chatId, type: "private", first_name: "u" },
      from: { id: 1, is_bot: false, first_name: "u" },
      text: "hi",
    },
  } as unknown as Update;
}

describe("createTurnQueue chain-depth cap", () => {
  test("rejects updates beyond maxChainDepth for the same chat", async () => {
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => {
      releaseFirst = r;
    });
    const ran: number[] = [];
    const tracker = new TurnTracker();
    const queue = createTurnQueue({
      runTurn: async (u) => {
        ran.push(u.update_id);
        if (u.update_id === 0) await gate;
      },
      maxConcurrentTurns: 4,
      tracker,
      maxChainDepth: 3,
    });

    // First update enters the mutex chain and parks on the gate.
    expect(queue.enqueue(msgUpdate(0)).kind).toBe("enqueued");
    // Two more queue up behind it (depths 2 and 3).
    expect(queue.enqueue(msgUpdate(1)).kind).toBe("enqueued");
    expect(queue.enqueue(msgUpdate(2)).kind).toBe("enqueued");

    // 4th hits the cap and is dropped.
    const rejected = queue.enqueue(msgUpdate(3));
    expect(rejected.kind).toBe("dropped_queue_full");
    if (rejected.kind === "dropped_queue_full") {
      expect(rejected.depth).toBe(3);
      expect(rejected.key).toBe(9000);
    }

    // A different chat is independent of the per-key cap.
    expect(queue.enqueue(msgUpdate(100, 9001)).kind).toBe("enqueued");

    releaseFirst();
    await tracker.drain();
    expect(ran).toContain(0);
    expect(ran).toContain(1);
    expect(ran).toContain(2);
    expect(ran).toContain(100);
    // The dropped update never ran.
    expect(ran).not.toContain(3);
  });

  test("after a chain drains, depth resets and new updates enqueue again", async () => {
    const tracker = new TurnTracker();
    const queue = createTurnQueue({
      runTurn: async () => {},
      maxConcurrentTurns: 4,
      tracker,
      maxChainDepth: 2,
    });

    expect(queue.enqueue(msgUpdate(0)).kind).toBe("enqueued");
    expect(queue.enqueue(msgUpdate(1)).kind).toBe("enqueued");
    expect(queue.enqueue(msgUpdate(2)).kind).toBe("dropped_queue_full");

    await tracker.drain();
    // tracker.end fires inside work()'s finally; the surrounding mutex.run's
    // own finally — which decrements the depth counter — runs one microtask
    // later. Sleep briefly to let it flush.
    await Bun.sleep(5);
    expect(queue.depth(9000)).toBe(0);
    expect(queue.enqueue(msgUpdate(3)).kind).toBe("enqueued");
  });
});
