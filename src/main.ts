/**
 * @fileoverview Entry point: wires every module and selects the transport.
 * @purpose Boot sequence — load config, open DB, bootstrap allowlist, build
 *          tracker / queue / broker / cost guard / throttle, start server
 *          with stats snapshot, install lifecycle, fire daily-report cron,
 *          and start the poll loop.
 *
 * `main.ts` is the only file that reaches across module boundaries. Every
 * other module has a narrow dep direction (see docs/ARCHITECTURE.md#module-map).
 * If you find yourself adding cross-module wiring outside `main`, ask whether
 * the new dep belongs upstream of one of the existing modules instead.
 *
 * The transport switch (`config.transport`) is the planned extension point
 * for Step 9 webhook (deferred). Today only `poll` is implemented; webhook
 * falls through to a `transport.not_implemented` warn log.
 *
 * Boot sequence (poll transport):
 *   1. loadConfig (fail-loud on missing required vars)
 *   2. openDb (mkdir, schema, prepared statements)
 *   3. createAllowlist + bootstrap (additive; INSERT OR IGNORE)
 *   4. createSessionStore (typed UPSERT layer)
 *   5. acquirePidFile (stale-detect + write)
 *   6. createTelegramClient (raw fetch + 429/409 handling)
 *   7. TurnTracker, ConfirmationBroker, CostCapGuard, DenialThrottle
 *   8. createTurnQueue (mutex + sema + tracker composition)
 *   9. startServer with /stats snapshot reading from queue + tracker + db
 *  10. installShutdown (drain on SIGINT/SIGTERM)
 *  11. startDailyReportCron (boot-fire + 24h interval, gated on allowlist)
 *  12. startPolling (long-poll loop — blocks until pollAbort)
 *
 * Position in the dependency graph:
 *   ALL modules → main → process entry
 *
 * Exports:
 *   - none (entry-point script). The default export is the side effect of
 *     the `main()` invocation at the bottom of the file.
 *
 * Key invariants:
 *   - Server boot is AFTER queue construction so /stats can read live
 *     counters from the same tracker + queue + db.
 *   - `installShutdown` runs BEFORE `startPolling` so the SIGTERM handler is
 *     installed before the loop can be interrupted.
 *   - Daily report cron starts ONLY when `allowlistBootstrap.length > 0` —
 *     otherwise there's no operator to DM.
 *   - `gateAndAuditDenied` returns `true` to mean "stop" (deny path); the
 *     poll handler `return`s on true. Callback queries route through the
 *     broker, not the queue.
 *
 * Gotchas:
 *   - `gateAndAuditDenied` writes the audit row for denials. The throttle
 *     check happens BEFORE the audit insert, so throttled denials skip the
 *     write. See docs/ARCHITECTURE.md#db-pollution-defenses.
 *   - `auditQueueFull` writes a `status='error', error_message='queue_full'`
 *     row when `enqueue()` returns `dropped_queue_full`. Downstream
 *     observability counts these as errors, not denials.
 *   - `process.exit(1)` on `loadConfig` failure is intentional — env errors
 *     are unrecoverable; restart with fixed env.
 *   - `main()` is at the bottom; the `.catch` logs `solrac.fatal` and exits
 *     1. Don't add unhandled-rejection handlers — fatal-exit is correct.
 *
 * Cross-references:
 *   - docs/ARCHITECTURE.md#end-to-end-data-flow — request lifecycle trace
 *   - docs/SETUP.md — how to boot this from a fresh clone
 *   - All other src/*.ts files — main is the integration test for the lot
 */

