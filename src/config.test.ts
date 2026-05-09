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

// Pin `SOLRAC_DEFAULT_ENGINE=primary` for the shared base so tests not
// specifically about the inversion don't have to also configure Ollama.
// The new default since PR-B is `ollama`, which requires `OLLAMA_ENABLED=true`
// — covered by the dedicated default-engine test block below.
const baseEnv: NodeJS.ProcessEnv = {
  ANTHROPIC_API_KEY: "sk-ant-test",
  TELEGRAM_BOT_TOKEN: "fake-tg-token",
  ALLOWLIST_BOOTSTRAP: "100",
  SOLRAC_DEFAULT_ENGINE: "primary",
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

describe("loadConfig — OLLAMA_TOOLS_ENABLED contract", () => {
  // Tools-on requires Ollama to be the default engine since PR-B; bake that
  // into a local helper so each test stays focused on the tool-flag contract.
  const toolsOnEnv: NodeJS.ProcessEnv = {
    ...baseEnv,
    SOLRAC_DEFAULT_ENGINE: "ollama",
    OLLAMA_ENABLED: "true",
    OLLAMA_MODEL: "gemma4:e4b",
  };

  test("default: tools off, max iterations 8, timeout 60s", () => {
    const cfg = loadConfig({ ...baseEnv });
    expect(cfg.ollamaToolsEnabled).toBe(false);
    expect(cfg.ollamaMaxToolIterations).toBe(8);
    expect(cfg.ollamaTimeoutMs).toBe(60_000);
  });

  test("tools on without integrations throws actionable error", () => {
    expect(() =>
      loadConfig({
        ...toolsOnEnv,
        OLLAMA_TOOLS_ENABLED: "true",
      }),
    ).toThrow(/SOLRAC_INTEGRATIONS_ENABLED=true/);
  });

  test("tools on + integrations on passes; bumps default timeout to 120s", () => {
    const cfg = loadConfig({
      ...toolsOnEnv,
      OLLAMA_TOOLS_ENABLED: "true",
      SOLRAC_INTEGRATIONS_ENABLED: "true",
    });
    expect(cfg.ollamaToolsEnabled).toBe(true);
    expect(cfg.integrationsEnabled).toBe(true);
    expect(cfg.ollamaTimeoutMs).toBe(120_000);
  });

  test("explicit OLLAMA_TIMEOUT_MS wins over the tools-on default bump", () => {
    const cfg = loadConfig({
      ...toolsOnEnv,
      OLLAMA_TOOLS_ENABLED: "true",
      SOLRAC_INTEGRATIONS_ENABLED: "true",
      OLLAMA_TIMEOUT_MS: "45000",
    });
    expect(cfg.ollamaTimeoutMs).toBe(45_000);
  });

  test("OLLAMA_MAX_TOOL_ITERATIONS override accepted", () => {
    const cfg = loadConfig({
      ...toolsOnEnv,
      OLLAMA_TOOLS_ENABLED: "true",
      SOLRAC_INTEGRATIONS_ENABLED: "true",
      OLLAMA_MAX_TOOL_ITERATIONS: "12",
    });
    expect(cfg.ollamaMaxToolIterations).toBe(12);
  });
});

describe("loadConfig — SOLRAC_DEFAULT_ENGINE", () => {
  // Required-vars triple, but no SOLRAC_DEFAULT_ENGINE → default is "ollama".
  const minimalEnv: NodeJS.ProcessEnv = {
    ANTHROPIC_API_KEY: "sk-ant-test",
    TELEGRAM_BOT_TOKEN: "fake-tg-token",
    ALLOWLIST_BOOTSTRAP: "100",
  };

  test("default is 'ollama' (PR-B inversion); requires OLLAMA_ENABLED", () => {
    expect(() => loadConfig({ ...minimalEnv })).toThrow(
      /SOLRAC_DEFAULT_ENGINE=ollama requires OLLAMA_ENABLED=true/,
    );
  });

  test("default 'ollama' with OLLAMA_ENABLED+OLLAMA_MODEL passes", () => {
    const cfg = loadConfig({
      ...minimalEnv,
      OLLAMA_ENABLED: "true",
      OLLAMA_MODEL: "gemma4:e4b",
    });
    expect(cfg.defaultEngine).toBe("ollama");
    expect(cfg.defaultEngineExplicit).toBe(false);
  });

  test("explicit SOLRAC_DEFAULT_ENGINE=primary passes without Ollama", () => {
    const cfg = loadConfig({ ...minimalEnv, SOLRAC_DEFAULT_ENGINE: "primary" });
    expect(cfg.defaultEngine).toBe("primary");
    expect(cfg.defaultEngineExplicit).toBe(true);
    expect(cfg.ollamaEnabled).toBe(false);
  });

  test("explicit SOLRAC_DEFAULT_ENGINE=secondary passes without Ollama", () => {
    const cfg = loadConfig({ ...minimalEnv, SOLRAC_DEFAULT_ENGINE: "secondary" });
    expect(cfg.defaultEngine).toBe("secondary");
  });

  test("invalid value throws with the allowed-set hint", () => {
    expect(() =>
      loadConfig({ ...minimalEnv, SOLRAC_DEFAULT_ENGINE: "claude" }),
    ).toThrow(/SOLRAC_DEFAULT_ENGINE must be "ollama", "primary", or "secondary"/);
  });

  test("default!=ollama with OLLAMA_TOOLS_ENABLED=true is unreachable; throws", () => {
    expect(() =>
      loadConfig({
        ...minimalEnv,
        SOLRAC_DEFAULT_ENGINE: "primary",
        OLLAMA_TOOLS_ENABLED: "true",
        SOLRAC_INTEGRATIONS_ENABLED: "true",
      }),
    ).toThrow(/unreachable/);
  });

  test("default=ollama + tools-on + integrations-on passes", () => {
    const cfg = loadConfig({
      ...minimalEnv,
      OLLAMA_ENABLED: "true",
      OLLAMA_MODEL: "gemma4:e4b",
      OLLAMA_TOOLS_ENABLED: "true",
      SOLRAC_INTEGRATIONS_ENABLED: "true",
    });
    expect(cfg.defaultEngine).toBe("ollama");
    expect(cfg.ollamaToolsEnabled).toBe(true);
  });

  test("blank SOLRAC_DEFAULT_ENGINE treated as unset (defaults to ollama)", () => {
    expect(() => loadConfig({ ...minimalEnv, SOLRAC_DEFAULT_ENGINE: "  " })).toThrow(
      /SOLRAC_DEFAULT_ENGINE=ollama requires OLLAMA_ENABLED=true/,
    );
    const cfg = loadConfig({
      ...minimalEnv,
      SOLRAC_DEFAULT_ENGINE: "  ",
      OLLAMA_ENABLED: "true",
      OLLAMA_MODEL: "gemma4:e4b",
    });
    expect(cfg.defaultEngine).toBe("ollama");
    expect(cfg.defaultEngineExplicit).toBe(false);
  });
});

describe("loadConfig — web UI", () => {
  test("default: webEnabled=false, defaults filled in", () => {
    const cfg = loadConfig({ ...baseEnv });
    expect(cfg.webEnabled).toBe(false);
    expect(cfg.webHost).toBe("127.0.0.1");
    expect(cfg.webPort).toBe(8080);
    expect(cfg.webToken).toBeNull();
    expect(cfg.webChatId).toBe(-1000);
  });

  test("SOLRAC_WEB_ENABLED=true without token throws", () => {
    expect(() => loadConfig({ ...baseEnv, SOLRAC_WEB_ENABLED: "true" })).toThrow(
      /SOLRAC_WEB_TOKEN is required when SOLRAC_WEB_ENABLED=true/,
    );
  });

  test("SOLRAC_WEB_ENABLED=true with token passes (loopback default)", () => {
    const cfg = loadConfig({
      ...baseEnv,
      SOLRAC_WEB_ENABLED: "true",
      SOLRAC_WEB_TOKEN: "deadbeef".repeat(8),
    });
    expect(cfg.webEnabled).toBe(true);
    expect(cfg.webToken).toBe("deadbeef".repeat(8));
  });

  test("0.0.0.0 still requires the token (no loopback shortcut)", () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        SOLRAC_WEB_ENABLED: "true",
        SOLRAC_WEB_HOST: "0.0.0.0",
      }),
    ).toThrow(/SOLRAC_WEB_TOKEN is required/);
  });

  test("SOLRAC_WEB_PORT colliding with PORT throws", () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        SOLRAC_WEB_ENABLED: "true",
        SOLRAC_WEB_TOKEN: "x".repeat(32),
        PORT: "9000",
        SOLRAC_WEB_PORT: "9000",
      }),
    ).toThrow(/must differ from PORT/);
  });

  test("SOLRAC_WEB_CHAT_ID positive integer throws", () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        SOLRAC_WEB_CHAT_ID: "1000",
      }),
    ).toThrow(/SOLRAC_WEB_CHAT_ID must be a negative integer/);
  });

  test("SOLRAC_WEB_CHAT_ID custom negative value accepted", () => {
    const cfg = loadConfig({ ...baseEnv, SOLRAC_WEB_CHAT_ID: "-42" });
    expect(cfg.webChatId).toBe(-42);
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

describe("loadConfig — integrations", () => {
  test("default: integrationsEnabled=false, integrationsDir=./integrations", () => {
    const cfg = loadConfig({ ...baseEnv });
    expect(cfg.integrationsEnabled).toBe(false);
    expect(cfg.integrationsDir).toBe("./integrations");
  });

  test("SOLRAC_INTEGRATIONS_ENABLED=true is parsed", () => {
    const cfg = loadConfig({ ...baseEnv, SOLRAC_INTEGRATIONS_ENABLED: "true" });
    expect(cfg.integrationsEnabled).toBe(true);
  });

  test("SOLRAC_INTEGRATIONS_DIR overrides default", () => {
    const cfg = loadConfig({ ...baseEnv, SOLRAC_INTEGRATIONS_DIR: "/var/solrac/integrations" });
    expect(cfg.integrationsDir).toBe("/var/solrac/integrations");
  });

  test("SOLRAC_INTEGRATIONS_DIR blank falls back to ./integrations", () => {
    const cfg = loadConfig({ ...baseEnv, SOLRAC_INTEGRATIONS_DIR: "  " });
    expect(cfg.integrationsDir).toBe("./integrations");
  });
});
