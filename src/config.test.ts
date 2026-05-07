/**
 * @fileoverview Unit tests for `loadConfig` validation paths.
 * @proves Required-vars enforcement, OLLAMA_URL scheme guard, and the
 *         OLLAMA_ENABLED → OLLAMA_MODEL contract all fail loud at boot.
 *
 * `config.ts` is the boot-time gatekeeper. A bad env value here should
 * surface as an actionable startup error, not a confusing runtime failure
 * thirty seconds in. The OLLAMA_URL guard in particular was added in
 * response to the Round-2 review: pre-fix, `OLLAMA_URL=localhost:11434`
 * (missing scheme) booted happily and only failed at the first `>` turn
 * with "ollama unreachable: localhost:11434".
 *
 * Scenarios covered:
 *
 *   required vars:
 *     - Missing required vars throw with the FULL list, not just the first.
 *
 *   OLLAMA_URL:
 *     - Default (unset) returns http://localhost:11434.
 *     - Trailing slash stripped.
 *     - Missing scheme throws (e.g. "localhost:11434" parses as scheme
 *       "localhost:" which is not http/https).
 *     - ftp:// scheme throws.
 *     - Garbage non-URL throws with "not a valid URL".
 *     - https:// passes.
 *
 *   OLLAMA_ENABLED:
 *     - true requires OLLAMA_MODEL, throws when unset.
 *     - false ignores OLLAMA_MODEL.
 *
 * Not covered (intentional):
 *   - Every numeric env coercion (parsePositiveNumber/Int internals — covered
 *     informally by the existing flood smoke and live boots).
 *
 * Cross-references:
 *   - config.ts — implementation
 *   - docs/CONFIG.md — env reference
 */

import { describe, expect, test } from "bun:test";
import { loadConfig } from "./config.ts";

const baseEnv: NodeJS.ProcessEnv = {
  ANTHROPIC_API_KEY: "sk-ant-test",
  TELEGRAM_BOT_TOKEN: "fake-tg-token",
  ALLOWLIST_BOOTSTRAP: "100",
};

describe("loadConfig — required vars", () => {
  test("missing required vars throws with the full list", () => {
    expect(() => loadConfig({})).toThrow(
      /Missing required env vars: ANTHROPIC_API_KEY, TELEGRAM_BOT_TOKEN, ALLOWLIST_BOOTSTRAP/,
    );
  });

  test("blank required vars count as missing", () => {
    expect(() =>
      loadConfig({ ANTHROPIC_API_KEY: "  ", TELEGRAM_BOT_TOKEN: "x", ALLOWLIST_BOOTSTRAP: "1" }),
    ).toThrow(/Missing required env vars: ANTHROPIC_API_KEY/);
  });
});

describe("loadConfig — OLLAMA_URL", () => {
  test("default is http://localhost:11434", () => {
    const cfg = loadConfig({ ...baseEnv });
    expect(cfg.ollamaUrl).toBe("http://localhost:11434");
  });

  test("strips a trailing slash", () => {
    const cfg = loadConfig({ ...baseEnv, OLLAMA_URL: "http://example.com:8080/" });
    expect(cfg.ollamaUrl).toBe("http://example.com:8080");
  });

  test("https:// is accepted", () => {
    const cfg = loadConfig({ ...baseEnv, OLLAMA_URL: "https://ollama.example.com" });
    expect(cfg.ollamaUrl).toBe("https://ollama.example.com");
  });

  test("missing scheme (host:port) throws", () => {
    // "localhost:11434" parses as a URL with scheme "localhost:" — not http/https.
    expect(() => loadConfig({ ...baseEnv, OLLAMA_URL: "localhost:11434" })).toThrow(
      /OLLAMA_URL must use http:\/\/ or https:\/\//,
    );
  });

  test("ftp:// scheme throws", () => {
    expect(() => loadConfig({ ...baseEnv, OLLAMA_URL: "ftp://nope" })).toThrow(
      /OLLAMA_URL must use http:\/\/ or https:\/\//,
    );
  });

  test("malformed URL throws with 'not a valid URL'", () => {
    expect(() => loadConfig({ ...baseEnv, OLLAMA_URL: "::::not a url::::" })).toThrow(
      /OLLAMA_URL is not a valid URL/,
    );
  });
});

describe("loadConfig — OLLAMA_ENABLED contract", () => {
  test("OLLAMA_ENABLED=true requires OLLAMA_MODEL", () => {
    expect(() => loadConfig({ ...baseEnv, OLLAMA_ENABLED: "true" })).toThrow(
      /OLLAMA_MODEL is required when OLLAMA_ENABLED=true/,
    );
  });

  test("OLLAMA_ENABLED=false ignores OLLAMA_MODEL absence", () => {
    const cfg = loadConfig({ ...baseEnv, OLLAMA_ENABLED: "false" });
    expect(cfg.ollamaEnabled).toBe(false);
    expect(cfg.ollamaModel).toBeNull();
  });

  test("OLLAMA_ENABLED=true with OLLAMA_MODEL set passes", () => {
    const cfg = loadConfig({
      ...baseEnv,
      OLLAMA_ENABLED: "true",
      OLLAMA_MODEL: "llama3.2",
    });
    expect(cfg.ollamaEnabled).toBe(true);
    expect(cfg.ollamaModel).toBe("llama3.2");
  });
});

describe("loadConfig — skills", () => {
  test("default: skillsEnabled=false, skillsDir=./skills", () => {
    const cfg = loadConfig({ ...baseEnv });
    expect(cfg.skillsEnabled).toBe(false);
    expect(cfg.skillsDir).toBe("./skills");
  });

  test("SOLRAC_SKILLS_ENABLED=true is parsed", () => {
    const cfg = loadConfig({ ...baseEnv, SOLRAC_SKILLS_ENABLED: "true" });
    expect(cfg.skillsEnabled).toBe(true);
  });

  test("SOLRAC_SKILLS_DIR overrides default", () => {
    const cfg = loadConfig({ ...baseEnv, SOLRAC_SKILLS_DIR: "/var/solrac/skills" });
    expect(cfg.skillsDir).toBe("/var/solrac/skills");
  });

  test("SOLRAC_SKILLS_DIR blank falls back to ./skills", () => {
    const cfg = loadConfig({ ...baseEnv, SOLRAC_SKILLS_DIR: "  " });
    expect(cfg.skillsDir).toBe("./skills");
  });
});
