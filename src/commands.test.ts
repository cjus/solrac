/**
 * @fileoverview Unit tests for `commands.ts`: parser + dispatcher.
 * @proves The slash-command parser is pure and case-insensitive, group-chat
 *         targeting fail-closes when boot-time `getMe` failed, and the four
 *         dispatcher paths (clear/status/help/unknown) write the expected
 *         audit row + reply text.
 *
 * The `/compact` dispatcher's happy path is NOT covered here — it makes a
 * real SDK call. The pre-flight cap rejection and "nothing to compact" paths
 * ARE covered (they short-circuit before the SDK). The live smoke
 * `test/smokes/compact.ts` (deferred to v1.1) covers the round trip.
 *
 * Scenarios covered:
 *
 *   parseCommand:
 *     - plain text returns passthrough.
 *     - leading whitespace tolerated.
 *     - empty `/`, `/ `, `/@bot` → empty (renders /help).
 *     - unknown commands surface as `unknown` (not passthrough).
 *     - case-insensitive on the command name.
 *     - tier flag tokens for /clear: primary/p/@, secondary/s/!, all/*.
 *     - tier flag tokens for /compact: primary/p/@, secondary/s/!.
 *     - /compact all is unknown (compact only takes single tiers).
 *     - extra args on /help and /status are ignored.
 *     - group-chat `@bot` matches (cmd runs) or mismatches (returns ignore).
 *     - botUsername=null fail-closes: plain commands run, `@bot` returns ignore.
 *
 *   runCommand dispatcher:
 *     - /clear on fresh chat → "already clean" reply, audit row "ok".
 *     - /clear all on chat with primary session → clears both tiers it touches.
 *     - /clear primary leaves secondary alone.
 *     - /help replies with the HELP_TEXT, audit row "ok".
 *     - /status renders all "none" on a fresh chat.
 *     - /status surfaces session/spend after a session id is set.
 *     - unknown command replies with the unknown text, audit row "ok"
 *       (status='ok' because the command was processed, just not recognized).
 *     - empty kind renders /help.
 *     - /compact rejects when per-chat cap is exceeded — error audit row,
 *       error reply, no SDK call attempted.
 *     - /compact replies "nothing to compact" on a fresh chat — error audit
 *       row, no SDK call.
 *
 * Not covered (intentional):
 *   - SDK round trip (live smoke / manual).
 *   - Group-chat `@otherbot` against a real Update (parser-only test covers it).
 *   - Concurrency between /clear and an in-flight runAgent — the per-chat
 *     KeyedMutex serialization is exercised in queue.test.ts.
 *
 * Cross-references:
 *   - commands.ts — implementation
 *   - docs/SLASH_COMMANDS_DESIGN.md — spec
 */

import type { Message } from "@grammyjs/types";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseCommand,
  runCommand,
  type ParseCommandDeps,
  type RunCommandDeps,
} from "./commands.ts";
import { openDb, type SolracDb } from "./db.ts";
import {
  createCostCapGuard,
  createGlobalCostCapGuard,
  type CostCapGuard,
  type GlobalCostCapGuard,
} from "./policy.ts";
import { createSessionStore, type SessionStore } from "./session.ts";
import {
  EMPTY_SKILL_REGISTRY,
  parseSkillFile,
  type Skill,
  type SkillRegistry,
} from "./skills.ts";
import type { TelegramClient } from "./telegram.ts";
import { createAllowlist } from "./allowlist.ts";

// ---------------------------------------------------------------------------
// parseCommand — pure. No fixtures needed.
// ---------------------------------------------------------------------------

const DEPS: ParseCommandDeps = { botUsername: "solrac_dev_bot" };
const DEPS_NO_BOT: ParseCommandDeps = { botUsername: null };

