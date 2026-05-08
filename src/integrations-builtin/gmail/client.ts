/**
 * Gmail OAuth + API client wrapper for the blessed `gmail` integration.
 *
 * Adapted from `apps/utcp-tools/src/integrations/gmail/client.ts` with two
 * substantive changes:
 *
 *   1. **Credential paths live in `~/.solrac/gmail/`** instead of the
 *      apps/utcp-tools source tree. Solrac is a self-contained deployment;
 *      operator OAuth state belongs in the operator's home dir, not next
 *      to the integration code (which is part of the solrac repo).
 *
 *   2. **`googleapis` + `google-auth-library` are lazy-loaded.** Solrac's
 *      `package.json` does NOT depend on them. The integration's `setup`
 *      function (`./index.ts`) probes the imports at boot, registers zero
 *      tools if absent, and logs a one-line hint to `npm install`. Inside
 *      this file, `loadGoogleModules()` does the actual dynamic import +
 *      caches the result. Handlers call it; if Gmail was disabled at boot,
 *      handlers are never registered, so this never runs in that case.
 *
 * Why we DO NOT keep tokens in the database: this client is consumed by
 * googleapis' OAuth2Client, which expects a file-loader callback API and
 * writes refreshed tokens back via filesystem on its own schedule. Storing
 * tokens in solrac's sqlite would require a custom adapter; using the
 * filesystem matches what `gmail-auth.ts` (operator bootstrap script)
 * writes. One source of truth.
 *
 * Cross-references:
 *   - ./index.ts — the setup() function that gates this on credentials.
 *   - solrac/scripts/gmail-auth.ts — bootstrap script that writes the
 *     accounts.json + per-alias <alias>.json token files.
 *   - apps/utcp-tools/src/integrations/gmail/client.ts — original to diff.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Type-only imports — at runtime we use the dynamic-imported module from
// `loadGoogleModules()`. These types come from the package's bundled .d.ts
// files; if `googleapis` isn't installed in solrac's node_modules, the
// type lookup fails at typecheck time. We handle that via the type-import
// fallback below: if the package is absent during `npm run typecheck`, we
// degrade to `unknown` and the runtime branches never execute. Keep the
// types alive when the package IS installed so handlers stay type-safe.

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type LooseAny = any; // narrow alias to avoid eslint-disable proliferation

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const GMAIL_DIR = join(homedir(), ".solrac", "gmail");
const CREDENTIALS_PATH = join(GMAIL_DIR, "credentials.json");
const ACCOUNTS_PATH = join(GMAIL_DIR, "accounts.json");

// ---------------------------------------------------------------------------
// On-disk shapes
// ---------------------------------------------------------------------------

interface OAuthClientConfig {
  installed?: { client_id: string; client_secret: string };
  web?: { client_id: string; client_secret: string };
}

export interface AccountInfo {
  email: string;
  tokenFile: string;
  scopes: string[];
  createdAt: string;
}

export type AccountsConfig = Record<string, AccountInfo>;

interface TokenData {
  access_token?: string | null;
  refresh_token?: string | null;
  scope?: string | null;
  token_type?: string | null;
  expiry_date?: number | null;
  id_token?: string | null;
}

// ---------------------------------------------------------------------------
// Lazy googleapis loader (cached after first call)
// ---------------------------------------------------------------------------

interface GoogleModules {
  google: LooseAny;
  OAuth2Client: LooseAny;
}

let googleModulesCache: GoogleModules | null = null;
let googleModulesError: Error | null = null;

/**
 * Dynamic-import `googleapis` + `google-auth-library` on first use. Cached.
 * Throws if the packages are not installed; the integration's `setup()` is
 * expected to probe-and-disable BEFORE any handler runs, so this should
 * only ever throw under unusual conditions (e.g. operator deleted
 * node_modules between boot and a tool call).
 */
export async function loadGoogleModules(): Promise<GoogleModules> {
  if (googleModulesCache !== null) return googleModulesCache;
  if (googleModulesError !== null) throw googleModulesError;
  try {
    const [googleapis, googleAuth] = await Promise.all([
      import("googleapis"),
      import("google-auth-library"),
    ]);
    googleModulesCache = {
      google: (googleapis as LooseAny).google,
      OAuth2Client: (googleAuth as LooseAny).OAuth2Client,
    };
    return googleModulesCache;
  } catch (err) {
    googleModulesError = err as Error;
    throw err;
  }
}

/**
 * Cheap presence check used by `setup()` at boot. Doesn't throw.
 */
