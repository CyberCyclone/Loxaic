Loxaic: a self-hosted, multi-user AI platform (an open alternative to hosted assistants and coding agents). llama.cpp inference, an agent tool-calling loop with sandboxed execution, one Expo frontend for iOS, Android, web and Electron, reachable over Tailscale or a reverse proxy.

Before you hand any change over:

1. Run what you changed: the unit suite for each package you touched, and the e2e spec on every lane it targets.
2. Prove each new test can fail: revert the fix, see it go red, restore it.
3. Report only what you ran as verified. Anything you could not run goes under "Not verified", with the reason.
4. For a protocol or state change, follow each piece of state through both sides (server and client) and every path that ends it.
5. Read your own diff top to bottom for stray edits, dead guards and claims the code does not back.
6. Read the `AGENTS.md` in each directory you touch; it holds that area's rules.

# AGENTS.md

This file and the `AGENTS.md` in each directory hold rules: what an agent must know before changing code, that the code does not show. Claude Code, Codex and Loxaic all read them; there is deliberately no `CLAUDE.md` (one would stop Claude Code reading these).

## Layout

- `apps/server`: Fastify API and WebSockets, the chat/agent tool loop, routines, sandbox providers (`src/sandbox/`), the managed llama.cpp runtime and HuggingFace downloads (`src/llama/`).
- `apps/mobile`: the one frontend (Expo, expo-router, gluestack-ui v5) for iOS, Android and web. Its web export is the web app, served same-origin by `apps/server`; there is no separate web app or UI package.
- `apps/desktop`: the deployment artifact. Electron GUI, a `--headless` entry, and a supervisor that runs an embedded Postgres and the bundled server, plus a Tailscale sidecar.
- `apps/e2e`: WebdriverIO suites for web, Electron, iOS and Android.
- `packages/agent`: tool definitions and permission-mode logic. `packages/types`: shared types and the stream wire protocol (`src/stream-protocol.ts`). `packages/db`: Drizzle schema and re-exported operators. `packages/api-client`: typed REST and WS client. `packages/sync`: offline-sync conflict detection. `packages/config-ts`: tsconfig bases.
- `infra/`: Dockerfiles, the `tsnet-proxy` Go sidecar, Tailscale Serve config. `docs/`: deployment and runtime guides for people. `design/`: the old HTML prototype, reference only.

## Commands

```bash
pnpm install
pnpm dev --filter=@loxaic/server  # just the API server (:4000), usually what you want
pnpm dev                          # server, Metro (:8081) and the desktop app together
pnpm --filter @loxaic/mobile web  # Expo web dev server (:8081)
MOCK_INFERENCE=true pnpm dev --filter=@loxaic/server  # no llama.cpp needed; the mock drives the tool loop
pnpm --filter @loxaic/desktop package:dir  # unpacked prod build, what the Electron e2e lane drives

pnpm test        # vitest across packages
pnpm lint        # eslint . over the whole repo, tests included; run it before pushing
pnpm typecheck   # tsc --noEmit across all packages

pnpm --filter @loxaic/server test -- src/streams/__tests__/drivers.test.ts   # one file
E2E_PORT=4055 pnpm --filter @loxaic/e2e test:web   # e2e: see apps/e2e/AGENTS.md and README.md
```

- `pnpm --filter … test -- <pattern>` can still run the whole suite; check the reported file count. `npx vitest run <path>` inside the package narrows reliably.
- Never run two of these at once: a `pnpm dev` server, an e2e lane, and the server vitest suite. They share the dev Postgres and the container engine, and each one's sweeps act on the others' sandboxes and rows.
- Ports in dev: server 4000, llama.cpp router 4002, ntfy 4003, Postgres 5432, Metro 8081. The self-contained desktop app uses 4100 and an ephemeral Postgres port, so it coexists with dev.

## Testing

Every pull request carries unit tests and end-to-end tests for what it changes, wherever either is possible. A check done once by hand protects nothing after merge.

- Unit tests pin every decision a module makes, edge cases included. Pull logic into something pure (a reducer, a function of its inputs) to make it testable; `apps/mobile/lib/connectionMonitorCore.ts` is the pattern.
- E2e tests cover each situation a user can get into (server down, slow or back; app locked, backgrounded or cold-started; laptop asleep; a dialog open), both where something should be said and where nothing should, on every platform where it exists. Platform-only cases go in `specs/native/`, `specs/electron/` or `specs/browser/`.
- Drive the real trigger (the OS event, the real server frozen by `helpers/server.ts`), never a stub of it.
- Prove a new test can fail before calling it coverage.
- If a scenario genuinely cannot be automated (real hardware, a paid account), the PR says which, why, and how it was checked. Slow setup or a flaky lane is a reason to fix the harness, not to skip.
- A change that is not user-visible says so in the PR instead of skipping screenshots silently; it still needs unit tests.
- Feature PRs carry screenshots captured by the specs with `shot('name')`. Never commit them (`apps/e2e/artifacts/` is ignored); embed them in the PR description.

