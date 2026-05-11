/**
 * @fileoverview Built-in Gmail integration — multi-account OAuth2 + 11 ops.
 * @purpose Port of `apps/utcp-tools/src/integrations/gmail/` adapted to
 *          solrac's `setup(ctx) → IntegrationModule` contract.
 *
 * Design choices that differ from the Linear *example* (`examples/integrations/linear/`):
 *
 *   - This is BLESSED (`src/integrations-builtin/gmail/`), not an example.
 *     It always loads when integrations are enabled. It self-gates: missing
 *     `googleapis` dep → no-op; missing credentials → no-op. Solrac runs
 *     normally either way.
 *
 *   - Heavier deps (`googleapis` + `google-auth-library`, ~30MB combined)
 *     are NOT in solrac's package.json. Operators who want Gmail run
 *     `npm install googleapis google-auth-library` from the solrac root.
 *     The `setup()` here probes `loadGoogleModules()` at boot; absent → log
 *     once + return zero tools.
 *
 *   - 11 ops total (matching utcp-tools): 5 reads (auto tier — no Telegram
 *     prompt), 4 organization mutations (confirm tier), 2 destructive ops
 *     (`gmail_delete_message` + `gmail_send_message`) which are confirm
 *     tier AND require an explicit `confirm: true` body field per call.
 *     Belt-and-suspenders: tier-confirm covers user intent, body-confirm
 *     covers model intent — both must be satisfied to send/delete.
 *
 *   - Credential paths: `~/.solrac/gmail/` (NOT inside the source tree).
 *     `accounts.json` enumerates aliases; `<alias>.json` holds OAuth
 *     tokens; `credentials.json` holds the OAuth client_id+secret. Operator
 *     runs `solrac gmail-auth <alias>` once per account to populate.
 *
 * Cross-references:
 *   - apps/utcp-tools/src/integrations/gmail/ — original (HTTP-server form)
 *   - src/integrations-builtin/gmail/auth-cli.ts — `solrac gmail-auth` bootstrap
 *   - docs/USAGE.md#integrations — operator setup walkthrough
 */

import type {
  IntegrationContext,
  IntegrationModule,
} from "../../integrations.ts";
import {
  createGmailClientApi,
  googleModulesAvailable,
} from "./client.ts";
import {
  buildMimeMessage,
  encodeMimeForGmail,
  extractHeaders,
  formatFullMessage,
  formatLabel,
  formatMessageSummary,
} from "./formatters.ts";

type LooseAny = any;
type ToolResult = { content: Array<{ type: "text"; text: string }> };

function jsonResult(payload: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

// `invalid_grant` is what Google's OAuth token endpoint returns when a
// refresh token has been revoked or expired. It surfaces from googleapis'
// auto-refresh path as a 400 (NOT 401), and the marker can live either on
// the top-level error message or under `response.data.error`. Detect both.
// Common cause for solrac operators: OAuth client is in "Testing" status
// and the 7-day refresh-token TTL elapsed; fix is to re-run the bootstrap
// script per affected alias.
function isInvalidGrant(err: unknown): boolean {
  const e = err as LooseAny;
  const message = typeof e?.message === "string" ? e.message : "";
  const dataError = typeof e?.response?.data?.error === "string"
    ? e.response.data.error
    : "";
  return message.includes("invalid_grant") || dataError === "invalid_grant";
}

function errorResult(err: unknown, account?: string): ToolResult {
  const e = err as LooseAny;
  // Friendly message for the most common operator failure modes; falls back
  // to the raw error string. The model receives this verbatim — keep it
  // actionable.
  const status = e?.response?.status ?? e?.code ?? null;
  const apiMessage = e?.response?.data?.error?.message ?? e?.message ?? String(err);

  // Auth-required path covers both:
  //   - HTTP 401 from the Gmail API (rare; auto-refresh usually handles)
  //   - invalid_grant from the OAuth token endpoint (refresh-token revoked)
  // The latter is what operators most commonly hit when an OAuth client
  // sits in "Testing" mode beyond Google's 7-day refresh-token TTL.
  if (status === 401 || isInvalidGrant(err)) {
    const aliasHint = account ?? "<alias>";
    return jsonResult({
      success: false,
      error:
        `Gmail authentication needs renewal for "${aliasHint}". ` +
        `Run: solrac gmail-auth ${aliasHint}`,
      authRequired: true,
    });
  }
  if (status === 403) {
    return jsonResult({
      success: false,
      error: `Permission denied: ${apiMessage}. Re-auth may be needed with the correct scope.`,
    });
  }
  if (status === 404) {
    return jsonResult({ success: false, error: apiMessage });
  }
  if (status === 429) {
    return jsonResult({
      success: false,
      error: "Gmail rate limit exceeded. Retry in 60 seconds.",
      retryAfter: 60,
    });
  }
  return jsonResult({ success: false, error: apiMessage });
}

function toArray<T>(value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value];
}

