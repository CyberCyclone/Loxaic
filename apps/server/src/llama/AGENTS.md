# apps/server/src/llama

The managed llama.cpp router: runtime install, preset file, HF downloads, GGUF parsing, fit, eviction, context stages, MTP, load failures. Fake router and env seams: `apps/server/test-fixtures/AGENTS.md`.

## Names and scope

- The UI says "Host models"; code keeps `local` (tables, routes, testIDs, error codes). Do not rename.
- `local_models` is keyed `(host_id, id)`; scope every query to `LOXAIC_INSTANCE_ID` (`""` when unset).
- `LLAMA_MODE`: `managed` (default), `attach` (sidecar at `LLAMA_ROUTER_URL`; models volume must be mounted at the same path, the preset names files absolutely), `off`.
- A bare ref is usable only for a `ready` + enabled row. Tests insert one via `__tests__/servable-model.ts`; never loosen the rule.
- Every name sent to the router goes through `routerModelName` (":" to "@"); read `/models` back with `modelIdFromRouterName`. The router rewrites ":" names.

## The preset file (admin input to process arguments)

- **The preset is the only place admin input becomes process arguments, and one unknown key stops the router from booting**. `load-settings.ts` is a typed, range-checked whitelist, re-validated at render; an invalid row falls back to defaults.
- `mlock`/`no-mmap` are not preset keys (`load-mode` is); `kv-offload` is a bool. Confirm new keys against a real router.

## Router process and logs

- Start the router with a random `LLAMA_API_KEY` in a from-scratch env (never argv), bound to loopback; the key rides as the built-in provider's `apiKey`.
- Start it with `--models-max 0` (also `infra/docker/llama-router.sh`): Loxaic unloads, not llama.cpp.
- `router-log.ts`: synchronous whole-line appends; file 0600 and `logs/` 0700 regardless of umask; open with `O_NOFOLLOW`; one rotation at 10 MB, and if rotation fails keep appending without retrying per write.
- `log-verbosity = 4` is written only in managed mode for the bundled build (`verifiedLogs`), the one checked to log no prompts. `carriesPrompt` drops prompt-carrying lines before anything keeps them.

## Hardware and fit

- Never pick the CPU automatically: `auto` resolves to Metal/CUDA/Vulkan or `needs-gpu`; a GPU build whose `--list-devices` finds no GPU is an error. CPU needs `cpuAcknowledged`.
- Fit labels are server-side only (`fit.ts`); `unknown` is never "will fit".
- Every consumer of "what this model loads with" (preset, `footprintBytes`, `fitFor`, listing window) goes through `settingsForStage`/`effectiveSettings`, never `loadSettings`.

## Pinning

- Only enabled models pin; disabling unpins; unpinning unloads nothing (`routes/admin-local-models.ts`).

## Device loss and load failures

- Blame MTP only when the load actually drafted. Never refuse MTP ahead of time, nor for concurrency; explain failures instead (`load-failure.ts`).
- `gpu-job-limit.ts`: what a single `lockup_timeout` value covers comes from `modinfo -p amdgpu` (`parseModinfo`); with no answer it is unknown. The server decides `short`; report only for managed Vulkan. Device-loss chat text names neither GPU nor limit (viewers see it).

## Downloads and GGUF (untrusted input)

- Verify HF's LFS sha256 before the rename, unconditionally; a GGUF with no oid is not offered (`groupQuants`) and refused again in `run()`.
- Paths carry the revision (`<repo>/<sha12>/<file>`); a size mismatch on an adopted file re-downloads. Rows sharing a file serialise on `inflightTargets`. A 200 to a `Range` request restarts from zero; cut off a transfer past its declared size in the stream.
- Read HF bodies with `hfFetchText` (capped, deadline covers the body), never `res.text()`.
- `gguf.ts` runs on the event loop: skip tokenizer arrays (`skipStrings`), bound every count and skip by `MAX_ARRAY` and file size, and read every key to the end of the key section (key order is not fixed).
- Read `HF_ENDPOINT`, `LLAMA_RELEASES_URL`, `LLAMA_RELEASES_FRESH_MS`, `LLAMA_DOWNLOAD_STALL_MS` at call time.
- `backfillHeaderFacts` never re-reads a stored fact (null included): a fix to `gguf.ts`/`shape.ts` parsing needs a migration that clears the affected `meta` fact.

## MTP heads

- Refuse `shared-` heads (`isSharedMtpHead`) when listing, at queue time, and again from the downloaded header.

## Context stages

- Non-admin cooldown `CONTEXT_STAGE_COOLDOWN_MS`; admins, `whenFull` and new-conversation step-downs are exempt (`checkStageRequest`). Only the same person's request replaces a pending switch; Cancel: starter, admin, or the conversation's editor (`pendingSwitch`).

## Runtime versions (`runtime.ts`, `releases.ts`)

- Every source installs through `installSource`. Never install an official build without GitHub's asset `digest` (`releaseBuild` refuses). Hold a custom build to the admin's SHA-256 when given; always record what it hashed to.
- Custom builds: https at every hop, enforced on stored rows too (`coerceCustomBuild` + `allowedBuildUrl`, and `fetchArchive` checks the first URL). Loopback http only under test-only `LOXAIC_TEST_HTTP_BUILDS=1`. `LLAMA_CUSTOM_RUNTIMES=off` disables them.
- Never return a custom build's URL to clients (host only; failures by error code).
- `assertContained` walks unpacked archives before running anything; judge symlinks by `linkDestination` (realpath, component by component), never by joining text. Run `tar` with `--no-same-owner --no-same-permissions`.
- Remove then write the install marker with `flag: "wx"`. `installedAt` trusts the directory: marker fields must match it and `bin` must resolve inside.
- `watchDisk` keeps 2 GB free: refuse up front, abort the download or kill `tar` at the margin.
- Match asset names only in `runtime-assets.ts`. Moving the pin: diff `common/arg.cpp`, `common/preset.*`, `tools/server/`; boot with every whitelisted key; recheck verbosity 4 logs no prompts.
- Every writer of the `localModels` settings row (`changeHostRuntime`, `updateLocalModelsSettings`) re-reads it first; drop a host's `runtimeByHost` entry once back on defaults.

## Extra options (`extra-options.ts`)

- Check keys against the running build's `--help` (`refreshOptions`). No option list: nothing can be set (409), except clearing or resending stored rows.
- `parseHelp` is one linear pass, no backtracking regex: help text is untrusted.
- `reservedReason` refuses, by any alias: every key Loxaic writes, router wiring, anything that downloads, serves or writes files, `log-*`/`verbose`, print-and-exit options, `chat-template*`, `lookup-cache-dynamic`. Never strip `no-` to find a reserved name.
