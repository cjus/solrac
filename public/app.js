// Solrac web UI — vanilla JS, no framework.
//
// Render flow:
//   1. /api/login → cookie set → reveal chat pane.
//   2. EventSource('/api/stream') → assistant_message / assistant_edit /
//      reaction events.
//   3. POST /api/message to send a user turn (which triggers the agent).
//   4. POST /api/confirm for tool-confirm Allow/Deny.
//
// Markdown rendering: events carry `markdown_source` — we run `marked.parse`
// then `sanitizeHtml` (allowlist) before injecting to .body. If a server's
// missing a markdown source (rare), we fall back to the already-sanitized
// `html` field.

import { sanitizeHtml } from "/static/sanitize.js";

const $ = (id) => document.getElementById(id);
const els = {
  app: $("app"),
  login: $("login"),
  loginForm: $("login-form"),
  loginToken: $("login-token"),
  loginError: $("login-error"),
  chat: $("chat"),
  messages: $("messages"),
  composer: $("composer"),
  composerText: $("composer-text"),
  sendBtn: $("send-btn"),
  clearBtn: $("clear-btn"),
  logoutBtn: $("logout-btn"),
  connState: $("conn-state"),
  enginePills: document.querySelectorAll(".engine-opt"),
  micBtn: $("mic-btn"),
  voiceBadge: $("voice-badge"),
  toastHost: $("toast-host"),
};

// Track DOM nodes by message_id so streaming edits can replace them in place.
const messageNodes = new Map();
// activeEngine carries the wire prefix the user picked: "" (server default —
// resolved from SOLRAC_DEFAULT_ENGINE), "@" (primary Claude), or "!"
// (secondary Claude). The actual engine identity for the default pill is
// whatever the server resolves no-prefix to; the title attr in index.html is
// server-injected so the operator sees the right label.
let activeEngine = "";
let stream = null;
let firstTab = true;
// Voice mode (mirror of sessions.voice_replies for the web chat id). Refreshed
// from /api/voice/state on boot and after the user sends /voice on|off.
let voiceModeOn = false;
// Voice availability for the deploy. Probed once at boot by HEAD-ing
// /api/voice/state — if it returns 401/200 the route exists (voice enabled);
// 503 means the server has VOICE_ENABLED=false and the mic/speak surface
// stays hidden.
let voiceFeatureAvailable = false;
// MediaRecorder state. `recorder` is the active recorder; `recordTimeoutId`
// is the auto-stop timer that fires at VOICE_STT_MAX_SECONDS (60s server-side).
let recorder = null;
let recordTimeoutId = null;
let recordChunks = [];
// 60s — matches server-side VOICE_STT_MAX_SECONDS default. Client-side cap
// keeps us from uploading audio the server will reject anyway.
const RECORD_MAX_MS = 60_000;

// ── Boot ───────────────────────────────────────────────

(async function init() {
  if (typeof globalThis.marked === "undefined") {
    showError("marked.js failed to load — check /static/marked.min.js");
    return;
  }
  // Configure marked: GFM (tables, strikethrough), no raw HTML.
  globalThis.marked.use({ gfm: true, breaks: false });
  bindUi();
  // Try to fetch history; if it 401s, we need login first.
  try {
    const res = await fetch("/api/history");
    if (res.ok) {
      const body = await res.json();
      enterChat(body.turns ?? []);
    } else {
      enterLogin();
    }
  } catch {
    enterLogin();
  }
})();

function bindUi() {
  els.loginForm.addEventListener("submit", onLoginSubmit);
  els.composer.addEventListener("submit", onSendSubmit);
  els.composerText.addEventListener("keydown", onComposerKeyDown);
  els.composerText.addEventListener("input", autoResize);
  els.clearBtn.addEventListener("click", () => sendUser("/clear all"));
  els.logoutBtn.addEventListener("click", onLogout);
  for (const pill of els.enginePills) {
    pill.addEventListener("click", () => setEngine(pill.dataset.prefix));
  }
  setEngine("");
  els.micBtn?.addEventListener("click", onMicClick);
}

