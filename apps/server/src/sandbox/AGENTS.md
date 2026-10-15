# apps/server/src/sandbox

Sandbox providers behind `provider.ts`'s `SandboxHandle`/`SandboxProvider`: containers (`container-engine.ts` mechanics, `container-provider.ts` policy), host directories (`host-provider.ts`) and the user's own machine (`executor-provider.ts`), plus the git checkout (`git.ts`). Rules here cover isolation, lifecycle and killing commands.

## Providers

- Execute through `SandboxHandle`/`SandboxProvider`, never a raw `Docker.Container`. Container vs host is `getSandboxMode()` at call time; host is an explicit `SANDBOX_MODE=host` opt-in.
- Never let a caller choose the provider kind per request; derive it from `getSandboxMode()`.
- Choose `executor-provider.ts` (`kind: "executor"`) only from the conversation's `local` workspace in `getConversationSandbox`, never from `SANDBOX_MODE`, a setting or a request field. Keep `"executor"` out of `SandboxMode`, so `POST /v1/sandboxes` cannot mint one and `invalidatedKinds()` never returns it.
- Write large payloads with `writeFileBinary`; the container `writeFile` passes data as an argv element and hits `ARG_MAX`.
- A custom image (`CreateSandboxConfig.image`, #253) is a row's pinned digest resolved by `sandbox-manager.ts`; never let a request name an image. See `src/images/AGENTS.md`.

## Isolation

- Containers get `NetworkMode: "none"` unless an admin enables `allowNetwork`; host sandboxes always have the host network. A sealed sandbox has no GitHub, by design.
- **No GitHub token ever enters a sandbox.** `cloneInto` clones through the egress proxy environment and `origin` stays the plain `https://github.com/…` URL.
- Commands Loxaic itself runs in a checkout use `gitSafeArgs` (hooks and fsmonitor off); the model writes `.git` freely.
- The `loxaic.user` label names the conversation owner (the row's `ownerId`), never whoever triggered the tool call.

## Lifecycle

- Only `SandboxGoneError` (`errors.ts`: container 404, missing host directory, executor `code: "gone"`) may mark a row `destroyed`. Every other failure propagates and leaves the row unchanged.
- `updateSandboxSettings()`/`applySandboxSettings` stop affected sandboxes, the extraction pool included, before `resetEngineCache()`; reset first and stops go to the wrong engine and orphan containers.

## Orphan sweep

- Tests must scope global sweeps (`ownerId`, `kind`) and never assert on their return counts; suites share one database and one engine.

## Killing commands

- On all three providers, never start a command whose signal is already aborted.
- An abort listener added after an await never hears an abort that already fired. `execInContainer` re-checks after `container.exec` (return without starting) and after attaching the listener (take the kill path); `exec-cancel.test.ts` covers each window.

## Tests

- In host-provider tests compare `pwd` against `realpathSync(workdir)` (macOS `/var` is `/private/var`); keep the logical path in `terminal.ready`.
- `exec-cancel.test.ts` must keep asserting an uncancelled wrapped command returns its own stdout, stderr and exit code.
