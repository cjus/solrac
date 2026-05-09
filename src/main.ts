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
import { join } from "node:path";
import { runAgent } from "./agent.ts";
import { createAllowlist, type Allowlist } from "./allowlist.ts";
import {
  BOT_COMMAND_REGISTRY,
  parseCommand,
  runCommand,
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
  packageDir,
} from "./instance.ts";
import { installShutdown } from "./lifecycle.ts";
import { log } from "./log.ts";
import { runOllamaTurn, type OllamaRunDeps } from "./ollama.ts";
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
  type CostCapGuard,
  type DenialThrottle,
  type GlobalCostCapGuard,
} from "./policy.ts";
import { createTurnQueue } from "./queue.ts";
import { startServer } from "./server.ts";
import { createSessionStore, type SessionStore } from "./session.ts";
import {
  createIntegrationContext,
  loadIntegrations,
  logIntegrationLoadResult,
} from "./integrations.ts";
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
  createCanUseTool: (args: { chatId: number; auditId: number }) => CanUseTool;
  // PLAN Step 11: present iff `OLLAMA_ENABLED=true`. When set, `>`-prefixed
  // messages route to runOllamaTurn instead of runAgent. Both paths share the
  // queue, mutex, semaphore, and tracker drain — dispatch happens inside the
  // queued worker.
  ollamaDeps: OllamaRunDeps | null;
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
  // `options.mcpServers`. Claude tiers only — Ollama path ignores this.
  mcpServer: McpSdkServerConfigWithInstance | null;
}