// ── Auth ───────────────────────────────────────────────

function enterLogin() {
  els.login.classList.remove("hidden");
  els.chat.classList.add("hidden");
  els.loginToken.focus();
}

function enterChat(history) {
  els.login.classList.add("hidden");
  els.chat.classList.remove("hidden");
  for (const turn of history) {
    if (turn.prompt) appendMessage({ role: "user", markdown: turn.prompt });
    if (turn.response) appendMessage({ role: "assistant", markdown: turn.response });
  }
  scrollToBottom();
  openStream();
  els.composerText.focus();
  // Probe voice availability once per session. /api/voice/state returns 200
  // when VOICE_ENABLED=true, 503 when off. We surface the mic + speak
  // buttons only when the deploy supports them.
  refreshVoiceState();
}

async function onLoginSubmit(e) {
  e.preventDefault();
  const token = els.loginToken.value;
  els.loginError.textContent = "";
  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
      credentials: "same-origin",
    });
    if (res.status === 401) {
      els.loginError.textContent = "invalid token";
      return;
    }
    if (!res.ok) {
      els.loginError.textContent = `login failed (${res.status})`;
      return;
    }
    els.loginToken.value = "";
    const histRes = await fetch("/api/history");
    const body = histRes.ok ? await histRes.json() : { turns: [] };
    enterChat(body.turns ?? []);
  } catch (err) {
    els.loginError.textContent = "network error";
  }
}

async function onLogout() {
  if (stream) {
    stream.close();
    stream = null;
  }
  await fetch("/api/logout", { method: "POST" }).catch(() => {});
  messageNodes.clear();
  els.messages.innerHTML = "";
  enterLogin();
}

// ── SSE stream ─────────────────────────────────────────

function openStream() {
  setConn("connecting");
  if (stream) stream.close();
  stream = new EventSource("/api/stream");
  stream.onopen = () => setConn("connected");
  stream.onerror = () => {
    setConn("disconnected");
    // Browser auto-reconnects EventSource; no manual logic required.
  };
  stream.onmessage = (e) => {
    let event;
    try {
      event = JSON.parse(e.data);
    } catch {
      return;
    }
    handleEvent(event);
  };
}

function setConn(state) {
  els.connState.dataset.state = state;
  els.connState.textContent =
    state === "connected" ? "live" : state === "connecting" ? "…" : "off";
}

function handleEvent(event) {
  if (event.kind === "message") {
    const node = appendMessage({
      role: "assistant",
      markdown: event.markdown_source,
      html_fallback: event.html,
      message_id: event.message_id,
      reply_markup: event.reply_markup,
    });
    if (event.reply_markup) {
      addConfirmButtons(node, event.reply_markup);
    }
    scrollToBottom();
  } else if (event.kind === "edit") {
    const node = messageNodes.get(event.message_id);
    if (!node) return;
    const stick = isNearBottom();
    renderBody(node.querySelector(".body"), event.markdown_source, event.html);
    // Update the stashed markdown so the speak button (added when the
    // final-state sentinel appears) picks up the latest text. Each edit
    // overwrites — by the time `✅` lands, dataset.markdown has the full
    // final reply.
    if (typeof event.markdown_source === "string") {
      node.dataset.markdown = event.markdown_source;
    }
    maybeAddSpeakButton(node);
    if (stick) scrollToBottom();
  } else if (event.kind === "reaction") {
    // We don't render reactions in the web UI v1.
  }
}

// ── Sending ────────────────────────────────────────────

async function onSendSubmit(e) {
  e.preventDefault();
  const raw = els.composerText.value.trim();
  if (!raw) return;
  const text = activeEngine ? `${activeEngine}${raw}` : raw;
  els.composerText.value = "";
  autoResize();
  await sendUser(text);
}

