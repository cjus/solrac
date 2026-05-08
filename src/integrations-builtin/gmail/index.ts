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
 *     runs `bun scripts/gmail-auth.ts <alias>` once per account to populate.
 *
 * Cross-references:
 *   - apps/utcp-tools/src/integrations/gmail/ — original (HTTP-server form)
 *   - solrac/scripts/gmail-auth.ts — operator OAuth bootstrap
 *   - docs/USAGE.md#integrations — operator setup walkthrough
 */

import type {
  IntegrationContext,
  IntegrationModule,
} from "../../integrations.ts";
import {
  getAvailableAccounts,
  getGmailClient,
  googleModulesAvailable,
  hasConfiguredAccounts,
  isGmailConfigured,
  listAccounts,
  resolveAccount,
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

function errorResult(err: unknown): ToolResult {
  const e = err as LooseAny;
  // Friendly message for the most common operator failure modes; falls back
  // to the raw error string. The model receives this verbatim — keep it
  // actionable.
  const status = e?.response?.status ?? e?.code ?? null;
  const apiMessage = e?.response?.data?.error?.message ?? e?.message ?? String(err);

  if (status === 401) {
    return jsonResult({
      success: false,
      error: `Gmail authentication expired. Run: bun scripts/gmail-auth.ts <alias>`,
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
  if (!isGmailConfigured()) {
    ctx.log.info("integrations.gmail.disabled", {
      reason: "credentials.json absent",
      expectedAt: "~/.solrac/gmail/credentials.json",
      hint:
        "Download OAuth client_id+secret from Google Cloud Console " +
        "(APIs & Services → Credentials), save as ~/.solrac/gmail/credentials.json.",
    });
    return { apiVersion: 1, tools: [] };
  }
  if (!hasConfiguredAccounts()) {
    ctx.log.info("integrations.gmail.no_accounts", {
      hint: "Run `bun scripts/gmail-auth.ts <alias>` once per account to authenticate.",
    });
    return { apiVersion: 1, tools: [] };
  }

  const log = (event: string, fields: Record<string, unknown>): void => {
    ctx.log.info(event, fields);
  };

  // Common: fetch a Gmail client by account, surfacing friendly errors.
  async function client(account: string): Promise<LooseAny> {
    return await getGmailClient(account, log);
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
          const accounts = listAccounts();
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
          return errorResult(err);
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
          return errorResult(err);
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
          return errorResult(err);
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
          return errorResult(err);
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
          return errorResult(err);
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
          return errorResult(err);
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
          return errorResult(err);
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
          return errorResult(err);
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
          return errorResult(err);
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
          const resolved = resolveAccount(args.account);
          if (!resolved) {
            const available = getAvailableAccounts();
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
          return errorResult(err);
        }
      },
      { alwaysLoad: true },
    ),
  ];

  ctx.log.info("integrations.gmail.loaded", {
    accountCount: getAvailableAccounts().length,
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
    },
  };
}
