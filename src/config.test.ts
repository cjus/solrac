/**
 * @fileoverview Unit tests for `loadConfig` validation paths.
 * @proves Required-vars enforcement, LOCAL_URL scheme guard, the
 *         LOCAL_ENABLED → LOCAL_MODEL/LOCAL_BACKEND contract, and the
 *         hard-cutover rejection of legacy `OLLAMA_*` env vars all fail loud
 *         at boot.
 *
 * `config.ts` is the boot-time gatekeeper. A bad env value here should
 * surface as an actionable startup error, not a confusing runtime failure
 * thirty seconds in.
 *
 * Cross-references:
 *   - config.ts — implementation
 *   - docs/CONFIG.md — env reference
 */

import { describe, expect, test } from "bun:test";
import { loadConfig } from "./config.ts";

// Pin `SOLRAC_DEFAULT_ENGINE=primary` for the shared base so tests not
// specifically about the inversion don't have to also configure the local
// engine. The new default is `local`, which requires `LOCAL_ENABLED=true`
// — covered by the dedicated default-engine test block below.
const TEST_HOME = "/tmp/solrac-config-test-home";
const baseEnv: NodeJS.ProcessEnv = {
  ANTHROPIC_API_KEY: "sk-ant-test",
  TELEGRAM_BOT_TOKEN: "fake-tg-token",
  ALLOWLIST_BOOTSTRAP: "100",
  SOLRAC_DEFAULT_ENGINE: "primary",
  SOLRAC_HOME: TEST_HOME,
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

describe("loadConfig — legacy OLLAMA_* env vars rejected", () => {
  test("any OLLAMA_* env var throws at boot with rename hint", () => {
    expect(() => loadConfig({ ...baseEnv, OLLAMA_ENABLED: "true" })).toThrow(
      /Legacy OLLAMA_\* env vars are no longer supported.*OLLAMA_ENABLED.*Rename to LOCAL_\*/s,
    );
  });

  test("multiple legacy keys are all listed, sorted", () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        OLLAMA_URL: "http://x",
        OLLAMA_MODEL: "y",
        OLLAMA_ENABLED: "true",
      }),
    ).toThrow(/OLLAMA_ENABLED, OLLAMA_MODEL, OLLAMA_URL/);
  });
});

describe("loadConfig — LOCAL_URL", () => {
  test("default (local disabled) is http://localhost:11434", () => {
    const cfg = loadConfig({ ...baseEnv });
    expect(cfg.localUrl).toBe("http://localhost:11434");
  });

  test("strips a trailing slash", () => {
    const cfg = loadConfig({ ...baseEnv, LOCAL_URL: "http://example.com:8080/" });
    expect(cfg.localUrl).toBe("http://example.com:8080");
  });

  test("https:// is accepted", () => {
    const cfg = loadConfig({ ...baseEnv, LOCAL_URL: "https://local.example.com" });
    expect(cfg.localUrl).toBe("https://local.example.com");
  });

  test("missing scheme (host:port) throws", () => {
    expect(() => loadConfig({ ...baseEnv, LOCAL_URL: "localhost:11434" })).toThrow(
      /LOCAL_URL must use http:\/\/ or https:\/\//,
    );
  });

  test("ftp:// scheme throws", () => {
    expect(() => loadConfig({ ...baseEnv, LOCAL_URL: "ftp://nope" })).toThrow(
      /LOCAL_URL must use http:\/\/ or https:\/\//,
    );
  });

  test("malformed URL throws with 'not a valid URL'", () => {
    expect(() => loadConfig({ ...baseEnv, LOCAL_URL: "::::not a url::::" })).toThrow(
      /LOCAL_URL is not a valid URL/,
    );
  });

  test("backend-aware default: LOCAL_BACKEND=lmstudio → :1234", () => {
    const cfg = loadConfig({
      ...baseEnv,
      SOLRAC_DEFAULT_ENGINE: "local",
      LOCAL_ENABLED: "true",
      LOCAL_BACKEND: "lmstudio",
      LOCAL_MODEL: "qwen2.5-7b",
    });
    expect(cfg.localUrl).toBe("http://localhost:1234");
  });

  test("backend-aware default: LOCAL_BACKEND=ollama → :11434", () => {
    const cfg = loadConfig({
      ...baseEnv,
      SOLRAC_DEFAULT_ENGINE: "local",
      LOCAL_ENABLED: "true",
      LOCAL_BACKEND: "ollama",
      LOCAL_MODEL: "gemma4:e4b",
    });
    expect(cfg.localUrl).toBe("http://localhost:11434");
  });

  test("explicit LOCAL_URL wins over backend-aware default", () => {
    const cfg = loadConfig({
      ...baseEnv,
      SOLRAC_DEFAULT_ENGINE: "local",
      LOCAL_ENABLED: "true",
      LOCAL_BACKEND: "lmstudio",
      LOCAL_MODEL: "qwen2.5-7b",
      LOCAL_URL: "http://gpu.lan:9999",
    });
    expect(cfg.localUrl).toBe("http://gpu.lan:9999");
  });
});