async function sendUser(text) {
  appendMessage({ role: "user", markdown: text });
  scrollToBottom();
  els.sendBtn.disabled = true;
  try {
    const res = await fetch("/api/message", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (res.status === 429) {
      appendMessage({
        role: "assistant",
        markdown: "❌ queue full, please slow down",
      });
    } else if (res.status === 401) {
      enterLogin();
    } else if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      appendMessage({
        role: "assistant",
        markdown: `❌ send failed: ${body.error ?? res.status}`,
      });
    }
  } catch (err) {
    appendMessage({ role: "assistant", markdown: `❌ network error: ${err.message}` });
  } finally {
    els.sendBtn.disabled = false;
    els.composerText.focus();
  }
  // Slash command that flips sessions.voice_replies — refresh the badge
  // shortly after so the UI reflects new state. Small delay lets the
  // command's audit row settle before we re-query.
  if (/^\s*\/voice(\s|$)/i.test(text)) {
    window.setTimeout(refreshVoiceState, 500);
  }
}

function onComposerKeyDown(e) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    els.composer.requestSubmit();
  }
}

function autoResize() {
  els.composerText.style.height = "auto";
  els.composerText.style.height = Math.min(els.composerText.scrollHeight, 200) + "px";
}

function setEngine(prefix) {
  activeEngine = prefix;
  for (const pill of els.enginePills) {
    pill.classList.toggle("active", pill.dataset.prefix === prefix);
  }
}

// ── Tool-confirm ───────────────────────────────────────

function addConfirmButtons(msgNode, replyMarkup) {
  const row = replyMarkup?.inline_keyboard?.[0];
  if (!Array.isArray(row)) return;
  msgNode.classList.add("confirm");
  const actions = document.createElement("div");
  actions.className = "actions";
  for (const btn of row) {
    const b = document.createElement("button");
    b.textContent = btn.text;
    b.className = btn.text.includes("Allow") ? "allow" : "deny";
    b.addEventListener("click", () => onConfirmClick(btn.callback_data, msgNode));
    actions.appendChild(b);
  }
  msgNode.querySelector(".body").appendChild(actions);
}

async function onConfirmClick(callbackData, msgNode) {
  // callback_data shape: cb:<id>:<a|d>
  const m = /^cb:([^:]+):([ad])$/.exec(callbackData);
  if (!m) return;
  const callbackId = m[1];
  const decision = m[2] === "a" ? "allow" : "deny";
  // Visual feedback: disable both buttons immediately.
  for (const b of msgNode.querySelectorAll(".actions button")) b.disabled = true;
  try {
    await fetch("/api/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callback_id: callbackId, decision }),
    });
  } catch {
    // No-op — server-side broker will time out on its own.
  }
}

// ── Rendering ──────────────────────────────────────────

function appendMessage({ role, markdown, html_fallback, message_id }) {
  const li = document.createElement("li");
  li.className = `msg ${role}`;
  if (typeof message_id === "number") li.dataset.messageId = String(message_id);
  // Stash the raw markdown on the LI so the speak button can read it
  // straight from the DOM rather than tracking a parallel Map.
  if (typeof markdown === "string") li.dataset.markdown = markdown;
  const roleLabel = document.createElement("div");
  roleLabel.className = "role";
  roleLabel.textContent = role === "user" ? "you" : "solrac";
  const body = document.createElement("div");
  body.className = "body";
  renderBody(body, markdown, html_fallback);
  li.appendChild(roleLabel);
  li.appendChild(body);
  els.messages.appendChild(li);
  if (typeof message_id === "number") messageNodes.set(message_id, li);
  if (role === "assistant") maybeAddSpeakButton(li);
  return li;
}

function renderBody(bodyEl, markdown, htmlFallback) {
  let html;
  if (typeof markdown === "string" && markdown.length > 0) {
    try {
      html = globalThis.marked.parse(markdown);
    } catch {
      html = htmlFallback ?? escapeText(markdown);
    }
  } else {
    html = htmlFallback ?? "";
  }
  bodyEl.innerHTML = sanitizeHtml(html);
}

