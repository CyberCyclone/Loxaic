# apps/server/src/llama

The managed llama.cpp router: runtime install, preset file, HF downloads, GGUF parsing, fit, eviction, context stages, MTP, load failures. Fake router and env seams: `apps/server/test-fixtures/AGENTS.md`.

## Names and scope

- The UI says "Host models"; code keeps `local` (tables, routes, testIDs, error codes). Do not rename.
- `local_models` is keyed `(host_id, id)`; scope every query to `LOXAIC_INSTANCE_ID` (`""` when unset).
- `LLAMA_MODE`: `managed` (default), `attach` (sidecar at `LLAMA_ROUTER_URL`; models volume must be mounted at the same path, the preset names files absolutely), `off`.
- A bare ref is usable only for a `ready` + enabled row. Tests insert one via `__tests__/servable-model.ts`; never loosen the rule.
- Build the listing from our rows (`listing.ts`); ask the router only for live state. `/props` needs `?model=`; its `n_ctx` is already per slot.
- Every name sent to the router goes through `routerModelName` (":" to "@"); read `/models` back with `modelIdFromRouterName`. The router rewrites ":" names.

## The preset file (admin input to process arguments)

- **The preset is the only place admin input becomes process arguments, and one unknown key stops the router from booting**. `load-settings.ts` is a typed, range-checked whitelist, re-validated at render; an invalid row falls back to defaults.
- `mlock`/`no-mmap` are not preset keys (`load-mode` is); `kv-offload` is a bool. Confirm new keys against a real router.
- `GET /models?reload=1` unloads every loaded model whose section changed, even mid-reply: `syncPreset` defers while a built-in run holds a slot and a touched model is loaded, ignoring the stage-switch holder (`builtinRunsActive`).
- `syncPreset` is serialised and names its temp file per call.
- `checkMtpSetting` and `checkTableSetting` run only where an admin writes, never inside `normalizeLoadSettings`, whose invalid-row fallback drops every setting.
- Saving a loaded model reloads it: `syncPreset({ restoreLoaded: true })` keeps the ids the reload will unload; `reloadNow` restores unpinned ones still in the preset. A deferred reload keeps the set; end flag, timer and set together (`endDeferredReload`). A refused reload clears the set. Only an admin write requests a restore.

## Router process and logs

- Start the router with a random `LLAMA_API_KEY` in a from-scratch env (never argv), bound to loopback; the key rides as the built-in provider's `apiKey`.
- Start it with `--models-max 0` (also `infra/docker/llama-router.sh`): Loxaic unloads, not llama.cpp.
- Write `LLAMA_DIR/router.pid`; reap a stale pid only if `ps` shows our preset path in its command line.
- `router-log.ts`: synchronous whole-line appends; file 0600 and `logs/` 0700 regardless of umask; open with `O_NOFOLLOW`; one rotation at 10 MB, and if rotation fails keep appending without retrying per write.
- `log-verbosity = 4` is written only in managed mode for the bundled build (`verifiedLogs`), the one checked to log no prompts. `carriesPrompt` drops prompt-carrying lines before anything keeps them.
- Keep one partial-line carry-over per stream (`lineSplitter`); stdout and stderr are read separately.
- Placement comes from llama.cpp's allocation log (`placement.ts`), never our estimates and never re-read from the log tail.
- A restart requested during a restart is queued, never folded in (`ensureRuntime`). Restart re-detects hardware; detecting no GPU clears the old device list.
- Keep `RuntimeView.state`'s old values for older clients (`restart` is the phase). Only pinned models reload after a restart.
- `residency.ts`: re-verify a cached child pid (parent, `--port`) before reading its fdinfo.
- `attach-router.test.ts` must start from a volume with a preset but no key: the only order in which `llama-router.sh`'s key wait is tested.

## Hardware and fit

- Never pick the CPU automatically: `auto` resolves to Metal/CUDA/Vulkan or `needs-gpu`; a GPU build whose `--list-devices` finds no GPU is an error. CPU needs `cpuAcknowledged`.
- Default devices are GPUs with at least `MIN_DEFAULT_DEVICE_BYTES` free at router start; fit labels use free memory now (`remeasureDevices`), counting our unpinned loaded models as reclaimable.
- Fit labels are server-side only (`fit.ts`); `unknown` is never "will fit".
- Every consumer of "what this model loads with" (preset, `footprintBytes`, `fitFor`, listing window) goes through `settingsForStage`/`effectiveSettings`, never `loadSettings`.
- `shape.ts`: treat any non-positive header size as missing (`pos()`). An unreadable header stores `shape: null` so boot backfill does not re-read it.
- Price an MTP head's KV as f16 whatever the model's cache type, and count it with the model's KV under `kv-offload` (`mtpKvBytes`).
- Never offer VRAM for the per-layer lookup table: the Vulkan override aborts the load.

## Eviction and pinning (`room.ts`)

