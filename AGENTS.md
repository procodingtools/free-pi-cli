# AGENTS.md

## Mirror — read before changing

- `free-pi-cli` is a one-way mirror of `packages/cli` (+ vendored `pi-ads`, `shared`) from the private `dennisonbertram/free-pi` monorepo. Sync runs automatically on every release; `.mirror-state.json` records what it wrote.
- **Do not publish to npm from here.** Publishing runs from the monorepo on a `cli-v<version>` tag.
- **PRs land here first** (against `main`), then a maintainer ports them into the monorepo. Sharp edge: the next release **overwrites `src/`, `test/`, `README.md`, `CHANGELOG.md`**, so an unported merge gets reverted — flag in the PR if you touched `src/vendor/*` (see below).

## Commands (bun, not npm)

```bash
bun install                  # CI uses: bun install --frozen-lockfile (bun 1.3.14)
bun test                     # full suite; focused: bun test test/<name>.test.ts
bun run typecheck            # tsc --noEmit
bun run build                # bun build src/index.ts --target=node --outdir dist … + chmod +x
```

- CI order is `typecheck → test → build`, matrix `ubuntu/macos/windows` with `fail-fast: false`. The Windows leg is load-bearing (shipped Win-only spawn/path/TTY bugs before) — watch it if you touch spawning, paths, or TTY. `build` is skipped on Windows (`chmod +x` is posix-only; dist ships from posix).
- Engines: `node >= 22.19.0`.
- `FREEPI_BASE_URL` overrides the backend (default `https://api.freepi.ai`) for local dev.

## Architecture

- Entry: `src/index.ts` is a **shim, not the CLI** — it checks zstd/`node-check` using only `node:zlib` + `./node-check`, then dynamically imports `./main`. Never add static imports there: `run.ts`/`pi-launch.ts` value-import `@earendil-works/pi-coding-agent` → undici, which crashes at load on old Node before any guard in `main()` could run (the 0.2.3 bug).
- `src/main.ts` dispatches local commands (`--version`, `--help`, `logout`, `mcp`) **before** `run()` — none contact the server.
- `src/run.ts` orchestrates `consent → login (GitHub device flow) → token check → version check/self-update → launchPi (pi TUI)`. Testable via injected `RunDeps` (`launchPi`, `checkClientVersion`, `maybeSelfUpdate`, `startGravityPixel`, …). The pre-launch half is `runPrelaunchGate()` — shared with headless `acp` mode, which passes `headless: true` (no prompts/login; missing credential or stale consent = stderr message + exit 1).
- `free-pi-cli acp` (`src/acp-command.ts`, `src/acp/`) is a headless ACP server over stdio (NDJSON JSON-RPC, same framing as pi's RPC mode). Sessions build through `buildAgentRuntime()` — the same helper the TUI uses — so extensions/tools/model-lock never fork. **stdout carries only protocol frames** (logs → stderr; resume-line patch restored on serve).
- Config is isolated from stock pi: `~/.free-pi/agent` (JWT at `credentials.json`, mode `0600`), never `~/.pi/agent` — see `src/paths.ts`. `~/.free-pi/config.json` (`{"autoUpdate":false}`) is **read-only, never created**.
- Provider (`src/provider.ts`): appends `/v1` to baseUrl (pi's openai-completions client appends `/chat/completions`), sends `x-session-id` + `x-client-version` headers.
- `src/vendor/{shared,pi-ads}` are monorepo copies resolved via `@freepi/*` aliases in `tsconfig.json`. Exception: `src/vendor/shared/{config,index}.ts` are **hand-written client-only rewrites** (server caps/tiers must not ship) — edits there need a maintainer to carry them back by hand.

## Invariants (do not break)

- **Declined consent = zero server calls.** `run()` must return before `checkClientVersion`, `maybeSelfUpdate`, `relaunchLatest`, or any fetch. Tests assert `stub.requests.length === 0`.
- **Consent is interactive-only** (`CONSENT_VERSION = "4"`, covers ads *and* session-training, no opt-out). It must never be satisfiable by pipe/flag; non-TTY prints `NON_INTERACTIVE_CONSENT_TEXT` instead of hanging. Anything touching consent, credential storage, or the ad boundary needs discussion first (per `CONTRIBUTING.md`); new dependencies likewise (tree is deliberately tiny).
- **Server notice / ad content never enters model context** — terminal-only logs or header banner (`header.ts`), never completion messages. Gravity pixel starts only after `consentCurrent`.
- Tests use in-process `Bun.serve` stubs — no real network or TUI. Notes: the `0600` credential assertion is posix-only (skip on win32); `startDeviceFlow` retry tests sleep ~9s by design.