function escapeText(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function showError(text) {
  document.body.innerHTML = `<pre style="padding:16px;color:#b91c1c">${escapeText(text)}</pre>`;
}

function scrollToBottom() {
  els.messages.scrollTop = els.messages.scrollHeight;
}

// Sticky-bottom threshold: treat the user as "at the bottom" if they're within
// this many pixels of it. Bigger than 0 because line-wrap during a streaming
// edit can shift scrollHeight by a few px between frames.
const STICK_THRESHOLD_PX = 64;
function isNearBottom() {
  const el = els.messages;
  return el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD_PX;
}

// ── Voice ──────────────────────────────────────────────

async function refreshVoiceState() {
  try {
    const res = await fetch("/api/voice/state");
    if (res.status === 503) {
      // Deploy has VOICE_ENABLED=false. Hide mic + speak surfaces entirely.
      voiceFeatureAvailable = false;
      voiceModeOn = false;
      els.micBtn?.classList.add("hidden");
      els.voiceBadge?.classList.add("hidden");
      return;
    }
    if (!res.ok) return;
    const body = await res.json();
    voiceFeatureAvailable = true;
    voiceModeOn = body.enabled === true;
    els.micBtn?.classList.remove("hidden");
    if (voiceModeOn) {
      els.voiceBadge?.classList.remove("hidden");
      if (els.voiceBadge) els.voiceBadge.textContent = "🔊 voice mode on";
    } else {
      els.voiceBadge?.classList.add("hidden");
    }
    // Audit existing assistant bubbles for speak buttons — when voice
    // becomes available mid-session (e.g. after a server restart), already
    // rendered messages should grow their speak button too.
    for (const node of messageNodes.values()) {
      maybeAddSpeakButton(node);
    }
  } catch {
    // Network error — leave state as-is.
  }
}

async function onMicClick() {
  if (!voiceFeatureAvailable) return;
  if (recorder) {
    stopRecording(); // user tap to stop mid-flight
    return;
  }
  try {
    const mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = pickMediaRecorderMime();
    recorder = new MediaRecorder(mediaStream, mime ? { mimeType: mime } : undefined);
    recordChunks = [];
    recorder.addEventListener("dataavailable", (e) => {
      if (e.data && e.data.size > 0) recordChunks.push(e.data);
    });
    recorder.addEventListener("stop", () => onRecordingStop(mediaStream));
    recorder.start();
    setMicState("recording");
    recordTimeoutId = window.setTimeout(() => stopRecording(), RECORD_MAX_MS);
  } catch (err) {
    showToast(`mic error: ${err.message ?? "permission denied"}`);
    recorder = null;
    setMicState("idle");
  }
}

function stopRecording() {
  if (!recorder) return;
  if (recordTimeoutId !== null) {
    window.clearTimeout(recordTimeoutId);
    recordTimeoutId = null;
  }
  try {
    recorder.stop();
  } catch {
    // already inactive
  }
}

async function onRecordingStop(mediaStream) {
  setMicState("uploading");
  // Stop the audio tracks so the browser indicator clears immediately.
  for (const t of mediaStream.getTracks()) t.stop();
  const chunks = recordChunks;
  const mime = recorder?.mimeType || "audio/webm";
  recorder = null;
  recordChunks = [];
  if (chunks.length === 0) {
    setMicState("idle");
    return;
  }
  const blob = new Blob(chunks, { type: mime });
  const form = new FormData();
  form.append("audio", blob, mime.includes("ogg") ? "audio.ogg" : "audio.webm");
  try {
    const res = await fetch("/api/stt", { method: "POST", body: form });
    if (res.status === 401) {
      enterLogin();
      setMicState("idle");
      return;
    }
    if (res.status === 413) {
      showToast("audio too large — try a shorter clip");
      setMicState("idle");
      return;
    }
    if (res.status === 429) {
      showToast("voice cap reached — try again in a minute");
      setMicState("idle");
      return;
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      showToast(`transcription failed: ${body.message ?? res.status}`);
      setMicState("idle");
      return;
    }
    const body = await res.json();
    const text = typeof body.text === "string" ? body.text : "";
    if (text) {
      // Pre-fill the composer; cursor at end so a quick edit-then-send is
      // one keystroke. Operator decides whether to send — defends against
      // STT errors. No auto-send in v1.
      els.composerText.value = els.composerText.value
        ? els.composerText.value + " " + text
        : text;
      autoResize();
      els.composerText.focus();
      const len = els.composerText.value.length;
      els.composerText.setSelectionRange(len, len);
    }
  } catch (err) {
    showToast(`network error: ${err.message ?? "unknown"}`);
  } finally {
    setMicState("idle");
  }
}

function setMicState(state) {
  if (!els.micBtn) return;
  els.micBtn.classList.toggle("recording", state === "recording");
  els.micBtn.classList.toggle("uploading", state === "uploading");
  els.micBtn.disabled = state === "uploading";
  els.micBtn.title =
    state === "recording" ? "stop recording" : state === "uploading" ? "uploading…" : "record voice";
}

// MediaRecorder mime varies by browser:
//   - Chromium → 'audio/webm;codecs=opus' (preferred)
//   - Firefox  → same
//   - Safari   → 'audio/mp4' (Safari rejects 'audio/webm')
// Pick the first supported; let MediaRecorder default if none match
// (Scribe v2 accepts both webm/opus and mp4/aac).
function pickMediaRecorderMime() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return null;
  for (const m of candidates) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return null;
}