describe("parseCommand", () => {
  test("plain text is passthrough", () => {
    expect(parseCommand("hello world", DEPS)).toEqual({ kind: "passthrough" });
    expect(parseCommand("@hello", DEPS)).toEqual({ kind: "passthrough" });
    expect(parseCommand("> hi", DEPS)).toEqual({ kind: "passthrough" });
    expect(parseCommand("", DEPS)).toEqual({ kind: "passthrough" });
  });

  test(": prefix is also accepted as a command alias", () => {
    expect(parseCommand(":help", DEPS)).toEqual({ kind: "run", cmd: { kind: "help" } });
    expect(parseCommand(":status", DEPS)).toEqual({ kind: "run", cmd: { kind: "status" } });
    expect(parseCommand(":clear", DEPS)).toEqual({
      kind: "run",
      cmd: { kind: "clear", tier: "all" },
    });
    expect(parseCommand(":compact !", DEPS)).toEqual({
      kind: "run",
      cmd: { kind: "compact", tier: "secondary" },
    });
    // PR-B: bare `:context` rejects with usage hint (kind: "unknown") instead
    // of silently defaulting to primary. Same contract as the `/` prefix.
    expect(parseCommand(":context @", DEPS)).toEqual({
      kind: "run",
      cmd: { kind: "context", tier: "primary" },
    });
    // Bare `:` renders help (parallel to bare `/`).
    expect(parseCommand(":", DEPS)).toEqual({ kind: "run", cmd: { kind: "empty" } });
  });

  test(": prefix unknowns fall through to passthrough (unlike /unknowns)", () => {
    // `:foo` is more likely natural text than a typo'd command, so we don't
    // surface "Unknown command" — we let engine routing pick it up.
    expect(parseCommand(":foo", DEPS)).toEqual({ kind: "passthrough" });
    expect(parseCommand(":notARealCommand args here", DEPS)).toEqual({ kind: "passthrough" });
    // Emoticons and natural `:`-using prose pass through cleanly.
    expect(parseCommand(":)", DEPS)).toEqual({ kind: "passthrough" });
    expect(parseCommand(":D oh hi", DEPS)).toEqual({ kind: "passthrough" });
  });

  test("/foo is unknown but :foo is passthrough — asymmetric by design", () => {
    expect(parseCommand("/foo", DEPS)).toEqual({
      kind: "run",
      cmd: { kind: "unknown", raw: "/foo" },
    });
    expect(parseCommand(":foo", DEPS)).toEqual({ kind: "passthrough" });
  });

  test(": prefix unknown reply preserves the `:` in raw", () => {
    // Known command + bad arg → unknown with the actual prefix the user typed.
    expect(parseCommand(":clear bananas", DEPS)).toEqual({
      kind: "run",
      cmd: { kind: "unknown", raw: ":clear bananas" },
    });
    expect(parseCommand("/clear bananas", DEPS)).toEqual({
      kind: "run",
      cmd: { kind: "unknown", raw: "/clear bananas" },
    });
  });

  test("leading whitespace tolerated", () => {
    expect(parseCommand("   /clear", DEPS)).toEqual({
      kind: "run",
      cmd: { kind: "clear", tier: "all" },
    });
  });

  test("bare slash and bot-targeted bare slash render help (empty)", () => {
    expect(parseCommand("/", DEPS)).toEqual({ kind: "run", cmd: { kind: "empty" } });
    expect(parseCommand("/ ", DEPS)).toEqual({ kind: "run", cmd: { kind: "empty" } });
    expect(parseCommand("/@solrac_dev_bot", DEPS)).toEqual({
      kind: "run",
      cmd: { kind: "empty" },
    });
  });

  test("unknown commands surface as unknown, not passthrough", () => {
    expect(parseCommand("/foo", DEPS)).toEqual({
      kind: "run",
      cmd: { kind: "unknown", raw: "/foo" },
    });
    expect(parseCommand("/foo bar baz", DEPS)).toEqual({
      kind: "run",
      cmd: { kind: "unknown", raw: "/foo" },
    });
  });

  test("command name is case-insensitive", () => {
    expect(parseCommand("/CLEAR", DEPS)).toEqual({
      kind: "run",
      cmd: { kind: "clear", tier: "all" },
    });
    expect(parseCommand("/Help", DEPS)).toEqual({ kind: "run", cmd: { kind: "help" } });
  });

  test("/help and /status ignore extra args", () => {
    expect(parseCommand("/help anything else", DEPS)).toEqual({
      kind: "run",
      cmd: { kind: "help" },
    });
    expect(parseCommand("/status verbose", DEPS)).toEqual({
      kind: "run",
      cmd: { kind: "status" },
    });
  });

  test("/clear tier tokens", () => {
    for (const [tok, tier] of [
      ["primary", "primary"],
      ["p", "primary"],
      ["@", "primary"],
      ["secondary", "secondary"],
      ["s", "secondary"],
      ["!", "secondary"],
      ["ollama", "ollama"],
      ["o", "ollama"],
      [">", "ollama"],
      ["all", "all"],
      ["*", "all"],
    ] as const) {
      expect(parseCommand(`/clear ${tok}`, DEPS)).toEqual({
        kind: "run",
        cmd: { kind: "clear", tier },
      });
    }
  });

  test("/compact rejects ollama tier — Ollama has no SDK session to summarize", () => {
    expect(parseCommand("/compact ollama", DEPS)).toEqual({
      kind: "run",
      cmd: { kind: "unknown", raw: "/compact ollama" },
    });
    expect(parseCommand("/compact >", DEPS)).toEqual({
      kind: "run",
      cmd: { kind: "unknown", raw: "/compact >" },
    });
  });

  test("/context rejects ollama tier — Ollama has no SDK session to inspect", () => {
    expect(parseCommand("/context ollama", DEPS)).toEqual({
      kind: "run",
      cmd: { kind: "unknown", raw: "/context ollama" },
    });
    expect(parseCommand("/context >", DEPS)).toEqual({
      kind: "run",
      cmd: { kind: "unknown", raw: "/context >" },
    });
  });

  test("/clear with unknown tier token surfaces as unknown", () => {
    expect(parseCommand("/clear bananas", DEPS)).toEqual({
      kind: "run",
      cmd: { kind: "unknown", raw: "/clear bananas" },
    });
  });

  test("/compact tier tokens (single only)", () => {
    for (const [tok, tier] of [
      ["primary", "primary"],
      ["p", "primary"],
      ["@", "primary"],
      ["secondary", "secondary"],
      ["s", "secondary"],
      ["!", "secondary"],
    ] as const) {
      expect(parseCommand(`/compact ${tok}`, DEPS)).toEqual({
        kind: "run",
        cmd: { kind: "compact", tier },
      });
    }
  });

  test("/compact all is unknown (compact only takes single tiers)", () => {
    expect(parseCommand("/compact all", DEPS)).toEqual({
      kind: "run",
      cmd: { kind: "unknown", raw: "/compact all" },
    });
    expect(parseCommand("/compact *", DEPS)).toEqual({
      kind: "run",
      cmd: { kind: "unknown", raw: "/compact *" },
    });
  });

  test("/compact bare rejects with usage hint (PR-B: explicit tier required)", () => {
    // PR-B: silent default to primary is misleading post-inversion since most
    // chats don't have a Claude session. Force the operator to specify @ or !.
    const result = parseCommand("/compact", DEPS);
    expect(result.kind).toBe("run");
    expect((result as { cmd: { kind: string; raw: string } }).cmd.kind).toBe("unknown");
    expect((result as { cmd: { kind: string; raw: string } }).cmd.raw).toContain(
      "compact",
    );
  });

  test("/context bare rejects with usage hint (PR-B: explicit tier required)", () => {
    const result = parseCommand("/context", DEPS);
    expect(result.kind).toBe("run");
    expect((result as { cmd: { kind: string; raw: string } }).cmd.kind).toBe("unknown");
    expect((result as { cmd: { kind: string; raw: string } }).cmd.raw).toContain(
      "context",
    );
  });

  test("/context tier tokens (single only)", () => {
    expect(parseCommand("/context !", DEPS)).toEqual({
      kind: "run",
      cmd: { kind: "context", tier: "secondary" },
    });
    expect(parseCommand("/context primary", DEPS)).toEqual({
      kind: "run",
      cmd: { kind: "context", tier: "primary" },
    });
    expect(parseCommand("/context @", DEPS)).toEqual({
      kind: "run",
      cmd: { kind: "context", tier: "primary" },
    });
  });

  test("/context all is unknown (single tier only, like /compact)", () => {
    expect(parseCommand("/context all", DEPS)).toEqual({
      kind: "run",
      cmd: { kind: "unknown", raw: "/context all" },
    });
  });

  test("group-chat @bot matched runs the command", () => {
    expect(parseCommand("/clear@solrac_dev_bot", DEPS)).toEqual({
      kind: "run",
      cmd: { kind: "clear", tier: "all" },
    });
    // Case-insensitive match.
    expect(parseCommand("/Clear@Solrac_Dev_Bot", DEPS)).toEqual({
      kind: "run",
      cmd: { kind: "clear", tier: "all" },
    });
  });

  test("group-chat @otherbot returns ignore", () => {
    expect(parseCommand("/clear@otherbot", DEPS)).toEqual({ kind: "ignore" });
    expect(parseCommand("/help@somebody_else", DEPS)).toEqual({ kind: "ignore" });
  });

  test("botUsername=null fails closed: plain commands run, @bot rejected", () => {
    expect(parseCommand("/clear", DEPS_NO_BOT)).toEqual({
      kind: "run",
      cmd: { kind: "clear", tier: "all" },
    });
    expect(parseCommand("/clear@solrac_dev_bot", DEPS_NO_BOT)).toEqual({ kind: "ignore" });
  });

  // ---------------------------------------------------------------------------
  // PNX-167.1 — skill resolution
  // ---------------------------------------------------------------------------

  test("/skill-name resolves against skill registry and captures args", () => {
    const skill = parseSkillFile(
      "---\nname: greet\ndescription: Greet the user\n---\nHello {{args}}.",
      "/p",
      RESERVED_BUILTINS,
    );
    const registry: SkillRegistry = {
      all: [skill],
      get: (n) => (n.toLowerCase() === "greet" ? skill : undefined),
      size: () => 1,
    };
    const result = parseCommand("/greet world", { ...DEPS, skillRegistry: registry });
    expect(result).toEqual({
      kind: "run",
      cmd: { kind: "skill", skill, args: "world" },
    });
  });

  test("/skill-name with multi-line args (newlines preserved, regex spans \\n)", () => {
    // Regression: COMMAND_RE used `.+?` for args, which doesn't match `\n`
    // without the `s` flag — multi-line `/tldr <text>\nmore text` then failed
    // the whole regex and returned kind:unknown, even with the skill loaded.
    // Now uses `[\s\S]+?` so multi-line pastes route correctly.
    const skill = parseSkillFile(
      "---\nname: tldr\ndescription: Summarize\n---\nSummary of: {{args}}",
      "/p",
      RESERVED_BUILTINS,
    );
    const registry: SkillRegistry = {
      all: [skill],
      get: (n) => (n.toLowerCase() === "tldr" ? skill : undefined),
      size: () => 1,
    };
    const result = parseCommand("/tldr line one\nline two\nline three", {
      ...DEPS,
      skillRegistry: registry,
    });
    expect(result).toEqual({
      kind: "run",
      cmd: { kind: "skill", skill, args: "line one\nline two\nline three" },
    });
  });

  test(":skill-name also resolves against registry (dual-prefix consistent)", () => {
    const skill = parseSkillFile(
      "---\nname: greet\ndescription: Greet the user\n---\nHello {{args}}.",
      "/p",
      RESERVED_BUILTINS,
    );
    const registry: SkillRegistry = {
      all: [skill],
      get: (n) => (n.toLowerCase() === "greet" ? skill : undefined),
      size: () => 1,
    };
    const result = parseCommand(":greet earth", { ...DEPS, skillRegistry: registry });
    expect(result).toEqual({
      kind: "run",
      cmd: { kind: "skill", skill, args: "earth" },
    });
  });

  test("unknown /name with empty registry → unknown", () => {
    const result = parseCommand("/notaskill", { ...DEPS, skillRegistry: EMPTY_SKILL_REGISTRY });
    expect(result).toEqual({ kind: "run", cmd: { kind: "unknown", raw: "/notaskill" } });
  });

  test("built-in commands still win over a same-named skill (parser doesn't reach skill lookup)", () => {
    // KNOWN_COMMANDS check happens first; even if a buggy registry returned a
    // skill named "clear", the built-in arm fires. (This is also enforced at
    // load time by reservedNames, but the parser is belt-and-suspenders.)
    const skill = parseSkillFile(
      "---\nname: rogue\ndescription: x\n---\nbody",
      "/p",
      RESERVED_BUILTINS,
    );
    const registry: SkillRegistry = {
      all: [skill],
      // Pretend `clear` is in the registry (shouldn't happen in practice).
      get: (n) => (n === "clear" ? skill : undefined),
      size: () => 1,
    };
    const result = parseCommand("/clear", { ...DEPS, skillRegistry: registry });
    expect(result).toEqual({ kind: "run", cmd: { kind: "clear", tier: "all" } });
  });

  test("args trimmed; multi-token args preserved verbatim", () => {
    const skill = parseSkillFile(
      "---\nname: echo\ndescription: x\n---\n{{args}}",
      "/p",
      RESERVED_BUILTINS,
    );
    const registry: SkillRegistry = {
      all: [skill],
      get: (n) => (n === "echo" ? skill : undefined),
      size: () => 1,
    };
    const result = parseCommand("/echo  hello   world  ", { ...DEPS, skillRegistry: registry });
    expect(result).toEqual({
      kind: "run",
      cmd: { kind: "skill", skill, args: "hello   world" },
    });
  });
});

