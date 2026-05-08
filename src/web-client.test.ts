/**
 * @fileoverview Unit tests for `createWebClient`.
 * @proves The WebClient implements `TelegramClient` faithfully enough that
 *         the agent, ollama, and commands code paths can use it interchangeably.
 *         Critical: `markdownSource` propagates to bus events; subscribers
 *         receive every published event; one subscriber's throw doesn't
 *         poison others; `call()` throws (catches accidental coupling).
 *
 * Cross-references:
 *   - web-client.ts — implementation
 *   - web.ts — primary consumer (SSE handler)
 */

import { describe, expect, test } from "bun:test";
import { createWebClient, type WebBusEvent } from "./web-client.ts";

describe("createWebClient — message ids", () => {
  test("sendMessage assigns monotonic message_ids starting at 1", async () => {
    const c = createWebClient();
    const a = await c.sendMessage(42, "first");
    const b = await c.sendMessage(42, "second");
    expect(a.message_id).toBe(1);
    expect(b.message_id).toBe(2);
  });

  test("editMessageText returns a Message with the provided message_id", async () => {
    const c = createWebClient();
    const r = await c.editMessageText(42, 17, "edited");
    expect(typeof r === "object").toBe(true);
    if (typeof r === "object") expect(r.message_id).toBe(17);
  });
});

describe("createWebClient — bus events", () => {
  test("subscriber receives the message event with markdownSource forwarded", async () => {
    const c = createWebClient();
    const events: WebBusEvent[] = [];
    c.subscribe((e) => events.push(e));
    await c.sendMessage(42, "<b>hi</b>", { parse_mode: "HTML", markdownSource: "**hi**" });
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.kind).toBe("message");
    if (e.kind !== "message") throw new Error("unreachable");
    expect(e.chat_id).toBe(42);
    expect(e.html).toBe("<b>hi</b>");
    expect(e.markdown_source).toBe("**hi**");
    expect(e.reply_markup).toBeNull();
  });

  test("editMessageText emits an edit event with markdown_source", async () => {
    const c = createWebClient();
    const events: WebBusEvent[] = [];
    c.subscribe((e) => events.push(e));
    await c.editMessageText(42, 7, "<i>e</i>", { parse_mode: "HTML", markdownSource: "*e*" });
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.kind).toBe("edit");
    if (e.kind !== "edit") throw new Error("unreachable");
    expect(e.message_id).toBe(7);
    expect(e.markdown_source).toBe("*e*");
  });

  test("reply_markup (inline keyboard) is forwarded for tool-confirm prompts", async () => {
    const c = createWebClient();
    const events: WebBusEvent[] = [];
    c.subscribe((e) => events.push(e));
    const keyboard = { inline_keyboard: [[{ text: "Allow", callback_data: "cb:abc:a" }]] };
    await c.sendMessage(42, "confirm?", { reply_markup: keyboard });
    expect(events).toHaveLength(1);
    const e = events[0]!;
    if (e.kind !== "message") throw new Error("unreachable");
    expect(e.reply_markup).toEqual(keyboard);
  });

  test("setMessageReaction emits a reaction event", async () => {
    const c = createWebClient();
    const events: WebBusEvent[] = [];
    c.subscribe((e) => events.push(e));
    await c.setMessageReaction(42, 3, "👍");
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.kind).toBe("reaction");
    if (e.kind !== "reaction") throw new Error("unreachable");
    expect(e.emoji).toBe("👍");
  });

  test("missing markdownSource → markdown_source is null in event", async () => {
    const c = createWebClient();
    const events: WebBusEvent[] = [];
    c.subscribe((e) => events.push(e));
    await c.sendMessage(42, "html only");
    const e = events[0]!;
    if (e.kind !== "message") throw new Error("unreachable");
    expect(e.markdown_source).toBeNull();
  });

  test("publishedCount tracks every emit", async () => {
    const c = createWebClient();
    expect(c.publishedCount()).toBe(0);
    await c.sendMessage(1, "a");
    await c.editMessageText(1, 1, "b");
    await c.setMessageReaction(1, 1, "🎉");
    expect(c.publishedCount()).toBe(3);
  });
});

describe("createWebClient — subscriber lifecycle", () => {
  test("returned unsubscribe stops further events", async () => {
    const c = createWebClient();
    const events: WebBusEvent[] = [];
    const off = c.subscribe((e) => events.push(e));
    await c.sendMessage(1, "a");
    off();
    await c.sendMessage(1, "b");
    expect(events).toHaveLength(1);
  });

  test("explicit unsubscribe(cb) also works", async () => {
    const c = createWebClient();
    const events: WebBusEvent[] = [];
    const cb = (e: WebBusEvent) => events.push(e);
    c.subscribe(cb);
    await c.sendMessage(1, "a");
    c.unsubscribe(cb);
    await c.sendMessage(1, "b");
    expect(events).toHaveLength(1);
  });

  test("a throwing subscriber does not poison other subscribers", async () => {
    const c = createWebClient();
    const seen: string[] = [];
    c.subscribe(() => {
      throw new Error("boom");
    });
    c.subscribe((e) => {
      if (e.kind === "message") seen.push(e.html);
    });
    await c.sendMessage(1, "after-boom");
    expect(seen).toEqual(["after-boom"]);
  });

  test("multiple subscribers each receive every event", async () => {
    const c = createWebClient();
    const a: number[] = [];
    const b: number[] = [];
    c.subscribe((e) => {
      if (e.kind === "message") a.push(e.message_id);
    });
    c.subscribe((e) => {
      if (e.kind === "message") b.push(e.message_id);
    });
    await c.sendMessage(1, "x");
    await c.sendMessage(1, "y");
    expect(a).toEqual([1, 2]);
    expect(b).toEqual([1, 2]);
  });
});

describe("createWebClient — TelegramClient surface", () => {
  test("getMe returns synthetic identity", async () => {
    const c = createWebClient({ botName: "test-bot" });
    const me = await c.getMe();
    expect(me.id).toBe(-1);
    expect(me.is_bot).toBe(true);
    expect(me.username).toBe("test-bot");
  });

  test("getUpdates returns empty (web does not poll)", async () => {
    const c = createWebClient();
    const u = await c.getUpdates({ offset: 0, timeout: 30 });
    expect(u).toEqual([]);
  });

  test("sendChatAction and setMyCommands are no-ops returning true", async () => {
    const c = createWebClient();
    expect(await c.sendChatAction(1, "typing")).toBe(true);
    expect(await c.setMyCommands([])).toBe(true);
  });

  test("call() throws — guards against accidental coupling regressions", async () => {
    const c = createWebClient();
    await expect(c.call("anyMethod")).rejects.toThrow(/not implemented/);
  });
});
