/**
 * @fileoverview Path-resolution tests for the gmail client factory.
 * @purpose PNX-171 — verify the gmail integration honors a non-default
 *          SOLRAC_HOME instead of the legacy hardcoded `~/.solrac/gmail`.
 *
 * Scope: filesystem reads only (loadAccounts, isGmailConfigured,
 * hasConfiguredAccounts, resolveAccount). The OAuth + Gmail API paths
 * (getOAuth2Client / getGmailClient) depend on optional `googleapis` +
 * `google-auth-library` deps and live Google endpoints — those are
 * covered by the smoke harness, not this unit test.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGmailClientApi,
  resolveGmailDir,
  resolveGmailPaths,
} from "./client.ts";

let testHome: string;

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "solrac-gmail-test-"));
});

afterEach(() => {
  rmSync(testHome, { recursive: true, force: true });
});

describe("resolveGmailDir / resolveGmailPaths", () => {
  test("roots under <solracHome>/integrations/gmail/", () => {
    expect(resolveGmailDir("/var/solrac")).toBe(
      "/var/solrac/integrations/gmail",
    );
  });

  test("paths object exposes credentials + accounts files", () => {
    const paths = resolveGmailPaths("/var/solrac");
    expect(paths.gmailDir).toBe("/var/solrac/integrations/gmail");
    expect(paths.credentialsPath).toBe(
      "/var/solrac/integrations/gmail/credentials.json",
    );
    expect(paths.accountsPath).toBe(
      "/var/solrac/integrations/gmail/accounts.json",
    );
  });
});

describe("createGmailClientApi with non-default SOLRAC_HOME", () => {
  test("isGmailConfigured() is false when credentials.json is absent", () => {
    const api = createGmailClientApi(testHome);
    expect(api.isGmailConfigured()).toBe(false);
  });

  test("isGmailConfigured() is true after credentials.json lands under integrations/gmail/", () => {
    const gmailDir = join(testHome, "integrations", "gmail");
    mkdirSync(gmailDir, { recursive: true });
    writeFileSync(
      join(gmailDir, "credentials.json"),
      JSON.stringify({ installed: { client_id: "x", client_secret: "y" } }),
    );
    const api = createGmailClientApi(testHome);
    expect(api.isGmailConfigured()).toBe(true);
    expect(api.paths.credentialsPath).toBe(
      join(testHome, "integrations", "gmail", "credentials.json"),
    );
  });

  test("hasConfiguredAccounts() is false when accounts.json is absent", () => {
    const api = createGmailClientApi(testHome);
    expect(api.hasConfiguredAccounts()).toBe(false);
    expect(api.loadAccounts()).toEqual({});
    expect(api.getAvailableAccounts()).toEqual([]);
  });

  test("loadAccounts() reads accounts.json from the non-default home", () => {
    const gmailDir = join(testHome, "integrations", "gmail");
    mkdirSync(gmailDir, { recursive: true });
    writeFileSync(
      join(gmailDir, "accounts.json"),
      JSON.stringify({
        ieee: {
          email: "carlos.ieee@gmail.com",
          tokenFile: "ieee.json",
          scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
          createdAt: "2026-05-11T00:00:00.000Z",
        },
      }),
    );
    const api = createGmailClientApi(testHome);
    expect(api.hasConfiguredAccounts()).toBe(true);
    expect(api.getAvailableAccounts()).toEqual(["ieee"]);
    expect(api.listAccounts()).toEqual([
      { alias: "ieee", email: "carlos.ieee@gmail.com" },
    ]);
  });

  test("resolveAccount() matches by alias and by email (case-insensitive)", () => {
    const gmailDir = join(testHome, "integrations", "gmail");
    mkdirSync(gmailDir, { recursive: true });
    writeFileSync(
      join(gmailDir, "accounts.json"),
      JSON.stringify({
        work: {
          email: "Carlos@Example.com",
          tokenFile: "work.json",
          scopes: [],
          createdAt: "2026-05-11T00:00:00.000Z",
        },
      }),
    );
    const api = createGmailClientApi(testHome);

    const byAlias = api.resolveAccount("work");
    expect(byAlias?.alias).toBe("work");

    const byEmail = api.resolveAccount("carlos@example.com");
    expect(byEmail?.alias).toBe("work");

    expect(api.resolveAccount("nope")).toBeNull();
  });

  test("two different SOLRAC_HOME values produce isolated state", () => {
    const otherHome = mkdtempSync(join(tmpdir(), "solrac-gmail-test-other-"));
    try {
      const gmailDir = join(testHome, "integrations", "gmail");
      mkdirSync(gmailDir, { recursive: true });
      writeFileSync(
        join(gmailDir, "accounts.json"),
        JSON.stringify({
          a: { email: "a@x.com", tokenFile: "a.json", scopes: [], createdAt: "" },
        }),
      );

      const apiA = createGmailClientApi(testHome);
      const apiB = createGmailClientApi(otherHome);

      expect(apiA.getAvailableAccounts()).toEqual(["a"]);
      expect(apiB.getAvailableAccounts()).toEqual([]);
    } finally {
      rmSync(otherHome, { recursive: true, force: true });
    }
  });
});
