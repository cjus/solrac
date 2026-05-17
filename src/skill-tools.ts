/**
 * @fileoverview Operator-defined skills exposed as MCP tools to the local agent.
 * @purpose Bridge the slash-command surface (`/<skill>` typed by the operator)
 *          to the agentic surface (model decides to call `skills__<name>`
 *          mid-tool-loop). The model sees each tool-eligible skill in its
 *          tool catalog with the operator-authored `description`; on call,
 *          this module dispatches to the same `runSkillBare` execution path
 *          the slash command uses, then writes a separate audit row tagged
 *          `origin='tool_call'` so operator-typed and agent-driven skill
 *          activity stay distinguishable in the audit log.
 *
 * Restrictions:
 *   - Only `tier: local` skills with `tool: true` are exposed. Claude-tier
 *     skills are slash-only.
 *   - Only the local path sees these tools. The Claude SDK's MCP server is
 *     untouched.
 *   - Permission tier is auto-allow. Cost cap is the backstop (local skills
 *     are free, so this is mostly a forward-compat statement).
 *
 * **RECURSION SAFETY** (load-bearing invariant):
 *   - The handler calls `runSkillBare` which calls the local driver with NO
 *     `tools` array. The sub-call therefore cannot itself call any tool.
 *   - If a future change adds tool surface to `runSkillBare`, a local agent
 *     calling `skills__foo` could trigger `foo` calling `skills__foo` →
 *     infinite loop. Loop detector + iteration cap mitigate, but the
 *     parser-level guard (no `tools` field) is the primary defense.
 *
 * Per-call context propagation:
 *   - Skill handlers need chatId / fromId / updateId / parentAuditId to write
 *     the audit row. The SDK's `(args) => ...` handler signature gives no
 *     room for these. Instead we use `node:async_hooks::AsyncLocalStorage`:
 *     the local tool-loop wraps each turn in `skillToolCtx.run({...}, ...)`,
 *     and the handler reads `skillToolCtx.getStore()` synchronously inside
 *     its async boundary.
 *   - ALS propagates correctly across `await` in Bun + Node, so async
 *     handlers see the same store across the request lifecycle.
 *   - Concurrent turns (Solrac runs N chats in parallel via the queue)
 *     each get their own AsyncLocalStorage context — no shared mutable
 *     state, no races.
 *
 * Position in the dependency graph:
 *   db + log + skills + commands (runSkillBare) → skill-tools → main
 *
 * Cross-references:
 *   - src/commands.ts::runSkillBare — pure execution helper, recursion-safe
 *   - src/engine.ts::runEngineTurnWithTools — wraps loop in skillToolCtx.run
 *   - docs/USAGE.md#skills-as-tools — operator-facing docs
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  runSkillBare,
  type EngineSkillDeps,
} from "./commands.ts";
import type { SolracDb } from "./db.ts";
import { log } from "./log.ts";
import { truncateAuditPrompt } from "./policy.ts";
import type { Skill, SkillRegistry } from "./skills.ts";

// ---------------------------------------------------------------------------
// Per-turn context (AsyncLocalStorage)
// ---------------------------------------------------------------------------

export interface SkillToolContext {
  readonly chatId: number;
  readonly fromId: number;
  // Inherited from the parent local-engine turn. May be null for synthesized
  // updates (e.g. scheduled fires that route through the local engine and
  // call a skill tool — those turns have updateId=null already).
  readonly updateId: number | null;
  readonly parentAuditId: number;
}

export const skillToolCtx = new AsyncLocalStorage<SkillToolContext>();

// ---------------------------------------------------------------------------
// Tool name / format
// ---------------------------------------------------------------------------

// Short name (what the local engine sees on the wire) is `skills__<name>`.
// The leading `skills` segment is the synthetic-integration namespace; the
// trailing `<name>` matches the operator's `name:` frontmatter. The
// `mcp__solrac__` prefix the policy layer expects is added by
// `engine-tools.ts::executeToolCall` when reconstructing the full name.
export const SKILL_TOOL_PREFIX = "skills__";

export function skillToolName(skillName: string): string {
  return `${SKILL_TOOL_PREFIX}${skillName}`;
}

/**
 * Error payload returned to the parent model when a skill-as-tool call fails.
 *
 * Why this shape: weak local models (gpt-oss-20b under LMStudio, surfaced
 * during v0.7.0 dogfooding) treat a bare `{success:false, error:"iteration_cap"}`
 * envelope as a transient failure and retry the same call 3-4× before the
 * loop detector intervenes. Skill execution is deterministic for the same
 * (skill, args) — retries can't succeed, they just waste rounds and confuse
 * the parent's reasoning about what tools to use next. Explicit `retryable:
 * false` + plain-prose `hint` give small models the signal they need to
 * abandon the tool and answer with whatever information they already have.
 *
 * Exported for unit-testing the payload shape and for callers that need to
 * synthesize a skill-error envelope outside the handler (e.g. context-missing
 * defensive path).
 */
export function buildSkillErrorPayload(
  skillName: string,
  errorMessage: string,
): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          success: false,
          error: errorMessage,
          retryable: false,
          hint:
            `Do not call 'skills__${skillName}' again this turn — same input ` +
            "produces the same result. Continue without this skill and answer the user " +
            "with whatever information you already have.",
        }),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tool definition builder