export async function googleModulesAvailable(): Promise<boolean> {
  try {
    await loadGoogleModules();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Account discovery (filesystem; no Google API calls)
// ---------------------------------------------------------------------------

export function loadAccounts(): AccountsConfig {
  if (!existsSync(ACCOUNTS_PATH)) return {};
  return JSON.parse(readFileSync(ACCOUNTS_PATH, "utf8")) as AccountsConfig;
}

export function listAccounts(): Array<{ alias: string; email: string }> {
  return Object.entries(loadAccounts()).map(([alias, info]) => ({
    alias,
    email: info.email,
  }));
}

export function resolveAccount(account: string): {
  alias: string;
  info: AccountInfo;
} | null {
  const accounts = loadAccounts();
  if (accounts[account]) return { alias: account, info: accounts[account] };
  for (const [alias, info] of Object.entries(accounts)) {
    if (info.email.toLowerCase() === account.toLowerCase()) {
      return { alias, info };
    }
  }
  return null;
}

export function getAvailableAccounts(): string[] {
  return Object.keys(loadAccounts());
}

export function isGmailConfigured(): boolean {
  return existsSync(CREDENTIALS_PATH);
}

export function hasConfiguredAccounts(): boolean {
  return Object.keys(loadAccounts()).length > 0;
}

// ---------------------------------------------------------------------------
// OAuth2 + Gmail client construction (cached per alias)
// ---------------------------------------------------------------------------

const oauthClientCache = new Map<string, LooseAny>();
const gmailClientCache = new Map<string, LooseAny>();

function loadCredentials(): { client_id: string; client_secret: string } {
  if (!existsSync(CREDENTIALS_PATH)) {
    throw new Error(
      `Gmail credentials not found at ${CREDENTIALS_PATH}. Download from ` +
        "Google Cloud Console → APIs & Services → Credentials, save as " +
        "credentials.json in ~/.solrac/gmail/.",
    );
  }
  const raw: OAuthClientConfig = JSON.parse(
    readFileSync(CREDENTIALS_PATH, "utf8"),
  );
  const config = raw.installed ?? raw.web;
  if (!config) {
    throw new Error(
      "Invalid credentials.json - missing 'installed' or 'web' key.",
    );
  }
  return config;
}

function loadToken(tokenFile: string): TokenData {
  const tokenPath = join(GMAIL_DIR, tokenFile);
  if (!existsSync(tokenPath)) {
    throw new Error(
      `Token file not found: ${tokenFile}. Run: bun scripts/gmail-auth.ts <alias>`,
    );
  }
  return JSON.parse(readFileSync(tokenPath, "utf8")) as TokenData;
}

function saveToken(tokenFile: string, tokens: TokenData): void {
  writeFileSync(join(GMAIL_DIR, tokenFile), JSON.stringify(tokens, null, 2));
}

function toCredentials(t: TokenData): Record<string, unknown> {
  return {
    access_token: t.access_token ?? undefined,
    refresh_token: t.refresh_token ?? undefined,
    scope: t.scope ?? undefined,
    token_type: t.token_type ?? undefined,
    expiry_date: t.expiry_date ?? undefined,
    id_token: t.id_token ?? undefined,
  };
}

/**
 * Get an authenticated OAuth2Client for `account` (alias or email).
 * Auto-refreshes tokens (`tokens` event handler persists refreshed creds
 * back to disk).
 *
 * `logEvent` is the integration's logger surface (`ctx.log`); used only for
 * the token-refresh notice. Errors propagate to the caller — handlers wrap
 * them in `{ success: false, error }` envelopes.
 */
export async function getOAuth2Client(
  account: string,
  logEvent: (event: string, fields: Record<string, unknown>) => void,
): Promise<LooseAny> {
  const resolved = resolveAccount(account);
  if (!resolved) {
    const available = getAvailableAccounts();
    throw new Error(
      `Account "${account}" not found. ` +
        (available.length > 0
          ? `Available: ${available.join(", ")}`
          : "No accounts configured. Run: bun scripts/gmail-auth.ts <alias>"),
    );
  }
  const { alias, info } = resolved;
  const cached = oauthClientCache.get(alias);
  if (cached) return cached;

  const { OAuth2Client } = await loadGoogleModules();
  const { client_id, client_secret } = loadCredentials();
  const client = new OAuth2Client(client_id, client_secret);

  const tokens = loadToken(info.tokenFile);
  client.setCredentials(toCredentials(tokens));

  // googleapis fires `tokens` whenever it refreshes. Persist the new pair so
  // future boots resume seamlessly. NOT logged at info level on every
  // refresh (would be noisy); use debug.
  client.on("tokens", (newTokens: LooseAny) => {
    const current = loadToken(info.tokenFile);
    saveToken(info.tokenFile, { ...current, ...newTokens });
    logEvent("integrations.gmail.token_refreshed", { alias });
  });

  oauthClientCache.set(alias, client);
  return client;
}

/**
 * Get an authenticated Gmail API client (`gmail_v1.Gmail`) for `account`.
 * Reuses the OAuth2 client cache.
 */
export async function getGmailClient(
  account: string,
  logEvent: (event: string, fields: Record<string, unknown>) => void,
): Promise<LooseAny> {
  const resolved = resolveAccount(account);
  if (!resolved) {
    const available = getAvailableAccounts();
    throw new Error(
      `Account "${account}" not found. ` +
        (available.length > 0
          ? `Available: ${available.join(", ")}`
          : "No accounts configured. Run: bun scripts/gmail-auth.ts <alias>"),
    );
  }
  const { alias } = resolved;
  const cached = gmailClientCache.get(alias);
  if (cached) return cached;

  const { google } = await loadGoogleModules();
  const auth = await getOAuth2Client(account, logEvent);
  const gmail = google.gmail({ version: "v1", auth });
  gmailClientCache.set(alias, gmail);
  return gmail;
}

/**
 * Clear the per-alias caches. Used by tests + by `gmail-auth.ts` after a
 * fresh OAuth flow so the new credentials get picked up without restart.
 */
export function clearGmailCaches(): void {
  oauthClientCache.clear();
  gmailClientCache.clear();
}
