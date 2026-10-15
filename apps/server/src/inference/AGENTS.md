# apps/server/src/inference

Model requests, providers, the run scheduler, prompt-reuse and progress figures, thinking levels, and the mock backend. These rules cover what breaks silently here.

## Transport

- Send every model request through `transport.ts` (`inferenceFetch`), never the global `fetch`: undici's 300 s header/body timeouts cut off long prompt evaluation (llama.cpp sends no headers until prefill ends).
- Quick probes (`/props`, `/v1/models`) stay on the global fetch with their own short timeouts.
- On the transport path a mid-stream Stop surfaces as `TypeError: terminated`; consumers must test `name === "AbortError" || signal.aborted`, never the name alone.
- Network-failure sentences name only the error code, never undici's message (it carries the backend `host:port` and reaches shared viewers).
- undici timers have ~1 s resolution; tests of short timeouts need delays of seconds.

## Providers

- No SSRF guard on provider base URLs, deliberately (admin-only; LAN hosts are the use case). Only http/https; refuse credentials in the URL.
- **Custom headers refuse `authorization`, every name in `CREDENTIAL_HEADERS`, hop-by-hop headers and any CR/LF**: headers are stored in the clear and returned to every admin.
- Keyed provider fetches use `redirect: "error"`.
- Scrub upstream error text before it becomes an Error (it is persisted and shown to all viewers); replace a 401/403 from an added provider with our own sentence; scrub `lastError` the same way.
- On the run path, invalidate only the request's own provider (`invalidateBackendModels(providerId)`); a provider write may clear all.
- The run path never fans out: it asks only the ref's own provider (`getModelInfo(ref)`, `resolveWindow(ref)`). Only `GET /v1/models` asks every provider (`listBackendModels`); never call that from `streams/runs`.
- Resolve a ref's provider per request (inside `streamCompletion`), never once per run: deleting a provider must stop the spend of a run already in flight.

## Context windows

- Configured windows apply when the list is fetched, after the allowlist; every provider write must clear the model cache.
- `ContextBreakdown.tool_sources` (`tallyToolSources`/`splitToolTokens`, largest remainder) is emit-only and must sum exactly to the `tools` part. An MCP entry carries the server id, never its name (the breakdown reaches shared viewers).

## Scheduler

- A run waiting on a human releases its slot via `slot.yieldWhile` and re-enters at the front.
- `acquireRunSlot` returns null on abort, never throws; only `yieldWhile` throws `RunSlotAbortedError`, caught by type. Let anything else propagate.
- Anything that holds or waits in the queue and then leaves must `pump()` (`onAbort` does for waiters).
- `onAdmitted` fires on the fast path, after a wait, and on `yieldWhile` re-entry; wire both `onQueued` and `onAdmitted` to the registry.
- `run.queued` carries a 1-based place, re-emitted as the queue moves, cleared by `iteration`.
- Re-check a value an await can change through a function call (`const stopped = () => signal.aborted`), never by reading the property again: TypeScript narrows it after the first check and the re-check reads as dead code.

## Host-model requests (provider.ts)

- Every built-in request asks the router `/models` first; fake backends in tests must answer it.
- llama.cpp's device-lost errors become a sentence naming neither the GPU nor the job limit (shown to shared viewers).

## Thinking levels

- Parse chat templates with the linear `tagBodies` scan, never a regex (catastrophic on unclosed tags); cap at `MAX_CHAT_TEMPLATE_CHARS`; read listing/`/props` bodies through `readCapped`.
- A send without `thinking_level` gets `DEFAULT_THINKING_LEVEL` (Medium), never the template's default.
- Clamp an unoffered level with `effectiveThinkingLevel` (nearest, cheaper of two), identically on server and client.

## Usage and progress figures

- Null means "not reported", never 0: `cached_tokens`, draft acceptance (`draft_tokens`/`draft_accepted_tokens`) when nothing was drafted. Never add `?? 0`.
- Never derive `prompt_tps` as `prompt_tokens / ttft`; use `timings.prompt_per_second` or null.
- Progress uses `return_progress: true` on the completion stream, never a `/slots` poll. Request it only from a backend that identified itself (`modelRunInfo`'s `nativeRuntime`); `liveStream` refuses it for any preset (OpenAI 400s).
- LM Studio reports no progress or cache figures over HTTP; do not re-probe.

## Mock backend

- Keyword triggers (`MOCK_QUESTIONS`, `MOCK_PROGRESS_MATCH`, `classifier-*`, "fill/overflow/exceed the context") live in `provider.ts`.

## Tests

- Provider tests: unique names, assert "contains", delete only by own `createdBy`/base URL. Dead base URL is `http://127.0.0.1:1`, never a blackhole address.