const RESERVED_BUILTINS = new Set(["clear", "compact", "context", "help", "status"]);

// ---------------------------------------------------------------------------
// Dispatcher fixtures
// ---------------------------------------------------------------------------

interface SentMessage {
  chatId: number;
  text: string;
  parseMode: string | undefined;
}

function makeFakeTg(): TelegramClient & { sent: SentMessage[] } {
  const sent: SentMessage[] = [];
  return {
    sent,
    call: (async () => undefined) as never,
    getUpdates: async () => [],
    sendMessage: (async (chatId: number, text: string, opts?: { parse_mode?: string }) => {
      sent.push({ chatId, text, parseMode: opts?.parse_mode });
      return { message_id: sent.length, date: 0, chat: { id: chatId, type: "private" } };
    }) as never,
    editMessageText: (async () => true) as never,
    setMessageReaction: (async () => true) as never,
    sendChatAction: (async () => true) as never,
    getMe: (async () => ({
      id: 1,
      is_bot: true,
      first_name: "Solrac",
      username: "solrac_dev_bot",
    })) as never,
    setMyCommands: (async () => true) as never,
  } as TelegramClient & { sent: SentMessage[] };
}

interface Harness {
  dir: string;
  db: SolracDb;
  sessions: SessionStore;
  tg: ReturnType<typeof makeFakeTg>;
  costGuard: CostCapGuard;
  globalCostGuard: GlobalCostCapGuard;
  deps: RunCommandDeps;
}

