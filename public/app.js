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
    renderBody(node.querySelector(".body"), event.markdown_source, event.html);
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
