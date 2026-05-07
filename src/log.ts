/**
 * @fileoverview Structured JSON logger for Solrac.
 * @purpose Emit one JSON line per event so journalctl + jq can grep, filter,
 *          and correlate without a log-aggregation framework.
 *
 * Solrac's runtime context is "single Bun process under systemd." The right
 * log primitive for that context is line-delimited JSON to stdout (info/debug)
 * and stderr (warn/error). systemd captures both via the journal; jq reads it.
 * No log-level filtering at runtime — every level prints, and `jq 'select(...)'`
 * replaces a level threshold. No timestamps from the system because each line
 * already carries an ISO `ts`.
 *
 * Why not `pino`/`bunyan`/`winston`: this is 24 lines and survives bumps to
 * Bun's runtime without needing a peer-dep matrix. The cost of a JSON.stringify
 * per log call is irrelevant at our throughput (<<1 line/ms).
 *
 * Position in the dependency graph:
 *   (no internal deps) → log → consumed by every other module
 *
 * Exports:
 *   - `log` — `{ debug, info, warn, error }`; each takes `(msg, fields?)`.
 *
 * Key invariants:
 *   - Every line is a single self-contained JSON object terminated by `\n`.
 *   - `error`/`warn` go to stderr so systemd's journal picks them up at the
 *     right priority; `info`/`debug` go to stdout.
 *   - Sensitive values (tokens, API keys) are NEVER logged. If you see a leak,
 *     fix it — there is no "redaction layer."
 *
 * Cross-references:
 *   - docs/OPERATIONS.md#log-events — canonical event-name catalog
 *   - docs/ARCHITECTURE.md#logging — field conventions
 */

type Level = "debug" | "info" | "warn" | "error";

type Fields = Record<string, unknown>;

function emit(level: Level, msg: string, fields?: Fields): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...fields,
  });
  if (level === "error" || level === "warn") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

export const log = {
  debug: (msg: string, fields?: Fields) => emit("debug", msg, fields),
  info: (msg: string, fields?: Fields) => emit("info", msg, fields),
  warn: (msg: string, fields?: Fields) => emit("warn", msg, fields),
  error: (msg: string, fields?: Fields) => emit("error", msg, fields),
};
