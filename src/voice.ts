/**
 * @fileoverview Voice (ElevenLabs STT + TTS) orchestration.
 * @purpose Sits between transport surfaces (web routes, Telegram dispatcher,
 *          agent post-turn hook) and the typed `elevenlabs.ts` HTTP wrapper.
 *          Owns gate + cap-check + audit-write + transport delivery for every
 *          voice event.
 *
 * Audit-before-acting parity: every entrypoint writes a `voice_events` row
 * regardless of outcome — allowed, denied at the gate, capped, or upstream
 * error. This mirrors the `audit` table's posture for Anthropic turns: the
 * voice log is the source of truth for "did we attempt N requests this hour?"
 *
 * Cost cap is per-axis. Anthropic burn (`audit.cost_usd`) and ElevenLabs
 * burn (`voice_events.cost_usd_estimate`) ride independent sliding-60-min
 * windows; one cap firing doesn't gate the other. Order of checks (per
 * PLAN.md §12.2):
 *   - STT: gate → global voice cap → per-chat voice cap → upstream → write
 *   - TTS: per-chat voice cap → global voice cap → length wall → upstream → write
 * Global before per-chat for the same reason the Anthropic hook orders it
 * that way: a host-wide hit shouldn't be masked by a per-chat pass.
 *
 * Position in the dependency graph:
 *   elevenlabs + db + log + config + policy + telegram + markdown → voice →
 *     consumed by web, main, agent, commands
 *
 * Exports:
 *   - `buildVoiceModePrompt(opts)` — voice-mode system block injected by both
 *     SOLRAC.md sites (`agent.ts::buildAugmentedPrompt`, engine.ts
 *     wrapInstanceMd seams) when `sessions.voice_replies=1`.
 *   - `stripMarkdownForSpeech(md)` — token-walk transform; tables/code → "[…]";
 *     lists flattened; links unwrapped; whitespace collapsed.
 *   - `estimateSttCostUsd` / `estimateTtsCostUsd` — cost math.
 *   - `handleWebStt` / `handleWebTts` — web `/api/stt` + `/api/tts` entrypoints.
 *   - `handleTelegramVoiceStt` — Telegram dispatcher branch for `msg.voice`.
 *   - `maybeReplyWithVoice` — post-turn hook (agent.ts/engine.ts) that
 *     attaches a voice note when `voice_replies=1` and transport is Telegram.
 *
 * Key invariants:
 *   - Every entrypoint writes a `voice_events` row regardless of outcome.
 *     Denied rows have `cost_usd_estimate=0` so they don't count toward caps.
 *   - The `<voice-mode>` block is plumbing, NOT user content. Audit rows
 *     persist the original user prompt; the prompt-augmentation layer
 *     (buildAugmentedPrompt / engine system messages) injects the block.
 *   - `stripMarkdownForSpeech` is pure: `marked.lexer` walks tokens; runtime
 *     state is per-call. Safe to call from any context.
 *   - TTS length is checked AFTER markdown strip so a long markdown reply
 *     that's mostly code fences (replaced with "[code block omitted]")
 *     doesn't refuse on the raw markdown length.
 *
 * Gotchas:
 *   - `maybeReplyWithVoice` is best-effort. Failures log + return; they do
 *     NOT propagate to the caller (the original turn must succeed even if
 *     TTS fails — voice is a UX layer, not the conversation).
 *   - `handleTelegramVoiceStt` synthesizes a new Update with `text=transcript`
 *     and NO `voice` field. The dispatcher loop must not re-process it as a
 *     voice message (the field strip is what prevents loops).
 *   - `handleWebTts` returns the upstream `ReadableStream` for proxy-through.
 *     The caller (`web.ts`) is responsible for not buffering server-side —
 *     that's the whole point of `/v1/text-to-speech/{id}/stream`.
 */