## Pull requests

- Target `dev`, the trunk and default branch. `master` and `beta` are release pointers moved only by `release.yml`; a hotfix PR to `master` is the one exception.
- Keep changes minimal and in the surrounding style; add a dependency only with a reason.
- Never push a `v*` tag: releases are cut by the owner (only admins can create them).
- Sign off every commit (`git commit -s`); the DCO check enforces it, agents included.
- Keep the description short: what changed, what was verified, what was not.
- End it with "What you need to do": a numbered list of actions only the owner can take, in order. Each item gives the exact command or click, what success looks like, and why it is needed; say what fails silently if it is skipped. No item may be "review this" or "consider whether"; a decision needs named options and a recommendation. If there is nothing: "Nothing. Merge when CI is green."
- Answer each review finding on its own thread, declined ones included with the reason, and leave resolving to whoever opened it. A top-level comment is only a summary.

## Rules that apply everywhere

- Import query operators and `db` from `@loxaic/db`, never from `drizzle-orm`: two drizzle instances break types.
- In `packages/db`, `packages/agent` and `packages/sync`, relative imports carry the `.ts` extension. They ship raw TypeScript run by Node's ESM resolution; `tsx` in dev won't catch a missing one. For the same reason, no `enum`s and no constructor parameter properties there: Node's strip-only mode cannot erase them, and nothing else catches it (`erasableSyntaxOnly` is not set).
- JSX only in `.tsx` files.
- Authenticate only through `apps/server/src/auth/middleware.ts`. Calling `auth.api.getSession` directly skips the ban and password-change checks.
- Never add a dependency with a required `nativewind` peer. It materialises a second React and breaks hooks on device.
- Any modal that can grow past a few rows needs both `max-h-[85%]` on `ModalContent` and `scrollEnabled` on `ModalBody`.
- UI colours use semantic gluestack tokens (`text-foreground`, `bg-primary`), never numbered Tailwind colours or hex in `className`. SVG fills and strokes are the exception: `react-native-svg` can't resolve CSS variables.
- A read without `orderBy` has no order, in tests too. Anything positional (`.at(-1)`, `[0]`) needs one; messages order by `(lamport, created_at)`.
- An abort listener added to an already-aborted signal never fires. Re-check `signal.aborted` after every await that comes before attaching the listener.
- A single-flight marker must be compared against the exact promise stored.
- Never pipe into `grep -q` under `pipefail`; capture the output, then match with a here-string (`grep -qx … <<< "$out"`).
- The version fields in `apps/desktop/package.json`, `apps/server/package.json` and `apps/mobile/app.json` stay `0.0.0`. The git tag is the version, stamped at release.
- Before designing around an EAS feature, run it once to check its paid tier.
- Issue and PR numbers in code comments refer to this repository.

## Directory rules

Each of these is read when you work in its directory:

- `apps/server/`: settings precedence, test isolation on the shared database, routes, conversations, routines, the GitHub connection. Below it:
  - `src/streams/` (stream log, run registry, prefix invariant, the tool loop in `runs/`); `src/ws/` (socket handlers, delivery).
  - `src/inference/` (providers, scheduler, the mock backend); `src/llama/` (the managed llama.cpp router); `test-fixtures/` (the fake router and mock MCP servers).
  - `src/agent/` (sandbox manager, checkpoints, workspaces, project instructions); `src/sandbox/`; `src/executor/`; `src/skills/`; `src/mcp/`; `src/permissions/`; `src/auth/`; `src/files/`; `src/egress/` (the GitHub credential proxy); `src/images/` (custom sandbox images); `src/browser/` (web_fetch's browser fallback).
- `apps/mobile/` (Expo, styling, testIDs, offline gating, and the rules for `app/`, `hooks/` and `lib/`), with `components/` on its own.
- `apps/e2e/`: how to write and run specs, and each platform's traps.
- `apps/desktop/`: Electron, the supervisor, the updater, signing.
- `packages/db/`, `packages/types/`, `packages/agent/`.
- `.github/` (release and CI workflows), `scripts/` (environments, releases), `infra/` (Dockerfiles, sidecars).

## What belongs in these files

Rules only: one line each where possible, imperative, naming the file or symbol. No incident history, "found in review" notes, measurements or design narrative; the reasoning goes in a code comment beside the code, or in the PR. Put a rule in the deepest directory it applies to. A test (`apps/server/src/agent/__tests__/agent-files.test.ts`) holds each file to a size that is given whole: the root within 15% of a 32k-token window, each directory file within 5% of a 64k one.