const harnesses: Harness[] = [];

beforeEach(() => {
  harnesses.length = 0;
});

afterEach(() => {
  for (const h of harnesses) {
    try {
      h.db.close();
    } catch {}
    rmSync(h.dir, { recursive: true, force: true });
  }
});

async function makeHarness(
  opts: { capUsd?: number; globalCapUsd?: number; skillRegistry?: SkillRegistry } = {},
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "solrac-cmd-"));
  const db = await openDb(dir);
  const sessions = createSessionStore(db);
  const allowlist = createAllowlist(db);
  const tg = makeFakeTg();
  const costGuard = createCostCapGuard(db, opts.capUsd ?? 1.0);
  const globalCostGuard = createGlobalCostCapGuard(db, opts.globalCapUsd ?? 4.0);
  const deps: RunCommandDeps = {
    tg,
    db,
    sessions,
    allowlist,
    dataDir: dir,
    primaryModel: "claude-sonnet-4-6",
    secondaryModel: "claude-opus-4-7",
    costGuard,
    globalCostGuard,
    getQueueSnapshot: () => ({ inFlight: 0, waiting: 0 }),
    startedAt: Date.now() - 60_000,
    hourlyCostCapUsd: opts.capUsd ?? 1.0,
    globalHourlyCostCapUsd: opts.globalCapUsd ?? 4.0,
    skillRegistry: opts.skillRegistry ?? EMPTY_SKILL_REGISTRY,
    ollamaSkillDeps: null,
    defaultEngine: "ollama",
    ollamaToolsEnabled: false,
  };
  const h: Harness = { dir, db, sessions, tg, costGuard, globalCostGuard, deps };
  harnesses.push(h);
  return h;
}

function fakeMsg(text: string, chatId: number = 100, fromId: number = 200): Message {
  return {
    message_id: 1,
    date: 0,
    chat: { id: chatId, type: "private" },
    from: { id: fromId, is_bot: false, first_name: "Carlos" },
    text,
  } as unknown as Message;
}

function lastAudit(db: SolracDb): {
  chat_id: number;
  prompt: string;
  response: string | null;
  status: string;
  error_message: string | null;
  model: string;
} {
  return db.raw
    .query(
      "SELECT chat_id, prompt, response, status, error_message, model FROM audit ORDER BY id DESC LIMIT 1",
    )
    .get() as never;
}

// ---------------------------------------------------------------------------
// /clear
// ---------------------------------------------------------------------------

describe("runCommand /clear", () => {
  test("fresh chat replies 'already clean' and writes ok audit", async () => {
    const h = await makeHarness();
    await runCommand(h.deps, fakeMsg("/clear"), { kind: "clear", tier: "all" }, 1);
    expect(h.tg.sent).toHaveLength(1);
    expect(h.tg.sent[0]!.text).toContain("Already clean");
    const row = lastAudit(h.db);
    expect(row.status).toBe("ok");
    expect(row.model).toBe("system");
    expect(row.response).toBe("already_clean");
  });

  test("clears existing primary session, leaves secondary alone", async () => {
    const h = await makeHarness();
    h.sessions.setSessionId(100, "primary", "p-uuid");
    h.sessions.setSessionId(100, "secondary", "s-uuid");

    await runCommand(h.deps, fakeMsg("/clear primary"), { kind: "clear", tier: "primary" }, 1);
    expect(h.sessions.getSessionId(100, "primary")).toBeNull();
    expect(h.sessions.getSessionId(100, "secondary")).toBe("s-uuid");
    expect(h.tg.sent[0]!.text).toContain("Cleared <b>primary</b>");
  });

  test("clear all wipes both tiers including pending summary", async () => {
    const h = await makeHarness();
    h.sessions.setSessionId(100, "primary", "p-uuid");
    h.sessions.setSummary(100, "secondary", "old summary", Date.now());

    await runCommand(h.deps, fakeMsg("/clear"), { kind: "clear", tier: "all" }, 1);
    expect(h.sessions.getSessionId(100, "primary")).toBeNull();
    expect(h.sessions.getSummary(100, "secondary")).toBeNull();
    expect(h.tg.sent[0]!.text).toContain("primary");
    expect(h.tg.sent[0]!.text).toContain("secondary");
    const row = lastAudit(h.db);
    expect(row.response).toBe("cleared:primary,secondary");
  });

  test("clear secondary on chat with only primary session reports already-clean", async () => {
    const h = await makeHarness();
    h.sessions.setSessionId(100, "primary", "p-uuid");
    await runCommand(
      h.deps,
      fakeMsg("/clear secondary"),
      { kind: "clear", tier: "secondary" },
      1,
    );
    expect(h.tg.sent[0]!.text).toContain("Already clean");
    expect(h.sessions.getSessionId(100, "primary")).toBe("p-uuid");
  });

  // --- Ollama tier (cutoff-based clear) ---

  test("/clear ollama on a chat with prior ollama turns sets the cutoff and replies 'Cleared'", async () => {
    const h = await makeHarness();
    seedOllamaTurn(h.db, 100, 5000);
    const before = Date.now();
    await runCommand(h.deps, fakeMsg("/clear ollama"), { kind: "clear", tier: "ollama" }, 1);
    expect(h.tg.sent[0]!.text).toContain("Cleared <b>ollama</b>");
    const cutoff = h.sessions.getOllamaCutoff(100);
    expect(cutoff).not.toBeNull();
    expect(cutoff!).toBeGreaterThanOrEqual(before);
    expect(lastAudit(h.db).response).toBe("cleared:ollama");
  });

  test("/clear ollama on a chat with no prior ollama turns reports 'Already clean'", async () => {
    const h = await makeHarness();
    await runCommand(h.deps, fakeMsg("/clear ollama"), { kind: "clear", tier: "ollama" }, 1);
    expect(h.tg.sent[0]!.text).toContain("Already clean");
    expect(h.sessions.getOllamaCutoff(100)).toBeNull();
  });

  test("back-to-back /clear ollama reports 'Already clean' the second time", async () => {
    const h = await makeHarness();
    seedOllamaTurn(h.db, 100, 5000);
    await runCommand(h.deps, fakeMsg("/clear ollama"), { kind: "clear", tier: "ollama" }, 1);
    expect(h.tg.sent[0]!.text).toContain("Cleared");
    await runCommand(h.deps, fakeMsg("/clear ollama"), { kind: "clear", tier: "ollama" }, 2);
    expect(h.tg.sent[1]!.text).toContain("Already clean");
  });

  test("/clear all includes ollama when ollama turns exist", async () => {
    const h = await makeHarness();
    h.sessions.setSessionId(100, "primary", "p-uuid");
    seedOllamaTurn(h.db, 100, 5000);
    await runCommand(h.deps, fakeMsg("/clear"), { kind: "clear", tier: "all" }, 1);
    expect(h.tg.sent[0]!.text).toContain("primary");
    expect(h.tg.sent[0]!.text).toContain("ollama");
    expect(h.sessions.getOllamaCutoff(100)).not.toBeNull();
    expect(lastAudit(h.db).response).toBe("cleared:primary,ollama");
  });
});

