/**
 * Linear SDK client singleton + helpers.
 *
 * Lazy-loaded by `index.ts::setup` via dynamic import — solrac itself does
 * not depend on `@linear/sdk`. The integration directory needs its own
 * `node_modules` (`npm install` from inside `examples/integrations/linear/`
 * after copying it to your `$SOLRAC_INTEGRATIONS_DIR`).
 *
 * `getLinearClient(env)` reads `LINEAR_API_KEY` from solrac's env (passed
 * through via `ctx.env`). Throws a friendly error if absent — the handler
 * surface catches and returns `{ success: false, error }` so the model
 * gets a clear message instead of an unhandled exception.
 */

import type { LinearClient as LinearClientType } from "@linear/sdk";

let client: LinearClientType | null = null;

export async function getLinearClient(
  env: Readonly<Record<string, string | undefined>>,
): Promise<LinearClientType> {
  const apiKey = env.LINEAR_API_KEY;
  if (!apiKey || apiKey.trim() === "") {
    throw new Error(
      "LINEAR_API_KEY environment variable is required. " +
        "Get your API key from Linear Settings → API → Personal API keys",
    );
  }
  if (!client) {
    // Dynamic import keeps `@linear/sdk` out of solrac's import graph; only
    // loaded when the integration's first tool runs. Safe to cache the
    // resolved module — Bun caches dynamic imports just like static ones.
    const { LinearClient } = await import("@linear/sdk");
    client = new LinearClient({ apiKey });
  }
  return client;
}

/**
 * Resolve a Linear identifier (e.g. `"ENG-123"`) or UUID to an Issue.
 * Mirrors utcp-tools' helper. Throws on bad format or not-found.
 */
export async function findIssueByIdentifier(
  c: LinearClientType,
  identifier: string,
): Promise<Awaited<ReturnType<LinearClientType["issue"]>>> {
  if (identifier.length > 20 && /^[0-9a-f-]+$/i.test(identifier)) {
    return await c.issue(identifier);
  }
  const match = identifier.toUpperCase().match(/^([A-Z]+)-(\d+)$/);
  if (!match) {
    throw new Error(
      `Invalid issue identifier: ${identifier}. Expected format like "ENG-123" or a UUID.`,
    );
  }
  const [, teamKey, numberStr] = match;
  const issueNumber = parseInt(numberStr!, 10);
  const issues = await c.issues({
    filter: { team: { key: { eq: teamKey } }, number: { eq: issueNumber } },
    first: 1,
  });
  if (issues.nodes.length === 0) {
    throw new Error(`Issue not found: ${identifier}`);
  }
  return issues.nodes[0]!;
}