// ---------------------------------------------------------------------------

export interface BuildSkillToolsDeps {
  readonly db: SolracDb;
  // Null-safe: deploys without the local engine configured can still load
  // skills (the tool-eligible filter below catches the contradiction). When
  // null and the registry contains tool-eligible skills, we log + return
  // empty rather than crash.
  readonly localSkillDeps: EngineSkillDeps | null;
}

/**
 * Build SDK MCP tool definitions for every tool-eligible skill in the
 * registry. A skill is tool-eligible when both:
 *   - `skill.tool === true` (operator opted in)
 *   - `skill.tier === "local"` (free-only restriction)
 *
 * Skills failing either gate are silently skipped (the parser raises at
 * load when `tool: true` is set with non-local tier; this is just defensive).
 */
export function buildSkillTools(
  registry: SkillRegistry,
  deps: BuildSkillToolsDeps,
): ReadonlyArray<SdkMcpToolDefinition<any>> {
  const eligible = registry.all.filter(
    (s) => s.tool && s.tier === "local",
  );
  if (eligible.length === 0) return Object.freeze([]);

  if (deps.localSkillDeps === null) {
    log.warn("skill_tools.local_unconfigured", {
      eligibleCount: eligible.length,
      message:
        "Tool-eligible skills exist but the local engine isn't configured; tools won't be exposed.",
    });
    return Object.freeze([]);
  }

  const local = deps.localSkillDeps;
  const tools: SdkMcpToolDefinition<any>[] = eligible.map((skill) =>
    buildOneSkillTool(skill, deps.db, local),
  );
  return Object.freeze(tools);
}

function buildOneSkillTool(
  skill: Skill,
  db: SolracDb,
  local: EngineSkillDeps,
): SdkMcpToolDefinition<any> {
  // The `args` schema mirrors the only template variable supported by skill
  // bodies (`{{args}}`). We expose it as a single string parameter rather
  // than a typed object so the model can pass natural-language input
  // verbatim — the same way an operator typing `/tldr <text>` does.
  return tool(
    skillToolName(skill.name),
    skill.description,
    {
      args: z
        .string()
        .describe(
          "The text or content to pass into the skill template. " +
            "Substituted for {{args}} in the skill body. May be multi-line.",
        ),
    },
    async ({ args }) => {
      const cx = skillToolCtx.getStore();
      const startedAt = Date.now();
      // Defensive: a misconfigured loop driver that forgets to wrap the
      // dispatch in `skillToolCtx.run(...)` would land here. Surface a clear
      // error rather than silently writing a malformed audit row.
      if (!cx) {
        const msg = `skill tool "${skill.name}" called outside skillToolCtx — loop driver did not wrap dispatch`;
        log.error("skill_tools.no_context", { skill: skill.name });
        return buildSkillErrorPayload(skill.name, msg);
      }

      const result = await runSkillBare(local, skill, args);
      const engineModelTag = `local:${local.driver.backend}:${local.model}:skill:${skill.name}`;

      // Audit row, origin='tool_call' so operators can distinguish agent-
      // driven skill activity from operator-typed `/<skill>` invocations:
      //   SELECT * FROM audit WHERE origin='tool_call' AND model LIKE '%:skill:%'
      const auditId = db.insertAudit({
        chatId: cx.chatId,
        fromId: cx.fromId,
        updateId: cx.updateId,
        prompt: truncateAuditPrompt(args),
        startedAt,
        model: engineModelTag,
        origin: "tool_call",
      });

      const toolCallsJson =
        result.toolCallSummaries.length > 0
          ? JSON.stringify(result.toolCallSummaries)
          : null;

      if (result.errorMessage !== null) {
        db.updateAuditEnd({
          id: auditId,
          response: null,
          toolCalls: toolCallsJson,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          cacheCreationInputTokens: null,
          cacheReadInputTokens: null,
          costUsd: 0,
          agentSessionId: null,
          status: "error",
          errorMessage: result.errorMessage,
          endedAt: Date.now(),
        });
        log.warn("skill_tools.error", {
          chatId: cx.chatId,
          parentAuditId: cx.parentAuditId,
          skill: skill.name,
          error: result.errorMessage,
        });
        // Skill execution is deterministic given the same (skill, args).
        // Tell the parent model explicitly not to retry — weak local models
        // otherwise burn 3-4 rounds re-calling the same failing skill before
        // the loop detector breaks the cycle. See `buildSkillErrorPayload`.
        return buildSkillErrorPayload(skill.name, result.errorMessage);
      }

      db.updateAuditEnd({
        id: auditId,
        response: result.text.slice(0, 200),
        toolCalls: toolCallsJson,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cacheCreationInputTokens: null,
        cacheReadInputTokens: null,
        costUsd: 0,
        agentSessionId: null,
        status: "ok",
        errorMessage: null,
        endedAt: Date.now(),
      });
      log.info("skill_tools.done", {
        chatId: cx.chatId,
        parentAuditId: cx.parentAuditId,
        skill: skill.name,
        tier: "local",
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        replyLength: result.text.length,
      });
      // Return the model's text verbatim. The calling local agent receives
      // it as the `tool` role content and composes its final user-facing
      // reply on top.
      return {
        content: [{ type: "text", text: result.text }],
      };
    },
  );
}