// Insert a successful Ollama audit row so /clear ollama can find something to clear.
function seedOllamaTurn(db: SolracDb, chatId: number, startedAt: number): void {
  const id = db.insertAudit({
    chatId,
    fromId: 200,
    updateId: 0,
    prompt: "hi",
    startedAt,
    model: "ollama:gemma",
  });
  db.updateAuditEnd({
    id,
    response: "hello",
    toolCalls: null,
    inputTokens: null,
    outputTokens: null,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
    costUsd: 0,
    agentSessionId: null,
    status: "ok",
    errorMessage: null,
    endedAt: startedAt + 1,
  });
}

// ---------------------------------------------------------------------------
// /help and unknown
// ---------------------------------------------------------------------------

describe("runCommand /help and /unknown", () => {
  test("/help replies with the help card and writes ok audit", async () => {
    const h = await makeHarness();
    await runCommand(h.deps, fakeMsg("/help"), { kind: "help" }, 1);
    expect(h.tg.sent[0]!.text).toContain("Solrac help");
    // Help lists command names bare (no prefix on each bullet); the header
    // documents that `/` and `:` both work. Bullets just have the bold name.
    expect(h.tg.sent[0]!.text).toContain("<b>clear</b>");
    expect(h.tg.sent[0]!.text).toContain("<b>compact</b>");
    expect(h.tg.sent[0]!.parseMode).toBe("HTML");
    expect(lastAudit(h.db).response).toBe("help_shown");
  });

  test("empty kind falls back to /help", async () => {
    const h = await makeHarness();
    await runCommand(h.deps, fakeMsg("/"), { kind: "empty" }, 1);
    expect(h.tg.sent[0]!.text).toContain("Solrac help");
  });

  test("unknown command replies with the unknown text", async () => {
    const h = await makeHarness();
    await runCommand(h.deps, fakeMsg("/wat"), { kind: "unknown", raw: "/wat" }, 1);
    expect(h.tg.sent[0]!.text).toContain("Unknown command");
    expect(h.tg.sent[0]!.text).toContain("/wat");
    expect(lastAudit(h.db).response).toBe("unknown_command");
    // status='ok' because the command was processed (with a usage hint reply);
    // we don't treat unknown as an error.
    expect(lastAudit(h.db).status).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// /status
// ---------------------------------------------------------------------------

describe("runCommand /status", () => {
  test("fresh chat suppresses the wall of 'none' (PR-B trim)", async () => {
    const h = await makeHarness();
    await runCommand(h.deps, fakeMsg("/status"), { kind: "status" }, 1);
    const text = h.tg.sent[0]!.text;
    expect(text).toContain("Solrac status");
    // PR-B: session/summary bullets only render when present. Fresh chat
    // shows neither — operators using default-Ollama don't see Claude noise.
    expect(text).not.toContain("primary session:");
    expect(text).not.toContain("secondary session:");
    expect(text).not.toContain("pending summary:");
    expect(lastAudit(h.db).response).toBe("status_shown");
  });

  test("renders shortened session id when present", async () => {
    const h = await makeHarness();
    h.sessions.setSessionId(100, "primary", "abcdefghijklmnop");
    await runCommand(h.deps, fakeMsg("/status"), { kind: "status" }, 1);
    const text = h.tg.sent[0]!.text;
    // Short form: first 4 + … + last 4
    expect(text).toContain("abcd…mnop");
  });

  test("surfaces pending summary when a /compact has run", async () => {
    const h = await makeHarness();
    h.sessions.setSummary(100, "primary", "sum text", Date.now());
    await runCommand(h.deps, fakeMsg("/status"), { kind: "status" }, 1);
    expect(h.tg.sent[0]!.text).toContain("pending summary: primary");
  });
});

// ---------------------------------------------------------------------------
// /compact — pre-flight rejections (no SDK call)
// ---------------------------------------------------------------------------

describe("runCommand /compact (pre-flight)", () => {
  test("cap-rejection audit row does not increase sumChatCostSince", async () => {
    // Pinning invariant: a /compact rejection writes an engine-tagged audit
    // row with cost_usd=NULL. The cost-cap query must NOT count those rows
    // toward the rolling spend — otherwise a spam of /compact attempts
    // would lock the user out of the cap window.
    const h = await makeHarness({ capUsd: 0.01 });
    const now = Date.now();
    // Seed a $0.05 row to push us over the $0.01 cap.
    const id = h.db.insertAudit({
      chatId: 100,
      fromId: 200,
      updateId: 0,
      prompt: "x",
      startedAt: now - 1000,
      model: "claude:primary:claude-sonnet-4-6",
    });
    h.db.updateAuditEnd({
      id,
      response: "y",
      toolCalls: null,
      inputTokens: null,
      outputTokens: null,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
      costUsd: 0.05,
      agentSessionId: null,
      status: "ok",
      errorMessage: null,
      endedAt: now - 500,
    });

    const before = h.db.sumChatCostSince(100, 0);
    expect(before).toBeCloseTo(0.05);

    await runCommand(
      h.deps,
      fakeMsg("/compact"),
      { kind: "compact", tier: "primary" },
      1,
    );

    // The rejection wrote an audit row but it must contribute 0 to the
    // cost rollup (cost_usd is NULL → COALESCE(SUM, 0) excludes it).
    const after = h.db.sumChatCostSince(100, 0);
    expect(after).toBeCloseTo(before);
  });

  test("rejects when per-chat hourly cap is exceeded; no audit response", async () => {
    const h = await makeHarness({ capUsd: 0.01 });
    // Seed a $0.05 audit row in the past hour so the cap fires before the
    // SDK is touched.
    const now = Date.now();
    const id = h.db.insertAudit({
      chatId: 100,
      fromId: 200,
      updateId: 0,
      prompt: "x",
      startedAt: now - 1000,
      model: "claude:primary:claude-sonnet-4-6",
    });
    h.db.updateAuditEnd({
      id,
      response: "y",
      toolCalls: null,
      inputTokens: null,
      outputTokens: null,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
      costUsd: 0.05,
      agentSessionId: null,
      status: "ok",
      errorMessage: null,
      endedAt: now - 500,
    });
    await runCommand(h.deps, fakeMsg("/compact"), { kind: "compact", tier: "primary" }, 1);
    const row = lastAudit(h.db);
    expect(row.status).toBe("error");
    expect(row.error_message).toContain("chat_cost_cap");
    expect(h.tg.sent[0]!.text).toContain("chat_cost_cap");
    // Compact rejection still tags with the engine model so future cap
    // checks include the rejection's $0 cost.
    expect(row.model).toBe("claude:primary:claude-sonnet-4-6");
  });

  test("replies 'nothing to compact' on a fresh chat", async () => {
    const h = await makeHarness();
    await runCommand(h.deps, fakeMsg("/compact"), { kind: "compact", tier: "primary" }, 1);
    expect(h.tg.sent[0]!.text).toContain("nothing to compact");
    const row = lastAudit(h.db);
    expect(row.status).toBe("error");
    expect(row.error_message).toBe("nothing_to_compact");
  });

  test("nothing-to-compact filters by previous summary cutoff", async () => {
    const h = await makeHarness();
    // Insert a successful primary turn 5s ago.
    const now = Date.now();
    const id = h.db.insertAudit({
      chatId: 100,
      fromId: 200,
      updateId: 0,
      prompt: "old turn",
      startedAt: now - 5000,
      model: "claude:primary:claude-sonnet-4-6",
    });
    h.db.updateAuditEnd({
      id,
      response: "old answer",
      toolCalls: null,
      inputTokens: null,
      outputTokens: null,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
      costUsd: 0.001,
      agentSessionId: null,
      status: "ok",
      errorMessage: null,
      endedAt: now - 4000,
    });
    // Pretend a prior /compact ran 2s ago — its cutoff would exclude the
    // turn above (older than the cutoff is excluded by the strict `>` filter).
    h.sessions.setSummary(100, "primary", "prior summary", now - 2000);
    await runCommand(h.deps, fakeMsg("/compact"), { kind: "compact", tier: "primary" }, 1);
    expect(h.tg.sent[0]!.text).toContain("nothing to compact");
  });
});

// ---------------------------------------------------------------------------
// /context
// ---------------------------------------------------------------------------

describe("runCommand /context", () => {
  test("fresh chat reports no successful turn yet", async () => {
    const h = await makeHarness();
    await runCommand(h.deps, fakeMsg("/context"), { kind: "context", tier: "primary" }, 1);
    const text = h.tg.sent[0]!.text;
    expect(text).toContain("Context");
    expect(text).toContain("primary");
    expect(text).toContain("turns (this chat+tier): 0");
    expect(text).toContain("No successful turn yet");
    expect(lastAudit(h.db).response).toBe("context_shown:primary");
  });

  test("renders cache + fresh + output and replay estimate from last turn", async () => {
    const h = await makeHarness();
    h.sessions.setSessionId(100, "primary", "abcd1234efgh5678");
    // Seed a turn with all four token types populated.
    const id = h.db.insertAudit({
      chatId: 100,
      fromId: 200,
      updateId: 0,
      prompt: "What's up?",
      startedAt: Date.now() - 1000,
      model: "claude:primary:claude-sonnet-4-6",
    });
    h.db.updateAuditEnd({
      id,
      response: "Quick reply.",
      toolCalls: null,
      inputTokens: 50,
      outputTokens: 100,
      cacheCreationInputTokens: 200,
      cacheReadInputTokens: 8000,
      costUsd: 0.0123,
      agentSessionId: null,
      status: "ok",
      errorMessage: null,
      endedAt: Date.now(),
    });

    await runCommand(h.deps, fakeMsg("/context"), { kind: "context", tier: "primary" }, 1);
    const text = h.tg.sent[0]!.text;
    // Session id is shortened first4…last4
    expect(text).toContain("abcd…5678");
    expect(text).toContain("turns (this chat+tier): 1");
    // Token lines render with thousand-separators
    expect(text).toContain("fresh input: 50 tokens");
    expect(text).toContain("cache read: 8,000 tokens");
    expect(text).toContain("cache create: 200 tokens");
    expect(text).toContain("output: 100 tokens");
    expect(text).toContain("$0.0123");
    // Replay estimate = 50 + 8000 + 200 + 100 = 8350
    expect(text).toContain("~8,350 tokens");
  });

  test("surfaces pending summary in /context", async () => {
    const h = await makeHarness();
    h.sessions.setSummary(100, "primary", "abcdef", 100); // 6 chars
    await runCommand(h.deps, fakeMsg("/context"), { kind: "context", tier: "primary" }, 1);
    expect(h.tg.sent[0]!.text).toContain("pending summary: 6 B");
  });

  test("/context !  shows secondary tier", async () => {
    const h = await makeHarness();
    h.sessions.setSessionId(100, "secondary", "secsess");
    await runCommand(h.deps, fakeMsg("/context !"), { kind: "context", tier: "secondary" }, 1);
    const text = h.tg.sent[0]!.text;
    expect(text).toContain("<b>secondary</b>");
    // Audit row ends with the requested tier suffix
    expect(lastAudit(h.db).response).toBe("context_shown:secondary");
  });
});

// ---------------------------------------------------------------------------
// /skill — operator-defined skills (PNX-167.1)
// ---------------------------------------------------------------------------
//
// Only the cap-rejection path is unit-tested — the happy path makes a real
// SDK call, same convention as `/compact`'s test coverage. Live verification
// over Telegram covers the round trip.

function fakeSkill(name: string, body: string = "Hello {{args}}."): Skill {
  return parseSkillFile(
    `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}`,
    `/tmp/${name}/SKILL.md`,
    RESERVED_BUILTINS,
  );
}

function singletonRegistry(skill: Skill): SkillRegistry {
  return {
    all: [skill],
    get: (n) => (n.toLowerCase() === skill.name ? skill : undefined),
    size: () => 1,
  };
}

describe("runCommand /skill (pre-flight)", () => {
  test("rejects when per-chat hourly cap is exceeded; engine-tagged audit", async () => {
    const skill = fakeSkill("greet");
    const h = await makeHarness({ capUsd: 0.01, skillRegistry: singletonRegistry(skill) });
    // Seed a $0.05 audit row so the cap fires before the SDK call.
    const now = Date.now();
    const id = h.db.insertAudit({
      chatId: 100,
      fromId: 200,
      updateId: 0,
      prompt: "x",
      startedAt: now - 1000,
      model: "claude:primary:claude-sonnet-4-6",
    });
    h.db.updateAuditEnd({
      id,
      response: "y",
      toolCalls: null,
      inputTokens: null,
      outputTokens: null,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
      costUsd: 0.05,
      agentSessionId: null,
      status: "ok",
      errorMessage: null,
      endedAt: now - 500,
    });
    await runCommand(
      h.deps,
      fakeMsg("/greet world"),
      { kind: "skill", skill, args: "world" },
      1,
    );
    const row = lastAudit(h.db);
    expect(row.status).toBe("error");
    expect(row.error_message).toContain("chat_cost_cap");
    // Engine + skill tag for greppability and cost-rollup consistency.
    expect(row.model).toBe("claude:primary:claude-sonnet-4-6:skill:greet");
    expect(h.tg.sent[0]!.text).toContain("chat_cost_cap");
  });

  test("global cap rejection also engine-tagged", async () => {
    const skill = fakeSkill("greet");
    const h = await makeHarness({
      capUsd: 100,
      globalCapUsd: 0.01,
      skillRegistry: singletonRegistry(skill),
    });
    const now = Date.now();
    // Seed across a different chat to exercise the global rollup, not chat.
    const id = h.db.insertAudit({
      chatId: 999,
      fromId: 200,
      updateId: 0,
      prompt: "x",
      startedAt: now - 1000,
      model: "claude:primary:claude-sonnet-4-6",
    });
    h.db.updateAuditEnd({
      id,
      response: "y",
      toolCalls: null,
      inputTokens: null,
      outputTokens: null,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
      costUsd: 0.05,
      agentSessionId: null,
      status: "ok",
      errorMessage: null,
      endedAt: now - 500,
    });
    await runCommand(
      h.deps,
      fakeMsg("/greet world"),
      { kind: "skill", skill, args: "world" },
      1,
    );
    const row = lastAudit(h.db);
    expect(row.status).toBe("error");
    expect(row.error_message).toContain("global_cost_cap");
  });

  test("rejection leaves cost rollup unchanged (cap-rollup invariant)", async () => {
    const skill = fakeSkill("greet");
    const h = await makeHarness({ capUsd: 0.01, skillRegistry: singletonRegistry(skill) });
    const now = Date.now();
    const id = h.db.insertAudit({
      chatId: 100,
      fromId: 200,
      updateId: 0,
      prompt: "x",
      startedAt: now - 1000,
      model: "claude:primary:claude-sonnet-4-6",
    });
    h.db.updateAuditEnd({
      id,
      response: "y",
      toolCalls: null,
      inputTokens: null,
      outputTokens: null,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
      costUsd: 0.05,
      agentSessionId: null,
      status: "ok",
      errorMessage: null,
      endedAt: now - 500,
    });
    const before = h.db.sumChatCostSince(100, 0);
    await runCommand(
      h.deps,
      fakeMsg("/greet world"),
      { kind: "skill", skill, args: "world" },
      1,
    );
    expect(h.db.sumChatCostSince(100, 0)).toBeCloseTo(before);
  });
});

describe("runCommand /help with skills", () => {
  test("/help renders skills section when registry is non-empty", async () => {
    const skill = fakeSkill("greet");
    const h = await makeHarness({ skillRegistry: singletonRegistry(skill) });
    await runCommand(h.deps, fakeMsg("/help"), { kind: "help" }, 1);
    const text = h.tg.sent[0]!.text;
    expect(text).toContain("<b>Skills</b>");
    expect(text).toContain("<b>greet</b>");
    expect(text).toContain("greet skill"); // description
  });

  test("/help omits skills section when registry is empty", async () => {
    const h = await makeHarness();
    await runCommand(h.deps, fakeMsg("/help"), { kind: "help" }, 1);
    expect(h.tg.sent[0]!.text).not.toContain("<b>Skills</b>");
  });
});

// ---------------------------------------------------------------------------
// /tasks
// ---------------------------------------------------------------------------

describe("parseCommand /tasks", () => {
  test("/tasks → tasks_list", () => {
    expect(parseCommand("/tasks", DEPS)).toEqual({
      kind: "run",
      cmd: { kind: "tasks_list" },
    });
  });

  test("/tasks run morning_digest → tasks_run", () => {
    expect(parseCommand("/tasks run morning_digest", DEPS)).toEqual({
      kind: "run",
      cmd: { kind: "tasks_run", name: "morning_digest" },
    });
  });

  test("/tasks bogus → unknown", () => {
    expect(parseCommand("/tasks foo bar", DEPS)).toEqual({
      kind: "run",
      cmd: { kind: "unknown", raw: "/tasks foo bar" },
    });
  });

  test(":tasks works as alias", () => {
    expect(parseCommand(":tasks", DEPS)).toEqual({
      kind: "run",
      cmd: { kind: "tasks_list" },
    });
  });
});

describe("runCommand /tasks", () => {
  test("scheduler disabled → 'scheduler disabled' reply", async () => {
    const h = await makeHarness();
    await runCommand(h.deps, fakeMsg("/tasks"), { kind: "tasks_list" }, 1);
    expect(h.tg.sent[0]!.text).toContain("scheduler disabled");
  });

  test("with registered tasks, /tasks lists each with next-fire", async () => {
    const h = await makeHarness();
    const fakeTask = {
      name: "morning_digest",
      description: "Morning digest task",
      body: "Run the digest",
      chatId: null,
      engine: "ollama" as const,
      spec: { kind: "every" as const, ms: 3_600_000 },
      catchUp: true,
      enabled: true,
      maxCostUsd: null,
      bootCatchUpJitterS: 0,
      sourcePath: "/tasks/morning_digest/TASK.md",
      sourceHash: "abc",
    };
    h.deps.taskRegistry = {
      all: [fakeTask],
      get: (n: string) => (n === "morning_digest" ? fakeTask : undefined),
      size: () => 1,
    };
    await runCommand(h.deps, fakeMsg("/tasks"), { kind: "tasks_list" }, 1);
    const text = h.tg.sent[0]!.text;
    expect(text).toContain("morning_digest");
    expect(text).toContain("every 1h");
    expect(text).toContain("ollama");
    // Next-fire rendering: never-run task → fire on next tick → "(now)" or
    // "(<small> late)" depending on the millisecond clock the test ran at.
    // Both forms include "next:" — that's the contract.
    expect(text).toContain("next:");
  });

  test("/tasks renders 'consumed' for one_off_consumed task", async () => {
    const h = await makeHarness();
    const fakeTask = {
      name: "alarm",
      description: "One-off alarm",
      body: "Ring",
      chatId: null,
      engine: "ollama" as const,
      spec: { kind: "at" as const, atMs: Date.now() - 86_400_000 },
      catchUp: false,
      enabled: true,
      maxCostUsd: null,
      bootCatchUpJitterS: 0,
      sourcePath: "/tasks/alarm/TASK.md",
      sourceHash: "abc",
    };
    h.deps.taskRegistry = {
      all: [fakeTask],
      get: (n: string) => (n === "alarm" ? fakeTask : undefined),
      size: () => 1,
    };
    h.db.upsertTaskMetadata({ name: "alarm", sourcePath: "/p", sourceHash: "h" });
    h.db.setTaskOneOffConsumed({
      name: "alarm",
      lastRunAt: Date.now() - 86_400_000,
      lastAuditId: null,
      lastStatus: "fired",
    });
    await runCommand(h.deps, fakeMsg("/tasks"), { kind: "tasks_list" }, 1);
    const text = h.tg.sent[0]!.text;
    expect(text).toContain("next: consumed");
  });

  test("/tasks renders '—' for disabled task", async () => {
    const h = await makeHarness();
    const fakeTask = {
      name: "paused",
      description: "Paused task",
      body: "noop",
      chatId: null,
      engine: "ollama" as const,
      spec: { kind: "every" as const, ms: 3_600_000 },
      catchUp: true,
      enabled: false,
      maxCostUsd: null,
      bootCatchUpJitterS: 0,
      sourcePath: "/tasks/paused/TASK.md",
      sourceHash: "abc",
    };
    h.deps.taskRegistry = {
      all: [fakeTask],
      get: (n: string) => (n === "paused" ? fakeTask : undefined),
      size: () => 1,
    };
    await runCommand(h.deps, fakeMsg("/tasks"), { kind: "tasks_list" }, 1);
    const text = h.tg.sent[0]!.text;
    expect(text).toContain("(disabled)");
    expect(text).toContain("next: —");
  });

  test("/tasks renders 'in <duration>' for future fire", async () => {
    const h = await makeHarness();
    const lastRun = Date.now() - 30 * 60 * 1000; // 30 min ago
    const fakeTask = {
      name: "hourly",
      description: "Hourly task",
      body: "Run",
      chatId: null,
      engine: "ollama" as const,
      spec: { kind: "every" as const, ms: 60 * 60 * 1000 }, // 1h
      catchUp: true,
      enabled: true,
      maxCostUsd: null,
      bootCatchUpJitterS: 0,
      sourcePath: "/tasks/hourly/TASK.md",
      sourceHash: "abc",
    };
    h.deps.taskRegistry = {
      all: [fakeTask],
      get: (n: string) => (n === "hourly" ? fakeTask : undefined),
      size: () => 1,
    };
    h.db.upsertTaskMetadata({ name: "hourly", sourcePath: "/p", sourceHash: "h" });
    h.db.markTaskFired({
      name: "hourly",
      lastRunAt: lastRun,
      lastAuditId: 1,
      lastStatus: "fired",
    });
    await runCommand(h.deps, fakeMsg("/tasks"), { kind: "tasks_list" }, 1);
    const text = h.tg.sent[0]!.text;
    // ~30m remain in the hour. Allow either "30m" or "29m" in case the clock
    // rolled.
    expect(text).toMatch(/\(in \d+m\)/);
  });

  test("/tasks run <name> calls triggerScheduledTask and reports outcome", async () => {
    const h = await makeHarness();
    const fired: string[] = [];
    h.deps.triggerScheduledTask = (n) => {
      fired.push(n);
      return { kind: "fired", name: n };
    };
    h.deps.taskRegistry = {
      all: [],
      get: () => undefined,
      size: () => 0,
    };
    await runCommand(
      h.deps,
      fakeMsg("/tasks run digest"),
      { kind: "tasks_run", name: "digest" },
      1,
    );
    expect(fired).toEqual(["digest"]);
    expect(h.tg.sent[0]!.text).toContain("fired task");
  });

  test("/tasks run <unknown> reports unknown_task", async () => {
    const h = await makeHarness();
    h.deps.triggerScheduledTask = (n) => ({ kind: "unknown_task", name: n });
    h.deps.taskRegistry = { all: [], get: () => undefined, size: () => 0 };
    await runCommand(
      h.deps,
      fakeMsg("/tasks run nope"),
      { kind: "tasks_run", name: "nope" },
      1,
    );
    expect(h.tg.sent[0]!.text).toContain("unknown task");
  });
});
