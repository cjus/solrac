#!/usr/bin/env bun
/**
 * @fileoverview Gmail OAuth bootstrap CLI for the blessed Gmail integration.
 * @purpose One-time interactive auth: opens a browser for Google's OAuth
 *          consent screen, captures the redirect, exchanges the code for
 *          tokens, and writes them to `~/.solrac/gmail/<alias>.json` plus
 *          `~/.solrac/gmail/accounts.json`.
 *
 * Run once per Gmail account the operator wants the agent to access:
 *
 *   bun scripts/gmail-auth.ts personal
 *   bun scripts/gmail-auth.ts work
 *
 * Prerequisite: download an OAuth client credentials.json from
 * Google Cloud Console (APIs & Services → Credentials) and save it to
 * `~/.solrac/gmail/credentials.json` first. The redirect URI in your
 * OAuth client config should include `http://localhost` (the script
 * binds a random ephemeral port at runtime; Google accepts loopback
 * with any port).
 *
 * Adapted from `apps/utcp-tools/scripts/gmail-auth.ts` with two changes:
 *
 *   1. **Paths in `~/.solrac/gmail/`** instead of relative-to-script.
 *      Solrac is a self-contained deployment; OAuth state belongs in
 *      the operator's home dir, not next to the source.
 *
 *   2. **Bun shebang.** Solrac runs on Bun (no `tsx`); the operator
 *      invokes via `bun scripts/gmail-auth.ts <alias>` rather than
 *      `pnpm gmail:auth`.
 *
 * Cross-references:
 *   - src/integrations-builtin/gmail/client.ts — reads what this writes.
 *   - docs/USAGE.md#integrations — operator-facing setup walkthrough.
 */

import { OAuth2Client } from "google-auth-library";
import { google } from "googleapis";
import { exec } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

const GMAIL_DIR = join(homedir(), ".solrac", "gmail");
const CREDENTIALS_PATH = join(GMAIL_DIR, "credentials.json");
const ACCOUNTS_PATH = join(GMAIL_DIR, "accounts.json");

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/userinfo.email",
];

interface CredentialsFile {
  installed?: { client_id: string; client_secret: string };
  web?: { client_id: string; client_secret: string };
}

interface AccountInfo {
  email: string;
  tokenFile: string;
  scopes: string[];
  createdAt: string;
}

type AccountsConfig = Record<string, AccountInfo>;

async function main(): Promise<void> {
  const alias = process.argv[2];
  if (!alias) {
    console.error("Usage: bun scripts/gmail-auth.ts <alias>");
    console.error('Example: bun scripts/gmail-auth.ts personal');
    process.exit(1);
  }
  if (!/^[a-z0-9_-]+$/i.test(alias)) {
    console.error(
      "Error: alias must be alphanumeric with dashes/underscores only.",
    );
    process.exit(1);
  }

  if (!existsSync(GMAIL_DIR)) {
    mkdirSync(GMAIL_DIR, { recursive: true });
  }
  if (!existsSync(CREDENTIALS_PATH)) {
    console.error(`Error: ${CREDENTIALS_PATH} not found.`);
    console.error(
      "Download from Google Cloud Console → APIs & Services → Credentials, " +
        "and save the JSON file as ~/.solrac/gmail/credentials.json.",
    );
    process.exit(1);
  }

  const credentials: CredentialsFile = JSON.parse(
    readFileSync(CREDENTIALS_PATH, "utf8"),
  );
  const config = credentials.installed ?? credentials.web;
  if (!config) {
    console.error(
      "Error: invalid credentials.json — missing 'installed' or 'web' key.",
    );
    process.exit(1);
  }
  const { client_id, client_secret } = config;

  // Bind a random port in 3457-3556. Google accepts any localhost port
  // for OAuth callbacks even if not pre-registered.
  const port = 3457 + Math.floor(Math.random() * 100);
  const redirectUri = `http://localhost:${port}/callback`;
  const oauth2Client = new OAuth2Client(client_id, client_secret, redirectUri);

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent", // force consent so we always get a refresh_token
  });

  console.log(`\nAuthenticating account: ${alias}`);
  console.log("Opening browser for Google sign-in...");

  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      if (!req.url?.startsWith("/callback")) {
        res.writeHead(404).end();
        return;
      }
      const url = new URL(req.url, `http://localhost:${port}`);
      const errorParam = url.searchParams.get("error");
      const codeParam = url.searchParams.get("code");

      if (errorParam) {
        res.writeHead(400, { "Content-Type": "text/html" }).end(
          `<h1>Authentication failed</h1><p>${errorParam}</p>`,
        );
        server.close();
        reject(new Error(errorParam));
        return;
      }
      if (codeParam) {
        res.writeHead(200, { "Content-Type": "text/html" }).end(
          `<h1>Authentication successful</h1>` +
            `<p>You can close this window and return to the terminal.</p>` +
            `<script>window.close()</script>`,
        );
        server.close();
        resolve(codeParam);
      }
    });

    server.listen(port, () => {
      // macOS `open` opens default browser. Linux operators may need to
      // copy-paste the URL — print it as a fallback.
      exec(`open "${authUrl}"`, (err) => {
        if (err) {
          console.log(`Open this URL in your browser:\n${authUrl}\n`);
        }
      });
    });

    // 5-minute timeout — give the operator time to consent without leaving
    // the script hanging forever if they walk away.
    setTimeout(
      () => {
        server.close();
        reject(new Error("Authentication timed out after 5 minutes."));
      },
      5 * 60 * 1000,
    );
  });

  console.log("Exchanging authorization code for tokens...");
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  // Pull the email address so accounts.json carries human-readable info.
  const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
  const userInfo = await oauth2.userinfo.get();
  const email = userInfo.data.email;
  if (!email) {
    console.error("Error: could not retrieve email address from Google.");
    process.exit(1);
  }

  const tokenFile = `${alias}.json`;
  writeFileSync(join(GMAIL_DIR, tokenFile), JSON.stringify(tokens, null, 2));
  console.log(`Token saved to: ~/.solrac/gmail/${tokenFile}`);

  let accounts: AccountsConfig = {};
  if (existsSync(ACCOUNTS_PATH)) {
    accounts = JSON.parse(readFileSync(ACCOUNTS_PATH, "utf8")) as AccountsConfig;
  }
  accounts[alias] = {
    email,
    tokenFile,
    scopes: SCOPES.filter((s) => !s.includes("userinfo")),
    createdAt: new Date().toISOString(),
  };
  writeFileSync(ACCOUNTS_PATH, JSON.stringify(accounts, null, 2));
  console.log(`Account registered: ${alias} → ${email}`);

  console.log(`\n✓ Authentication complete.`);
  console.log(
    `\nRestart solrac to load the new account. Then via the agent:\n` +
      `  "search my ${alias} Gmail for unread emails"\n`,
  );
}

main().catch((err: unknown) => {
  console.error("Authentication failed:", (err as Error).message);
  process.exit(1);
});
