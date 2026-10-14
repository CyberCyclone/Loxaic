# apps/server/src/sandbox

Sandbox providers behind `provider.ts`'s `SandboxHandle`/`SandboxProvider`: containers (`container-engine.ts` mechanics, `container-provider.ts` policy), host directories (`host-provider.ts`) and the user's own machine (`executor-provider.ts`), plus the git checkout (`git.ts`). Rules here cover isolation, lifecycle and killing commands.

## Providers

- Execute through `SandboxHandle`/`SandboxProvider`, never a raw `Docker.Container`. Container vs host is `getSandboxMode()` at call time; host is an explicit `SANDBOX_MODE=host` opt-in.
- Never let a caller choose the provider kind per request; derive it from `getSandboxMode()`.
- Choose `executor-provider.ts` (`kind: "executor"`) only from the conversation's `local` workspace in `getConversationSandbox`, never from `SANDBOX_MODE`, a setting or a request field. Keep `"executor"` out of `SandboxMode`, so `POST /v1/sandboxes` cannot mint one and `invalidatedKinds()` never returns it.
- Local workspaces ignore the server posture (`mode: off`, `allowNetwork`, `hostingBlockedReason()`), and executor rows are excluded from the per-user running cap.
- Keep `container-engine.ts` free of settings and the database; policy belongs in `container-provider.ts`. The executor imports the engine, and `settings.ts` would bundle `@loxaic/db` into `dist/executor.js` (`executor/__tests__/isolation.test.ts`).
- `exec` and `openTerminal` default to `handle.workdir` in every provider when no directory is named (container: `/home/loxaic/repo`, which the image creates).
- Write large payloads with `writeFileBinary`; the container `writeFile` passes data as an argv element and hits `ARG_MAX`.
- Derive whether a terminal is a PTY from the ref (`isContainerRef`), never by asking: `terminal.ready` goes out before the far side answers.

## Isolation

- Containers get `NetworkMode: "none"` unless an admin enables `allowNetwork`; host sandboxes always have the host network. A sealed sandbox has no GitHub, by design.
- **No GitHub token ever enters a sandbox.** `cloneInto` clones through the egress proxy environment and `origin` stays the plain `https://github.com/…` URL.
- Commands Loxaic itself runs in a checkout use `gitSafeArgs` (hooks and fsmonitor off); the model writes `.git` freely.
- Clone in full, never `--depth=1`; shallow breaks log, blame and diff.
- The `loxaic.user` label names the conversation owner (the row's `ownerId`), never whoever triggered the tool call.
- `SANDBOX_EXTRA_HOSTS` (`host:ip`, comma-separated) maps to `HostConfig.ExtraHosts`.

## Lifecycle

- `stop()` pauses and keeps everything; only `destroy()` discards. Every provider implements `isRunning()`, `exists()` (true when stopped), `start()` (throws when gone), `stop()` and `destroy()`.
- Only `SandboxGoneError` (`errors.ts`: container 404, missing host directory, executor `code: "gone"`) may mark a row `destroyed`. Every other failure propagates and leaves the row unchanged.
- Executor `attach()` and `exists()` throw when the machine is offline; "cannot ask" must never become "destroyed" (`markDeadRowsDestroyed`). Executor `stop()`/`destroy()` never touch the user's folder.
- A host `stop()` deletes its working directory; scope settings sweeps with `invalidatedKinds()`.
- Containers use `AutoRemove: false` and outlive the server; the boot sweep pauses ones a previous process left running.
- Keep `Init: true`: PID 1 `tail -f` ignores SIGTERM (every stop would wait for SIGKILL) and tini reaps orphans.
- `updateSandboxSettings()`/`applySandboxSettings` stop affected sandboxes, the extraction pool included, before `resetEngineCache()`; reset first and stops go to the wrong engine and orphan containers.

## Orphan sweep

- `sweepOrphanSandboxes()` finds rowless containers by the `loxaic.sandbox` label (container provider only).
- It must skip containers carrying `loxaic.executor`: no server row claims them, and the engine may be the user's own.
- It only considers containers created before this process started (`createdBefore`, default module load), compared on the engine clock in whole seconds, never milliseconds (`Created` rounds down).
- Tests must scope global sweeps (`ownerId`, `kind`) and never assert on their return counts; suites share one database and one engine.

## Image

- The `loxaic-sandbox` tag is a content hash of `sandbox.Dockerfile`; `ensureImage()` builds only when the tag is absent, so a fixed tag would never rebuild.
- `sandboxImage()` must not collapse the digest to a fixed tag when the build directory is missing.
- `ensureImage()` treats a progress entry with `errorDetail` as a failed build; the daemon reports failed steps there, not as dockerode's `err`.
- Test helper `sandboxImageReady()` (`__tests__/docker-available.ts`) checks the current tag, not the image name.

## Killing commands

- The Docker Engine API has no kill-exec on any engine. `execInContainer` wraps every exec in `setsid -w bash -c 'trap … EXIT; echo $$ > <pgidfile>; "$@"'` and cancels with a second exec that signals the process group.
- Use `setsid -w`, not bare `setsid` (exec would report success when the command starts). Don't `exec "$@"` in the wrapper.
- Record the PGID to a file from inside the new session; never `pgrep -f <marker>`, which matches `setsid` itself, outside the group.
- Kill the process group, not the pid. Host-provider children spawn `detached: true` and live groups are killed on process exit.
- Wrap every container exec, not only cancellable ones: timeouts use the same kill. Needs util-linux `setsid -w` (absent in busybox).
- On all three providers, never start a command whose signal is already aborted.
- An abort listener added after an await never hears an abort that already fired. `execInContainer` re-checks after `container.exec` (return without starting) and after attaching the listener (take the kill path); `exec-cancel.test.ts` covers each window.
- The killer waits, bounded, for the PGID file and is awaited to completion.
- For the executor, `ExecOptions.signal` rides beside the call, never on the wire; an abort sends `exec.cancel {id}`.

## Tests

- In host-provider tests compare `pwd` against `realpathSync(workdir)` (macOS `/var` is `/private/var`); keep the logical path in `terminal.ready`.
- `exec-cancel.test.ts` must keep asserting an uncancelled wrapped command returns its own stdout, stderr and exit code.
