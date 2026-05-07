# Contributing to Solrac

Thanks for your interest in Solrac. This is a small, opinionated project — contributions that fit the design philosophy ([README.md#design-philosophy](./README.md#design-philosophy)) are very welcome.

## Reporting issues

- Search [existing issues](https://github.com/cjus/solrac/issues) first.
- Include: Bun version, OS, redacted log lines, reproduction steps.
- Don't paste tokens, allowlist ids, or `.env` values.

## Development setup

```sh
git clone https://github.com/cjus/solrac.git
cd solrac
npm install
cp .env.example .env   # fill in 3 required values; see docs/SETUP.md
npm run dev
```

Solrac requires **Bun ≥1.3.0** as the runtime (`bun:sqlite`, `bun:test`, `Bun.serve`). npm is the package manager only — `npm install` resolves dependencies; the app itself runs on Bun.

## Before submitting a PR

```sh
npm run typecheck      # tsc --noEmit, must pass
npm test               # bun test, must pass
npm run lint           # eslint, if you have it set up locally
```

For changes that touch policy, cost cap, audit, or shutdown semantics, also run the relevant smoke:

```sh
npm run smoke:flood
npm run smoke:ollama   # only if you have Ollama running locally
```

## Style

- TypeScript-strict. No `any`. Prefer `unknown` + narrowing.
- Imperative, lowercase commit messages — no period. Example: `add cost cap reset on session clear`.
- Keep PRs focused. One logical change per PR.
- Update docs (`docs/USAGE.md`, `docs/CONFIG.md`, `docs/ARCHITECTURE.md`) when behavior or env vars change.

## Scope

Solrac is intentionally small. Things we'll likely **not** merge:

- HTTP/Telegram framework dependencies (we use raw `fetch` + `Bun.serve` on purpose).
- Multi-tenancy, web UI, hosted-service features.
- Bedrock/Vertex auth (direct Anthropic only — see [docs/ARCHITECTURE.md#anti-goals](./docs/ARCHITECTURE.md#anti-goals)).
- Sub-agent enablement (open question — see [docs/ROADMAP.md](./docs/ROADMAP.md)).

If you want to revisit any of these, open an issue first to discuss before opening a PR.

## License

By contributing, you agree your contributions are licensed under the [MIT License](./LICENSE).