describe("loadConfig — LOCAL_BACKEND contract", () => {
  test("LOCAL_ENABLED=true without LOCAL_BACKEND throws", () => {
    expect(() =>
      loadConfig({ ...baseEnv, LOCAL_ENABLED: "true", LOCAL_MODEL: "x" }),
    ).toThrow(/LOCAL_BACKEND is required when LOCAL_ENABLED=true/);
  });

  test("invalid LOCAL_BACKEND value throws", () => {
    expect(() =>
      loadConfig({ ...baseEnv, LOCAL_ENABLED: "true", LOCAL_BACKEND: "vllm", LOCAL_MODEL: "x" }),
    ).toThrow(/LOCAL_BACKEND must be "ollama" or "lmstudio"/);
  });

  test("LOCAL_BACKEND=ollama accepted", () => {
    const cfg = loadConfig({
      ...baseEnv,
      SOLRAC_DEFAULT_ENGINE: "local",
      LOCAL_ENABLED: "true",
      LOCAL_BACKEND: "ollama",
      LOCAL_MODEL: "gemma4:e4b",
    });
    expect(cfg.localBackend).toBe("ollama");
  });

  test("LOCAL_BACKEND=lmstudio accepted", () => {
    const cfg = loadConfig({
      ...baseEnv,
      SOLRAC_DEFAULT_ENGINE: "local",
      LOCAL_ENABLED: "true",
      LOCAL_BACKEND: "lmstudio",
      LOCAL_MODEL: "qwen2.5-7b",
    });
    expect(cfg.localBackend).toBe("lmstudio");
  });

  test("LOCAL_BACKEND parsed even when LOCAL_ENABLED=false (harmless preconfig)", () => {
    const cfg = loadConfig({ ...baseEnv, LOCAL_BACKEND: "lmstudio" });
    expect(cfg.localEnabled).toBe(false);
    expect(cfg.localBackend).toBe("lmstudio");
  });
});

describe("loadConfig — LOCAL_ENABLED contract", () => {
  test("LOCAL_ENABLED=true requires LOCAL_MODEL", () => {
    expect(() =>
      loadConfig({ ...baseEnv, LOCAL_ENABLED: "true", LOCAL_BACKEND: "ollama" }),
    ).toThrow(/LOCAL_MODEL is required when LOCAL_ENABLED=true/);
  });

  test("LOCAL_ENABLED=false ignores LOCAL_MODEL absence", () => {
    const cfg = loadConfig({ ...baseEnv, LOCAL_ENABLED: "false" });
    expect(cfg.localEnabled).toBe(false);
    expect(cfg.localModel).toBeNull();
    expect(cfg.localBackend).toBeNull();
  });

  test("LOCAL_ENABLED=true with backend + model passes", () => {
    const cfg = loadConfig({
      ...baseEnv,
      SOLRAC_DEFAULT_ENGINE: "local",
      LOCAL_ENABLED: "true",
      LOCAL_BACKEND: "ollama",
      LOCAL_MODEL: "llama3.2",
    });
    expect(cfg.localEnabled).toBe(true);
    expect(cfg.localBackend).toBe("ollama");
    expect(cfg.localModel).toBe("llama3.2");
  });
});

