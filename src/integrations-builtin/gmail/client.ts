/**
 * Gmail OAuth + API client wrapper for the blessed `gmail` integration.
 *
 * Adapted from `apps/utcp-tools/src/integrations/gmail/client.ts` with two
 * substantive changes:
 *
 *   1. **Credential paths live under `$SOLRAC_HOME/integrations/gmail/`** —
 *      threaded in via `ctx.solracHome` rather than hardcoded to `homedir()`.
 *      Solrac is a self-contained deployment; operator OAuth state belongs in
 *      `$SOLRAC_HOME`, alongside the rest of solrac's on-disk state.
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
 * filesystem matches what `solrac gmail-auth` (operator bootstrap) writes.
 * One source of truth.
 *
 * Cross-references:
 *   - ./index.ts — the setup() function that resolves paths and gates this
 *     on credentials.
 *   - src/integrations-builtin/gmail/auth-cli.ts — operator OAuth bootstrap
 *     surfaced as `solrac gmail-auth <alias>`.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

/** Absolute path to the gmail integration's on-disk state, derived from
 *  `$SOLRAC_HOME/integrations/gmail/`. */
export function resolveGmailDir(solracHome: string): string {
  return join(solracHome, "integrations", "gmail");
}

export interface GmailPaths {
  readonly gmailDir: string;
  readonly credentialsPath: string;
  readonly accountsPath: string;
}

export function resolveGmailPaths(solracHome: string): GmailPaths {
  const gmailDir = resolveGmailDir(solracHome);
  return {
    gmailDir,
    credentialsPath: join(gmailDir, "credentials.json"),
    accountsPath: join(gmailDir, "accounts.json"),
  };
}

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
// Gmail client API factory
// ---------------------------------------------------------------------------

export interface GmailClientApi {
  readonly paths: GmailPaths;
  loadAccounts(): AccountsConfig;
  listAccounts(): Array<{ alias: string; email: string }>;
  resolveAccount(account: string): { alias: string; info: AccountInfo } | null;
  getAvailableAccounts(): string[];
  isGmailConfigured(): boolean;
  hasConfiguredAccounts(): boolean;
  getOAuth2Client(
    account: string,
    logEvent: (event: string, fields: Record<string, unknown>) => void,
  ): Promise<LooseAny>;
  getGmailClient(
    account: string,
    logEvent: (event: string, fields: Record<string, unknown>) => void,
  ): Promise<LooseAny>;
  clearCaches(): void;
}

export function createGmailClientApi(solracHome: string): GmailClientApi {
  const paths = resolveGmailPaths(solracHome);
  const oauthClientCache = new Map<string, LooseAny>();
  const gmailClientCache = new Map<string, LooseAny>();

  function loadAccounts(): AccountsConfig {
    if (!existsSync(paths.accountsPath)) return {};
    return JSON.parse(readFileSync(paths.accountsPath, "utf8")) as AccountsConfig;
  }

  function listAccounts(): Array<{ alias: string; email: string }> {
    return Object.entries(loadAccounts()).map(([alias, info]) => ({
      alias,
      email: info.email,
    }));
  }

  function resolveAccount(
    account: string,
  ): { alias: string; info: AccountInfo } | null {
    const accounts = loadAccounts();
    if (accounts[account]) return { alias: account, info: accounts[account] };
    for (const [alias, info] of Object.entries(accounts)) {
      if (info.email.toLowerCase() === account.toLowerCase()) {
        return { alias, info };
      }
    }
    return null;
  }

  function getAvailableAccounts(): string[] {
    return Object.keys(loadAccounts());
  }

  function isGmailConfigured(): boolean {
    return existsSync(paths.credentialsPath);
  }

  function hasConfiguredAccounts(): boolean {
    return Object.keys(loadAccounts()).length > 0;
  }

  function loadCredentials(): { client_id: string; client_secret: string } {
    if (!existsSync(paths.credentialsPath)) {
      throw new Error(
        `Gmail credentials not found at ${paths.credentialsPath}. Download from ` +
          "Google Cloud Console → APIs & Services → Credentials, save as " +
          `credentials.json in ${paths.gmailDir}.`,
      );
    }
    const raw: OAuthClientConfig = JSON.parse(
      readFileSync(paths.credentialsPath, "utf8"),
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
    const tokenPath = join(paths.gmailDir, tokenFile);
    if (!existsSync(tokenPath)) {
      throw new Error(
        `Token file not found: ${tokenFile}. Run: solrac gmail-auth <alias>`,
      );
    }
    return JSON.parse(readFileSync(tokenPath, "utf8")) as TokenData;
  }

  function saveToken(tokenFile: string, tokens: TokenData): void {
    writeFileSync(
      join(paths.gmailDir, tokenFile),
      JSON.stringify(tokens, null, 2),
    );
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

  async function getOAuth2Client(
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
            : "No accounts configured. Run: solrac gmail-auth <alias>"),
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
    // future boots resume seamlessly.
    client.on("tokens", (newTokens: LooseAny) => {
      const current = loadToken(info.tokenFile);
      saveToken(info.tokenFile, { ...current, ...newTokens });
      logEvent("integrations.gmail.token_refreshed", { alias });
    });

    oauthClientCache.set(alias, client);
    return client;
  }

  async function getGmailClient(
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
            : "No accounts configured. Run: solrac gmail-auth <alias>"),
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

  function clearCaches(): void {
    oauthClientCache.clear();
    gmailClientCache.clear();
  }

  return {
    paths,
    loadAccounts,
    listAccounts,
    resolveAccount,
    getAvailableAccounts,
    isGmailConfigured,
    hasConfiguredAccounts,
    getOAuth2Client,
    getGmailClient,
    clearCaches,
  };
}
