/**
 * @fileoverview Operator-defined skills exposed as MCP tools to the Ollama agent.
 * @purpose Bridge the slash-command surface (`/<skill>` typed by the operator)
 *          to the agentic surface (model decides to call `skills__<name>`
 *          mid-tool-loop). The model sees each tool-eligible skill in its
 *          tool catalog with the operator-authored `description`; on call,
 *          this module dispatches to the same `runSkillBare` execution path
 *          the slash command uses, then writes a separate audit row tagged
 *          `origin='tool_call'` so operator-typed and agent-driven skill
 *          activity stay distinguishable in the audit log.
 *
 * Phase 1 restrictions (locked-in, see PR description):
 *   - Only `tier: ollama` skills with `tool: true` are exposed. Claude-tier
 *     skills are slash-only until Phase 2.
 *   - Only the Ollama path sees these tools. The Claude SDK's MCP server is
 *     untouched.
 *   - Permission tier is auto-allow. Cost cap is the backstop (Phase 1 skills
 *     are free, so this is mostly a forward-compat statement).
 *
 * **RECURSION SAFETY** (load-bearing invariant):
 *   - The handler calls `runSkillBare` which posts to Ollama with NO `tools`
 *     field. The sub-call therefore cannot itself call any tool.
 *   - `skill-tools.test.ts` asserts the outgoing fetch body has no `tools`
 *     key — a regression breaks CI rather than production.
 *   - If a future change adds tool surface to `runSkillBare`, an Ollama agent
 *     calling `skills__foo` could trigger `foo` calling `skills__foo` →
 *     infinite loop. Loop detector + iteration cap mitigate, but the parser-
 *     level guard (no `tools` field) is the primary defense.
 *
 * Per-call context propagation:
 *   - Skill handlers need chatId / fromId / updateId / parentAuditId to write
 *     the audit row. The SDK's `(args) => ...` handler signature gives no
 *     room for these. Instead we use `node:async_hooks::AsyncLocalStorage`:
 *     the Ollama tool-loop wraps each turn in `skillToolCtx.run({...}, ...)`,
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
 *   - src/ollama.ts::runOllamaTurnWithTools — wraps loop in skillToolCtx.run
 *   - docs/USAGE.md#skills-as-tools — operator-facing docs
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  runSkillBare,
  type OllamaSkillDeps,
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
  // Inherited from the parent Ollama turn. May be null for synthesized
  // updates (e.g. scheduled fires that route through Ollama and end up
  // calling a skill tool — those turns have updateId=null already).
  readonly updateId: number | null;
  readonly parentAuditId: number;
}

export const skillToolCtx = new AsyncLocalStorage<SkillToolContext>();

// ---------------------------------------------------------------------------
// Tool name / format
// ---------------------------------------------------------------------------

// Short name (what Ollama sees on the wire) is `skills__<name>`. The leading
// `skills` segment is the synthetic-integration namespace; the trailing
// `<name>` matches the operator's `name:` frontmatter (already validated to
// `[a-z0-9_]{1,32}`). Underscores in the separator and the name combine to
// `skills__foo_bar` for a skill named `foo_bar`. The `mcp__solrac__` prefix
// the policy layer expects is added by `ollama-tools.ts::executeToolCall`
// when reconstructing the full name (matching the existing convention for
// non-MCP integrations).
export const SKILL_TOOL_PREFIX = "skills__";

export function skillToolName(skillName: string): string {
  return `${SKILL_TOOL_PREFIX}${skillName}`;
}

// ---------------------------------------------------------------------------
// Tool definition builder
// ---------------------------------------------------------------------------

export interface BuildSkillToolsDeps {
  readonly db: SolracDb;
  // Null-safe: deploys without Ollama configured can still load skills (the
  // tool-eligible filter below catches the contradiction). When null and the
  // registry contains tool-eligible skills, we log + return empty rather
  // than crash.
  readonly ollamaSkillDeps: OllamaSkillDeps | null;
}

/**
 * Build SDK MCP tool definitions for every tool-eligible skill in the
 * registry. A skill is tool-eligible when both:
 *   - `skill.tool === true` (operator opted in)
 *   - `skill.tier === "ollama"` (Phase 1 free-only restriction)
 *
 * Skills failing either gate are silently skipped (the parser raises at
 * load when `tool: true` is set with non-ollama tier; this is just defensive).
 */
export function buildSkillTools(
  registry: SkillRegistry,
  deps: BuildSkillToolsDeps,
): ReadonlyArray<SdkMcpToolDefinition<any>> {
  const eligible = registry.all.filter(
    (s) => s.tool && s.tier === "ollama",
  );
  if (eligible.length === 0) return Object.freeze([]);

  if (deps.ollamaSkillDeps === null) {
    log.warn("skill_tools.ollama_unconfigured", {
      eligibleCount: eligible.length,
      message:
        "Tool-eligible skills exist but Ollama isn't configured; tools won't be exposed.",
    });
    return Object.freeze([]);
  }

  const ollama = deps.ollamaSkillDeps;
  const tools: SdkMcpToolDefinition<any>[] = eligible.map((skill) =>
    buildOneSkillTool(skill, deps.db, ollama),
  );
  return Object.freeze(tools);
}

function buildOneSkillTool(
  skill: Skill,
  db: SolracDb,
  ollama: OllamaSkillDeps,
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
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ success: false, error: msg }),
            },
          ],
        };
      }

      const result = await runSkillBare(ollama, skill, args);
      const engineModelTag = `ollama:${ollama.model}:skill:${skill.name}`;

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
        // The model gets a structured error string so it can adapt — drop
        // the call from its plan, retry with different args, etc. Mirrors
        // the integration error envelope (success/error JSON).
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                error: result.errorMessage,
              }),
            },
          ],
        };
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
        tier: "ollama",
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        replyLength: result.text.length,
      });
      // Return the model's text verbatim. The calling Ollama agent receives
      // it as the `tool` role content and composes its final user-facing
      // reply on top.
      return {
        content: [{ type: "text", text: result.text }],
      };
    },
  );
}