describe("loadConfig — LOCAL_TOOLS_ENABLED contract", () => {
  // Tools-on requires the local engine to be the default; bake that into a
  // local helper so each test stays focused on the tool-flag contract.
  const toolsOnEnv: NodeJS.ProcessEnv = {
    ...baseEnv,
    SOLRAC_DEFAULT_ENGINE: "local",
    LOCAL_ENABLED: "true",
    LOCAL_BACKEND: "ollama",
    LOCAL_MODEL: "gemma4:e4b",
  };

  test("default: tools off, max iterations 8, timeout 60s", () => {
    const cfg = loadConfig({ ...baseEnv });
    expect(cfg.localToolsEnabled).toBe(false);
    expect(cfg.localMaxToolIterations).toBe(8);
    expect(cfg.localTimeoutMs).toBe(60_000);
  });

  test("tools on without integrations throws actionable error", () => {
    expect(() =>
      loadConfig({
        ...toolsOnEnv,
        LOCAL_TOOLS_ENABLED: "true",
      }),
    ).toThrow(/SOLRAC_INTEGRATIONS_ENABLED=true/);
  });

  test("tools on + integrations on passes; bumps default timeout to 120s", () => {
    const cfg = loadConfig({
      ...toolsOnEnv,
      LOCAL_TOOLS_ENABLED: "true",
      SOLRAC_INTEGRATIONS_ENABLED: "true",
    });
    expect(cfg.localToolsEnabled).toBe(true);
    expect(cfg.integrationsEnabled).toBe(true);
    expect(cfg.localTimeoutMs).toBe(120_000);
  });

  test("explicit LOCAL_TIMEOUT_MS wins over the tools-on default bump", () => {
    const cfg = loadConfig({
      ...toolsOnEnv,
      LOCAL_TOOLS_ENABLED: "true",
      SOLRAC_INTEGRATIONS_ENABLED: "true",
      LOCAL_TIMEOUT_MS: "45000",
    });
    expect(cfg.localTimeoutMs).toBe(45_000);
  });

  test("LOCAL_MAX_TOOL_ITERATIONS override accepted", () => {
    const cfg = loadConfig({
      ...toolsOnEnv,
      LOCAL_TOOLS_ENABLED: "true",
      SOLRAC_INTEGRATIONS_ENABLED: "true",
      LOCAL_MAX_TOOL_ITERATIONS: "12",
    });
    expect(cfg.localMaxToolIterations).toBe(12);
  });
});