import { Marked } from "marked";
import type { Token, Tokens } from "marked";
import type { Update } from "@grammyjs/types";
import type { Config } from "./config.ts";
import type { SolracDb } from "./db.ts";
import { log as defaultLog } from "./log.ts";
import {
  ElevenLabsAuthError,
  ElevenLabsError,
  ElevenLabsRateError,
  speechToText,
  textToSpeechStream,
} from "./elevenlabs.ts";
import { gateUpdate } from "./policy.ts";
import type { TelegramClient } from "./telegram.ts";

// One hour sliding window — matches `HOURLY_COST_CAP_USD` for Anthropic.
const COST_WINDOW_MS = 60 * 60 * 1000;

// Reuse a single Marked instance for `lexer()` — token shapes are identical
// across calls, and the lexer carries no per-call state.
const speechMarked = new Marked({ gfm: true, breaks: false });

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/**
 * Returns the voice-mode system-prompt block. Injected by both SOLRAC.md
 * sites when `sessions.voice_replies=1`. `words` comes from
 * `config.voiceReplyWordsHint` (clamped to [30, 200] at boot).
 *
 * The "expand 3×" carve-out gives the model headroom when the operator
 * explicitly asks for more — without it, "explain in detail" would be
 * curtailed by the soft target. The hard wall (`VOICE_TTS_MAX_CHARS`) is
 * the last line of defense if the model ignores both.
 */
export function buildVoiceModePrompt(opts: { words: number }): string {
  const w = opts.words;
  const expanded = w * 3;
  return [
    "<voice-mode>",
    `The user is listening to your reply as audio. Respond in under ${w} words.`,
    "No preamble — answer directly. Prefer prose over lists, code, or tables.",
    "If the user asks you to expand, elaborate, or give more detail, you may",
    `use up to ${expanded} words.`,
    "</voice-mode>",
  ].join("\n");
}

/**
 * Token-walk transform: markdown → plain text suitable for TTS. Code
 * fences and tables are summarized rather than read literally — neither
 * speaks well, and reading code character-by-character is an antifeature.
 * Returns trimmed, single-spaced text.
 */
export function stripMarkdownForSpeech(markdown: string): string {
  const trimmed = stripAgentFooter(markdown);
  let tokens: Token[];
  try {
    tokens = speechMarked.lexer(trimmed);
  } catch {
    // Parser glitch — fall back to the raw text so we never refuse to
    // speak. The downstream length wall still gates absurdly long inputs.
    return collapseWhitespace(trimmed);
  }
  const out = walkTokens(tokens);
  return collapseWhitespace(out);
}

// Footer pattern from agent.ts::buildFooter / engine.ts::renderFinal:
//   *✅ <metadata>*   — italicized line with the ✅ prefix carrying turn
//                       count / cost / engine info. Pure UI chrome that
//                       should never be spoken aloud. The ✅ (U+2705) is
//                       distinctive enough that any occurrence is the
//                       footer; strip from ✅ to the closing `*` on the
//                       same line.
const FOOTER_RE = /\*\s*✅[^*\n]*\*/g;
function stripAgentFooter(markdown: string): string {
  return markdown.replace(FOOTER_RE, "");
}

function walkTokens(tokens: Token[]): string {
  const parts: string[] = [];
  for (const t of tokens) {
    parts.push(renderToken(t));
  }
  return parts.join(" ");
}

