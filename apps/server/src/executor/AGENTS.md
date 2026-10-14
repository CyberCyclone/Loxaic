# apps/server/src/executor

The local executor: `main.ts` is a second tsup entry (`dist/executor.js`) that the desktop app runs on the user's own machine, dialling `/ws/executor` to run a `local` workspace's tools, terminals and optional container. `registry.ts` and `protocol.ts` are the server side. Rules here cover the trust boundary in both directions.

## Trust

- **The executor does not trust the server.** `service.ts` re-checks every `ref` and path in every call against the user's chosen roots by `realpath`; the server's `resolvePath` is lexical and repositories contain symlinks out.
- Judge a not-yet-existing path by its nearest existing ancestor's real path. A removed root is revoked on the next call.
- Realpath confinement applies to direct refs only (`confined` in `service.ts`); inside a container, the container is the boundary.
- The roots bound the file verbs and where commands start, not what `exec` runs: a direct workspace runs the model's shell commands as the user. Never claim otherwise in code comments, UI or docs.
- An executor id belongs to the user who first registered it: `registerExecutor` replaces a same-user connection and refuses a cross-user claim with 4003. The id is not a secret.
- The session token arrives on stdin, first line only; never put it in env, argv, logs or the persisted config.
- On close code 4001 the executor exits rather than retrying; the desktop starts a fresh one with a fresh session.

## Import isolation

- The executor's import graph must not reach the database, settings, the server entry, fastify or dockerode; `__tests__/isolation.test.ts` enforces it. `sandbox/provider.ts` may only be `import type`d.
- Use `sandbox/container-engine.ts` for container mechanics, never `container-provider.ts` (it reads settings).

## Calls

- `callExecutor` decides offline up front (nothing connected means fail now) and every call has a deadline. `exec`'s deadline is the command's own timeout plus a margin, so the executor's timeout fires first with real output.
- `create` gets `CREATE_TIMEOUT_MS` (10 min) for a first image build; every other call keeps the 15 s default.
- `exec.cancel` must not settle the pending call: the executor kills the command and answers the original call with its partial output. Remove the abort listener when the call settles.

## Local containers (container.ts)

- A container-isolated workspace bind-mounts only the chosen folder at `/home/loxaic/repo` with the server's image, is fixed at chat start, and is offered only when the machine reports `capabilities.container` (probed per connection).
- Attaching requires the `loxaic.executor` label, so a server cannot exec into arbitrary containers, and re-checks `loxaic.localFolder` against the current roots.
- Resolve `stop`/`destroy` "for release" (label check only), never gated on folder approval, so a withdrawn folder's container stays removable.
- Shape-check a server-supplied container id (`CONTAINER_ID_RE`, `[0-9a-f]{12,64}`) before it enters an Engine API path.
- At most `MAX_LOCAL_CONTAINERS` (8) per machine, counted by label.
- Cache the engine and re-check it with a bounded ping; `attachLocalContainer` is on every call's path.
- Network is on for local containers, deliberately: the user already chose to run commands on their own machine.
- On Linux run as the desktop user's uid:gid with `HOME=/tmp` (not the mounted folder); on macOS and Windows don't force a uid. The Linux path is unverified.
- Container `stop` pauses and `destroy` removes it; neither touches the folder. Both are no-ops for a direct workspace.

## Terminals (terminal.ts)

- Terminals stream over the executor's existing socket keyed by `terminalId`; opening requires an approved directory re-checked at open time, and at most `MAX_TERMINALS` (8) are open.
- A lost server connection closes every shell; never leave bash running on the user's machine for a server that has gone.
- A direct workspace's shell is deliberately unbounded once open (`exec` already runs anything there); don't confine it.