// ── Speak (TTS) ────────────────────────────────────────

// Detect "final state" of an assistant message — the agent and engine
// runners suffix successful turns with a `✅ N turns · $X.XXXX` footer
// in the markdown source (see agent.ts::buildFooter). When that sentinel
// is present we know the stream is settled and the speak button is safe
// to expose. Mid-stream the button stays absent so the operator can't
// pay for TTS on a partial reply.
function isFinalAssistantMarkdown(md) {
  if (typeof md !== "string") return false;
  return md.includes("*✅");
}

function maybeAddSpeakButton(node) {
  if (!voiceFeatureAvailable) return;
  if (node.classList.contains("user")) return;
  if (node.querySelector(".speak-btn")) return; // already added
  const md = node.dataset.markdown;
  if (!isFinalAssistantMarkdown(md)) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "speak-btn";
  btn.title = "speak this reply";
  btn.setAttribute("aria-label", "speak this reply");
  btn.textContent = "🔊";
  btn.addEventListener("click", () => onSpeakClick(node, btn));
  node.appendChild(btn);
}

async function onSpeakClick(node, btn) {
  const markdown = node.dataset.markdown ?? "";
  const messageId = node.dataset.messageId ? Number(node.dataset.messageId) : null;
  if (!markdown) return;
  btn.disabled = true;
  btn.classList.add("loading");
  try {
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message_id: messageId, markdown }),
    });
    if (res.status === 401) {
      enterLogin();
      return;
    }
    if (res.status === 413) {
      showToast("reply too long to speak — try /voice on for terser replies");
      return;
    }
    if (res.status === 429) {
      const body = await res.json().catch(() => ({}));
      showToast(body.message ?? "voice cap reached");
      return;
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      showToast(`speak failed: ${body.message ?? res.status}`);
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    // Inject audio via DOM API (NOT innerHTML) — the sanitizer is for
    // marked-rendered LLM content; this audio element is UI chrome added
    // by app code, so the trust boundary doesn't move (plan §10.3).
    let existing = node.querySelector(".speak-audio");
    if (existing) {
      // Revoke the previous blob URL before replacing so we don't leak.
      const prev = existing.dataset.blobUrl;
      if (prev) URL.revokeObjectURL(prev);
      existing.remove();
    }
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.src = url;
    audio.className = "speak-audio";
    audio.dataset.blobUrl = url;
    audio.autoplay = true;
    node.appendChild(audio);
  } catch (err) {
    showToast(`network error: ${err.message ?? "unknown"}`);
  } finally {
    btn.disabled = false;
    btn.classList.remove("loading");
  }
}

// ── Toast ──────────────────────────────────────────────

function showToast(text) {
  if (!els.toastHost) return;
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = text;
  els.toastHost.appendChild(t);
  // 4s fade-then-remove. The CSS animation handles fade; we just clean up.
  window.setTimeout(() => {
    t.classList.add("fading");
    window.setTimeout(() => t.remove(), 500);
  }, 4000);
}
