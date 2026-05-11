/**
 * @fileoverview Gmail OAuth bootstrap, surfaced as `solrac gmail-auth <alias>`.
 * @purpose One-time interactive OAuth per Gmail account the agent can access.
 *          Opens a browser for Google consent, captures the redirect on a
 *          loopback server, exchanges the code for tokens, and writes them
 *          to `$SOLRAC_HOME/integrations/gmail/<alias>.json` plus an entry
 *          in `accounts.json`.
 *
 * Why this lives in `src/` (not `scripts/`): the curl-pipe binary install
 * ships `solrac` only — no `bun`, no source tree. Putting the bootstrap
 * behind a subcommand lets it run from the same binary the operator
 * already has.
 *
 * Cross-references:
 *   - ./client.ts — reads what this writes.
 *   - src/main.ts — `argv[2] === "gmail-auth"` dispatch arm.
 *   - docs/USAGE.md#integrations — operator-facing setup walkthrough.
 */

import { exec } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { resolveSolracHome } from "../../config.ts";
import { resolveGmailPaths, type AccountsConfig } from "./client.ts";

type LooseAny = any; // eslint-disable-line @typescript-eslint/no-explicit-any

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

function printUsage(): void {
  console.error("Usage: solrac gmail-auth <alias>");
  console.error("Example: solrac gmail-auth personal");
}

function printMissingCredentials(credentialsPath: string): void {
  console.error(`Error: credentials.json not found at ${credentialsPath}\n`);
  console.error("To create one:");
  console.error(
    "  1. Enable the Gmail API:",
    "https://console.cloud.google.com/apis/library/gmail.googleapis.com",
  );
  console.error(
    "  2. Create an OAuth client:",
    "https://console.cloud.google.com/apis/credentials",
  );
  console.error(
    "     → Create Credentials → OAuth client ID → Desktop app",
  );
  console.error(`  3. Download the JSON and save it to the path above.`);
}

/**
 * Run the gmail-auth bootstrap. Returns the exit code; the dispatcher in
 * `main.ts` calls `process.exit(code)` so this function stays testable.
 */
export async function runGmailAuth(argv: string[]): Promise<number> {
  const alias = argv[0];
  if (!alias) {
    printUsage();
    return 1;
  }
  if (!/^[a-z0-9_-]+$/i.test(alias)) {
    console.error(
      "Error: alias must be alphanumeric with dashes/underscores only.",
    );
    return 1;
  }

  const solracHome = resolveSolracHome(process.env.SOLRAC_HOME);
  const paths = resolveGmailPaths(solracHome);

  console.log(`solrac home: ${solracHome}`);
  console.log(`gmail dir:   ${paths.gmailDir}\n`);

  if (!existsSync(paths.gmailDir)) {
    mkdirSync(paths.gmailDir, { recursive: true });
  }
  if (!existsSync(paths.credentialsPath)) {
    printMissingCredentials(paths.credentialsPath);
    return 1;
  }

  const credentials: CredentialsFile = JSON.parse(
    readFileSync(paths.credentialsPath, "utf8"),
  );
  const config = credentials.installed ?? credentials.web;
  if (!config) {
    console.error(
      "Error: invalid credentials.json — missing 'installed' or 'web' key.",
    );
    return 1;
  }
  const { client_id, client_secret } = config;

  // googleapis / google-auth-library are optional deps; the gmail integration
  // self-gates on their presence at boot. Lazy-load here so the bootstrap
  // fails loud with an actionable hint instead of an import error.
  let OAuth2Client: LooseAny;
  let google: LooseAny;
  try {
    const [authLib, googleApis] = await Promise.all([
      import("google-auth-library"),
      import("googleapis"),
    ]);
    OAuth2Client = (authLib as LooseAny).OAuth2Client;
    google = (googleApis as LooseAny).google;
  } catch (err) {
    console.error(
      "Error: googleapis + google-auth-library are not installed.\n",
    );
    console.error(
      "Run: npm install googleapis google-auth-library\n",
    );
    console.error(`(import error: ${(err as Error).message})`);
    return 1;
  }

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

  console.log(`Authenticating account: ${alias}`);
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
      // macOS `open` opens the default browser. Linux operators may need to
      // copy-paste the URL — print it as a fallback.
      exec(`open "${authUrl}"`, (err) => {
        if (err) {
          console.log(`Open this URL in your browser:\n${authUrl}\n`);
        }
      });
    });

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

  const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
  const userInfo = await oauth2.userinfo.get();
  const email = userInfo.data.email;
  if (!email) {
    console.error("Error: could not retrieve email address from Google.");
    return 1;
  }

  const tokenFile = `${alias}.json`;
  const tokenPath = join(paths.gmailDir, tokenFile);
  writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
  console.log(`Token saved to: ${tokenPath}`);

  let accounts: AccountsConfig = {};
  if (existsSync(paths.accountsPath)) {
    accounts = JSON.parse(
      readFileSync(paths.accountsPath, "utf8"),
    ) as AccountsConfig;
  }
  accounts[alias] = {
    email,
    tokenFile,
    scopes: SCOPES.filter((s) => !s.includes("userinfo")),
    createdAt: new Date().toISOString(),
  };
  writeFileSync(paths.accountsPath, JSON.stringify(accounts, null, 2));
  console.log(`Account registered: ${alias} → ${email}`);

  console.log(`\n✓ Authentication complete.`);
  console.log(
    `\nRestart solrac to load the new account. Then via the agent:\n` +
      `  "search my ${alias} Gmail for unread emails"\n`,
  );
  return 0;
}