// Truncate any single rendered line so a 200-message bulk action doesn't
// produce a 50KB confirm prompt. Subjects above this cap are tail-trimmed
// with an ellipsis. Number tuned by hand: 90 chars fits a typical desktop
// row without wrapping.
const MAX_SUBJECT_DISPLAY_LEN = 90;
// Message-list cap for confirm-prompt rendering. Beyond this, we summarize
// "and N more" so the prompt never blows past Telegram's ~4KB practical ceiling.
const MAX_MESSAGE_ROWS = 12;

interface MessageDigest {
  id: string;
  subject: string;
  from: string;
}

// Strip emoji code points from operator-display strings. Email subjects
// from marketers love leading 🚀✨🚗 noise that adds nothing to a confirm
// prompt; the regex covers Extended_Pictographic plus the ZWJ + variation
// selectors that compose multi-codepoint emoji. Run after subject extraction.
function stripEmojis(s: string): string {
  return s
    .replace(/[\p{Extended_Pictographic}‍️]+/gu, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Escape characters that would break our markdown interpolation: backticks
// (would close inline code), backslashes, and asterisks/underscores at word
// boundaries (would render as bold/italic). Subjects are user-controlled so
// we have to assume hostile input.
function mdEsc(s: string): string {
  return s.replace(/[\\`*_~[\]()<>]/g, (m) => `\\${m}`);
}

function shortenSubject(s: string): string {
  if (s.length <= MAX_SUBJECT_DISPLAY_LEN) return s;
  return s.slice(0, MAX_SUBJECT_DISPLAY_LEN - 1) + "…";
}

// Strip an RFC-5322 display name's "Name <email>" wrapping so we can show
// just "Name" — falls back to the raw value when the format isn't matched.
function shortenFrom(raw: string): string {
  const trimmed = raw.trim();
  const m = /^"?([^"<]+?)"?\s*<[^>]+>\s*$/.exec(trimmed);
  if (m && m[1]) return m[1].trim();
  return trimmed;
}

async function fetchDigests(
  c: LooseAny,
  ids: ReadonlyArray<string>,
): Promise<MessageDigest[]> {
  // Cap the per-render fan-out. Callers with N>MAX_MESSAGE_ROWS get the
  // first MAX_MESSAGE_ROWS expanded plus an overflow line; we only pay for
  // the visible ones.
  const visible = ids.slice(0, MAX_MESSAGE_ROWS);
  const results = await Promise.all(
    visible.map(async (id): Promise<MessageDigest> => {
      try {
        const res = await c.users.messages.get({
          userId: "me",
          id,
          format: "metadata",
          metadataHeaders: ["Subject", "From"],
        });
        const headers = extractHeaders(res.data.payload?.headers);
        return {
          id,
          subject: stripEmojis(headers.subject?.trim() || "") || "(no subject)",
          from: stripEmojis(headers.from?.trim() || "") || "(unknown sender)",
        };
      } catch {
        return {
          id,
          subject: `(metadata unavailable · id: ${id.slice(-8)})`,
          from: "",
        };
      }
    }),
  );
  return results;
}

// Markdown bullet list. Both marked (web) and `mdToTelegramHtml` (Telegram)
// render `- item` lines as a list — web gets `<ul><li>`, Telegram gets `•`
// per-item with proper line breaks.
function renderMessageList(
  digests: ReadonlyArray<MessageDigest>,
  totalCount: number,
): string {
  const lines = digests.map((d) => {
    const subject = mdEsc(shortenSubject(d.subject));
    const from =
      d.from === "" ? "" : ` — *${mdEsc(shortenSubject(shortenFrom(d.from)))}*`;
    return `- ${subject}${from}`;
  });
  if (totalCount > digests.length) {
    lines.push(`- *…and ${totalCount - digests.length} more*`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------

export default async function setup(
  ctx: IntegrationContext,
): Promise<IntegrationModule> {
  // Boot-time gate: if either dep is missing OR no credentials are present,
  // register zero tools. Solrac continues normally; the agent simply doesn't
  // see Gmail tools. Each gate logs ONCE so operators see why.

  const haveDeps = await googleModulesAvailable();
  if (!haveDeps) {
    ctx.log.warn("integrations.gmail.deps_missing", {
      hint: "Run `npm install googleapis google-auth-library` from the solrac root to enable.",
    });
    return { apiVersion: 1, tools: [] };
  }

  const api = createGmailClientApi(ctx.solracHome);

  if (!api.isGmailConfigured()) {
    ctx.log.info("integrations.gmail.disabled", {
      reason: "credentials.json absent",
      expectedAt: api.paths.credentialsPath,
      hint:
        "Download OAuth client_id+secret from Google Cloud Console " +
        `(APIs & Services → Credentials), save as ${api.paths.credentialsPath}.`,
    });
    return { apiVersion: 1, tools: [] };
  }
  if (!api.hasConfiguredAccounts()) {
    ctx.log.info("integrations.gmail.no_accounts", {
      hint: "Run `solrac gmail-auth <alias>` once per account to authenticate.",
    });
    return { apiVersion: 1, tools: [] };
  }

  const log = (event: string, fields: Record<string, unknown>): void => {
    ctx.log.info(event, fields);
  };

  // Common: fetch a Gmail client by account, surfacing friendly errors.
  async function client(account: string): Promise<LooseAny> {
    return await api.getGmailClient(account, log);
  }

  // ---------------------------------------------------------------------------
  // Confirm-prompt formatters (Issue: opaque message IDs in confirm prompts)
  // ---------------------------------------------------------------------------
  //
  // The broker calls these BEFORE rendering the inline-keyboard prompt so the
  // operator sees email subjects + senders instead of raw `messageIds`. Cost
  // is a single batched `messages.get(format:metadata)` per render — bounded
  // to MAX_MESSAGE_ROWS so a 200-message bulk action doesn't fan out.
  //
  // All formatters fail-soft: a Gmail API error inside renderMessageList
  // produces "metadata unavailable · id: ..." rows but never throws. The
  // broker has its own JSON-fallback path if these throw, so worst case is
  // the operator sees the original opaque payload.

  type LabelArgs = {
    account: string;
    messageIds: string | string[];
    labelIds: string | string[];
  };
  type MessageIdsArgs = { account: string; messageIds: string | string[] };
  type SendArgs = {
    account: string;
    to: string | string[];
    cc?: string | string[];
    bcc?: string | string[];
    subject: string;
    body: string;
    bodyType?: "text" | "html";
    replyTo?: string;
    attachments?: ReadonlyArray<unknown>;
  };

  async function formatMessageIdsAction(
    verb: string,
    input: unknown,
  ): Promise<string> {
    const args = input as MessageIdsArgs;
    const ids = toArray(args.messageIds);
    const c = await client(args.account);
    const digests = await fetchDigests(c, ids);
    const account = mdEsc(args.account);
    const list = renderMessageList(digests, ids.length);
    const noun = ids.length === 1 ? "message" : "messages";
    return `${verb} **${ids.length}** ${noun} in **${account}**:\n\n${list}`;
  }

  async function formatLabelAction(
    verb: string,
    input: unknown,
  ): Promise<string> {
    const args = input as LabelArgs;
    const ids = toArray(args.messageIds);
    const labels = toArray(args.labelIds).map(mdEsc).join(", ");
    const c = await client(args.account);
    const digests = await fetchDigests(c, ids);
    const account = mdEsc(args.account);
    const list = renderMessageList(digests, ids.length);
    const noun = ids.length === 1 ? "message" : "messages";
    const preposition = verb === "Apply" ? "to" : "from";
    return `${verb} \`${labels}\` ${preposition} **${ids.length}** ${noun} in **${account}**:\n\n${list}`;
  }

  function formatSendAction(input: unknown): string {
    const args = input as SendArgs;
    const to = toArray(args.to).map(mdEsc).join(", ");
    const cc = args.cc ? toArray(args.cc).map(mdEsc).join(", ") : null;
    const bcc = args.bcc ? toArray(args.bcc).map(mdEsc).join(", ") : null;
    const subject = mdEsc(args.subject || "(no subject)");
    const account = mdEsc(args.account);
    const bodyPreview =
      args.body.length > 240 ? args.body.slice(0, 240) + "…" : args.body;
    const attachCount = args.attachments?.length ?? 0;
    const lines: string[] = [
      `Send email **from** **${account}**`,
      `- **To:** ${to}`,
    ];
    if (cc) lines.push(`- **Cc:** ${cc}`);
    if (bcc) lines.push(`- **Bcc:** ${bcc}`);
    lines.push(`- **Subject:** *${subject}*`);
    if (attachCount > 0) {
      const noun = attachCount === 1 ? "file" : "files";
      lines.push(`- **Attachments:** ${attachCount} ${noun}`);
    }
    if (args.replyTo) {
      lines.push(`- *(reply to message ${mdEsc(args.replyTo)})*`);
    }
    lines.push("");
    // Body preview as a fenced code block — both renderers preserve newlines
    // inside `<pre>`, so multi-line bodies stay readable.
    lines.push("```");
    lines.push(bodyPreview);
    lines.push("```");
    return lines.join("\n");
  }

  const tools = [
    // ===== READS (auto tier) =====

    // gmail_list_accounts
    ctx.tool(
      "gmail_list_accounts",
      "List all configured Gmail accounts (aliases + email addresses). " +
        "Use this FIRST before other Gmail tools to discover which accounts " +
        "are available — every other Gmail tool requires an `account` param.",
      {},
      async (): Promise<ToolResult> => {
        try {
          const accounts = api.listAccounts();
          return jsonResult({
            success: true,
            count: accounts.length,
            accounts,
          });
        } catch (err) {
          return errorResult(err);
        }
      },
      { alwaysLoad: true },
    ),

    // gmail_list_labels
    ctx.tool(
      "gmail_list_labels",
      "List all Gmail labels for an account (system labels like INBOX, " +
        "SENT, TRASH and user-created labels). Use to discover label IDs " +
        "for filtering or for gmail_apply_label / gmail_remove_label.",
      {
        account: ctx.z
          .string()
          .describe('Account alias (e.g. "personal") or email address.'),
      },
      async (args): Promise<ToolResult> => {
        try {
          const c = await client(args.account);
          const list = await c.users.labels.list({ userId: "me" });
          const labels = list.data.labels ?? [];
          // Get full detail (incl. counts) for each label.
          const formatted = await Promise.all(
            labels.map(async (label: LooseAny) => {
              try {
                const detail = await c.users.labels.get({
                  userId: "me",
                  id: label.id!,
                });
                return formatLabel(detail.data);
              } catch {
                return formatLabel(label);
              }
            }),
          );
          return jsonResult({
            success: true,
            count: formatted.length,
            labels: formatted,
          });
        } catch (err) {
          return errorResult(err, args.account);
        }
      },
      { alwaysLoad: true },
    ),

    // gmail_search_messages
    ctx.tool(
      "gmail_search_messages",
      "Search Gmail using its native query syntax. Returns message " +
        "summaries (id, threadId, snippet, from, subject, date, labels). " +
        "Use gmail_get_message for full content.\n\n" +
        "Common operators: from:, to:, subject:, has:attachment, " +
        "is:unread, is:starred, in:inbox|sent|trash|spam, " +
        "label:<id>, after:YYYY/MM/DD, before:YYYY/MM/DD, " +
        "newer_than:7d, older_than:1m. Combine with spaces (AND) " +
        "or OR; exclude with `-`.",
      {
        account: ctx.z.string(),
        query: ctx.z.string().describe("Gmail search query."),
        maxResults: ctx.z
          .number()
          .min(1)
          .max(100)
          .optional()
          .describe("Max messages to return (default 10, max 100)."),
        includeSpamTrash: ctx.z.boolean().optional(),
      },
      async (args): Promise<ToolResult> => {
        try {
          const c = await client(args.account);
          const list = await c.users.messages.list({
            userId: "me",
            q: args.query,
            maxResults: Math.min(args.maxResults ?? 10, 100),
            includeSpamTrash: args.includeSpamTrash ?? false,
          });
          const refs: LooseAny[] = list.data.messages ?? [];
          const messages = await Promise.all(
            refs.map(async (ref: LooseAny) => {
              const msg = await c.users.messages.get({
                userId: "me",
                id: ref.id!,
                format: "metadata",
                metadataHeaders: ["From", "To", "Subject", "Date"],
              });
              return formatMessageSummary(msg.data);
            }),
          );
          return jsonResult({
            success: true,
            count: messages.length,
            resultSizeEstimate: list.data.resultSizeEstimate,
            nextPageToken: list.data.nextPageToken,
            messages,
          });
        } catch (err) {
          return errorResult(err, args.account);
        }
      },
      { alwaysLoad: true },
    ),

    // gmail_get_message
    ctx.tool(
      "gmail_get_message",
      "Get full message content by ID — headers, plain-text and HTML " +
        "bodies, attachment metadata. Use messageId from search results.",
      {
        account: ctx.z.string(),
        messageId: ctx.z.string(),
        format: ctx.z
          .enum(["minimal", "metadata", "full"])
          .optional()
          .describe("minimal | metadata | full (default)."),
      },
      async (args): Promise<ToolResult> => {
        try {
          const c = await client(args.account);
          const res = await c.users.messages.get({
            userId: "me",
            id: args.messageId,
            format: args.format ?? "full",
          });
          return jsonResult({
            success: true,
            message: formatFullMessage(res.data),
          });
        } catch (err) {
          return errorResult(err, args.account);
        }
      },
      { alwaysLoad: true },
    ),

    // gmail_list_threads
    ctx.tool(
      "gmail_list_threads",
      "List email threads (conversation groups). Each thread contains " +
        "multiple messages. Useful for reviewing email chains end-to-end.",
      {
        account: ctx.z.string(),
        query: ctx.z
          .string()
          .optional()
          .describe("Optional Gmail query — same syntax as search_messages."),
        maxResults: ctx.z.number().min(1).max(100).optional(),
        includeSpamTrash: ctx.z.boolean().optional(),
      },
      async (args): Promise<ToolResult> => {
        try {
          const c = await client(args.account);
          const list = await c.users.threads.list({
            userId: "me",
            q: args.query,
            maxResults: Math.min(args.maxResults ?? 10, 100),
            includeSpamTrash: args.includeSpamTrash ?? false,
          });
          const refs: LooseAny[] = list.data.threads ?? [];
          const threads = await Promise.all(
            refs.map(async (ref: LooseAny) => {
              const t = await c.users.threads.get({
                userId: "me",
                id: ref.id!,
                format: "metadata",
                metadataHeaders: ["From", "Subject", "Date"],
              });
              const msgs: LooseAny[] = t.data.messages ?? [];
              return {
                id: t.data.id ?? "",
                snippet: t.data.snippet ?? "",
                historyId: t.data.historyId,
                messageCount: msgs.length,
                messages: msgs.map((msg: LooseAny) => {
                  const hdrs = extractHeaders(msg.payload?.headers);
                  return {
                    id: msg.id ?? "",
                    from: hdrs.from,
                    subject: hdrs.subject,
                    date: hdrs.date,
                    snippet: msg.snippet ?? "",
                  };
                }),
              };
            }),
          );
          return jsonResult({
            success: true,
            count: threads.length,
            resultSizeEstimate: list.data.resultSizeEstimate,
            nextPageToken: list.data.nextPageToken,
            threads,
          });
        } catch (err) {
          return errorResult(err, args.account);
        }
      },
      { alwaysLoad: true },
    ),

    // ===== ORGANIZATION (confirm tier — see meta.toolTiers below) =====

    // gmail_apply_label
    ctx.tool(
      "gmail_apply_label",
      "Apply one or more labels to one or more messages. Common labels: " +
        "STARRED, IMPORTANT, or custom IDs from gmail_list_labels.",
      {
        account: ctx.z.string(),
        messageIds: ctx.z
          .union([ctx.z.string(), ctx.z.array(ctx.z.string())])
          .describe("Single ID or array."),
        labelIds: ctx.z
          .union([ctx.z.string(), ctx.z.array(ctx.z.string())])
          .describe("Single label ID or array."),
      },
      async (args): Promise<ToolResult> => {
        try {
          const c = await client(args.account);
          const msgIds = toArray(args.messageIds);
          const lblIds = toArray(args.labelIds);
          await Promise.all(
            msgIds.map((id) =>
              c.users.messages.modify({
                userId: "me",
                id,
                requestBody: { addLabelIds: lblIds },
              }),
            ),
          );
          return jsonResult({
            success: true,
            modified: msgIds.length,
            labelsApplied: lblIds,
          });
        } catch (err) {
          return errorResult(err, args.account);
        }
      },
      { alwaysLoad: true },
    ),

    // gmail_remove_label
    ctx.tool(
      "gmail_remove_label",
      "Remove labels from messages. Common: remove UNREAD (mark read), " +
        "remove STARRED (unstar), remove custom labels.",
      {
        account: ctx.z.string(),
        messageIds: ctx.z.union([ctx.z.string(), ctx.z.array(ctx.z.string())]),
        labelIds: ctx.z.union([ctx.z.string(), ctx.z.array(ctx.z.string())]),
      },
      async (args): Promise<ToolResult> => {
        try {
          const c = await client(args.account);
          const msgIds = toArray(args.messageIds);
          const lblIds = toArray(args.labelIds);
          await Promise.all(
            msgIds.map((id) =>
              c.users.messages.modify({
                userId: "me",
                id,
                requestBody: { removeLabelIds: lblIds },
              }),
            ),
          );
          return jsonResult({
            success: true,
            modified: msgIds.length,
            labelsRemoved: lblIds,
          });
        } catch (err) {
          return errorResult(err, args.account);
        }
      },
      { alwaysLoad: true },
    ),

    // gmail_archive_message — remove INBOX label
    ctx.tool(
      "gmail_archive_message",
      "Archive messages by removing the INBOX label. Reversible — apply " +
        "INBOX again with gmail_apply_label.",
      {
        account: ctx.z.string(),
        messageIds: ctx.z.union([ctx.z.string(), ctx.z.array(ctx.z.string())]),
      },
      async (args): Promise<ToolResult> => {
        try {
          const c = await client(args.account);
          const msgIds = toArray(args.messageIds);
          await Promise.all(
            msgIds.map((id) =>
              c.users.messages.modify({
                userId: "me",
                id,
                requestBody: { removeLabelIds: ["INBOX"] },
              }),
            ),
          );
          return jsonResult({ success: true, archived: msgIds.length });
        } catch (err) {
          return errorResult(err, args.account);
        }
      },
      { alwaysLoad: true },
    ),

    // gmail_trash_message — recoverable for 30 days
    ctx.tool(
      "gmail_trash_message",
      "Move messages to Trash. Recoverable for 30 days. For permanent " +
        "deletion use gmail_delete_message (requires confirm:true).",
      {
        account: ctx.z.string(),
        messageIds: ctx.z.union([ctx.z.string(), ctx.z.array(ctx.z.string())]),
      },
      async (args): Promise<ToolResult> => {
        try {
          const c = await client(args.account);
          const msgIds = toArray(args.messageIds);
          await Promise.all(
            msgIds.map((id) => c.users.messages.trash({ userId: "me", id })),
          );
          return jsonResult({ success: true, trashed: msgIds.length });
        } catch (err) {
          return errorResult(err, args.account);
        }
      },
      { alwaysLoad: true },
    ),

    // ===== DESTRUCTIVE (confirm tier + body confirm field) =====

    // gmail_delete_message — IRREVERSIBLE
    ctx.tool(
      "gmail_delete_message",
      "PERMANENTLY delete messages. CANNOT be recovered. For safe " +
        "deletion, use gmail_trash_message (recoverable 30 days). " +
        "Requires `confirm: true` to execute (belt-and-suspenders alongside " +
        "the user's Telegram-confirm prompt).",
      {
        account: ctx.z.string(),
        messageIds: ctx.z.union([ctx.z.string(), ctx.z.array(ctx.z.string())]),
        confirm: ctx.z
          .literal(true)
          .describe(
            "Must be exactly `true`. The MODEL must explicitly assert " +
              "intent before the user's Telegram approval is even shown.",
          ),
      },
      async (args): Promise<ToolResult> => {
        try {
          if (args.confirm !== true) {
            return jsonResult({
              success: false,
              error: "confirm must be exactly `true` to permanently delete.",
            });
          }
          const c = await client(args.account);
          const msgIds = toArray(args.messageIds);
          await Promise.all(
            msgIds.map((id) => c.users.messages.delete({ userId: "me", id })),
          );
          return jsonResult({
            success: true,
            deleted: msgIds.length,
            warning: "Messages have been permanently deleted and cannot be recovered.",
          });
        } catch (err) {
          return errorResult(err, args.account);
        }
      },
      { alwaysLoad: true },
    ),

    // gmail_send_message
    ctx.tool(
      "gmail_send_message",
      "Send an email. Supports plain text or HTML body, multiple " +
        "recipients (to/cc/bcc), reply threading, and base64-encoded " +
        "attachments. Requires `confirm: true` to send (belt-and-suspenders " +
        "alongside the user's Telegram-confirm prompt).",
      {
        account: ctx.z.string(),
        to: ctx.z.union([ctx.z.string(), ctx.z.array(ctx.z.string())]),
        cc: ctx.z
          .union([ctx.z.string(), ctx.z.array(ctx.z.string())])
          .optional(),
        bcc: ctx.z
          .union([ctx.z.string(), ctx.z.array(ctx.z.string())])
          .optional(),
        subject: ctx.z.string(),
        body: ctx.z.string(),
        bodyType: ctx.z.enum(["text", "html"]).optional(),
        replyTo: ctx.z
          .string()
          .optional()
          .describe(
            "Message ID to reply to. Sets In-Reply-To and References for threading.",
          ),
        attachments: ctx.z
          .array(
            ctx.z.object({
              filename: ctx.z.string(),
              content: ctx.z.string().describe("Base64-encoded file content."),
              mimeType: ctx.z.string(),
            }),
          )
          .optional(),
        confirm: ctx.z
          .literal(true)
          .describe(
            "Must be exactly `true`. The MODEL must explicitly assert " +
              "intent before the user's Telegram approval is even shown.",
          ),
      },
      async (args): Promise<ToolResult> => {
        try {
          if (args.confirm !== true) {
            return jsonResult({
              success: false,
              error: "confirm must be exactly `true` to send.",
            });
          }
          const resolved = api.resolveAccount(args.account);
          if (!resolved) {
            const available = api.getAvailableAccounts();
            return jsonResult({
              success: false,
              error: `Account "${args.account}" not found. Available: ${available.join(", ") || "(none)"}`,
            });
          }
          const c = await client(args.account);
          const toList = toArray(args.to);
          const ccList = args.cc ? toArray(args.cc) : undefined;
          const bccList = args.bcc ? toArray(args.bcc) : undefined;

          // If replying, fetch the original Message-ID so RFC threading
          // headers point at the right ancestor.
          let replyToMessageId: string | undefined;
          if (args.replyTo) {
            try {
              const orig = await c.users.messages.get({
                userId: "me",
                id: args.replyTo,
                format: "metadata",
                metadataHeaders: ["Message-ID"],
              });
              const idHdr = orig.data.payload?.headers?.find(
                (h: LooseAny) =>
                  String(h.name ?? "").toLowerCase() === "message-id",
              );
              replyToMessageId = idHdr?.value;
            } catch {
              // Couldn't fetch original — send unthreaded rather than fail.
            }
          }

          const mime = buildMimeMessage({
            from: resolved.info.email,
            to: toList,
            cc: ccList,
            bcc: bccList,
            subject: args.subject,
            body: args.body,
            bodyType: args.bodyType,
            replyToMessageId,
            attachments: args.attachments,
          });
          const raw = encodeMimeForGmail(mime);

          const res = await c.users.messages.send({
            userId: "me",
            requestBody: { raw },
          });
          return jsonResult({
            success: true,
            messageId: res.data.id ?? "",
            threadId: res.data.threadId ?? "",
            to: toList,
            subject: args.subject,
          });
        } catch (err) {
          return errorResult(err, args.account);
        }
      },
      { alwaysLoad: true },
    ),
  ];

  ctx.log.info("integrations.gmail.loaded", {
    accountCount: api.getAvailableAccounts().length,
    toolCount: tools.length,
  });

  return {
    apiVersion: 1,
    tools,
    meta: {
      // Default: confirm. We override the read tools to auto below.
      tier: "confirm",
      toolTiers: {
        // Read tools — no Telegram prompt. Cost cap and loop detector
        // still apply via PreToolUse.
        gmail_list_accounts: "auto",
        gmail_list_labels: "auto",
        gmail_search_messages: "auto",
        gmail_get_message: "auto",
        gmail_list_threads: "auto",
        // Mutating tools — keep confirm. Belt-and-suspenders for
        // gmail_delete_message + gmail_send_message via the body-level
        // `confirm: true` field.
        gmail_apply_label: "confirm",
        gmail_remove_label: "confirm",
        gmail_archive_message: "confirm",
        gmail_trash_message: "confirm",
        gmail_delete_message: "confirm",
        gmail_send_message: "confirm",
      },
      // Per-tool confirm-prompt formatters. The broker invokes these instead
      // of dumping JSON, so the operator sees subjects + senders for each
      // affected message rather than opaque IDs.
      confirmFormatters: {
        gmail_apply_label: (input) => formatLabelAction("Apply", input),
        gmail_remove_label: (input) => formatLabelAction("Remove", input),
        gmail_archive_message: (input) => formatMessageIdsAction("Archive", input),
        gmail_trash_message: (input) =>
          formatMessageIdsAction("Move to Trash (recoverable 30 days)", input),
        gmail_delete_message: (input) =>
          formatMessageIdsAction("**PERMANENTLY DELETE**", input),
        gmail_send_message: (input) => formatSendAction(input),
      },
    },
  };
}
