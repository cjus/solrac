/**
 * @fileoverview Raw Telegram Bot API client (no framework runtime).
 * @purpose Issue HTTPS POSTs to api.telegram.org with structured error
 *          handling for the two responses Solrac specifically cares about:
 *          429 (rate limit, retry after `parameters.retry_after`) and 409
 *          (conflict — another consumer is calling getUpdates).
 *
 * Solrac uses `@grammyjs/types` for type definitions only. The framework's
 * runtime (router, middleware, sessions) is not used — see
 * docs/ARCHITECTURE.md#anti-goals for why. ~130 lines of `fetch` is more
 * legible than wiring grammY's session middleware around a single bot.
 *
 * The 429 retry parses `parameters.retry_after` as a float because some
 * Telegram clients return sub-second values (0.5, 1.2). `Bun.sleep` accepts
 * fractional ms so we multiply and floor.
 *
 * The 409 path throws `TelegramConflictError` instead of looping. `poll.ts`
 * catches that specific error and exits 1 — letting systemd restart and the
 * next boot's stale-PID detection clean up. See docs/RUNBOOK.md#409-conflict.
 *
 * Position in the dependency graph:
 *   log + config → telegram → consumed by poll, agent, policy (broker),
 *                              daily-report, main (callback ack)
 *
 * Exports:
 *   - `createTelegramClient(token)` — factory returning a `TelegramClient`.
 *   - `TelegramClient` — interface with generic `call`, plus typed helpers:
 *     `getUpdates`, `sendMessage`, `editMessageText`, `setMessageReaction`,
 *     `sendChatAction`.
 *   - `TelegramConflictError` — 409 variant; signals "exit 1, don't retry."
 *   - `TelegramApiError` — generic non-409, non-429 API failure.
 *   - `htmlEscapeText(s)` — escape `&`, `<`, `>` for HTML text-context interpolation.
 *   - `htmlEscapeAttr(s)` — escape `&`, `<`, `>`, `"`, `'` for HTML attribute-context
 *     interpolation (OWASP 5-char form). Use this for `href`, `src`, `data-*`, etc.
 *   - `GetUpdatesParams`, supporting types.
 *
 * Key invariants:
 *   - Outbound `parse_mode` is HTML throughout Solrac (NOT MarkdownV2 — only
 *     three escape chars). `htmlEscapeText` is the canonical text-context escape;
 *     `htmlEscapeAttr` is the canonical attribute-context escape. Pick by where
 *     the value lands — text content vs. inside an `attr="…"`. Today every call
 *     site is text-context; the split exists so a future attribute interpolation
 *     can't silently inherit the wrong helper (10.2 hardening).
 *   - 409 → throw `TelegramConflictError`. NEVER retry; that would race with
 *     the other consumer indefinitely.
 *   - 429 → retry with `Bun.sleep(retry_after * 1000)`, no backoff cap (we
 *     trust Telegram's `retry_after`).
 *   - `signal?: AbortSignal` is honored end-to-end; the poll loop's
 *     `pollAbort` lets lifecycle break out of long-poll waits.
 *
 * Gotchas:
 *   - `editMessageText` returns `Message | true` per Telegram's API: `true`
 *     when editing an inline-message that we don't own. Solrac always edits
 *     its own messages so it's effectively `Message`, but the type honors the
 *     spec.
 *   - 429s log a `telegram.rate_limited` warn line. If you see them
 *     repeatedly, the agent is firing too many tool calls per turn.
 *   - The base URL embeds the token. Don't log the URL — token leaks. We
 *     never do; if you add a debug log of the URL, redact `bot<token>`.
 *
 * Cross-references:
 *   - docs/RUNBOOK.md#409-conflict — full recovery procedure
 *   - docs/ARCHITECTURE.md#anti-goals — why no grammY runtime
 *   - poll.ts — primary consumer for `getUpdates`
 */

import type { Message, Update } from "@grammyjs/types";
import { log } from "./log.ts";