function makeRunTurn(deps: RunTurnDeps): (update: Update) => Promise<void> {
  return async (update) => {
    const msg = update.message;
    if (!msg || !msg.text || !msg.from) {
      log.debug("turn.ignored", { update_id: update.update_id, kind: "non-text-or-no-from" });
      return;
    }
    log.info("turn.start", {
      update_id: update.update_id,
      chat_id: msg.chat.id,
      from_id: msg.from.id,
      text: msg.text.slice(0, 80),
    });

    // PNX-167 — slash commands intercept before engine-prefix routing. Three
    // outcomes from the parser:
    //   - run        → we own this command; dispatch and return (no engine)
    //   - ignore     → starts with `/` but `@bot` targets another bot in a
    //                  group chat; drop the update silently
    //   - passthrough → not a command; existing engine routing handles it
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

    const parsed = parseEnginePrefix(msg.text, deps.config.defaultEngine);

    if (parsed.engine === "ollama") {
      if (!deps.ollamaDeps) {
        // Defensive: shouldn't fire in practice — boot validation requires
        // `OLLAMA_ENABLED=true` whenever `defaultEngine === "ollama"`. Kept as
        // a safety net so a misconfigured deploy ack-replies rather than
        // hangs on the no-deps path.
        await deps.tg
          .sendMessage(msg.chat.id, "ollama disabled in this deployment")
          .catch((err) => log.warn("ollama.disabled_ack_failed", { error: (err as Error).message }));
        log.info("turn.done", { update_id: update.update_id, chat_id: msg.chat.id, route: "ollama_disabled" });
        return;
      }
      // No-prefix Ollama: empty body is unreachable on Telegram (the platform
      // rejects empty messages) and the web UI guards against it. Send the
      // user's text straight to the runner.
      await runOllamaTurn(deps.ollamaDeps, {
        chatId: msg.chat.id,
        fromId: msg.from.id,
        updateId: update.update_id,
        prompt: parsed.prompt,
      });
      log.info("turn.done", { update_id: update.update_id, chat_id: msg.chat.id, route: "ollama" });
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
        isDefaultEngine: deps.config.defaultEngine !== "ollama",
        primaryModel: deps.primaryModel,
        secondaryModel: deps.secondaryModel,
        costGuard: deps.costGuard,
        globalCostGuard: deps.globalCostGuard,
        createCanUseTool: deps.createCanUseTool,
        mcpServer: deps.mcpServer,
      },
      {
        chatId: msg.chat.id,
        fromId: msg.from.id,
        updateId: update.update_id,
        prompt: promptForAgent,
        engine: parsed.engine,
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
      ? "✅ Allowed"
      : "❌ Denied";
  await tg
    .call("answerCallbackQuery", { callback_query_id: result.callbackQueryId, text })
    .catch((err) => log.warn("callback.ack_failed", { error: (err as Error).message }));
  // Strip the inline keyboard so the prompt can't be re-tapped. Append the
  // verdict to the message text so chat history shows what was decided after
  // the toast disappears.
  const cqMsg = update.callback_query?.message;
  if (cqMsg && "message_id" in cqMsg && "chat" in cqMsg) {
    const original = "text" in cqMsg && typeof cqMsg.text === "string" ? cqMsg.text : "";
    await tg
      .call("editMessageText", {
        chat_id: cqMsg.chat.id,
        message_id: cqMsg.message_id,
        text: `${original}\n\n— ${text}`,
        reply_markup: { inline_keyboard: [] },
      })
      .catch((err) => log.warn("callback.strip_keyboard_failed", { error: (err as Error).message }));
  }
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
    // distinguishable from real claude/ollama: rows in audit dumps.
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

// PR-B — operator-readable label for the web UI's default-engine pill. The
// pill itself ships with the empty `data-prefix=""`, but the title attr is
// substituted at serve time (see `web.ts::renderIndexHtml`) so the user
// hovers over a label matching the deploy.
function defaultEngineLabel(engine: "ollama" | "primary" | "secondary"): string {
  if (engine === "ollama") return "ollama";
  if (engine === "primary") return "primary Claude (Sonnet)";
  return "secondary Claude (Opus)";
}

// PR-B — boot-time Ollama health probe. Non-fatal: any failure is logged
// (warn) so the operator sees the misconfiguration but the process keeps
// running. Daemon may come up after Solrac under systemd; the next user
// turn will succeed once the daemon is reachable.
async function probeOllamaHealth(url: string, model: string): Promise<void> {
  try {
    const res = await fetch(`${url}/api/tags`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      log.warn("ollama.boot_health_failed", {
        url,
        status: res.status,
        hint: "ensure the Ollama daemon is running (e.g., `ollama serve`)",
      });
      return;
    }
    const body = (await res.json().catch(() => ({}))) as {
      models?: Array<{ name?: unknown }>;
    };
    const models = Array.isArray(body.models)
      ? body.models.map((m) => (typeof m.name === "string" ? m.name : "")).filter(Boolean)
      : [];
    if (!models.includes(model)) {
      log.warn("ollama.boot_health_model_missing", {
        url,
        model,
        availableModels: models,
        hint: `pull the model: \`ollama pull ${model}\``,
      });
      return;
    }
    log.info("ollama.boot_health_ok", { url, model });
  } catch (err) {
    log.warn("ollama.boot_health_failed", {
      url,
      error: (err as Error).message,
      hint: "ensure the Ollama daemon is running (e.g., `ollama serve`)",
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
    ollamaEnabled: config.ollamaEnabled,
    ollamaModel: config.ollamaModel,
    ollamaUrl: config.ollamaUrl,
  });
  // PR-B — one-release-cycle silent-flip guard. Operators upgrading from a
  // pre-PR-B build without setting `SOLRAC_DEFAULT_ENGINE` would see no-prefix
  // messages start hitting Ollama. Boot validation throws if Ollama isn't
  // enabled, so we never silently route to a broken backend — but we still
  // warn so the diff in posture is visible. Remove this branch in the next
  // minor release.
  if (!config.defaultEngineExplicit) {
    log.warn("solrac.default_engine_implicit", {
      value: config.defaultEngine,
      hint: "set SOLRAC_DEFAULT_ENGINE explicitly to silence; default flipped from primary to ollama in PR-B",
    });
  }

  // PNX-167 (system-prompt externalization). Bootstrap SOUL.md + SOLRAC.md
  // into the launch cwd from the package defaults if absent, then load SOUL
  // into memory and remember the SOLRAC.md path for per-turn re-reads.
  const launchCwd = process.cwd();
  const bootstrap = bootstrapInstanceFiles(launchCwd, packageDir());
  logBootstrapResult(launchCwd, bootstrap);
  let soul: string;
  try {
    soul = loadSoul(launchCwd);
  } catch (err) {
    log.error("instance.soul_load_failed", { error: (err as Error).message });
    process.exit(1);
  }
  const solracMdPath = instanceMdPath(launchCwd);

  const db = await openDb(config.dataDir);
  const allowlist = createAllowlist(db);
  allowlist.bootstrap(config.allowlistBootstrap);
  const sessions = createSessionStore(db);

  const pidPath = await acquirePidFile(config.dataDir);

  if (config.transport === "poll") {
    const tg = createTelegramClient(config.telegramBotToken);
    const tracker = new TurnTracker();
    const broker = createConfirmationBroker({ tg });
    // Separate broker for the web transport so confirmation prompts go to
    // the WebClient bus (and on into the SSE stream) instead of Telegram.
    // The web's `/api/confirm` endpoint calls `webBroker.resolve(...)`.
    const tgWebClient = config.webEnabled ? createWebClient() : null;
    const webBroker = tgWebClient ? createConfirmationBroker({ tg: tgWebClient }) : null;
    const costGuard = createCostCapGuard(db, config.hourlyCostCapUsd);
    const globalCostGuard = createGlobalCostCapGuard(db, config.globalHourlyCostCapUsd);
    const denialThrottle = createDenialThrottle();
    // Phase 2 — load integrations BEFORE `createCanUseTool` so the per-turn
    // policy hook closes over the per-tool tier map captured here. Off by
    // default; when enabled, both `src/integrations-builtin/` (always tried,
    // shipped with solrac) and `$SOLRAC_INTEGRATIONS_DIR` (operator-owned)
    // are scanned. First-dir-wins on tool-name collisions so a stale
    // operator copy can't shadow a blessed integration. Tools registered
    // here surface to Claude tiers as `mcp__solrac__<name>`. Ollama
    // path does NOT see integrations on the tools-off branch — see ollama.ts.
    let integrationsMcpServer: McpSdkServerConfigWithInstance | null = null;
    let integrationToolTiers: ReadonlyMap<string, "auto" | "confirm"> = new Map();
    // PR-A — capture the tools array so the Ollama tools-on path can reuse
    // the same in-process integration handlers. Stays empty (and the array
    // reference is shared as `EMPTY_INTEGRATIONS_TOOLS`) when integrations
    // are off so downstream `Array.isArray + length>0` checks work uniformly.
    let integrationTools: ReadonlyArray<SdkMcpToolDefinition<any>> = [];
    if (config.integrationsEnabled) {
      const builtinDir = join(import.meta.dir, "integrations-builtin");
      const result = await loadIntegrations(
        [builtinDir, config.integrationsDir],
        createIntegrationContext(),
      );
      logIntegrationLoadResult([builtinDir, config.integrationsDir], result);
      integrationToolTiers = result.toolTiers;
      integrationTools = result.tools;
      if (result.tools.length > 0) {
        integrationsMcpServer = createSdkMcpServer({
          name: "solrac",
          version: "1.0.0",
          tools: [...result.tools],
        });
      }
    }
    // PR-A — boot warning: tools enabled but no integrations actually loaded.
    // Operator probably forgot to drop something into `integrationsDir`, or
    // a typo broke every module. Fail-soft (start anyway) but make the
    // misconfiguration loud in the boot log.
    if (config.ollamaToolsEnabled && integrationTools.length === 0) {
      log.warn("ollama.tools_enabled_but_zero_loaded", {
        integrationsDir: config.integrationsDir,
        hint: "set SOLRAC_INTEGRATIONS_DIR or add modules under integrations-builtin/",
      });
    }
    const createCanUseTool = ({ chatId, auditId }: { chatId: number; auditId: number }) => {
      const b = webBroker && chatId === config.webChatId ? webBroker : broker;
      return createPolicyHook({
        chatId,
        auditId,
        costGuard,
        broker: b,
        integrationToolTiers,
      });
    };
    // PLAN Step 11: Ollama deps are constructed once iff the feature is on.
    // When off, dispatch in makeRunTurn falls through to a "disabled" reply.
    //
    // PR-A — tool-loop wiring. When BOTH `ollamaToolsEnabled=true` AND we
    // actually loaded integration tools, surface the tools surface + tier
    // map + broker into the deps so `runOllamaTurn` dispatches through the
    // tool-loop driver. When tools are off (or zero loaded), the same deps
    // shape carries `toolEnabled: false` and the single-shot path runs as
    // before.
    const ollamaToolsActive =
      config.ollamaToolsEnabled && integrationTools.length > 0;
    const ollamaIsDefault = config.defaultEngine === "ollama";
    const ollamaDeps: OllamaRunDeps | null =
      config.ollamaEnabled && config.ollamaModel
        ? {
            tg,
            db,
            sessions,
            url: config.ollamaUrl,
            model: config.ollamaModel,
            timeoutMs: config.ollamaTimeoutMs,
            historyLimit: config.ollamaHistoryLimit,
            soul,
            instanceMdPath: solracMdPath,
            isDefaultEngine: ollamaIsDefault,
            toolEnabled: ollamaToolsActive,
            tools: ollamaToolsActive ? integrationTools : undefined,
            toolTiers: ollamaToolsActive ? integrationToolTiers : undefined,
            broker: ollamaToolsActive ? broker : undefined,
            maxToolIterations: config.ollamaMaxToolIterations,
          }
        : null;
    if (ollamaDeps) {
      log.info("ollama.boot", {
        url: config.ollamaUrl,
        model: config.ollamaModel,
        isDefaultEngine: ollamaIsDefault,
        toolsEnabled: ollamaToolsActive,
        toolCount: ollamaToolsActive ? integrationTools.length : 0,
        maxToolIterations: ollamaToolsActive
          ? config.ollamaMaxToolIterations
          : null,
        timeoutMs: config.ollamaTimeoutMs,
      });
    }
    // PR-B — Ollama is the recommended default; probe the daemon at boot so
    // operators see a misconfiguration immediately (vs. on first user turn).
    // Non-fatal: a slow-starting daemon may not be ready yet under systemd
    // (After=ollama.service ordering helps but doesn't guarantee readiness),
    // and crashing Solrac because of a transient probe failure is worse than
    // logging it.
    if (ollamaIsDefault && ollamaDeps && config.ollamaModel) {
      void probeOllamaHealth(config.ollamaUrl, config.ollamaModel);
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
    // PNX-167.1 — load operator-defined skills before registering Telegram
    // bot commands so autocomplete includes them. Disabled by default
    // (`SOLRAC_SKILLS_ENABLED=false`) — when enabled, fail-soft: a bad
    // SKILL.md degrades that single skill, not the whole boot.
    const skillRegistry: SkillRegistry = config.skillsEnabled
      ? (() => {
          const reserved = new Set(BOT_COMMAND_REGISTRY.map((c) => c.command));
          const result = loadSkillsSync(config.skillsDir, reserved);
          logSkillLoadResult(config.skillsDir, result);
          return result.registry;
        })()
      : EMPTY_SKILL_REGISTRY;

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
      defaultEngine: config.defaultEngine,
      ollamaToolsEnabled: config.ollamaToolsEnabled,
    };
    // Web UI transport (optional). The `webClient` was built earlier so the
    // `webBroker` could capture it; reuse the same instance here so all bus
    // events flow through one subscriber set.
    const webClient: WebClient | null = tgWebClient;
    let webCommandDeps: RunCommandDeps | null = null;
    let webOllamaDeps: OllamaRunDeps | null = null;
    if (webClient) {
      webCommandDeps = {
        ...commandDeps,
        tg: webClient,
      };
      // Ollama-on-web path needs the web broker (not the Telegram broker)
      // so confirm prompts ride the SSE bus to the operator's browser
      // session, not their Telegram chat. `tg` swap alone wasn't enough
      // once the tools-on path started consulting `broker` for confirm UX.
      webOllamaDeps = ollamaDeps
        ? {
            ...ollamaDeps,
            tg: webClient,
            broker: ollamaDeps.broker !== undefined ? webBroker! : undefined,
          }
        : null;
    }

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
      ollamaDeps,
      commandDeps,
      botUsername,
      skillRegistry,
      mcpServer: integrationsMcpServer,
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
          ollamaDeps: webOllamaDeps,
          commandDeps: webCommandDeps!,
          botUsername: null,
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
        rootDir: packageDir(),
        defaultEngineLabel: defaultEngineLabel(config.defaultEngine),
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
      });
    }
    installShutdown({ tracker, db, pidPath, pollAbort, server, webServer });
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

// Only run as an entry script. `import.meta.main` is `true` when this file is
// the program entry, `false` when imported by a test. Without this guard the
// boot sequence runs on every test file that pulls in an exported helper.
if (import.meta.main) {
  main().catch((err) => {
    log.error("solrac.fatal", { error: (err as Error).message });
    process.exit(1);
  });
}