- `ensureRoom` unloads unpinned models LRU-first, one at a time: `waitForModelStatus`, then re-list free memory before deciding again. Never decide on summed estimates.
- Never unload a model still loading or with a request in flight (`trackRequest`). Count a send before making room, or an Unload can slip in between.
- `ensureRoom` honours the run's abort signal.
- Refuse (`NoRoomError` to `local_model_no_room`) only when pinned models are in the way; never for a model too big for an empty GPU, nor `might-fit`.
- The send-time check (`assertModelUsable` to `checkRoom`) plans without unloading; routine saves use `assertModelResolvable`, which skips it.
- Pinned models stay loaded: `loadPinnedModels` on router healthy, after every preset reload, and on pin. Only enabled models pin; disabling unpins; unpinning unloads nothing. Unload is 409 while pinned, loading or answering.

## Device loss and load failures

- Check device loss before load failure, reading the child's own log too.
- On loss, `discardLostModel` unloads in the background ignoring in-flight counts and pins, reloads a pinned one, and treats only `loaded` as still holding the device. A stuck unload goes to `stuckAfterLoss` (not `loadErrors`, which clear on `loaded`).
- `isLoadFailure` matches only `model name=<name> failed to load`; attachment decode errors also say "failed to load".
- `explainModelLoadFailure` reads only lines after the newest spawn line for that model; another model spawned on the same port ends them (`lostDevice` too).
- Blame MTP only when the load actually drafted. Never refuse MTP ahead of time, nor for concurrency; explain failures instead (`load-failure.ts`).
- `gpu-job-limit.ts`: what a single `lockup_timeout` value covers comes from `modinfo -p amdgpu` (`parseModinfo`); with no answer it is unknown. The server decides `short`; report only for managed Vulkan. Device-loss chat text names neither GPU nor limit (viewers see it).

## Downloads and GGUF (untrusted input)

- Verify HF's LFS sha256 before the rename, unconditionally; a GGUF with no oid is not offered (`groupQuants`) and refused again in `run()`.
- Paths carry the revision (`<repo>/<sha12>/<file>`); a size mismatch on an adopted file re-downloads. Rows sharing a file serialise on `inflightTargets`. A 200 to a `Range` request restarts from zero; cut off a transfer past its declared size in the stream.
- Read HF bodies with `hfFetchText` (capped, deadline covers the body), never `res.text()`.
- `gguf.ts` runs on the event loop: skip tokenizer arrays (`skipStrings`), bound every count and skip by `MAX_ARRAY` and file size, and read every key to the end of the key section (key order is not fixed).
- `isProjectorFile`: "mmproj" as a word anywhere. `isMtpHeadFile` files are excluded from quant grouping.
- Read `HF_ENDPOINT`, `LLAMA_RELEASES_URL`, `LLAMA_RELEASES_FRESH_MS`, `LLAMA_DOWNLOAD_STALL_MS` at call time.
- `backfillHeaderFacts` never re-reads a stored fact (null included): a fix to `gguf.ts`/`shape.ts` parsing needs a migration that clears the affected `meta` fact.

## MTP heads

- An embedded head (`mtpSource`) needs `nextn_predict_layers > 0` and a `blk.N.nextn.` tensor.
- Refuse `shared-` heads (`isSharedMtpHead`) when listing, at queue time, and again from the downloaded header.
- A head is its own job (`${id}#mtp`); never re-queue the model row (it would leave the preset and unload). 409 for a head on a failed model.
- `presetLines` writes MTP lines only once the head is ready; a removed, refused or failed head turns MTP off (`settingsWithoutHead`).

## Context stages

- A stage is model-wide: switching reloads for everyone. A switch takes the built-in queue exclusively (`acquireExclusiveSlot`), writes the stage, rewrites the preset, loads (`loadWithRoom`), then warms the cache.
- `cancelled` means nothing changed: a stopped or failed switch restores the stage via `putBack`.
- Refuse YaRN stages while base settings carry `rope-freq-scale` (same llama.cpp parameter); trained context is advice.
- `applyStageChange`'s `onWaitEnded` must also fire when the wait is withdrawn.
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
- Downloading changes nothing; `runtime/select` refuses a version not on disk; pin a build only after the switch is accepted.
- A chosen build that dies before its first health check goes to `error` (`explainRouterExit`): no retry, no fallback, selection kept.
- Ask `--version` before `--list-devices`; catch `execFile` throwing ENOEXEC; a listing or `--help` cut off by timeout or `maxBuffer` is an error, never a shorter list (`listDevicesOutcome`, `helpOutcome`).
- `LOXAIC_LLAMA_SERVER_BIN` replaces the bundled build only. A disk-only release has `prerelease: null`, not `false`.

## Extra options (`extra-options.ts`)

- Check keys against the running build's `--help` (`refreshOptions`). No option list: nothing can be set (409), except clearing or resending stored rows.
- `parseHelp` is one linear pass, no backtracking regex: help text is untrusted.
- Store keys as typed (dashes trimmed), never as another alias (`no-warmup` vs `warmup`); detect duplicates by option.
- `reservedReason` refuses, by any alias: every key Loxaic writes, router wiring, anything that downloads, serves or writes files, `log-*`/`verbose`, print-and-exit options, `chat-template*`, `lookup-cache-dynamic`. Never strip `no-` to find a reserved name.
- `extraOptionLines` re-checks on every write: unknown keys are left out (`extraOptionsSkipped`) and may pass through a save unchanged (`kept`).
