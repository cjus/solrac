/**
 * @fileoverview Typed `fetch` wrapper for the ElevenLabs HTTP API.
 * @purpose Two endpoints, one file. STT (`POST /v1/speech-to-text`, multipart)
 *          and TTS streaming (`POST /v1/text-to-speech/{voice_id}/stream`,
 *          JSON in / chunked body out). No SDK — preserves the "marked is the
 *          only other runtime dep" anti-goal.
 *
 * Solrac sits behind ElevenLabs at conversational latency. STT is a single
 * round-trip with an audio blob; TTS is proxy-streamed from upstream straight
 * back to the caller (browser `<audio>` or buffered for Telegram `sendVoice`),
 * so this module returns the upstream `ReadableStream` as-is rather than
 * buffering server-side.
 *
 * §17 probe captured at impl time (2026-05): with
 * `output_format=opus_48000_64`, ElevenLabs returns an Ogg-containerized
 * Opus payload (magic bytes `OggS`, `content-type: audio/opus`). Telegram's
 * `sendVoice` accepts this directly — no transcoding step needed. If a future
 * ElevenLabs change flips this to raw Opus, the `voice.ts` probe falls back
 * to `mp3_44100_64` + `sendAudio` via env var.
 *
 * Position in the dependency graph:
 *   log + config → elevenlabs → consumed by voice
 *
 * Exports:
 *   - `speechToText(opts)` — multipart upload, returns `{ text, durationSeconds }`.
 *   - `textToSpeechStream(opts)` — JSON request, returns `{ contentType, body }`
 *     where `body` is the upstream `ReadableStream<Uint8Array>` (proxy through).
 *   - `ElevenLabsError` / `ElevenLabsAuthError` / `ElevenLabsRateError` —
 *     typed errors; orchestration layer maps to user-facing outcomes.
 *
 * Key invariants:
 *   - The API key is passed in via the call site (`opts.apiKey`) — this module
 *     never reads `process.env`. Lets `voice.ts` own the "voice disabled"
 *     branching without an env probe per call.
 *   - Never logs the API key, the upload bytes, or the response audio. The
 *     plain transcript text is fine to log (the operator owns the audit log)
 *     but the wrapper itself does NOT log — callers do.
 *   - `signal?: AbortSignal` is honored on both requests so an operator-side
 *     timeout (or shutdown) can cut the upstream connection. Default timeout
 *     wiring lives in the caller, not here.
 *
 * Gotchas:
 *   - ElevenLabs returns HTTP 401 for missing/invalid keys, 429 for rate
 *     limits, and 422 for malformed bodies. We surface 401 → `ElevenLabsAuthError`,
 *     429 → `ElevenLabsRateError`, everything else 4xx/5xx → `ElevenLabsError`
 *     with the upstream message in `.message` if JSON-decodable.
 *   - The STT response shape is `{ text, audio_duration_secs, ... }` — we
 *     consume only the two fields we bill on; future fields (language, words)
 *     are ignored silently to avoid churn on minor upstream additions.
 *   - For TTS we return the `ReadableStream` from `Response.body`. The caller
 *     is responsible for consuming it (`Response(body)` pipe-through for web,
 *     `arrayBuffer()` aggregation for Telegram). Leaking it = leaking a socket.
 */

const STT_URL = "https://api.elevenlabs.io/v1/speech-to-text";
const TTS_BASE = "https://api.elevenlabs.io/v1/text-to-speech";

export class ElevenLabsError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ElevenLabsError";
    this.status = status;
  }
}

export class ElevenLabsAuthError extends ElevenLabsError {
  constructor(message: string) {
    super(message, 401);
    this.name = "ElevenLabsAuthError";
  }
}

export class ElevenLabsRateError extends ElevenLabsError {
  constructor(message: string) {
    super(message, 429);
    this.name = "ElevenLabsRateError";
  }
}

export interface SttResult {
  text: string;
  durationSeconds: number;
}

export interface SttRequestOpts {
  apiKey: string;
  modelId: string;
  audio: Blob;
  filename?: string;
  signal?: AbortSignal;
}

export interface TtsRequestOpts {
  apiKey: string;
  voiceId: string;
  modelId: string;
  outputFormat: string;
  text: string;
  signal?: AbortSignal;
}

export interface TtsStream {
  contentType: string;
  body: ReadableStream<Uint8Array>;
}

async function decodeUpstreamError(res: Response): Promise<string> {
  try {
    const body = await res.text();
    try {
      const parsed = JSON.parse(body) as { detail?: { message?: string } | string };
      if (typeof parsed.detail === "string") return parsed.detail;
      if (parsed.detail && typeof parsed.detail.message === "string") return parsed.detail.message;
    } catch {
      // Body is not JSON; fall through and surface the raw text bounded.
    }
    return body.slice(0, 200);
  } catch {
    return `HTTP ${res.status}`;
  }
}

function throwForStatus(status: number, message: string): never {
  if (status === 401) throw new ElevenLabsAuthError(message);
  if (status === 429) throw new ElevenLabsRateError(message);
  throw new ElevenLabsError(message, status);
}

export async function speechToText(opts: SttRequestOpts): Promise<SttResult> {
  const form = new FormData();
  form.append("model_id", opts.modelId);
  form.append("file", opts.audio, opts.filename ?? "audio.webm");
  const res = await fetch(STT_URL, {
    method: "POST",
    headers: { "xi-api-key": opts.apiKey },
    body: form,
    signal: opts.signal,
  });
  if (!res.ok) {
    const msg = await decodeUpstreamError(res);
    throwForStatus(res.status, `ElevenLabs STT failed: ${msg}`);
  }
  const json = (await res.json()) as {
    text?: unknown;
    audio_duration_secs?: unknown;
  };
  const text = typeof json.text === "string" ? json.text : "";
  const durationSeconds =
    typeof json.audio_duration_secs === "number" ? json.audio_duration_secs : 0;
  return { text, durationSeconds };
}

export async function textToSpeechStream(opts: TtsRequestOpts): Promise<TtsStream> {
  const url = `${TTS_BASE}/${encodeURIComponent(opts.voiceId)}/stream?output_format=${encodeURIComponent(opts.outputFormat)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": opts.apiKey,
      "content-type": "application/json",
      accept: "audio/*",
    },
    body: JSON.stringify({ text: opts.text, model_id: opts.modelId }),
    signal: opts.signal,
  });
  if (!res.ok) {
    const msg = await decodeUpstreamError(res);
    throwForStatus(res.status, `ElevenLabs TTS failed: ${msg}`);
  }
  if (res.body === null) {
    throw new ElevenLabsError("ElevenLabs TTS returned empty body", res.status);
  }
  const contentType = res.headers.get("content-type") ?? "application/octet-stream";
  return { contentType, body: res.body };
}