export class TelegramConflictError extends Error {
  constructor(public readonly description: string) {
    super(`Telegram 409 Conflict: ${description}`);
    this.name = "TelegramConflictError";
  }
}

export class TelegramApiError extends Error {
  constructor(
    public readonly code: number,
    public readonly description: string,
  ) {
    super(`Telegram API ${code}: ${description}`);
    this.name = "TelegramApiError";
  }
}

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
}

interface SendMessageOpts {
  parse_mode?: "HTML";
  disable_web_page_preview?: boolean;
  reply_to_message_id?: number;
  reply_markup?: unknown;
}

type ChatAction =
  | "typing"
  | "upload_photo"
  | "upload_document"
  | "upload_video"
  | "record_voice";

export interface GetUpdatesParams {
  offset: number;
  timeout: number;
  allowed_updates?: ReadonlyArray<Exclude<keyof Update, "update_id">>;
}

// PNX-167 — surfaces of `getMe` Solrac actually consumes. Telegram returns
// more fields (can_join_groups, supports_inline_queries, etc.); we only need
// `username` to scope `/cmd@<bot>` group-chat targeting.
export interface BotIdentity {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

// PNX-167 — `setMyCommands` payload row.
export interface BotCommand {
  command: string;
  description: string;
}

export interface TelegramClient {
  call: <T>(
    method: string,
    body?: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<T>;
  getUpdates: (params: GetUpdatesParams, signal?: AbortSignal) => Promise<Update[]>;
  sendMessage: (chatId: number, text: string, opts?: SendMessageOpts) => Promise<Message>;
  editMessageText: (
    chatId: number,
    messageId: number,
    text: string,
    opts?: SendMessageOpts,
  ) => Promise<Message | true>;
  setMessageReaction: (chatId: number, messageId: number, emoji: string) => Promise<true>;
  sendChatAction: (chatId: number, action: ChatAction) => Promise<true>;
  // PNX-167 — boot-time helpers. `getMe` is called once to cache the bot
  // username for group-chat command parsing. `setMyCommands` registers the
  // four user-facing commands so Telegram clients show them in autocomplete.
  // Both are non-fatal at boot — wrapped in `.catch` at the call site.
  getMe: () => Promise<BotIdentity>;
  setMyCommands: (commands: ReadonlyArray<BotCommand>) => Promise<true>;
}

export function htmlEscapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function htmlEscapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function createTelegramClient(token: string): TelegramClient {
  const base = `https://api.telegram.org/bot${token}`;

  async function call<T>(
    method: string,
    body?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    let attempt = 0;
    while (true) {
      attempt++;
      const res = await fetch(`${base}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        signal,
      });
      const json = (await res.json()) as TelegramResponse<T>;
      if (json.ok) return json.result as T;
      const code = json.error_code ?? res.status;
      const description = json.description ?? "unknown";
      if (code === 409) throw new TelegramConflictError(description);
      if (code === 429) {
        const retryAfter = Number(json.parameters?.retry_after ?? 1);
        log.warn("telegram.rate_limited", { method, retryAfter, attempt });
        await Bun.sleep(Math.max(retryAfter * 1000, 100));
        continue;
      }
      throw new TelegramApiError(code, description);
    }
  }

  return {
    call,
    getUpdates(params, signal) {
      return call<Update[]>("getUpdates", params as unknown as Record<string, unknown>, signal);
    },
    sendMessage(chatId, text, opts) {
      return call<Message>("sendMessage", { chat_id: chatId, text, ...opts });
    },
    editMessageText(chatId, messageId, text, opts) {
      return call<Message | true>("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text,
        ...opts,
      });
    },
    setMessageReaction(chatId, messageId, emoji) {
      return call<true>("setMessageReaction", {
        chat_id: chatId,
        message_id: messageId,
        reaction: [{ type: "emoji", emoji }],
      });
    },
    sendChatAction(chatId, action) {
      return call<true>("sendChatAction", { chat_id: chatId, action });
    },
    getMe() {
      return call<BotIdentity>("getMe");
    },
    setMyCommands(commands) {
      return call<true>("setMyCommands", { commands });
    },
  };
}