describe("loadConfig — SOLRAC_DEFAULT_ENGINE", () => {
  // Required-vars triple, no SOLRAC_DEFAULT_ENGINE → default is "local".
  const minimalEnv: NodeJS.ProcessEnv = {
    ANTHROPIC_API_KEY: "sk-ant-test",
    TELEGRAM_BOT_TOKEN: "fake-tg-token",
    ALLOWLIST_BOOTSTRAP: "100",
  };

  test("default is 'local'; requires LOCAL_ENABLED", () => {
    expect(() => loadConfig({ ...minimalEnv })).toThrow(
      /SOLRAC_DEFAULT_ENGINE=local requires LOCAL_ENABLED=true/,
    );
  });

  test("default 'local' with LOCAL_ENABLED+LOCAL_BACKEND+LOCAL_MODEL passes", () => {
    const cfg = loadConfig({
      ...minimalEnv,
      LOCAL_ENABLED: "true",
      LOCAL_BACKEND: "ollama",
      LOCAL_MODEL: "gemma4:e4b",
    });
    expect(cfg.defaultEngine).toBe("local");
    expect(cfg.defaultEngineExplicit).toBe(false);
  });

  test("explicit SOLRAC_DEFAULT_ENGINE=primary passes without local engine", () => {
    const cfg = loadConfig({ ...minimalEnv, SOLRAC_DEFAULT_ENGINE: "primary" });
    expect(cfg.defaultEngine).toBe("primary");
    expect(cfg.defaultEngineExplicit).toBe(true);
    expect(cfg.localEnabled).toBe(false);
  });

  test("explicit SOLRAC_DEFAULT_ENGINE=secondary passes without local engine", () => {
    const cfg = loadConfig({ ...minimalEnv, SOLRAC_DEFAULT_ENGINE: "secondary" });
    expect(cfg.defaultEngine).toBe("secondary");
  });

  test("SOLRAC_DEFAULT_ENGINE=ollama hard-rejected with rename hint", () => {
    expect(() => loadConfig({ ...minimalEnv, SOLRAC_DEFAULT_ENGINE: "ollama" })).toThrow(
      /SOLRAC_DEFAULT_ENGINE=ollama is no longer accepted.*LOCAL_BACKEND=ollama/s,
    );
  });

  test("invalid value throws with the allowed-set hint", () => {
    expect(() =>
      loadConfig({ ...minimalEnv, SOLRAC_DEFAULT_ENGINE: "claude" }),
    ).toThrow(/SOLRAC_DEFAULT_ENGINE must be "local", "primary", or "secondary"/);
  });

  test("default!=local with LOCAL_TOOLS_ENABLED=true is unreachable; throws", () => {
    expect(() =>
      loadConfig({
        ...minimalEnv,
        SOLRAC_DEFAULT_ENGINE: "primary",
        LOCAL_TOOLS_ENABLED: "true",
        SOLRAC_INTEGRATIONS_ENABLED: "true",
      }),
    ).toThrow(/unreachable/);
  });

  test("default=local + tools-on + integrations-on passes", () => {
    const cfg = loadConfig({
      ...minimalEnv,
      LOCAL_ENABLED: "true",
      LOCAL_BACKEND: "ollama",
      LOCAL_MODEL: "gemma4:e4b",
      LOCAL_TOOLS_ENABLED: "true",
      SOLRAC_INTEGRATIONS_ENABLED: "true",
    });
    expect(cfg.defaultEngine).toBe("local");
    expect(cfg.localToolsEnabled).toBe(true);
  });

  test("blank SOLRAC_DEFAULT_ENGINE treated as unset (defaults to local)", () => {
    expect(() => loadConfig({ ...minimalEnv, SOLRAC_DEFAULT_ENGINE: "  " })).toThrow(
      /SOLRAC_DEFAULT_ENGINE=local requires LOCAL_ENABLED=true/,
    );
    const cfg = loadConfig({
      ...minimalEnv,
      SOLRAC_DEFAULT_ENGINE: "  ",
      LOCAL_ENABLED: "true",
      LOCAL_BACKEND: "ollama",
      LOCAL_MODEL: "gemma4:e4b",
    });
    expect(cfg.defaultEngine).toBe("local");
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
  test("default: skillsEnabled=false, skillsDir resolves under solracHome", () => {
    const cfg = loadConfig({ ...baseEnv });
    expect(cfg.skillsEnabled).toBe(false);
    expect(cfg.skillsDir).toBe(`${TEST_HOME}/skills`);
  });

  test("SOLRAC_SKILLS_ENABLED=true is parsed", () => {
    const cfg = loadConfig({ ...baseEnv, SOLRAC_SKILLS_ENABLED: "true" });
    expect(cfg.skillsEnabled).toBe(true);
  });

  test("SOLRAC_SKILLS_DIR absolute overrides default", () => {
    const cfg = loadConfig({ ...baseEnv, SOLRAC_SKILLS_DIR: "/var/solrac/skills" });
    expect(cfg.skillsDir).toBe("/var/solrac/skills");
  });

  test("SOLRAC_SKILLS_DIR relative resolves against solracHome", () => {
    const cfg = loadConfig({ ...baseEnv, SOLRAC_SKILLS_DIR: "./alt-skills" });
    expect(cfg.skillsDir).toBe(`${TEST_HOME}/alt-skills`);
  });

  test("SOLRAC_SKILLS_DIR blank falls back to <home>/skills", () => {
    const cfg = loadConfig({ ...baseEnv, SOLRAC_SKILLS_DIR: "  " });
    expect(cfg.skillsDir).toBe(`${TEST_HOME}/skills`);
  });
});

describe("loadConfig — integrations", () => {
  test("default: integrationsEnabled=false, integrationsDir resolves under solracHome", () => {
    const cfg = loadConfig({ ...baseEnv });
    expect(cfg.integrationsEnabled).toBe(false);
    expect(cfg.integrationsDir).toBe(`${TEST_HOME}/integrations`);
  });

  test("SOLRAC_INTEGRATIONS_ENABLED=true is parsed", () => {
    const cfg = loadConfig({ ...baseEnv, SOLRAC_INTEGRATIONS_ENABLED: "true" });
    expect(cfg.integrationsEnabled).toBe(true);
  });

  test("SOLRAC_INTEGRATIONS_DIR absolute overrides default", () => {
    const cfg = loadConfig({ ...baseEnv, SOLRAC_INTEGRATIONS_DIR: "/var/solrac/integrations" });
    expect(cfg.integrationsDir).toBe("/var/solrac/integrations");
  });

  test("SOLRAC_INTEGRATIONS_DIR blank falls back to <home>/integrations", () => {
    const cfg = loadConfig({ ...baseEnv, SOLRAC_INTEGRATIONS_DIR: "  " });
    expect(cfg.integrationsDir).toBe(`${TEST_HOME}/integrations`);
  });
});

describe("loadConfig — solracHome resolution", () => {
  test("explicit SOLRAC_HOME wins (absolute)", () => {
    const cfg = loadConfig({ ...baseEnv, SOLRAC_HOME: "/explicit/home" });
    expect(cfg.solracHome).toBe("/explicit/home");
    expect(cfg.dataDir).toBe("/explicit/home/data");
  });

  test("explicit SOLRAC_HOME relative resolves against process.cwd()", () => {
    const cfg = loadConfig({ ...baseEnv, SOLRAC_HOME: "./relative-home" });
    expect(cfg.solracHome).toBe(`${process.cwd()}/relative-home`);
  });

  test("DATA_DIR absolute overrides default", () => {
    const cfg = loadConfig({ ...baseEnv, DATA_DIR: "/var/solrac/data" });
    expect(cfg.dataDir).toBe("/var/solrac/data");
  });

  test("DATA_DIR relative resolves against solracHome", () => {
    const cfg = loadConfig({ ...baseEnv, DATA_DIR: "./mydata" });
    expect(cfg.dataDir).toBe(`${TEST_HOME}/mydata`);
  });
});

describe("loadConfig — REMOTE_* (OpenRouter)", () => {
  test("default: remoteEnabled=false, no provider, defaults populated", () => {
    const cfg = loadConfig({ ...baseEnv });
    expect(cfg.remoteEnabled).toBe(false);
    expect(cfg.remoteBackend).toBe(null);
    expect(cfg.remoteModel).toBe(null);
    expect(cfg.remoteApiKey).toBe(null);
    // The base URL is empty when remote is disabled (no backend selected to
    // resolve a default for); validation only runs on enabled paths.
    expect(cfg.remoteBaseUrl).toBe("");
    expect(cfg.remoteHttpReferer).toBe("https://github.com/cjus/solrac");
    expect(cfg.remoteXTitle).toBe("solrac");
  });

  test("REMOTE_ENABLED=true requires REMOTE_BACKEND", () => {
    expect(() =>
      loadConfig({ ...baseEnv, REMOTE_ENABLED: "true" }),
    ).toThrow(/REMOTE_BACKEND is required/);
  });

  test("REMOTE_ENABLED=true requires REMOTE_MODEL", () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        REMOTE_ENABLED: "true",
        REMOTE_BACKEND: "openrouter",
        REMOTE_API_KEY: "sk-or-test",
      }),
    ).toThrow(/REMOTE_MODEL is required/);
  });

  test("REMOTE_ENABLED=true requires REMOTE_API_KEY", () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        REMOTE_ENABLED: "true",
        REMOTE_BACKEND: "openrouter",
        REMOTE_MODEL: "anthropic/claude-3.5-sonnet",
      }),
    ).toThrow(/REMOTE_API_KEY is required/);
  });

  test("invalid REMOTE_BACKEND value throws", () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        REMOTE_ENABLED: "true",
        REMOTE_BACKEND: "totally-real-provider",
      }),
    ).toThrow(/REMOTE_BACKEND must be "openrouter"/);
  });

  test("full REMOTE_* config + SOLRAC_DEFAULT_ENGINE=local passes", () => {
    const cfg = loadConfig({
      ...baseEnv,
      SOLRAC_DEFAULT_ENGINE: "local",
      REMOTE_ENABLED: "true",
      REMOTE_BACKEND: "openrouter",
      REMOTE_MODEL: "anthropic/claude-3.5-sonnet",
      REMOTE_API_KEY: "sk-or-test",
    });
    expect(cfg.remoteEnabled).toBe(true);
    expect(cfg.remoteBackend).toBe("openrouter");
    expect(cfg.remoteModel).toBe("anthropic/claude-3.5-sonnet");
    expect(cfg.remoteApiKey).toBe("sk-or-test");
    expect(cfg.remoteBaseUrl).toBe("https://openrouter.ai/api/v1");
    expect(cfg.defaultEngine).toBe("local");
  });

  test("REMOTE_BASE_URL override strips trailing slash", () => {
    const cfg = loadConfig({
      ...baseEnv,
      REMOTE_ENABLED: "true",
      REMOTE_BACKEND: "openrouter",
      REMOTE_MODEL: "x/y",
      REMOTE_API_KEY: "k",
      REMOTE_BASE_URL: "https://proxy.example.com/api/v1/",
    });
    expect(cfg.remoteBaseUrl).toBe("https://proxy.example.com/api/v1");
  });

  test("malformed REMOTE_BASE_URL throws at boot", () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        REMOTE_ENABLED: "true",
        REMOTE_BACKEND: "openrouter",
        REMOTE_MODEL: "x/y",
        REMOTE_API_KEY: "k",
        REMOTE_BASE_URL: "openrouter.ai/api/v1",
      }),
    ).toThrow(/REMOTE_BASE_URL/);
  });

  test("LOCAL_ENABLED + REMOTE_ENABLED both true is mutually exclusive", () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        LOCAL_ENABLED: "true",
        LOCAL_BACKEND: "ollama",
        LOCAL_MODEL: "gemma3",
        REMOTE_ENABLED: "true",
        REMOTE_BACKEND: "openrouter",
        REMOTE_MODEL: "anthropic/claude-3.5-sonnet",
        REMOTE_API_KEY: "k",
      }),
    ).toThrow(/mutually exclusive/);
  });

  test("SOLRAC_DEFAULT_ENGINE=local works with REMOTE_ENABLED=true (no on-host LLM)", () => {
    // The user's stated framing: a host that can't run a local LLM still
    // gets a default-engine option via OpenRouter.
    const cfg = loadConfig({
      ...baseEnv,
      SOLRAC_DEFAULT_ENGINE: "local",
      REMOTE_ENABLED: "true",
      REMOTE_BACKEND: "openrouter",
      REMOTE_MODEL: "openai/gpt-4o-mini",
      REMOTE_API_KEY: "k",
    });
    expect(cfg.defaultEngine).toBe("local");
    expect(cfg.localEnabled).toBe(false);
    expect(cfg.remoteEnabled).toBe(true);
  });

  test("SOLRAC_DEFAULT_ENGINE=local with neither LOCAL nor REMOTE enabled throws", () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        SOLRAC_DEFAULT_ENGINE: "local",
      }),
    ).toThrow(/requires LOCAL_ENABLED=true.*or REMOTE_ENABLED=true/s);
  });

  test("REMOTE_HTTP_REFERER + REMOTE_X_TITLE overrides are accepted", () => {
    const cfg = loadConfig({
      ...baseEnv,
      REMOTE_HTTP_REFERER: "https://my-fork.example",
      REMOTE_X_TITLE: "my-solrac-fork",
    });
    expect(cfg.remoteHttpReferer).toBe("https://my-fork.example");
    expect(cfg.remoteXTitle).toBe("my-solrac-fork");
  });

  test("REMOTE_TIMEOUT_MS / REMOTE_HISTORY_LIMIT / REMOTE_MAX_TOOL_ITERATIONS defaults", () => {
    const cfg = loadConfig({ ...baseEnv });
    expect(cfg.remoteTimeoutMs).toBe(60_000);
    expect(cfg.remoteHistoryLimit).toBe(6);
    expect(cfg.remoteMaxToolIterations).toBe(8);
  });
});
