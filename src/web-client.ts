/**
 * @fileoverview WebClient — a `TelegramClient`-compatible sink that publishes
 *               outbound messages to an in-process bus instead of hitting
 *               Telegram's API. Consumed by the SSE handler in `web.ts`.
 * @purpose Drop-in transport for the web UI. agent.ts / local.ts / commands.ts
 *          already accept any `TelegramClient` — pointing them at this client
 *          gives the browser the same content stream the Telegram bot gets,
 *          without changing any business logic.
 *
 * Position in the dependency graph:
 *   telegram (types) → web-client → consumed by web (SSE) and main (wiring)
 *
 * Exports:
 *   - `createWebClient({ botName? })` — factory returning a `WebClient`.
 *   - `WebClient` — extends `TelegramClient` with `subscribe(cb)` and
 *     `unsubscribe(cb)` for SSE handlers, plus `publishedCount()` for tests.
 *   - `WebBusEvent` — the discriminated event the SSE handler forwards.
 *
 * Key invariants:
 *   - `message_id` values are monotonic non-zero integers, assigned per
 *     `sendMessage` call. `editMessageText` requires the consumer to remember
 *     which id to target — same as Telegram.
 *   - `markdownSource` (sidecar opt on SendMessageOpts) takes precedence over
 *     the HTML body for SSE delivery; consumers fall back to HTML when absent.
 *   - `setMyCommands` / `sendChatAction` are no-ops — the browser doesn't need
 *     "typing…" indicators or a /command autocomplete registry from us.
 *   - `getMe` returns a synthetic identity (`id: -1`) so callers that cache
 *     the bot username (group-chat addressing) behave; the value is never
 *     compared against a real Telegram id.
 *   - `call()` throws — only the typed methods are used by the agent/policy/
 *     commands path. Unexpected calls would hide a coupling regression.
 *
 * Gotchas:
 *   - The bus has no buffering. If no subscriber is attached when a turn
 *     starts (e.g. browser closed mid-turn), events are dropped silently —
 *     just like Telegram drops messages to a chat the user has muted. The
 *     audit row is the durable record.
 */

import type { Message } from "@grammyjs/types";
import type { BotIdentity, SendMessageOpts, TelegramClient } from "./telegram.ts";

export type WebBusEvent =
  | {
      kind: "message";
      chat_id: number;
      message_id: number;
      html: string;
      markdown_source: string | null;
      reply_markup: unknown | null;
    }
  | {
      kind: "edit";
      chat_id: number;
      message_id: number;
      html: string;
      markdown_source: string | null;
    }
  | {
      kind: "reaction";
      chat_id: number;
      message_id: number;
      emoji: string;
    };

export type WebBusSubscriber = (event: WebBusEvent) => void;

export interface WebClient extends TelegramClient {
  subscribe(cb: WebBusSubscriber): () => void;
  unsubscribe(cb: WebBusSubscriber): void;
  publishedCount(): number;
  /** Synthetic bot identity; useful for tests and `getMe` callers. */
  readonly identity: BotIdentity;
}

export interface WebClientOpts {
  botName?: string;
}

const SYNTHETIC_DATE = () => Math.floor(Date.now() / 1000);

export function createWebClient(opts: WebClientOpts = {}): WebClient {
  const subscribers = new Set<WebBusSubscriber>();
  let nextMessageId = 1;
  let publishedCount = 0;
  const identity: BotIdentity = {
    id: -1,
    is_bot: true,
    first_name: opts.botName ?? "solrac-web",
    username: opts.botName ?? "solrac_web",
  };

  function publish(event: WebBusEvent): void {
    publishedCount++;
    for (const cb of subscribers) {
      try {
        cb(event);
      } catch {
        // A failing subscriber must not poison the others. Best-effort.
      }
    }
  }

  function makeMessage(chatId: number, text: string, messageId: number): Message {
    return {
      message_id: messageId,
      date: SYNTHETIC_DATE(),
      chat: {
        id: chatId,
        type: "private",
        first_name: identity.first_name,
      },
      from: {
        id: identity.id,
        is_bot: identity.is_bot,
        first_name: identity.first_name,
        username: identity.username,
      },
      text,
    };
  }

  return {
    identity,
    subscribe(cb) {
      subscribers.add(cb);
      return () => {
        subscribers.delete(cb);
      };
    },
    unsubscribe(cb) {
      subscribers.delete(cb);
    },
    publishedCount() {
      return publishedCount;
    },
    async call() {
      throw new Error("WebClient.call is not implemented — use the typed helpers");
    },
    async getUpdates() {
      // The web transport does not poll — clients post via /api/message.
      return [];
    },
    async sendMessage(chatId: number, text: string, options?: SendMessageOpts) {
      const messageId = nextMessageId++;
      publish({
        kind: "message",
        chat_id: chatId,
        message_id: messageId,
        html: text,
        markdown_source: options?.markdownSource ?? null,
        reply_markup: options?.reply_markup ?? null,
      });
      return makeMessage(chatId, text, messageId);
    },
    async editMessageText(
      chatId: number,
      messageId: number,
      text: string,
      options?: SendMessageOpts,
    ) {
      publish({
        kind: "edit",
        chat_id: chatId,
        message_id: messageId,
        html: text,
        markdown_source: options?.markdownSource ?? null,
      });
      return makeMessage(chatId, text, messageId);
    },
    async setMessageReaction(chatId: number, messageId: number, emoji: string) {
      publish({ kind: "reaction", chat_id: chatId, message_id: messageId, emoji });
      return true as const;
    },
    async sendChatAction() {
      return true as const;
    },
    async getMe() {
      return identity;
    },
    async setMyCommands() {
      return true as const;
    },
  };
}
