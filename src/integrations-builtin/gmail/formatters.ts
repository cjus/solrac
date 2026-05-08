/**
 * Gmail response shapers + MIME parsing/building.
 *
 * Adapted from `apps/utcp-tools/src/integrations/gmail/formatters.ts` plus
 * the inline `buildMimeMessage` helper from utcp-tools' `index.ts`. Pure
 * data transformations — no Google API calls, no I/O. Easy to audit.
 *
 * Why combined into one file: in utcp-tools, message-shape formatters and
 * the MIME builder were in different files (formatters.ts + index.ts).
 * Solrac collapses them here because the integration's index.ts is already
 * substantial; keeping all data shaping in formatters.ts makes the handler
 * file (`./index.ts`) read as wiring instead of plumbing.
 *
 * Types use `LooseAny` for googleapis schema types since those are only
 * available when the operator has installed `googleapis`. Solrac itself
 * doesn't depend on it; see `./client.ts::loadGoogleModules`.
 */

type LooseAny = any;

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

const SYSTEM_LABELS = new Set([
  "INBOX",
  "SENT",
  "DRAFT",
  "SPAM",
  "TRASH",
  "STARRED",
  "IMPORTANT",
  "UNREAD",
  "CATEGORY_PERSONAL",
  "CATEGORY_SOCIAL",
  "CATEGORY_PROMOTIONS",
  "CATEGORY_UPDATES",
  "CATEGORY_FORUMS",
]);

export interface FormattedLabel {
  id: string;
  name: string;
  type: "system" | "user";
  messageCount?: number;
  unreadCount?: number;
}

