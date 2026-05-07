# Anthropic Agent SDK — verified surface

Package: `@anthropic-ai/claude-agent-sdk@0.2.119`
Probed: 2026-04-27 (Apr 27 PDT)
Source: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`

## Top-level exports (probe)

`AbortError`, `DirectConnectError`, `DirectConnectTransport`, `EXIT_REASONS`,
`HOOK_EVENTS`, `InMemorySessionStore`, `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`,
`createSdkMcpServer`, `deleteSession`, `foldSessionSummary`, `forkSession`,
`getSessionInfo`, `getSessionMessages`, `getSubagentMessages`,
`importSessionToStore`, `listSessions`, `listSubagents`,
`parseDirectConnectUrl`, `query`, `renameSession`, `startup`, `tagSession`,
`tool`, `unstable_v2_createSession`, `unstable_v2_prompt`,
`unstable_v2_resumeSession`.

`query` arity = 1 (single options object).

## `Options` keys Solrac depends on (verified in `.d.ts`)

| Plan name        | Verified | Where (sdk.d.ts) | Notes |
|------------------|----------|------------------|-------|
| `canUseTool`     | yes      | line 1174        | type `CanUseTool` (line 146); receives `(toolName, input, { signal, suggestions, blockedPath, decisionReason, ... })`. **Compatible with `resume`** — see correction below |
| `permissionMode` | yes      | line 1447        | union: `'default' \| 'acceptEdits' \| 'bypassPermissions' \| 'plan' \| 'dontAsk' \| 'auto'` (line 1757). `'auto'` exists — useful default for trusted users |
| `resume`         | yes      | line 1509        | `string` session UUID. **Compatible with `canUseTool`** — see correction below |
| `maxTurns`       | yes      | line 1386        | `number` |
| `mcpServers`     | yes      | line 1416        | `Record<string, McpServerConfig>` (named map, not array) |
| `cwd`            | yes      | line 1183        | per-chat workspace dir |
| `model`          | yes      | line 1421        | `string` model id |
| `systemPrompt`   | yes      | line 1695        | `string \| string[] \| { ... }` — richer than expected |
| `hooks`          | yes      | line 1279        | `Partial<Record<HookEvent, HookCallbackMatcher[]>>` |
| `allowedTools`   | yes (bonus) | line 1169     | tool name allowlist; pairs with `canUseTool` |
| `disallowedTools`| yes (bonus) | line 1189     | tool name denylist |
| `env`            | yes (bonus) | line 1212     | env-var overrides for spawned tools |

## Call-outs

- **`resume` and `canUseTool` are NOT mutually exclusive.** An earlier read of `sdk.d.ts` misattributed the "Mutually exclusive with `resume`" JSDoc — that comment belongs to **`continue?: boolean`** (line 1179), not `canUseTool` (line 1174). JSDoc precedes the field it documents; `canUseTool` has its own JSDoc at lines 1170–1173 ("Custom permission handler..."). `agent.ts::runAgent` uses `resume` + `canUseTool` directly with no fork plumbing.
- **`forkSession` shortcut** — there's an inline `forkSession?: boolean` option at line 1258 ("When true, resumed sessions will fork to a new session ID rather than continuing the previous session. Use with `resume`."). Simpler than the standalone `forkSession()` function. Not used today — single-session-per-chat is enough; revisit if audit-trace per turn becomes valuable.
- **`PermissionMode` includes `'auto'` and `'dontAsk'`** — treat `'default'` as the safe baseline. `'auto'` may be the right pick for the auto-allow tier in `policy.ts`.
- **`mcpServers` is a `Record`, not an array** — configs are keyed by name.
- **`systemPrompt` accepts an array** — useful for layering base persona + per-chat overrides without string concat.
- **Bonus knobs (`allowedTools`, `disallowedTools`, `env`)** — let `policy.ts` pre-filter cheaply before `canUseTool` runs.

## How to refresh

```sh
bun scripts/sdk-probe.ts > docs/SDK_NOTES.md
```

Re-run after any `pnpm add @anthropic-ai/claude-agent-sdk@<new>` bump. The probe captures runtime exports; cross-check the table above against `sdk.d.ts` line numbers when bumping versions.
