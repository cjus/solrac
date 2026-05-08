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

import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import type { Update } from "@grammyjs/types";
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

    const parsed = parseEnginePrefix(msg.text);

    if (parsed.engine === "ollama") {
      if (!deps.ollamaDeps) {
        // Feature off in this deployment. The handler is fire-and-forget; we
        // don't enqueue a turn and don't write an audit row. Cheap reply so
        // silence isn't ambiguous.
        await deps.tg
          .sendMessage(msg.chat.id, "ollama disabled in this deployment")
          .catch((err) => log.warn("ollama.disabled_ack_failed", { error: (err as Error).message }));
        log.info("turn.done", { update_id: update.update_id, chat_id: msg.chat.id, route: "ollama_disabled" });
        return;
      }
      if (parsed.prompt === "") {
        // Empty payload after `>`. Render a usage hint; no audit row, no enqueue.
        await deps.tg
          .sendMessage(
            msg.chat.id,
            `usage: <code>&gt; &lt;prompt&gt;</code> — sends to local Ollama (model: ${deps.ollamaDeps.model})`,
            { parse_mode: "HTML" },
          )
          .catch((err) => log.warn("ollama.usage_ack_failed", { error: (err as Error).message }));
        log.info("turn.done", { update_id: update.update_id, chat_id: msg.chat.id, route: "ollama_usage" });
        return;
      }
      await runOllamaTurn(deps.ollamaDeps, {
        chatId: msg.chat.id,
        fromId: msg.from.id,
        updateId: update.update_id,
        prompt: parsed.prompt,
      });
      log.info("turn.done", { update_id: update.update_id, chat_id: msg.chat.id, route: "ollama" });
      return;
    }

    // Claude tier path. PLAN Step 12: explicit `!` → primary, `@` → secondary,
    // no prefix → primary (default cheap tier). Empty payload after an
    // explicit prefix renders a usage hint; the no-prefix-empty case can't
    // happen on Telegram (the platform rejects empty messages) but we still
    // pass `msg.text` through to the runner unchanged in that case.
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
        primaryModel: deps.primaryModel,
        secondaryModel: deps.secondaryModel,
        costGuard: deps.costGuard,
        globalCostGuard: deps.globalCostGuard,
        createCanUseTool: deps.createCanUseTool,
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
    const createCanUseTool = ({ chatId, auditId }: { chatId: number; auditId: number }) => {
      const b = webBroker && chatId === config.webChatId ? webBroker : broker;
      return createPolicyHook({ chatId, auditId, costGuard, broker: b });
    };
    // PLAN Step 11: Ollama deps are constructed once iff the feature is on.
    // When off, dispatch in makeRunTurn falls through to a "disabled" reply.
    const ollamaDeps: OllamaRunDeps | null =
      config.ollamaEnabled && config.ollamaModel
        ? {
            tg,
            db,
            url: config.ollamaUrl,
            model: config.ollamaModel,
            timeoutMs: config.ollamaTimeoutMs,
            historyLimit: config.ollamaHistoryLimit,
            soul,
            instanceMdPath: solracMdPath,
          }
        : null;
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
      webOllamaDeps = ollamaDeps ? { ...ollamaDeps, tg: webClient } : null;
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