function renderToken(t: Token): string {
  switch (t.type) {
    case "space":
      return " ";
    case "heading": {
      return walkTokens((t as Tokens.Heading).tokens as Token[]) + ". ";
    }
    case "paragraph":
      return walkTokens((t as Tokens.Paragraph).tokens as Token[]) + " ";
    case "text": {
      const tt = t as Tokens.Text;
      if (tt.tokens) return walkTokens(tt.tokens as Token[]);
      return tt.text;
    }
    case "strong":
      return walkTokens((t as Tokens.Strong).tokens as Token[]);
    case "em":
      return walkTokens((t as Tokens.Em).tokens as Token[]);
    case "del":
      return walkTokens((t as Tokens.Del).tokens as Token[]);
    case "link":
      return walkTokens((t as Tokens.Link).tokens as Token[]);
    case "image":
      return (t as Tokens.Image).text ?? "";
    case "codespan":
      return (t as Tokens.Codespan).text;
    case "code":
      return "[code block omitted]";
    case "table":
      return "[table omitted]";
    case "blockquote":
      return "Quote: " + walkTokens((t as Tokens.Blockquote).tokens as Token[]) + " ";
    case "list": {
      const list = t as Tokens.List;
      const items = list.items.map((it) =>
        walkTokens(it.tokens as Token[]).trim(),
      );
      return items.join(", ") + ". ";
    }
    case "list_item":
      return walkTokens((t as Tokens.ListItem).tokens as Token[]);
    case "hr":
      return ". ";
    case "br":
      return " ";
    case "html":
      // Strip tags; HTML rarely appears in our outputs but a stray <br>
      // shouldn't read aloud as "less-than br greater-than."
      return (t as Tokens.HTML).text.replace(/<[^>]+>/g, " ");
    case "escape":
      return (t as Tokens.Escape).text;
    default:
      return "";
  }
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * STT cost estimate. ElevenLabs Scribe is billed per hour of audio at
 * $0.22/hr (May 2026). Operator can override the price via
 * `ELEVENLABS_STT_PRICE_USD_PER_HOUR` if their plan differs.
 */
export function estimateSttCostUsd(durationSeconds: number, pricePerHour: number): number {
  return (durationSeconds / 3600) * pricePerHour;
}

/**
 * TTS cost estimate. Flash v2.5 is $0.05/1k chars; bump to $0.10 for Multi
 * v2. Operator pins via `ELEVENLABS_TTS_PRICE_USD_PER_1K_CHARS`.
 */
export function estimateTtsCostUsd(chars: number, pricePer1k: number): number {
  return (chars / 1000) * pricePer1k;
}

// ---------------------------------------------------------------------------
// Orchestration entrypoints
// ---------------------------------------------------------------------------

export interface VoiceTelegramSender {
  // Phase 5 wires these to typed `telegram.ts` helpers backed by multipart
  // POSTs to sendVoice / sendAudio. Kept as a small injected interface so
  // Phase 1 voice.ts has no compile-time dependency on the Telegram bot
  // token (which lives in main.ts).
  sendVoice: (
    chatId: number,
    audio: ArrayBuffer,
    opts?: { replyToMessageId?: number; mimeType?: string },
  ) => Promise<void>;
  sendAudio: (
    chatId: number,
    audio: ArrayBuffer,
    opts?: { replyToMessageId?: number; mimeType?: string },
  ) => Promise<void>;
}

export interface VoiceDeps {
  db: SolracDb;
  tg: TelegramClient;
  config: Config;
  log?: typeof defaultLog;
  // Phase 5 — when present, `maybeReplyWithVoice` uses it to send audio.
  // When omitted (Phase 1 + web transport), the post-turn TTS attach is
  // a no-op (web has its own per-message speak button).
  telegramSender?: VoiceTelegramSender;
  // Phase 4 — when present, `handleTelegramVoiceStt` uses it to gate before
  // paying for Scribe. When omitted, gate is skipped (test scaffolding).
  isAllowed?: (userId: number) => boolean;
}

export type WebSttResult =
  | { kind: "ok"; text: string }
  | { kind: "denied_cap" }
  | { kind: "error"; message: string };

export type WebTtsResult =
  | { kind: "stream"; contentType: string; body: ReadableStream<Uint8Array> }
  | { kind: "too_long"; maxChars: number }
  | { kind: "denied_cap" }
  | { kind: "error"; message: string };

export type TelegramSttResult =
  | { kind: "synthesized"; update: Update }
  | { kind: "denied_gate" }
  | { kind: "denied_cap" }
  | { kind: "error"; message: string };

/**
 * Web `/api/stt` entrypoint. Cap → ElevenLabs STT → voice_events row.
 * No gate here — the web route's session-cookie auth is the gate (web is
 * single-user; the cookie proves operator identity).
 */
export async function handleWebStt(
  deps: VoiceDeps,
  opts: { chatId: number; audio: Blob; signal?: AbortSignal },
): Promise<WebSttResult> {
  const log = deps.log ?? defaultLog;
  const cfg = deps.config;
  if (!cfg.voiceEnabled || cfg.elevenlabsApiKey === null) {
    return { kind: "error", message: "voice disabled" };
  }
  const now = Date.now();
  const sinceMs = now - COST_WINDOW_MS;
  const globalUsed = deps.db.voiceCostUsedGlobalLast60min(sinceMs);
  if (globalUsed >= cfg.voiceGlobalHourlyCostCapUsd) {
    deps.db.recordVoiceEvent({
      chatId: opts.chatId,
      tsMs: now,
      kind: "stt",
      source: "web",
      model: cfg.elevenlabsSttModel,
      voiceId: null,
      auditId: null,
      durationMs: null,
      chars: null,
      costUsdEstimate: 0,
      status: "denied_cap",
      errorMessage: "global_voice_cap",
    });
    log.warn("voice.cost_cap_exceeded", {
      chat_id: opts.chatId,
      kind: "stt",
      scope: "global",
      window_cost_usd: globalUsed,
    });
    return { kind: "denied_cap" };
  }
  const chatUsed = deps.db.voiceCostUsedLast60min(opts.chatId, sinceMs);
  if (chatUsed >= cfg.voiceHourlyCostCapUsd) {
    deps.db.recordVoiceEvent({
      chatId: opts.chatId,
      tsMs: now,
      kind: "stt",
      source: "web",
      model: cfg.elevenlabsSttModel,
      voiceId: null,
      auditId: null,
      durationMs: null,
      chars: null,
      costUsdEstimate: 0,
      status: "denied_cap",
      errorMessage: "chat_voice_cap",
    });
    log.warn("voice.cost_cap_exceeded", {
      chat_id: opts.chatId,
      kind: "stt",
      scope: "chat",
      window_cost_usd: chatUsed,
    });
    return { kind: "denied_cap" };
  }
  try {
    const result = await speechToText({
      apiKey: cfg.elevenlabsApiKey,
      modelId: cfg.elevenlabsSttModel,
      audio: opts.audio,
      signal: opts.signal,
    });
    const cost = estimateSttCostUsd(result.durationSeconds, cfg.elevenlabsSttPriceUsdPerHour);
    deps.db.recordVoiceEvent({
      chatId: opts.chatId,
      tsMs: now,
      kind: "stt",
      source: "web",
      model: cfg.elevenlabsSttModel,
      voiceId: null,
      auditId: null,
      durationMs: Math.round(result.durationSeconds * 1000),
      chars: null,
      costUsdEstimate: cost,
      status: "ok",
      errorMessage: null,
    });
    return { kind: "ok", text: result.text };
  } catch (err) {
    return handleElevenLabsError(deps, {
      err,
      chatId: opts.chatId,
      tsMs: now,
      kind: "stt",
      source: "web",
      model: cfg.elevenlabsSttModel,
      voiceId: null,
    });
  }
}

/**
 * Web `/api/tts` entrypoint. Cap → length wall → ElevenLabs TTS stream →
 * voice_events row. Returns the upstream `ReadableStream` for proxy-through;
 * the caller wraps in `new Response(body, …)`.
 */
export async function handleWebTts(
  deps: VoiceDeps,
  opts: { chatId: number; markdown: string; auditId: number | null; signal?: AbortSignal },
): Promise<WebTtsResult> {
  const log = deps.log ?? defaultLog;
  const cfg = deps.config;
  if (!cfg.voiceEnabled || cfg.elevenlabsApiKey === null || cfg.elevenlabsVoiceId === null) {
    return { kind: "error", message: "voice disabled" };
  }
  const speech = stripMarkdownForSpeech(opts.markdown);
  const now = Date.now();
  const sinceMs = now - COST_WINDOW_MS;
  const chatUsed = deps.db.voiceCostUsedLast60min(opts.chatId, sinceMs);
  if (chatUsed >= cfg.voiceHourlyCostCapUsd) {
    deps.db.recordVoiceEvent({
      chatId: opts.chatId,
      tsMs: now,
      kind: "tts",
      source: "web",
      model: cfg.elevenlabsTtsModel,
      voiceId: cfg.elevenlabsVoiceId,
      auditId: opts.auditId,
      durationMs: null,
      chars: speech.length,
      costUsdEstimate: 0,
      status: "denied_cap",
      errorMessage: "chat_voice_cap",
    });
    log.warn("voice.cost_cap_exceeded", {
      chat_id: opts.chatId,
      kind: "tts",
      scope: "chat",
      window_cost_usd: chatUsed,
    });
    return { kind: "denied_cap" };
  }
  const globalUsed = deps.db.voiceCostUsedGlobalLast60min(sinceMs);
  if (globalUsed >= cfg.voiceGlobalHourlyCostCapUsd) {
    deps.db.recordVoiceEvent({
      chatId: opts.chatId,
      tsMs: now,
      kind: "tts",
      source: "web",
      model: cfg.elevenlabsTtsModel,
      voiceId: cfg.elevenlabsVoiceId,
      auditId: opts.auditId,
      durationMs: null,
      chars: speech.length,
      costUsdEstimate: 0,
      status: "denied_cap",
      errorMessage: "global_voice_cap",
    });
    log.warn("voice.cost_cap_exceeded", {
      chat_id: opts.chatId,
      kind: "tts",
      scope: "global",
      window_cost_usd: globalUsed,
    });
    return { kind: "denied_cap" };
  }
  if (speech.length > cfg.voiceTtsMaxChars) {
    deps.db.recordVoiceEvent({
      chatId: opts.chatId,
      tsMs: now,
      kind: "tts",
      source: "web",
      model: cfg.elevenlabsTtsModel,
      voiceId: cfg.elevenlabsVoiceId,
      auditId: opts.auditId,
      durationMs: null,
      chars: speech.length,
      costUsdEstimate: 0,
      status: "error",
      errorMessage: "too_long",
    });
    return { kind: "too_long", maxChars: cfg.voiceTtsMaxChars };
  }
  try {
    const stream = await textToSpeechStream({
      apiKey: cfg.elevenlabsApiKey,
      voiceId: cfg.elevenlabsVoiceId,
      modelId: cfg.elevenlabsTtsModel,
      outputFormat: cfg.elevenlabsTtsFormatWeb,
      text: speech,
      signal: opts.signal,
    });
    const cost = estimateTtsCostUsd(speech.length, cfg.elevenlabsTtsPriceUsdPer1k);
    deps.db.recordVoiceEvent({
      chatId: opts.chatId,
      tsMs: now,
      kind: "tts",
      source: "web",
      model: cfg.elevenlabsTtsModel,
      voiceId: cfg.elevenlabsVoiceId,
      auditId: opts.auditId,
      durationMs: null,
      chars: speech.length,
      costUsdEstimate: cost,
      status: "ok",
      errorMessage: null,
    });
    return { kind: "stream", contentType: stream.contentType, body: stream.body };
  } catch (err) {
    return handleElevenLabsError(deps, {
      err,
      chatId: opts.chatId,
      tsMs: now,
      kind: "tts",
      source: "web",
      model: cfg.elevenlabsTtsModel,
      voiceId: cfg.elevenlabsVoiceId,
      chars: speech.length,
      auditId: opts.auditId,
    });
  }
}

/**
 * Telegram dispatcher branch for `msg.voice`. Gate → cap → getFile →
 * stream-download → Scribe → synthesize a new text Update. The caller
 * (main.ts) feeds the synthesized Update back into the queue, where it
 * follows the normal text-message path.
 */
export async function handleTelegramVoiceStt(
  deps: VoiceDeps,
  opts: { update: Update; voiceFileId: string },
): Promise<TelegramSttResult> {
  const log = deps.log ?? defaultLog;
  const cfg = deps.config;
  const update = opts.update;
  const msg = update.message;
  if (!msg) return { kind: "error", message: "no message" };
  const chatId = msg.chat.id;
  const now = Date.now();
  if (!cfg.voiceEnabled || cfg.elevenlabsApiKey === null) {
    return { kind: "error", message: "voice disabled" };
  }
  // Gate first — never pay Scribe for a non-allowlisted sender.
  if (deps.isAllowed) {
    const gate = gateUpdate(update, deps.isAllowed);
    if (gate.kind !== "ok") {
      deps.db.recordVoiceEvent({
        chatId,
        tsMs: now,
        kind: "stt",
        source: "telegram",
        model: cfg.elevenlabsSttModel,
        voiceId: null,
        auditId: null,
        durationMs: null,
        chars: null,
        costUsdEstimate: 0,
        status: "denied_gate",
        errorMessage: gate.kind,
      });
      return { kind: "denied_gate" };
    }
  }
  const sinceMs = now - COST_WINDOW_MS;
  const globalUsed = deps.db.voiceCostUsedGlobalLast60min(sinceMs);
  if (globalUsed >= cfg.voiceGlobalHourlyCostCapUsd) {
    deps.db.recordVoiceEvent({
      chatId,
      tsMs: now,
      kind: "stt",
      source: "telegram",
      model: cfg.elevenlabsSttModel,
      voiceId: null,
      auditId: null,
      durationMs: null,
      chars: null,
      costUsdEstimate: 0,
      status: "denied_cap",
      errorMessage: "global_voice_cap",
    });
    log.warn("voice.cost_cap_exceeded", {
      chat_id: chatId,
      kind: "stt",
      scope: "global",
      window_cost_usd: globalUsed,
    });
    return { kind: "denied_cap" };
  }
  const chatUsed = deps.db.voiceCostUsedLast60min(chatId, sinceMs);
  if (chatUsed >= cfg.voiceHourlyCostCapUsd) {
    deps.db.recordVoiceEvent({
      chatId,
      tsMs: now,
      kind: "stt",
      source: "telegram",
      model: cfg.elevenlabsSttModel,
      voiceId: null,
      auditId: null,
      durationMs: null,
      chars: null,
      costUsdEstimate: 0,
      status: "denied_cap",
      errorMessage: "chat_voice_cap",
    });
    log.warn("voice.cost_cap_exceeded", {
      chat_id: chatId,
      kind: "stt",
      scope: "chat",
      window_cost_usd: chatUsed,
    });
    return { kind: "denied_cap" };
  }
  try {
    // `getFile` resolves the file_path; the actual download URL is
    // `https://api.telegram.org/file/bot<TOKEN>/<file_path>`. Never log
    // that URL — it contains the bot token.
    const fileInfo = await deps.tg.call<{ file_path?: string }>("getFile", {
      file_id: opts.voiceFileId,
    });
    if (!fileInfo.file_path) {
      throw new Error("telegram getFile returned no file_path");
    }
    const downloadUrl = `https://api.telegram.org/file/bot${cfg.telegramBotToken}/${fileInfo.file_path}`;
    const dlRes = await fetch(downloadUrl);
    if (!dlRes.ok) {
      throw new Error(`telegram file download failed: HTTP ${dlRes.status}`);
    }
    const audioBuf = await dlRes.arrayBuffer();
    if (audioBuf.byteLength > cfg.voiceSttMaxBytes) {
      throw new Error(
        `telegram voice exceeds VOICE_STT_MAX_BYTES (${audioBuf.byteLength} > ${cfg.voiceSttMaxBytes})`,
      );
    }
    const audioBlob = new Blob([audioBuf], { type: "audio/ogg" });
    const result = await speechToText({
      apiKey: cfg.elevenlabsApiKey,
      modelId: cfg.elevenlabsSttModel,
      audio: audioBlob,
      filename: "voice.ogg",
    });
    const cost = estimateSttCostUsd(result.durationSeconds, cfg.elevenlabsSttPriceUsdPerHour);
    deps.db.recordVoiceEvent({
      chatId,
      tsMs: now,
      kind: "stt",
      source: "telegram",
      model: cfg.elevenlabsSttModel,
      voiceId: null,
      auditId: null,
      durationMs: Math.round(result.durationSeconds * 1000),
      chars: null,
      costUsdEstimate: cost,
      status: "ok",
      errorMessage: null,
    });
    const synthesized = synthesizeTextUpdate(update, result.text);
    return { kind: "synthesized", update: synthesized };
  } catch (err) {
    return handleElevenLabsError(deps, {
      err,
      chatId,
      tsMs: now,
      kind: "stt",
      source: "telegram",
      model: cfg.elevenlabsSttModel,
      voiceId: null,
    });
  }
}

/**
 * Post-turn TTS attach for Telegram. No-ops when voice mode is off, when
 * the voice transport disabled, when the deploy has no `telegramSender`,
 * or when the cap/length wall fires. Failures are best-effort and DO NOT
 * propagate — the assistant's text reply must already have been sent.
 */
export async function maybeReplyWithVoice(
  deps: VoiceDeps,
  opts: {
    chatId: number;
    messageId: number | null;
    auditId: number | null;
    finalText: string;
  },
): Promise<void> {
  const log = deps.log ?? defaultLog;
  const cfg = deps.config;
  if (!cfg.voiceEnabled || cfg.elevenlabsApiKey === null || cfg.elevenlabsVoiceId === null) {
    return;
  }
  if (!deps.telegramSender) return;
  if (!deps.db.getVoiceRepliesFlag(opts.chatId)) return;
  const speech = stripMarkdownForSpeech(opts.finalText);
  if (speech.length === 0) return;
  const now = Date.now();
  const sinceMs = now - COST_WINDOW_MS;
  const chatUsed = deps.db.voiceCostUsedLast60min(opts.chatId, sinceMs);
  if (chatUsed >= cfg.voiceHourlyCostCapUsd) {
    deps.db.recordVoiceEvent({
      chatId: opts.chatId,
      tsMs: now,
      kind: "tts",
      source: "telegram",
      model: cfg.elevenlabsTtsModel,
      voiceId: cfg.elevenlabsVoiceId,
      auditId: opts.auditId,
      durationMs: null,
      chars: speech.length,
      costUsdEstimate: 0,
      status: "denied_cap",
      errorMessage: "chat_voice_cap",
    });
    log.warn("voice.cost_cap_exceeded", {
      chat_id: opts.chatId,
      kind: "tts",
      scope: "chat",
      window_cost_usd: chatUsed,
    });
    return;
  }
  const globalUsed = deps.db.voiceCostUsedGlobalLast60min(sinceMs);
  if (globalUsed >= cfg.voiceGlobalHourlyCostCapUsd) {
    deps.db.recordVoiceEvent({
      chatId: opts.chatId,
      tsMs: now,
      kind: "tts",
      source: "telegram",
      model: cfg.elevenlabsTtsModel,
      voiceId: cfg.elevenlabsVoiceId,
      auditId: opts.auditId,
      durationMs: null,
      chars: speech.length,
      costUsdEstimate: 0,
      status: "denied_cap",
      errorMessage: "global_voice_cap",
    });
    log.warn("voice.cost_cap_exceeded", {
      chat_id: opts.chatId,
      kind: "tts",
      scope: "global",
      window_cost_usd: globalUsed,
    });
    return;
  }
  if (speech.length > cfg.voiceTtsMaxChars) {
    deps.db.recordVoiceEvent({
      chatId: opts.chatId,
      tsMs: now,
      kind: "tts",
      source: "telegram",
      model: cfg.elevenlabsTtsModel,
      voiceId: cfg.elevenlabsVoiceId,
      auditId: opts.auditId,
      durationMs: null,
      chars: speech.length,
      costUsdEstimate: 0,
      status: "error",
      errorMessage: "too_long",
    });
    await deps.tg
      .sendMessage(opts.chatId, "reply too long to speak — try a shorter prompt")
      .catch((err) => log.warn("voice.too_long_notice_failed", { error: (err as Error).message }));
    return;
  }
  try {
    const stream = await textToSpeechStream({
      apiKey: cfg.elevenlabsApiKey,
      voiceId: cfg.elevenlabsVoiceId,
      modelId: cfg.elevenlabsTtsModel,
      outputFormat: cfg.elevenlabsTtsFormatTg,
      text: speech,
    });
    const buf = await new Response(stream.body).arrayBuffer();
    const cost = estimateTtsCostUsd(speech.length, cfg.elevenlabsTtsPriceUsdPer1k);
    deps.db.recordVoiceEvent({
      chatId: opts.chatId,
      tsMs: now,
      kind: "tts",
      source: "telegram",
      model: cfg.elevenlabsTtsModel,
      voiceId: cfg.elevenlabsVoiceId,
      auditId: opts.auditId,
      durationMs: null,
      chars: speech.length,
      costUsdEstimate: cost,
      status: "ok",
      errorMessage: null,
    });
    // Opus format implies sendVoice; anything else (mp3 fallback) uses
    // sendAudio. The env-var-driven format pick at boot decides which.
    const useVoiceNote = cfg.elevenlabsTtsFormatTg.startsWith("opus_");
    const mimeType = stream.contentType;
    const replyOpts = opts.messageId
      ? { replyToMessageId: opts.messageId, mimeType }
      : { mimeType };
    if (useVoiceNote) {
      await deps.telegramSender.sendVoice(opts.chatId, buf, replyOpts);
    } else {
      await deps.telegramSender.sendAudio(opts.chatId, buf, replyOpts);
    }
  } catch (err) {
    deps.db.recordVoiceEvent({
      chatId: opts.chatId,
      tsMs: now,
      kind: "tts",
      source: "telegram",
      model: cfg.elevenlabsTtsModel,
      voiceId: cfg.elevenlabsVoiceId,
      auditId: opts.auditId,
      durationMs: null,
      chars: speech.length,
      costUsdEstimate: 0,
      status: "error",
      errorMessage: (err as Error).message,
    });
    log.warn("voice.tts_failed", { chat_id: opts.chatId, error: (err as Error).message });
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface ErrorContext {
  err: unknown;
  chatId: number;
  tsMs: number;
  kind: "stt" | "tts";
  source: "web" | "telegram";
  model: string;
  voiceId: string | null;
  chars?: number | null;
  auditId?: number | null;
}

function handleElevenLabsError(
  deps: VoiceDeps,
  ctx: ErrorContext,
): { kind: "error"; message: string } {
  const log = deps.log ?? defaultLog;
  const message =
    ctx.err instanceof Error ? ctx.err.message : "elevenlabs request failed";
  deps.db.recordVoiceEvent({
    chatId: ctx.chatId,
    tsMs: ctx.tsMs,
    kind: ctx.kind,
    source: ctx.source,
    model: ctx.model,
    voiceId: ctx.voiceId,
    auditId: ctx.auditId ?? null,
    durationMs: null,
    chars: ctx.chars ?? null,
    costUsdEstimate: 0,
    status: "error",
    errorMessage: message,
  });
  if (ctx.err instanceof ElevenLabsAuthError) {
    log.error("voice.auth_failed", { chat_id: ctx.chatId, kind: ctx.kind, source: ctx.source });
  } else if (ctx.err instanceof ElevenLabsRateError) {
    log.warn("voice.rate_limited", { chat_id: ctx.chatId, kind: ctx.kind, source: ctx.source });
  } else if (ctx.err instanceof ElevenLabsError) {
    log.warn("voice.upstream_error", {
      chat_id: ctx.chatId,
      kind: ctx.kind,
      source: ctx.source,
      status: ctx.err.status,
      message,
    });
  } else {
    log.warn("voice.failed", { chat_id: ctx.chatId, kind: ctx.kind, source: ctx.source, message });
  }
  return { kind: "error", message };
}

/**
 * Construct a synthesized text Update from a voice Update. Carries the
 * same update_id / chat / from so the downstream dispatcher treats it
 * identically to a typed message. The `voice` field is intentionally
 * dropped — the dispatcher must not re-route it as a voice message.
 */
function synthesizeTextUpdate(original: Update, transcript: string): Update {
  const msg = original.message!;
  return {
    update_id: original.update_id,
    message: {
      message_id: msg.message_id,
      date: msg.date,
      chat: msg.chat,
      from: msg.from,
      text: transcript,
    },
  } as Update;
}