export function formatLabel(label: LooseAny): FormattedLabel {
  return {
    id: label.id ?? "",
    name: label.name ?? "",
    type: SYSTEM_LABELS.has(label.id ?? "") ? "system" : "user",
    messageCount: label.messagesTotal ?? undefined,
    unreadCount: label.messagesUnread ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

export interface MessageHeaders {
  from?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  date?: string;
  messageId?: string;
  inReplyTo?: string;
}

export function extractHeaders(headers: LooseAny[] | undefined): MessageHeaders {
  if (!headers) return {};
  const map = new Map<string, string | undefined>(
    headers.map((h: LooseAny) => [
      String(h.name ?? "").toLowerCase(),
      h.value as string | undefined,
    ]),
  );
  return {
    from: map.get("from"),
    to: map.get("to"),
    cc: map.get("cc"),
    bcc: map.get("bcc"),
    subject: map.get("subject"),
    date: map.get("date"),
    messageId: map.get("message-id"),
    inReplyTo: map.get("in-reply-to"),
  };
}

// ---------------------------------------------------------------------------
// Body parsing (recursive MIME walk; handles single-part + multipart)
// ---------------------------------------------------------------------------

export interface MessageBody {
  text?: string;
  html?: string;
}

function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64").toString("utf8");
}

export function parseMessageBody(payload: LooseAny | undefined): MessageBody {
  if (!payload) return {};
  const result: MessageBody = {};

  if (payload.body?.data) {
    const mimeType: string = payload.mimeType ?? "";
    const decoded = decodeBase64Url(payload.body.data);
    if (mimeType === "text/plain") result.text = decoded;
    else if (mimeType === "text/html") result.html = decoded;
  }

  if (Array.isArray(payload.parts)) {
    for (const part of payload.parts) {
      const mimeType: string = part.mimeType ?? "";
      if (mimeType === "text/plain" && part.body?.data && !result.text) {
        result.text = decodeBase64Url(part.body.data);
      } else if (mimeType === "text/html" && part.body?.data && !result.html) {
        result.html = decodeBase64Url(part.body.data);
      } else if (mimeType.startsWith("multipart/")) {
        const nested = parseMessageBody(part);
        if (!result.text && nested.text) result.text = nested.text;
        if (!result.html && nested.html) result.html = nested.html;
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Attachments (metadata only — content not fetched)
// ---------------------------------------------------------------------------

export interface AttachmentInfo {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}

export function extractAttachments(
  payload: LooseAny | undefined,
): AttachmentInfo[] {
  const out: AttachmentInfo[] = [];
  if (!payload) return out;

  function walk(part: LooseAny): void {
    if (part.filename && part.body?.attachmentId) {
      out.push({
        id: part.body.attachmentId,
        filename: part.filename,
        mimeType: part.mimeType ?? "application/octet-stream",
        size: part.body.size ?? 0,
      });
    }
    if (Array.isArray(part.parts)) {
      for (const nested of part.parts) walk(nested);
    }
  }
  walk(payload);
  return out;
}

function hasAttachments(payload: LooseAny | undefined): boolean {
  if (!payload) return false;
  if (payload.filename && payload.body?.attachmentId) return true;
  if (Array.isArray(payload.parts)) {
    return payload.parts.some((p: LooseAny) => hasAttachments(p));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Message summaries (for search results)
// ---------------------------------------------------------------------------

export interface MessageSummary {
  id: string;
  threadId: string;
  snippet: string;
  from?: string;
  to?: string;
  subject?: string;
  date?: string;
  labels: string[];
  isUnread: boolean;
  hasAttachments: boolean;
}

export function formatMessageSummary(message: LooseAny): MessageSummary {
  const headers = extractHeaders(message.payload?.headers);
  const labels: string[] = message.labelIds ?? [];
  return {
    id: message.id ?? "",
    threadId: message.threadId ?? "",
    snippet: message.snippet ?? "",
    from: headers.from,
    to: headers.to,
    subject: headers.subject,
    date: headers.date,
    labels,
    isUnread: labels.includes("UNREAD"),
    hasAttachments: hasAttachments(message.payload),
  };
}

// ---------------------------------------------------------------------------
// Full messages (for `gmail_get_message`)
// ---------------------------------------------------------------------------

export interface FormattedMessage {
  id: string;
  threadId: string;
  labels: string[];
  snippet: string;
  headers: MessageHeaders;
  body: MessageBody;
  attachments: AttachmentInfo[];
  isUnread: boolean;
  internalDate: string;
}

export function formatFullMessage(message: LooseAny): FormattedMessage {
  const labels: string[] = message.labelIds ?? [];
  return {
    id: message.id ?? "",
    threadId: message.threadId ?? "",
    labels,
    snippet: message.snippet ?? "",
    headers: extractHeaders(message.payload?.headers),
    body: parseMessageBody(message.payload),
    attachments: extractAttachments(message.payload),
    isUnread: labels.includes("UNREAD"),
    internalDate: message.internalDate ?? "",
  };
}

// ---------------------------------------------------------------------------
// MIME message builder (for `gmail_send_message`)
// ---------------------------------------------------------------------------

export interface BuildMimeOptions {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  bodyType?: "text" | "html";
  replyToMessageId?: string;
  attachments?: Array<{ filename: string; content: string; mimeType: string }>;
}

/**
 * Build a base64-able MIME string for Gmail's `users.messages.send`.
 * Handles plain text, HTML, and attachment multipart/mixed.
 *
 * Subject is base64-encoded (RFC 2047 encoded-word format) so non-ASCII
 * chars don't mangle. Body is base64-encoded with explicit
 * Content-Transfer-Encoding header. Boundary is timestamp-based; adequate
 * for one-shot sends (collisions astronomically unlikely).
 */
export function buildMimeMessage(opts: BuildMimeOptions): string {
  const boundary = `boundary_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2)}`;
  const hasAttach = opts.attachments && opts.attachments.length > 0;

  const headers: string[] = [
    `From: ${opts.from}`,
    `To: ${opts.to.join(", ")}`,
  ];
  if (opts.cc?.length) headers.push(`Cc: ${opts.cc.join(", ")}`);
  if (opts.bcc?.length) headers.push(`Bcc: ${opts.bcc.join(", ")}`);
  headers.push(
    `Subject: =?UTF-8?B?${Buffer.from(opts.subject).toString("base64")}?=`,
  );
  headers.push(`MIME-Version: 1.0`);
  if (opts.replyToMessageId) {
    headers.push(`In-Reply-To: ${opts.replyToMessageId}`);
    headers.push(`References: ${opts.replyToMessageId}`);
  }

  const contentType = opts.bodyType === "html" ? "text/html" : "text/plain";

  if (hasAttach) {
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    let msg = headers.join("\r\n") + "\r\n\r\n";
    msg += `--${boundary}\r\n`;
    msg += `Content-Type: ${contentType}; charset="UTF-8"\r\n`;
    msg += `Content-Transfer-Encoding: base64\r\n\r\n`;
    msg += Buffer.from(opts.body).toString("base64") + "\r\n";
    for (const att of opts.attachments!) {
      msg += `--${boundary}\r\n`;
      msg += `Content-Type: ${att.mimeType}; name="${att.filename}"\r\n`;
      msg += `Content-Disposition: attachment; filename="${att.filename}"\r\n`;
      msg += `Content-Transfer-Encoding: base64\r\n\r\n`;
      msg += att.content + "\r\n";
    }
    msg += `--${boundary}--`;
    return msg;
  }

  headers.push(`Content-Type: ${contentType}; charset="UTF-8"`);
  headers.push(`Content-Transfer-Encoding: base64`);
  return headers.join("\r\n") + "\r\n\r\n" + Buffer.from(opts.body).toString("base64");
}

/**
 * Encode a MIME string for Gmail's `raw` field (URL-safe base64, no
 * padding).
 */
export function encodeMimeForGmail(mime: string): string {
  return Buffer.from(mime)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