import {
  createSdkMcpServer,
  type CanUseTool,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import type { Update } from "@grammyjs/types";
import packageJson from "../package.json";
import { runAgent } from "./agent.ts";
import { createAllowlist, type Allowlist } from "./allowlist.ts";
import {
  BOT_COMMAND_REGISTRY,
  parseCommand,
  runCommand,
  type EngineSkillDeps,
  type RunCommandDeps,
} from "./commands.ts";
import { loadConfig, type Config } from "./config.ts";
import { startDailyReportCron } from "./daily-report.ts";
import { openDb, type SolracDb } from "./db.ts";
import {
  bootstrapInstanceFiles,
  instanceMdPath,
  loadSoul,
  logBootstrapResult,
} from "./instance.ts";
import { installShutdown } from "./lifecycle.ts";
import { log } from "./log.ts";
import {
  runEngineTurn,
  type EngineRunDeps,
} from "./engine.ts";
import type { EngineDriver } from "./engine-driver.ts";
import { createLocalDriver } from "./local-driver.ts";
import { createRemoteDriver } from "./remote-driver.ts";
import { acquirePidFile, startPolling } from "./poll.ts";
import {
  createConfirmationBroker,
  createCostCapGuard,
  createDenialThrottle,
  createGlobalCostCapGuard,
  createPolicyHook,
  dispatchCallbackQuery,
  extractChatId,
  extractFromId,
  gateUpdate,
  parseEnginePrefix,
  truncateAuditPrompt,
  type ConfirmationBroker,
  type ConfirmHandle,
  type CostCapGuard,
  type DenialThrottle,
  type GlobalCostCapGuard,
} from "./policy.ts";
import { createTurnQueue, type EnqueueResult } from "./queue.ts";
import {
  EMPTY_TASK_REGISTRY,
  getScheduledContext,
  loadTasksSync,
  logTaskLoadResult,
  startScheduler,
  type SchedulerHandle,
  type TaskRegistry,
} from "./scheduler.ts";
import { startServer } from "./server.ts";
import { createSessionStore, type SessionStore } from "./session.ts";
import {
  type ConfirmFormatter,
  BUILTIN_INTEGRATION_NAMES,
  createIntegrationContext,
  loadBuiltinIntegrations,
  loadIntegrations,
  logIntegrationLoadResult,
  mergeIntegrationResults,
} from "./integrations.ts";
import { buildSkillTools } from "./skill-tools.ts";
import {
  EMPTY_SKILL_REGISTRY,
  loadSkillsSync,
  logSkillLoadResult,
  skillsToBotCommands,
  type SkillRegistry,
} from "./skills.ts";
import { createTelegramClient, type TelegramClient } from "./telegram.ts";
import { TurnTracker } from "./turn-tracker.ts";
import { createWebClient, type WebClient } from "./web-client.ts";
import { startWebServer } from "./web.ts";
import {
  handleTelegramVoiceStt,
  maybeReplyWithVoice,
  type VoiceDeps,
  type VoiceTelegramSender,
} from "./voice.ts";

interface RunTurnDeps {
  tg: TelegramClient;
  db: SolracDb;
  sessions: SessionStore;
  config: Config;
  // PNX-167 (system-prompt externalization). `soul` is the SOUL.md text
  // loaded once at boot; `instanceMdPath` points at SOLRAC.md in the launch
  // cwd and is re-read per turn by both engine runners.
  soul: string;
  instanceMdPath: string;
  // PLAN Step 12: lifted out of `config` so the dispatcher can read each tier
  // directly and the engine-aware usage hints stay simple. Both must match
  // the Anthropic SDK's expected model id.
  primaryModel: string;
  secondaryModel: string;
  costGuard: CostCapGuard;
  globalCostGuard: GlobalCostCapGuard;
  createCanUseTool: (args: {
    chatId: number;
    auditId: number;
    pendingHandles: Map<string, ConfirmHandle>;
  }) => CanUseTool;
  // Present iff `LOCAL_ENABLED=true`. When set, no-prefix messages route to
  // runEngineTurn instead of runAgent. Both paths share the queue, mutex,
  // semaphore, and tracker drain — dispatch happens inside the queued worker.
  localDeps: EngineRunDeps | null;
  // PNX-167 — slash command surface. `commandDeps` carries the dispatcher's
  // dependencies (allowlist, queue snapshot, startedAt, etc.) so the
  // command path stays self-contained. `botUsername` is the cached lowercase
  // identifier from boot-time `getMe`; `null` if the call failed (we then
  // accept plain commands and reject any `@bot` suffix in `parseCommand`).
  commandDeps: RunCommandDeps;
  botUsername: string | null;
  // PNX-167.1 — operator-defined skills loaded from `$SOLRAC_SKILLS_DIR` at
  // boot. Plumbed into `parseCommand` so a typed `/<skill-name>` resolves
  // before the unknown-command fallback. `EMPTY_SKILL_REGISTRY` when the
  // feature is disabled (`SOLRAC_SKILLS_ENABLED=false`).
  skillRegistry: SkillRegistry;
  // Phase 2 — in-process MCP server hosting operator + blessed integrations.
  // `null` when integrations are disabled or zero tools loaded; otherwise the
  // value created by `createSdkMcpServer` and threaded into `runAgent`'s
  // `options.mcpServers`. Claude tiers only — local path ignores this.
  mcpServer: McpSdkServerConfigWithInstance | null;
  // Voice (ElevenLabs). `null` when VOICE_ENABLED=false. When non-null, the
  // dispatcher routes `msg.voice` through `handleTelegramVoiceStt` to
  // transcribe → enqueue the synthesized text Update. Wired only on the
  // Telegram transport (web has its own /api/stt route).
  voiceDeps: VoiceDeps | null;
  // Forward reference to `queue.enqueue` so the voice dispatcher can
  // re-enqueue a synthesized text Update once STT lands. Mutable closure
  // bound at boot (queue is built after makeRunTurn — same pattern as
  // `getQueueSnapshot` and `triggerScheduledTask`).
  enqueue: (update: Update) => EnqueueResult;
  // Phase 5 — post-turn TTS attach. Threaded into AgentRunDeps and the
  // localDeps EngineRunDeps so Claude tiers + local + remote all attach a
  // voice note when `voice_replies=1`. `undefined` on the web RunTurnDeps
  // (web has its own per-message speak button).
  attachVoiceReply?: AttachVoiceReply;
  // Word target for the voice-mode prompt nudge (Phase 1). Threaded to
  // both runners. `undefined` when VOICE_ENABLED=false; identical for
  // Telegram + web (both transports inject the nudge when /voice on).
  voiceReplyWords?: number;
}

type AttachVoiceReply = (opts: {
  chatId: number;
  messageId: number | null;
  auditId: number;
  finalText: string;
}) => Promise<void>;

function makeRunTurn(deps: RunTurnDeps): (update: Update) => Promise<void> {
  return async (update) => {
    const msg = update.message;
    if (!msg || !msg.from) {
      log.debug("turn.ignored", { update_id: update.update_id, kind: "no-msg-or-no-from" });
      return;
    }
    // Voice note → STT → re-enqueue as synthesized text. Gated on
    // `voiceDeps` (null when VOICE_ENABLED=false). The synthesized Update
    // carries the same update_id/from/chat but `text=transcript` and NO
    // `voice` field, so this branch can't loop. Cap-check, gate, and
    // voice_events row all happen inside `handleTelegramVoiceStt`.
    if (!msg.text && msg.voice && deps.voiceDeps) {
      const chatId = msg.chat.id;
      log.info("turn.voice_received", {
        update_id: update.update_id,
        chat_id: chatId,
        from_id: msg.from.id,
        duration: msg.voice.duration,
      });
      await deps.tg
        .sendChatAction(chatId, "record_voice")
        .catch((err) =>
          log.debug("voice.chat_action_failed", { error: (err as Error).message }),
        );
      const result = await handleTelegramVoiceStt(deps.voiceDeps, {
        update,
        voiceFileId: msg.voice.file_id,
      });
      if (result.kind === "synthesized") {
        log.info("voice.stt_ok", {
          update_id: update.update_id,
          chat_id: chatId,
          text_preview: result.update.message?.text?.slice(0, 80) ?? "",
        });
        const enq = deps.enqueue(result.update);
        if (enq.kind === "dropped_queue_full") {
          await deps.tg
            .sendMessage(chatId, `queue full (${enq.depth} waiting) — try again in a moment`)
            .catch((err) =>
              log.warn("voice.queue_full_notice_failed", { error: (err as Error).message }),
            );
        }
        return;
      }
      if (result.kind === "denied_cap") {
        await deps.tg
          .sendMessage(chatId, "voice cap reached, try again in a minute")
          .catch((err) =>
            log.warn("voice.cap_notice_failed", { error: (err as Error).message }),
          );
      } else if (result.kind === "error") {
        log.warn("voice.stt_failed", {
          update_id: update.update_id,
          chat_id: chatId,
          message: result.message,
        });
        await deps.tg
          .sendMessage(chatId, "voice transcription failed — try sending as text")
          .catch((err) =>
            log.warn("voice.error_notice_failed", { error: (err as Error).message }),
          );
      }
      // denied_gate is silent (parity with the text-gate path).
      return;
    }
    if (!msg.text) {
      log.debug("turn.ignored", { update_id: update.update_id, kind: "non-text-or-voice" });
      return;
    }
    // Scheduler — when this update was synthesized by the tick driver, the
    // message carries a `__solrac_scheduled` field. Skips the slash-command
    // parser (scheduled tasks never invoke `/cmd`) and propagates the task
    // identity into the runner so the audit row carries origin='scheduled'.
    const scheduledCtx = getScheduledContext(msg);
    log.info("turn.start", {
      update_id: update.update_id,
      chat_id: msg.chat.id,
      from_id: msg.from.id,
      text: msg.text.slice(0, 80),
      ...(scheduledCtx && { scheduled_task: scheduledCtx.name }),
    });

    // PNX-167 — slash commands intercept before engine-prefix routing. Three
    // outcomes from the parser:
    //   - run        → we own this command; dispatch and return (no engine)
    //   - ignore     → starts with `/` but `@bot` targets another bot in a
    //                  group chat; drop the update silently
    //   - passthrough → not a command; existing engine routing handles it
    //
    // Skip command parsing for scheduled fires — the scheduler rejects empty
    // bodies at parse, and a TASK.md whose body happens to start with `/`
    // would otherwise be hijacked by a bot command.
    if (scheduledCtx) {
      // Fall through to engine-prefix routing below.
    } else {
    const parsedCmd = parseCommand(msg.text, {
      botUsername: deps.botUsername,
      skillRegistry: deps.skillRegistry,
    });
    if (parsedCmd.kind === "ignore") {
      log.debug("turn.command_other_bot", {
        update_id: update.update_id,
        chat_id: msg.chat.id,
      });
      return;
    }
    if (parsedCmd.kind === "run") {
      await runCommand(deps.commandDeps, msg, parsedCmd.cmd, update.update_id);
      log.info("turn.done", {
        update_id: update.update_id,
        chat_id: msg.chat.id,
        route: `cmd:${parsedCmd.cmd.kind}`,
      });
      return;
    }
    } // end !scheduledCtx command-parsing branch

    const parsed = parseEnginePrefix(msg.text, deps.config.defaultEngine);

    if (parsed.engine === "local") {
      if (!deps.localDeps) {
        // Defensive: shouldn't fire in practice — boot validation requires
        // `LOCAL_ENABLED=true` whenever `defaultEngine === "local"`. Kept as
        // a safety net so a misconfigured deploy ack-replies rather than
        // hangs on the no-deps path.
        await deps.tg
          .sendMessage(msg.chat.id, "local engine disabled in this deployment")
          .catch((err) =>
            log.warn("engine.disabled_ack_failed", { error: (err as Error).message }),
          );
        log.info("turn.done", {
          update_id: update.update_id,
          chat_id: msg.chat.id,
          route: "local_disabled",
        });
        return;
      }
      // Empty body is unreachable on Telegram (the platform rejects empty
      // messages) and the web UI guards against it. Send the user's text
      // straight to the runner.
      await runEngineTurn(deps.localDeps, {
        chatId: msg.chat.id,
        fromId: msg.from.id,
        updateId: scheduledCtx ? null : update.update_id,
        prompt: parsed.prompt,
        scheduledTaskName: scheduledCtx?.name ?? null,
      });
      log.info("turn.done", {
        update_id: update.update_id,
        chat_id: msg.chat.id,
        route: "local",
      });
      return;
    }

    // Claude tier path. PR-B: `@` → primary, `!` → secondary; no-prefix only
    // routes here when the operator pinned `SOLRAC_DEFAULT_ENGINE=primary` (or
    // `=secondary`). Empty payload after an explicit prefix renders a usage
    // hint.
    if (parsed.explicit && parsed.prompt === "") {
      const tierLabel = parsed.engine === "primary" ? "primary Claude" : "secondary Claude";
      const prefixChar = parsed.engine === "primary" ? "@" : "!";
      const tierModel =
        parsed.engine === "primary" ? deps.primaryModel : deps.secondaryModel;
      await deps.tg
        .sendMessage(
          msg.chat.id,
          `usage: <code>${prefixChar}&lt;prompt&gt;</code> — sends to ${tierLabel} (model: ${tierModel})`,
          { parse_mode: "HTML" },
        )
        .catch((err) =>
          log.warn("claude.usage_ack_failed", { error: (err as Error).message }),
        );
      log.info("turn.done", {
        update_id: update.update_id,
        chat_id: msg.chat.id,
        route: `${parsed.engine}_usage`,
      });
      return;
    }

    // Explicit-prefix prompts are pre-trimmed by the parser; no-prefix
    // prompts pass `msg.text` through untouched (matches pre-Step-12 path).
    const promptForAgent = parsed.explicit ? parsed.prompt : msg.text;

    await runAgent(
      {
        tg: deps.tg,
        db: deps.db,
        sessions: deps.sessions,
        dataDir: deps.config.dataDir,
        soul: deps.soul,
        instanceMdPath: deps.instanceMdPath,
        // PR-B — `true` only when the operator pinned a Claude tier as
        // default (Claude-only deploys). Drives the capability-note tone.
        isDefaultEngine: deps.config.defaultEngine !== "local",
        primaryModel: deps.primaryModel,
        secondaryModel: deps.secondaryModel,
        costGuard: deps.costGuard,
        globalCostGuard: deps.globalCostGuard,
        createCanUseTool: deps.createCanUseTool,
        mcpServer: deps.mcpServer,
        voiceReplyWords: deps.voiceReplyWords,
        attachVoiceReply: deps.attachVoiceReply,
      },
      {
        chatId: msg.chat.id,
        fromId: msg.from.id,
        updateId: scheduledCtx ? null : update.update_id,
        prompt: promptForAgent,
        engine: parsed.engine,
        scheduledTaskName: scheduledCtx?.name ?? null,
      },
    );
    log.info("turn.done", {
      update_id: update.update_id,
      chat_id: msg.chat.id,
      route: parsed.engine,
    });
  };
}

async function handleCallbackQuery(
  update: Update,
  broker: ConfirmationBroker,
  tg: TelegramClient,
): Promise<void> {
  const result = dispatchCallbackQuery(broker, update);
  if (!result.handled || !result.callbackQueryId) return;
  const text = result.expired
    ? "Confirmation expired — send the request again."
    : result.decision === "allow"
      ? "Allowed"
      : "Denied";
  // The toast shown on the user's tap. Confirm-message text edits (verdict
  // line + outcome line) are owned by the broker — see policy.ts so the
  // verdict + tool-outcome footers stay consistent. We keep `answerCallbackQuery`
  // here because it requires the `callback_query_id` from the update event.
  await tg
    .call("answerCallbackQuery", { callback_query_id: result.callbackQueryId, text })
    .catch((err) => log.warn("callback.ack_failed", { error: (err as Error).message }));
}

function gateAndAuditDenied(
  update: Update,
  allowlist: Allowlist,
  db: SolracDb,
  throttle: DenialThrottle,
): boolean {
  const gate = gateUpdate(update, allowlist.isAllowed);
  if (gate.kind === "ok") return false;
  if (gate.kind === "no_from") {
    log.debug("update.no_from", { update_id: update.update_id });
    return true;
  }
  if (throttle.check(gate.fromId) === "skip") {
    log.debug("update.denied_throttled", {
      update_id: update.update_id,
      from_id: gate.fromId,
      chat_id: gate.chatId ?? null,
    });
    return true;
  }
  const now = Date.now();
  const promptText = truncateAuditPrompt(
    update.message?.text ?? update.callback_query?.data ?? "",
  );
  const auditId = db.insertAudit({
    chatId: gate.chatId ?? 0,
    fromId: gate.fromId,
    updateId: update.update_id,
    prompt: promptText,
    startedAt: now,
    // Denials predate engine selection; tag as 'system' so the row is
    // distinguishable from real claude/local: rows in audit dumps.
    model: "system",
  });
  db.updateAuditEnd({
    id: auditId,
    response: null,
    toolCalls: null,
    inputTokens: null,
    outputTokens: null,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
    costUsd: null,
    agentSessionId: null,
    status: "denied",
    errorMessage: "from_id not in allowlist",
    endedAt: now,
  });
  log.warn("update.denied_unallowlisted", {
    update_id: update.update_id,
    from_id: gate.fromId,
    chat_id: gate.chatId ?? null,
    audit_id: auditId,
  });
  return true;
}

export function auditQueueFull(update: Update, db: SolracDb, tg: TelegramClient, depth: number): void {
  const fromId = extractFromId(update);
  if (fromId === undefined) return;
  const chatId = extractChatId(update) ?? 0;
  const now = Date.now();
  const promptText = truncateAuditPrompt(
    update.message?.text ?? update.callback_query?.data ?? "",
  );
  const auditId = db.insertAudit({
    chatId,
    fromId,
    updateId: update.update_id,
    prompt: promptText,
    startedAt: now,
    // Queue-full predates engine selection; the original update was rejected
    // before any engine ran.
    model: "system",
  });
  db.updateAuditEnd({
    id: auditId,
    response: null,
    toolCalls: null,
    inputTokens: null,
    outputTokens: null,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
    costUsd: null,
    agentSessionId: null,
    status: "error",
    errorMessage: "queue_full",
    endedAt: now,
  });
  log.warn("update.dropped_queue_full", {
    update_id: update.update_id,
    from_id: fromId,
    chat_id: chatId,
    depth,
    audit_id: auditId,
  });
  // Fire-and-forget: tell the user their message was dropped so silence isn't
  // ambiguous. The queue-full path is already a backpressure signal — the cap
  // fired because this chat has ≥MAX_CHAT_QUEUE_DEPTH turns chained. One more
  // message to the same chat is acceptable (and the agent itself isn't running
  // for this update). We don't await; if Telegram is also struggling, the
  // audit row is the operator-facing source of truth.
  if (chatId !== 0) {
    void tg
      .sendMessage(chatId, "queue full, please slow down")
      .catch((err) => log.warn("queue_full.ack_failed", { error: (err as Error).message }));
  }
}

// Operator-readable label for the web UI's default-engine pill. The pill
// itself ships with the empty `data-prefix=""`, but the title attr is
// substituted at serve time so the user hovers over a label matching the
// deploy. Engine-slot deploys carry the mode + backend in parentheses
// (e.g. `local (ollama)`, `remote (openrouter)`) so the operator sees which
// backend served the turn at a glance.
function defaultEngineLabel(
  engine: "local" | "primary" | "secondary",
  localBackend: "ollama" | "lmstudio" | null,
  remoteBackend: "openrouter" | null,
): string {
  if (engine === "local") {
    if (remoteBackend) return `remote (${remoteBackend})`;
    return `local (${localBackend ?? "?"})`;
  }
  if (engine === "primary") return "primary Claude (Sonnet)";
  return "secondary Claude (Opus)";
}

// Boot-time local-engine health probe. Non-fatal: any failure is logged
// (warn) so the operator sees the misconfiguration but the process keeps
// running. Daemon may come up after Solrac under systemd; the next user
// turn will succeed once the daemon is reachable. Delegates the probe to
// the driver so each backend hits its own probe URL (`/api/tags` for Ollama,
// `/v1/models` for LMStudio).
async function probeEngineHealth(driver: EngineDriver, model: string): Promise<void> {
  const backend = driver.backend;
  try {
    const result = await driver.probe(model, AbortSignal.timeout(5_000));
    if (!result.ok) {
      if (result.modelMissing) {
        log.warn("engine.boot_health_model_missing", {
          backend,
          model,
          hint: result.reason,
        });
      } else {
        log.warn("engine.boot_health_failed", {
          backend,
          model,
          hint: result.reason,
        });
      }
      return;
    }
    log.info("engine.boot_health_ok", { backend, model });
  } catch (err) {
    log.warn("engine.boot_health_failed", {
      backend,
      model,
      error: (err as Error).message,
    });
  }
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    log.error("config.invalid", { error: (err as Error).message });
    process.exit(1);
  }

  log.info("solrac.boot", {
    version: packageJson.version,
    transport: config.transport,
    defaultEngine: config.defaultEngine,
    primaryModel: config.primaryModel,
    secondaryModel: config.secondaryModel,
    port: config.port,
    dataDir: config.dataDir,
    allowlistSize: config.allowlistBootstrap.length,
    maxConcurrentTurns: config.maxConcurrentTurns,
    hourlyCostCapUsd: config.hourlyCostCapUsd,
    globalHourlyCostCapUsd: config.globalHourlyCostCapUsd,
    localEnabled: config.localEnabled,
    localBackend: config.localBackend,
    localModel: config.localModel,
    localUrl: config.localUrl,
    remoteEnabled: config.remoteEnabled,
    remoteBackend: config.remoteBackend,
    remoteModel: config.remoteModel,
    remoteBaseUrl: config.remoteBaseUrl,
  });
  // One-release-cycle silent-flip guard. Operators upgrading without setting
  // `SOLRAC_DEFAULT_ENGINE` would see no-prefix messages start hitting the
  // local engine. Boot validation throws if the local engine isn't enabled,
  // so we never silently route to a broken backend — but we still warn so
  // the diff in posture is visible. Remove this branch in the next minor.
  if (!config.defaultEngineExplicit) {
    log.warn("solrac.default_engine_implicit", {
      value: config.defaultEngine,
      hint: "set SOLRAC_DEFAULT_ENGINE explicitly to silence",
    });
  }

  // PNX-167 (system-prompt externalization) + PNX-168 (Bun packaging).
  // Bootstrap SOUL.md + SOLRAC.md into `solracHome` (resolved at config time
  // — defaults to cwd in dev, ~/.solrac/ in the packaged binary) from the
  // embedded canonical defaults baked into the binary via text imports. Then
  // load SOUL into memory and remember the SOLRAC.md path for per-turn
  // re-reads. SOUL.md.new emits when an upgraded binary's embedded SOUL
  // diverges from the operator's edited copy.
  const bootstrap = bootstrapInstanceFiles(config.solracHome);
  logBootstrapResult(config.solracHome, bootstrap);
  let soul: string;
  try {
    soul = loadSoul(config.solracHome);
  } catch (err) {
    log.error("instance.soul_load_failed", { error: (err as Error).message });
    process.exit(1);
  }
  const solracMdPath = instanceMdPath(config.solracHome);

  const db = await openDb(config.dataDir);
  const allowlist = createAllowlist(db);
  allowlist.bootstrap(config.allowlistBootstrap);
  const sessions = createSessionStore(db);

  const pidPath = await acquirePidFile(config.dataDir);

  if (config.transport === "poll") {
    const tg = createTelegramClient(config.telegramBotToken);
    const tracker = new TurnTracker();
    const tgWebClient = config.webEnabled ? createWebClient() : null;
    const costGuard = createCostCapGuard(db, config.hourlyCostCapUsd);
    const globalCostGuard = createGlobalCostCapGuard(db, config.globalHourlyCostCapUsd);
    const denialThrottle = createDenialThrottle();
    // Load integrations BEFORE the brokers so the per-tool confirm-prompt
    // formatter map can be captured into both. Off by default; when enabled,
    // both `src/integrations-builtin/` (always tried, shipped with solrac)
    // and `$SOLRAC_INTEGRATIONS_DIR` (operator-owned) are scanned. First-dir-
    // wins on tool-name collisions so a stale operator copy can't shadow a
    // blessed integration. Tools registered here surface to Claude tiers as
    // `mcp__solrac__<name>`. Local path does NOT see integrations on the
    // tools-off branch — see engine.ts.
    let integrationsMcpServer: McpSdkServerConfigWithInstance | null = null;
    let integrationToolTiers: ReadonlyMap<string, "auto" | "confirm"> = new Map();
    let integrationConfirmFormatters: ReadonlyMap<string, ConfirmFormatter> = new Map();
    // Capture the tools array so the local tools-on path can reuse
    // the same in-process integration handlers. Stays empty (and the array
    // reference is shared as `EMPTY_INTEGRATIONS_TOOLS`) when integrations
    // are off so downstream `Array.isArray + length>0` checks work uniformly.
    let integrationTools: ReadonlyArray<SdkMcpToolDefinition<any>> = [];
    // Names of integrations that successfully registered ≥1 tool. Consumed by
    // `loadSkillsSync` to gate `requires:`-declared skills at boot rather than
    // letting them fail opaquely on first invocation. A probe-failed integration
    // (sources entry with `toolCount === 0`) does NOT satisfy the gate — a
    // skill that calls notion_search needs the tool to actually exist.
    let loadedIntegrationNames: ReadonlySet<string> = new Set();
    if (config.integrationsEnabled) {
      // PNX-168 — builtins now load from a static-import registry so the
      // compiled binary includes them. Operator dirs still load via dynamic
      // `import()` (works in --compile because Bun's runtime handles it).
      // Builtins win on tool-name collisions; the merge logs each cross-source
      // collision with both source identifiers.
      const ctx = createIntegrationContext(config.solracHome);
      const builtinResult = await loadBuiltinIntegrations(ctx);
      const operatorResult = await loadIntegrations([config.integrationsDir], ctx);
      const result = mergeIntegrationResults(builtinResult, operatorResult);
      logIntegrationLoadResult(
        [`<builtin>:[${BUILTIN_INTEGRATION_NAMES.join(",")}]`, config.integrationsDir],
        result,
      );
      integrationToolTiers = result.toolTiers;
      integrationConfirmFormatters = result.confirmFormatters;
      integrationTools = result.tools;
      loadedIntegrationNames = new Set(
        result.sources.filter((s) => s.toolCount > 0).map((s) => s.name),
      );
      if (result.tools.length > 0) {
        integrationsMcpServer = createSdkMcpServer({
          name: "solrac",
          version: "1.0.0",
          tools: [...result.tools],
        });
      }
    }

    // Engine-slot driver — backend selected per `LOCAL_BACKEND` (local mode)
    // OR `REMOTE_BACKEND` (remote mode). The two modes are mutually exclusive
    // at boot (config.ts validates), so at most one constructor fires. The
    // resulting driver fills the same `local` engine slot — runner picks the
    // mode-aware behavior via the `mode` field on EngineRunDeps.
    let localDriver: EngineDriver | null = null;
    let localSlotMode: "local" | "remote" = "local";
    let localSlotModel: string | null = null;
    let localSlotTimeoutMs = 60_000;
    let localSlotHistoryLimit = 6;
    let localSlotMaxToolIterations = 8;
    if (config.localEnabled && config.localBackend && config.localModel) {
      localDriver = createLocalDriver(config.localBackend, { url: config.localUrl });
      localSlotMode = "local";
      localSlotModel = config.localModel;
      localSlotTimeoutMs = config.localTimeoutMs;
      localSlotHistoryLimit = config.localHistoryLimit;
      localSlotMaxToolIterations = config.localMaxToolIterations;
    } else if (config.remoteEnabled && config.remoteBackend && config.remoteModel && config.remoteApiKey) {
      localDriver = createRemoteDriver(config.remoteBackend, {
        url: config.remoteBaseUrl,
        apiKey: config.remoteApiKey,
        referer: config.remoteHttpReferer,
        title: config.remoteXTitle,
      });
      localSlotMode = "remote";
      localSlotModel = config.remoteModel;
      localSlotTimeoutMs = config.remoteTimeoutMs;
      localSlotHistoryLimit = config.remoteHistoryLimit;
      localSlotMaxToolIterations = config.remoteMaxToolIterations;
    }

    // Skill-side local deps (one-shot, no tool loop, no streaming). Built
    // from config directly (not derived from `localDeps` below) so it's
    // available for `buildSkillTools` before the main `localDeps` is
    // assembled. Both consumers see the same driver instance.
    const localSkillDeps: EngineSkillDeps | null =
      localDriver && localSlotModel
        ? {
            driver: localDriver,
            model: localSlotModel,
            timeoutMs: localSlotTimeoutMs,
            soul,
          }
        : null;

    // Skill registry — load before assembling the local tool surface so
    // tool-eligible skills (`tool: true && tier: local`) can be merged into
    // `integrationTools` and surface to the local model alongside built-in
    // integrations. Disabled by default (`SOLRAC_SKILLS_ENABLED=false`);
    // fail-soft: a malformed SKILL.md degrades that single skill, not boot.
    const skillRegistry: SkillRegistry = config.skillsEnabled
      ? (() => {
          const reserved = new Set(BOT_COMMAND_REGISTRY.map((c) => c.command));
          const result = loadSkillsSync(
            config.skillsDir,
            reserved,
            config.defaultEngine,
            loadedIntegrationNames,
          );
          logSkillLoadResult(config.skillsDir, result);
          return result.registry;
        })()
      : EMPTY_SKILL_REGISTRY;

    // Tool-eligible skills become MCP tools the local agent can call by name.
    // All skill tools auto-allow (locked decision; cost cap is the backstop —
    // and local-tier skills are free anyway). Names are added to
    // `integrationToolTiers` so the policy classifier sees the same map.
    const skillTools = buildSkillTools(skillRegistry, {
      db,
      localSkillDeps,
    });
    if (skillTools.length > 0) {
      const merged = new Map(integrationToolTiers);
      for (const t of skillTools) merged.set(t.name, "auto");
      integrationToolTiers = merged;
      integrationTools = [...integrationTools, ...skillTools];
      log.info("skills.tools_loaded", { count: skillTools.length });
    }

    // Boot warning: tools enabled but no integrations actually loaded.
    // Operator probably forgot to drop something into `integrationsDir`, or
    // a typo broke every module. Fail-soft (start anyway) but make the
    // misconfiguration loud in the boot log.
    if (config.localToolsEnabled && integrationTools.length === 0) {
      log.warn("engine.tools_enabled_but_zero_loaded", {
        integrationsDir: config.integrationsDir,
        hint: "set SOLRAC_INTEGRATIONS_DIR or add modules under integrations-builtin/",
      });
    }
    const broker = createConfirmationBroker({
      tg,
      confirmFormatters: integrationConfirmFormatters,
    });
    // Separate broker for the web transport so confirmation prompts go to
    // the WebClient bus (and on into the SSE stream) instead of Telegram.
    // The web's `/api/confirm` endpoint calls `webBroker.resolve(...)`.
    const webBroker = tgWebClient
      ? createConfirmationBroker({
          tg: tgWebClient,
          confirmFormatters: integrationConfirmFormatters,
        })
      : null;
    const createCanUseTool = ({
      chatId,
      auditId,
      pendingHandles,
    }: {
      chatId: number;
      auditId: number;
      pendingHandles: Map<string, ConfirmHandle>;
    }) => {
      const b = webBroker && chatId === config.webChatId ? webBroker : broker;
      return createPolicyHook({
        chatId,
        auditId,
        costGuard,
        broker: b,
        integrationToolTiers,
        pendingHandles,
      });
    };
    // Engine-slot deps are constructed once iff the feature is on. When off,
    // dispatch in makeRunTurn falls through to a "disabled" reply.
    //
    // Tool-loop wiring: when BOTH `localToolsEnabled=true` AND we actually
    // loaded integration tools, surface the tools + tier map + broker into
    // the deps so `runEngineTurn` dispatches through the tool-loop driver.
    // When tools are off (or zero loaded), the same deps shape carries
    // `toolEnabled: false` and the single-shot path runs.
    //
    // `LOCAL_TOOLS_ENABLED` gates the tool-loop for BOTH local and remote
    // mode — the env-var name predates the remote mode but the code path is
    // identical. (Renaming to `BYO_TOOLS_ENABLED` is a v0.7.0-class hard
    // cutover and out of scope for this PR.)
    const localToolsActive =
      config.localToolsEnabled && integrationTools.length > 0;
    const localIsDefault = config.defaultEngine === "local";
    const localDeps: EngineRunDeps | null =
      localDriver && localSlotModel
        ? {
            tg,
            db,
            sessions,
            driver: localDriver,
            model: localSlotModel,
            timeoutMs: localSlotTimeoutMs,
            historyLimit: localSlotHistoryLimit,
            soul,
            instanceMdPath: solracMdPath,
            isDefaultEngine: localIsDefault,
            toolEnabled: localToolsActive,
            tools: localToolsActive ? integrationTools : undefined,
            toolTiers: localToolsActive ? integrationToolTiers : undefined,
            broker: localToolsActive ? broker : undefined,
            maxToolIterations: localSlotMaxToolIterations,
            voiceReplyWords: config.voiceEnabled ? config.voiceReplyWordsHint : undefined,
            attachVoiceReply: undefined,
          }
        : null;
    if (localDeps && localDriver) {
      log.info("engine.boot", {
        backend: localDriver.backend,
        mode: localSlotMode,
        url: localSlotMode === "local" ? config.localUrl : config.remoteBaseUrl,
        model: localSlotModel,
        isDefaultEngine: localIsDefault,
        toolsEnabled: localToolsActive,
        toolCount: localToolsActive ? integrationTools.length : 0,
        maxToolIterations: localToolsActive ? localSlotMaxToolIterations : null,
        timeoutMs: localSlotTimeoutMs,
      });
    }
    // Attach the tool surface to localSkillDeps AFTER integrationTools/
    // skillTools are merged and the broker is built. `buildSkillTools` above
    // captures localSkillDeps by reference, so mutating the same object
    // reaches every captured site.
    if (localSkillDeps && localToolsActive) {
      localSkillDeps.tools = integrationTools;
      localSkillDeps.toolTiers = integrationToolTiers;
      localSkillDeps.broker = broker;
    }
    // Engine-slot health probe — runs for whichever backend (local or remote)
    // is wired and selected as the default. Non-fatal: a slow-starting daemon
    // may not be ready yet under systemd, and a transient OpenRouter network
    // blip shouldn't crash Solrac.
    if (localIsDefault && localDeps && localDriver && localSlotModel) {
      void probeEngineHealth(localDriver, localSlotModel);
    }
    // PNX-167 — boot-time bot identity for `/cmd@<bot>` group-chat targeting.
    // Failure is non-fatal: we proceed with `botUsername=null`, which causes
    // `parseCommand` to accept plain commands and reject any `@bot` suffix
    // (fail-closed).
    const me = await tg.getMe().catch((err) => {
      log.warn("telegram.get_me_failed", { error: (err as Error).message });
      return null;
    });
    const botUsername = me?.username ? me.username.toLowerCase() : null;
    log.info("solrac.bot_identity", {
      botUsername,
      botId: me?.id ?? null,
    });
    // Scheduler — load TASK.md files at boot. Same fail-soft posture as
    // skills: a malformed TASK.md degrades that single task, not the whole
    // boot. The scheduler tick loop is started later, after the turn queue
    // is built (it depends on `queue.enqueue`).
    const taskRegistry: TaskRegistry = config.tasksEnabled
      ? (() => {
          const result = loadTasksSync(config.tasksDir, config.defaultEngine);
          logTaskLoadResult(config.tasksDir, result);
          return result.registry;
        })()
      : EMPTY_TASK_REGISTRY;

    // PNX-167 — register slash commands so Telegram clients show them in the
    // bot's autocomplete menu. Non-fatal — autocomplete is a UX nicety.
    // Skills are appended after the built-in registry so the canonical
    // commands sort first.
    const allBotCommands = [
      ...BOT_COMMAND_REGISTRY,
      ...skillsToBotCommands(skillRegistry.all),
    ];
    await tg
      .setMyCommands(allBotCommands)
      .catch((err) => log.warn("telegram.set_commands_failed", { error: (err as Error).message }));
    // Forward declaration: `commandDeps` needs `getQueueSnapshot` which reads
    // from `queue` — but `queue` itself is built with `makeRunTurn(...)` which
    // depends on `commandDeps`. Break the cycle by constructing `commandDeps`
    // with a closure that captures `queue` after it's built.
    let queueRef: ReturnType<typeof createTurnQueue> | null = null;
    // Mutable forward reference so `runCommand` can invoke the scheduler's
    // `triggerNow` from a `/tasks run <name>` reply. The scheduler is
    // constructed AFTER `commandDeps` (it depends on `queue`); the closure
    // resolves the latest reference at call time.
    let schedulerRef: SchedulerHandle | null = null;
    const commandDeps: RunCommandDeps = {
      tg,
      db,
      sessions,
      allowlist,
      dataDir: config.dataDir,
      primaryModel: config.primaryModel,
      secondaryModel: config.secondaryModel,
      costGuard,
      globalCostGuard,
      getQueueSnapshot: () => ({
        inFlight: queueRef?.inFlight() ?? 0,
        waiting: queueRef?.waiting() ?? 0,
      }),
      startedAt,
      hourlyCostCapUsd: config.hourlyCostCapUsd,
      globalHourlyCostCapUsd: config.globalHourlyCostCapUsd,
      skillRegistry,
      localSkillDeps,
      defaultEngine: config.defaultEngine,
      localToolsEnabled: config.localToolsEnabled,
      // null when neither LOCAL_ENABLED nor REMOTE_ENABLED — `/help` then
      // renders the Claude-only engine section without a cost-framing chip.
      engineSlotMode: localDeps ? localSlotMode : null,
      taskRegistry,
      triggerScheduledTask: (name) =>
        schedulerRef
          ? schedulerRef.triggerNow(name)
          : { kind: "unknown_task", name },
      // Skills now run with full tool surface (see commands.ts::runSkill);
      // share the same canUseTool factory + MCP server with runAgent so the
      // interactive confirm UX and integration tool catalog are identical.
      createCanUseTool,
      mcpServer: integrationsMcpServer,
    };
    // Web UI transport (optional). The `webClient` was built earlier so the
    // `webBroker` could capture it; reuse the same instance here so all bus
    // events flow through one subscriber set.
    const webClient: WebClient | null = tgWebClient;
    let webCommandDeps: RunCommandDeps | null = null;
    let webLocalDeps: EngineRunDeps | null = null;
    if (webClient) {
      // Web-routed /<skill> invocations: rewrite the broker so confirm
      // prompts ride the SSE bus rather than Telegram (mirrors the
      // webLocalDeps swap below). `tools` and `toolTiers` are unchanged —
      // only the broker differs per transport.
      const webEngineSkillDeps: EngineSkillDeps | null = commandDeps.localSkillDeps
        ? {
            ...commandDeps.localSkillDeps,
            broker:
              commandDeps.localSkillDeps.broker !== undefined
                ? webBroker!
                : undefined,
          }
        : null;
      webCommandDeps = {
        ...commandDeps,
        tg: webClient,
        localSkillDeps: webEngineSkillDeps,
      };
      // Local-engine-on-web path needs the web broker (not the Telegram
      // broker) so confirm prompts ride the SSE bus to the operator's
      // browser session, not their Telegram chat. `tg` swap alone wasn't
      // enough once the tools-on path started consulting `broker` for
      // confirm UX.
      webLocalDeps = localDeps
        ? {
            ...localDeps,
            tg: webClient,
            broker: localDeps.broker !== undefined ? webBroker! : undefined,
          }
        : null;
    }

    // Voice (Phase 4 STT + Phase 5 TTS attach). Built once at boot when
    // VOICE_ENABLED=true; null otherwise. Telegram dispatcher gets the
    // populated value; web transport passes `null` because it has its own
    // /api/stt and /api/tts routes (Phase 2).
    //
    // The `telegramSender` lets the post-turn hook attach a voice note to
    // assistant replies on the Telegram transport. Phase 5's
    // `maybeReplyWithVoice` no-ops when this is missing.
    const telegramSender: VoiceTelegramSender | null = config.voiceEnabled
      ? {
          sendVoice: async (chatId, audio, opts) => {
            await tg.sendVoice(chatId, audio, {
              reply_to_message_id: opts?.replyToMessageId,
              mime_type: opts?.mimeType,
            });
          },
          sendAudio: async (chatId, audio, opts) => {
            await tg.sendAudio(chatId, audio, {
              reply_to_message_id: opts?.replyToMessageId,
              mime_type: opts?.mimeType,
            });
          },
        }
      : null;
    const voiceDeps: VoiceDeps | null = config.voiceEnabled
      ? {
          db,
          tg,
          config,
          isAllowed: allowlist.isAllowed,
          telegramSender: telegramSender ?? undefined,
        }
      : null;
    // Bound once so AgentRunDeps + EngineRunDeps share the same callback
    // (and the same VoiceDeps, including cost-cap state).
    const attachVoiceReply: AttachVoiceReply | undefined = voiceDeps
      ? (opts) => maybeReplyWithVoice(voiceDeps, opts)
      : undefined;
    // Splice the post-turn hook onto the Telegram-bound `localDeps` so the
    // engine runner sees it when the operator types into a Telegram chat.
    // `webLocalDeps` (built above as a spread of `localDeps`) is overridden
    // explicitly below — web has its own per-message speak button.
    if (localDeps) {
      localDeps.attachVoiceReply = attachVoiceReply;
    }
    if (webLocalDeps) {
      webLocalDeps.attachVoiceReply = undefined;
    }
    // Forward reference for the voice dispatcher's re-enqueue. Mirrors the
    // `queueRef` pattern — queue is built after makeRunTurn, but the closure
    // resolves the latest reference at call time.
    const voiceEnqueue = (update: Update): EnqueueResult => {
      if (!queueRef) {
        // Defensive: voice dispatch fires inside a queue worker, so queue
        // must exist. If it doesn't, drop loud rather than NPE.
        log.warn("voice.enqueue_pre_queue", { update_id: update.update_id });
        return { kind: "dropped_queue_full", depth: 0, key: 0 };
      }
      return queueRef.enqueue(update);
    };

    const tgRunTurn = makeRunTurn({
      tg,
      db,
      sessions,
      config,
      soul,
      instanceMdPath: solracMdPath,
      primaryModel: config.primaryModel,
      secondaryModel: config.secondaryModel,
      costGuard,
      globalCostGuard,
      createCanUseTool,
      localDeps,
      commandDeps,
      botUsername,
      skillRegistry,
      mcpServer: integrationsMcpServer,
      voiceDeps,
      enqueue: voiceEnqueue,
      voiceReplyWords: config.voiceEnabled ? config.voiceReplyWordsHint : undefined,
      attachVoiceReply,
    });
    const webRunTurn = webClient
      ? makeRunTurn({
          tg: webClient,
          db,
          sessions,
          config,
          soul,
          instanceMdPath: solracMdPath,
          primaryModel: config.primaryModel,
          secondaryModel: config.secondaryModel,
          costGuard,
          globalCostGuard,
          createCanUseTool,
          localDeps: webLocalDeps,
          commandDeps: webCommandDeps!,
          botUsername: null,
          voiceDeps: null,
          enqueue: voiceEnqueue,
          voiceReplyWords: config.voiceEnabled ? config.voiceReplyWordsHint : undefined,
          attachVoiceReply: undefined,
          skillRegistry,
          mcpServer: integrationsMcpServer,
        })
      : null;

    const queue = createTurnQueue({
      runTurn: (update) => {
        const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id ?? 0;
        if (webRunTurn && chatId === config.webChatId) return webRunTurn(update);
        return tgRunTurn(update);
      },
      maxConcurrentTurns: config.maxConcurrentTurns,
      tracker,
    });
    queueRef = queue;
    const server = startServer({
      port: config.port,
      startedAt,
      stats: {
        bearerToken: config.statsBearerToken,
        snapshot: () => ({
          rss: process.memoryUsage().rss,
          uptime: (Date.now() - startedAt) / 1000,
          pendingTurns: tracker.count,
          inFlight: queue.inFlight(),
          waiting: queue.waiting(),
          spend24hUsd: db.sumCostSince(Date.now() - 24 * 60 * 60 * 1000),
        }),
      },
    });
    const pollAbort = new AbortController();
    let webServer: ReturnType<typeof startWebServer> | null = null;
    if (config.webEnabled && webClient && config.webToken && webBroker) {
      let nextWebUpdateId = 1;
      webServer = startWebServer({
        host: config.webHost,
        port: config.webPort,
        token: config.webToken,
        webChatId: config.webChatId,
        webClient,
        defaultEngineLabel: defaultEngineLabel(
          config.defaultEngine,
          config.localBackend,
          config.remoteBackend,
        ),
        onMessage: (text) => {
          const id = nextWebUpdateId++;
          const update: Update = {
            update_id: id,
            message: {
              message_id: id,
              date: Math.floor(Date.now() / 1000),
              chat: { id: config.webChatId, type: "private", first_name: "web" },
              from: {
                id: config.webChatId,
                is_bot: false,
                first_name: "operator",
              },
              text,
            },
          };
          const result = queue.enqueue(update);
          if (result.kind === "dropped_queue_full") {
            auditQueueFull(update, db, webClient, result.depth);
            return "queue_full";
          }
          return "queued";
        },
        onConfirm: (callbackId, decision) => webBroker.resolve(callbackId, decision),
        // Slash-command audit rows store marker strings (`help_shown`,
        // `status_shown`, `cleared:primary,secondary`, …) — useful in the DB
        // for ops queries, but not human-readable in a browser conversation
        // view. Filter them out of history hydration; the user can re-run a
        // slash command live to see the real output.
        loadHistory: () =>
          db
            .recentChatTurns(config.webChatId, 50)
            .filter((r) => !r.model.startsWith("system")),
        // Voice (Phase 2). Same VoiceDeps as the Telegram path so the
        // sliding 60-min cap is shared across transports — operator can't
        // double up by talking on web + Telegram simultaneously.
        voiceDeps,
        voiceRepliesEnabled: () => db.getVoiceRepliesFlag(config.webChatId),
      });
    }
    // Scheduler tick loop — started AFTER queue construction (it depends on
    // queue.enqueue) and BEFORE installShutdown (so the shutdown handler
    // gets a stop reference to call before pollAbort.abort).
    if (
      config.tasksEnabled &&
      taskRegistry.size() > 0 &&
      config.allowlistBootstrap.length > 0
    ) {
      const operatorFromId = config.allowlistBootstrap[0]!;
      schedulerRef = startScheduler({
        db,
        registry: taskRegistry,
        enqueue: (update) => queue.enqueue(update),
        operatorFromId,
        defaultEngine: config.defaultEngine,
        // For DMs (operator chats) `from.id === chat.id`; using operatorFromId
        // as the default chat falls back to a DM-to-self when a TASK.md
        // omits chat_id, matching the daily-report convention.
        defaultChatId: operatorFromId,
      });
      log.info("scheduler.started", { taskCount: taskRegistry.size() });
    } else if (config.tasksEnabled && taskRegistry.size() === 0) {
      log.warn("scheduler.enabled_but_zero_tasks", {
        tasksDir: config.tasksDir,
        hint: "create <tasksDir>/<name>/TASK.md or set SOLRAC_TASKS_ENABLED=false",
      });
    }
    installShutdown({
      tracker,
      db,
      pidPath,
      pollAbort,
      server,
      webServer,
      scheduler: schedulerRef,
    });
    if (config.allowlistBootstrap.length > 0) {
      startDailyReportCron({ db, tg, targetChatId: config.allowlistBootstrap[0]! });
    }
    await startPolling({
      tg,
      db,
      signal: pollAbort.signal,
      handler: async (update) => {
        if (gateAndAuditDenied(update, allowlist, db, denialThrottle)) return;
        // Inline-keyboard responses are routed to the policy broker, not the
        // turn queue: they unblock an in-flight `canUseTool`, they don't start
        // a new agent turn.
        if (update.callback_query) {
          await handleCallbackQuery(update, broker, tg);
          return;
        }
        const result = queue.enqueue(update);
        if (result.kind === "dropped_queue_full") {
          auditQueueFull(update, db, tg, result.depth);
        }
      },
    });
  } else {
    log.warn("transport.not_implemented", { transport: config.transport });
    startServer({ port: config.port, startedAt });
  }
}

