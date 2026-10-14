# apps/server/src/inference

Model requests, providers, the run scheduler, prompt-reuse and progress figures, thinking levels, and the mock backend. These rules cover what breaks silently here.

## Transport

- Send every model request through `transport.ts` (`inferenceFetch`), never the global `fetch`: undici's 300 s header/body timeouts cut off long prompt evaluation (llama.cpp sends no headers until prefill ends).
- The transport's undici `Agent` and `fetch` must come from the same npm `undici` package; mixing with Node's bundled fetch breaks across undici majors (Electron's Node 20 vs dev Node 24).
- Both timeouts are `INFERENCE_TIMEOUT_CEILING_MS` (1 h). Never 0 (a wedged backend holds the slot forever) and never lowered toward 300 s.
- Quick probes (`/props`, `/v1/models`) stay on the global fetch with their own short timeouts.
- `liveStream`'s `finally` must cancel the stream reader, not just release it, or the backend keeps generating for nobody.
- Do not rely on fetch's `signal` alone: undici can drop its abort link after GC. `AbortableRequest` wraps the dispatcher per request and calls undici's `abort` from its own listener; keep its state per dispatch and settle only when the final redirect hop ends.
- On that path a mid-stream Stop surfaces as `TypeError: terminated`; consumers must test `name === "AbortError" || signal.aborted`, never the name alone.
- Network-failure sentences name only the error code, never undici's message (it carries the backend `host:port` and reaches shared viewers).
- undici timers have ~1 s resolution; tests of short timeouts need delays of seconds.

## Providers

- The built-in provider is not a row: `defaultProvider()` in `providers.ts` synthesizes it (id `default`, slug null) at call time. `INFERENCE_BASE_URL` is only converted once into an added provider at boot.
- An unresolvable model reference is a typed error, never a fallthrough to the built-in backend (llama.cpp ignores `model` and answers with whatever is loaded).
- A local model is usable only when `status = ready AND enabled`, enforced at send time in `resolveLocalRef`; otherwise `local_model_unavailable`. `"default"` resolves to the first servable model.
- `baseUrl` includes its version segment: a bare origin gets `/v1` appended; a versioned path is left as typed.
- Send `nativeRoot` probes (LM Studio-native, `/props`) only for a provider with no preset; a hosted API burns a timeout on a 404 each refresh.
- No SSRF guard on provider base URLs, deliberately (admin-only; LAN hosts are the use case). Only http/https; refuse credentials in the URL.
- **Custom headers refuse `authorization`, every name in `CREDENTIAL_HEADERS`, hop-by-hop headers and any CR/LF**: headers are stored in the clear and returned to every admin.
- Keyed provider fetches use `redirect: "error"`.
- Decrypt keys with the cached scrypt derive in `provider-secrets.ts`; an uncached sync scrypt per request stalls the event loop.
- Scrub upstream error text before it becomes an Error (it is persisted and shown to all viewers); replace a 401/403 from an added provider with our own sentence; scrub `lastError` the same way.
- Read provider rows through the short async TTL cache, resolved per request, not per run: deleting a provider must stop an in-flight run's spend, and a boot snapshot breaks clusters.
- The run path never fans out: `getModelInfo(ref)`/`resolveWindow(ref)` touch only the ref's provider. Only `GET /v1/models` asks all, in parallel, a failure contributing an empty list.
- On the run path, invalidate only the request's own provider (`invalidateBackendModels(providerId)`); a provider write may clear all.
- `format: "gguf"` only when the backend answered `/props`, never on "has no preset".
- A failed Test reports the endpoint the admin configured, never the LM Studio probe's `/api/v0/models`.
- A hosted model reports `loaded: true`; built-in models are listed first (clients pick the first loaded model).
- A non-null allowlist doubles as the manual model list when `/models` fails; an empty array means unset (null = all).
- A provider slug is fixed at creation and stored in every `slug::model` ref; deleting a provider and recreating it under the same name rebinds them.

## Context windows

- An added provider's unknown window is `null`, not the 8192 fallback; `windowFor` refuses a `context_source: "default"` figure for compaction (`context_tokens` is display-only).
- Precedence in `withConfiguredWindow` (`models.ts`): llama.cpp's allocated window, admin size for the model, provider-declared, then `"*"`. `"*"` never overrides a declared size; the result is `context_source: "configured"`.
- Configured windows apply when the list is fetched, after the allowlist; every provider write must clear the model cache.
- `context.ts` never tallies images (backend-specific cost); documents are tallied via `textOfContent`.
- `ContextBreakdown.tool_sources` (`tallyToolSources`/`splitToolTokens`, largest remainder) is emit-only and must sum exactly to the `tools` part. An MCP entry carries the server id, never its name (the breakdown reaches shared viewers).
- `context_overflow` is recognised by `context-overflow.ts` from known provider bodies only, never text that merely mentions context.

## Scheduler

- `scheduler.ts`, not `streams/registry.ts`, stops two conversations interleaving on one backend's cached prefix.
- Schedule by run, never by model call: a turn and all its tool iterations hold one slot, tool execution included (deliberate).
- A run waiting on a human releases its slot via `slot.yieldWhile` and re-enters at the front.
- One queue per provider; `providerId` defaults to `"default"` on `acquireRunSlot`/`resolveMaxConcurrent`/`schedulerState`.
- Built-in concurrency: `INFERENCE_MAX_CONCURRENT_RUNS` > admin setting > `/props` `total_slots` > 1. Added provider: row's `maxConcurrentRuns` > authed `/props` > 1, never the env var. Never default above 1: over-estimating thrashes the cache silently.
- An unresolvable provider gets 1 and is never probed (`probeTotalSlots(undefined)` means the built-in backend).
- `acquireRunSlot` returns null on abort, never throws; only `yieldWhile` throws `RunSlotAbortedError`, caught by type. Let anything else propagate.
- `enter()` re-checks abort after its await and again after registering the listener, via a function call so TS narrowing does not elide it.
- Anything that holds or waits in the queue and then leaves must `pump()` (`onAbort` does for waiters).
- `onAdmitted` fires on the fast path, after a wait, and on `yieldWhile` re-entry; wire both `onQueued` and `onAdmitted` to the registry.
- `run.queued` carries a 1-based place, re-emitted as the queue moves, cleared by `iteration`.

## Host-model requests (provider.ts)

- Every built-in request asks the router `/models` first; fake backends in tests must answer it.
- Call `trackRequest` before `ensureRoom`, so an admin Unload cannot land in between.
- Wait for an in-progress discard of the model (`afterDiscard`) before `ensureRoom`; a stop ends the wait, not the discard.
- `streamCompletion` rethrows a load failure with the explanation sentence, stored as the backend's words.
- llama.cpp's device-lost errors become a sentence naming neither the GPU nor the job limit (shown to shared viewers).

## Thinking levels

- Offer only levels a model is known to take (`thinking.ts`); send no field for a model with none (hosted APIs 400 on unknown fields).
- Parse chat templates with the linear `tagBodies` scan, never a regex (catastrophic on unclosed tags); cap at `MAX_CHAT_TEMPLATE_CHARS`; read listing/`/props` bodies through `readCapped`.
- A send without `thinking_level` gets `DEFAULT_THINKING_LEVEL` (Medium), never the template's default.
- llama.cpp: `reasoning_effort` (`"none"` = off); off also sends `chat_template_kwargs.enable_thinking: false`; toggle-only templates get `enable_thinking: true` for on.
- Clamp an unoffered level with `effectiveThinkingLevel` (nearest, cheaper of two), identically on server and client.

## Usage and progress figures

- Null means "not reported", never 0: `cached_tokens`, draft acceptance (`draft_tokens`/`draft_accepted_tokens`) when nothing was drafted. Never add `?? 0`.
- Never derive `prompt_tps` as `prompt_tokens / ttft`; use `timings.prompt_per_second` or null.
- `reusable_tokens` (`prompt-reuse.ts`): a full-prefix extension reports the previous request's `prompt_tokens`; an earlier break reports 0, never an estimate. Traces are an in-memory LRU; after a restart claim nothing.
- `prefill-rate.ts`'s ETA may use `(prompt_tokens − reusable)/ttft` only on an exact strict extension with ≥256 evaluated tokens and no load. Never store it, show it as a rate, or feed `prompt_tps`.
- Progress uses `return_progress: true` on the completion stream, never a `/slots` poll. Request it only from a backend that identified itself (`modelRunInfo`'s `nativeRuntime`); `liveStream` refuses it for any preset (OpenAI 400s).
- Read progress until a report says the prompt is evaluated, not until output appears (an assistant prefill is echoed first). Omit `progress` when nothing was reported.
- Throttle re-emits to one a second (`promptProgressEmitter`), always sending the first report and the first 100%; latch that exemption.
- `remaining_ms` is null once nothing is left and below `MIN_EVALUATED_TOKENS`.
- LM Studio reports no progress or cache figures over HTTP; do not re-probe.

## Mock backend

- `MOCK_INFERENCE` applies only to the built-in provider; added providers stay live. An enabled local model with a router running still goes to the router (`servedByLocalRouter`).
- Keep the mock untidy: tool-call text ends in a newline, tool args in an order jsonb won't keep, timings fractional. `prompt-prefix.test.ts` has a canary.
- The slow path (`MOCK_SLOW_MATCH`, "take your time") must honour the abort signal.
- Keyword triggers (`MOCK_QUESTIONS`, `MOCK_PROGRESS_MATCH`, `classifier-*`, "fill/overflow/exceed the context") live in `provider.ts`; notices (instructions, skills) are stripped before triggers match.
- `MOCK_SCENARIOS_FILE` (`mock-scenarios.ts`) drives multi-step tool calls; read at call time. Compute `stepIndex` once in `mockStream` and walk steps by call counts, never index steps by it. A step fires only if every one of its calls' tools is offered.

## Tests

- Provider tests: unique names, assert "contains", delete only by own `createdBy`/base URL. Dead base URL is `http://127.0.0.1:1`, never a blackhole address.