// CLI subcommand dispatch. Subcommands run without loadConfig() so they work
// on a fresh install before TELEGRAM_BOT_TOKEN / ANTHROPIC_API_KEY are set.
// Each subcommand resolves its own paths (via resolveSolracHome) and returns
// a process exit code.
async function dispatchSubcommand(subcommand: string): Promise<number> {
  if (subcommand === "gmail-auth") {
    const { runGmailAuth } = await import(
      "./integrations-builtin/gmail/auth-cli.ts"
    );
    return await runGmailAuth(process.argv.slice(3));
  }
  console.error(`Unknown subcommand: ${subcommand}`);
  console.error("Known subcommands: gmail-auth");
  return 1;
}

// Only run as an entry script. `import.meta.main` is `true` when this file is
// the program entry, `false` when imported by a test. Without this guard the
// boot sequence runs on every test file that pulls in an exported helper.
if (import.meta.main) {
  const subcommand = process.argv[2];
  if (subcommand !== undefined && !subcommand.startsWith("-")) {
    dispatchSubcommand(subcommand)
      .then((code) => process.exit(code))
      .catch((err: unknown) => {
        console.error(`${subcommand} failed:`, (err as Error).message);
        process.exit(1);
      });
  } else {
    main().catch((err) => {
      log.error("solrac.fatal", { error: (err as Error).message });
      process.exit(1);
    });
  }
}
