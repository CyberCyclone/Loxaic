# AGENTS.md

**This file is the source of truth** for architecture, conventions, and gotchas.
([`HANDOVER.md`](HANDOVER.md) is a legacy document kept for historical context only.)

## Project in one line

Self-hosted, multi-user AI platform — a Claude + Claude Code replacement: llama.cpp
inference, a real agent tool-calling loop with sandboxed execution, one universal Expo
frontend (iOS/Android/Web/Electron), reachable remotely over Tailscale (or your own
reverse proxy).

## Layout

- `apps/server` — Fastify API + WS (chat + agent tool loop) + routines scheduler + agent sandbox providers (`src/sandbox/`)
- `apps/mobile` — the one frontend (Expo + expo-router + gluestack-ui v5), targets iOS/Android/Web
- `apps/desktop` — the deployment artifact: an Electron GUI, a `--headless` entry (`src/headless.js`), and a
  service supervisor (`src/supervisor/`) that brings up an embedded Postgres + the bundled server so the app
  is self-contained with no Docker/Postgres install required; also embeds a Tailscale sidecar
- `packages/agent` — tool definitions, permission-mode logic (shared by server + client); the wire event
  union (`StreamEventKind`) lives in `packages/types` instead
- `packages/api-client` — typed REST + WS client used by `apps/mobile`
- `packages/db` — Drizzle schema + re-exported query operators
- `packages/sync` — fork/conflict detection for the offline sync protocol
- `packages/types` — shared primitive types (`ContentBlock`, `Result`, etc.)
- `packages/config-ts` — shared tsconfig bases
- `infra/` — Dockerfiles, the `tsnet-proxy` Go module (Electron's embedded Tailscale sidecar), Tailscale Serve config
- `design/` — the original static HTML/CSS prototype; historical reference only, not built or imported by anything

There is no separate web app and no separate UI package — `apps/mobile`'s Expo web
export **is** the web app, served same-origin by `apps/server` (see HANDOVER.md).

## Commands

```bash
pnpm install
pnpm dev                          # turbo: server (4000) — mobile/web/desktop have their own dev scripts, see HANDOVER.md
docker compose up --build         # db + server (serves API + web same-origin) + inference + ntfy
pnpm --filter @shannon/mobile web # Expo web dev server (localhost:8081)
pnpm --filter @shannon/mobile ios # or android

pnpm --filter @shannon/desktop dev         # self-contained desktop app, dev mode (embedded stack, Metro web build)
pnpm --filter @shannon/desktop package     # prod build: mac dmg, linux AppImage + deb, windows nsis (untested)
pnpm --filter @shannon/desktop package:dir # prod, unpacked — faster iteration, what the e2e suite drives

pnpm test        # turbo test — vitest (only apps/server + apps/desktop have tests today)
pnpm lint        # turbo lint — eslint (apps/server)
pnpm typecheck   # turbo typecheck — tsc --noEmit across all packages
```

Tests are Vitest, colocated under `__tests__/` dirs. Run one package or one test:

```bash
pnpm --filter @shannon/server test               # all server tests
pnpm --filter @shannon/server test -- authz      # tests matching "authz"
pnpm --filter @shannon/server test -- src/streams/__tests__/drivers.test.ts
```

End-to-end suites are WebdriverIO, in `apps/e2e`, and run on demand (never as part of
`pnpm test`). They stand the whole stack up themselves:

```bash
pnpm --filter @shannon/e2e test:web        # see apps/e2e/README.md for setup + env vars
E2E_SELF_CONTAINED=1 pnpm --filter @shannon/e2e test:electron  # against the packaged app's own embedded stack
```

## End-to-end tests

**Every feature PR adds or updates e2e coverage for the behaviour it changes**, and carries
screenshots showing that behaviour working. Writing those tests is the implementer's job
(human or AI) — the harness already exists, so this is normally a spec file and a few
`testID`s, not new infrastructure.

- **Tests** live in `apps/e2e/src/specs/`. Select by `testID` using the helpers in
  `src/helpers/` — never by CSS class, text position, or list index (the message list is
  inverted and virtualised, so position is not stable). New interactive elements need a
  `testID` following the convention in Gotchas above.
- **Screenshots** are captured with `shot('name')` at the moments that actually evidence the
  feature — the state that would look wrong if it regressed, not just the happy end state.
  Failures are captured automatically.
- **Screenshots are never committed.** `apps/e2e/artifacts/` is gitignored; embed the PNGs in
  the PR description instead, straight from that directory.
- If a change genuinely isn't user-visible, say so in the PR rather than skipping the section.

## Gotchas

### TypeScript + React Native

- **JSX files must use `.tsx`** — TypeScript ignores JSX in `.ts` files.
- **Relative imports in packages with no build step** (`packages/db`, `packages/agent`,
  `packages/sync`) **must include the `.ts` extension** (`from "./schema.ts"`, not
  `from "./schema"`). These packages ship raw TS — `apps/server`'s bundler (tsup) leaves
  them external, so they run under Node's native TypeScript support in production, which
  follows real ESM resolution rules (dev's `tsx` loader is more forgiving and won't catch
  a missing extension).
- **`expo-image-picker` is native-only.** Its web implementation creates a transient hidden
  `<input type="file">` at click time and clicks it programmatically — no stable element to
  attach a `testID` to, and nothing for e2e to drive. The composer's attach control is split
  per-platform instead (`components/composer/AttachButton.tsx` / `.web.tsx`, same convention as
  `ImageViewer.tsx` / `.web.tsx`): native keeps the camera/library actionsheet over
  `expo-image-picker`, web renders a real, persistent `<input type="file">`
  (`composer.attach.input`) that `apps/e2e/src/helpers/attachments.ts` drives directly.

### testIDs and e2e selectors

- **Naming scheme:** dot-separated `area.element[.qualifier]`, lowerCamel per segment
  (`login.submit`, `agent.mode.manual`, `sidebar.nav.chat`). `area` is the screen or shared
  component family (`login`, `composer`, `chat`, `agent`, `sidebar`, `shell`); `qualifier`
  is used for items generated from an existing data array (`MODES`, `NAV_ITEMS`) — never an
  invented string.
- **testID goes on the interactive element the user actually touches** (the real
  `InputField`/`TextareaInput`/`Pressable`/`Button`), not a decorative wrapper — except for
  assertion anchors that have no interactive element of their own (a message bubble, an
  error `Text`).
- **Web/Electron selector caveat:** most `apps/mobile/components/ui/**` wrappers spread
  `{...props}` straight through, so `testID` reaches react-native-web's `Button`/
  `Pressable`/`Input`/`Textarea`/native `FlatList`, which map it to the DOM attribute
  `data-testid` automatically. But `box`, `heading`, `hstack`, `vstack`, and `text` have
  `.web.tsx` overrides that render a raw DOM element directly (`<div>`, `<span>`, `<h1>`–
  `<h6>`) — those five have been patched by hand to also emit `data-testid={testID}`, so
  every testID resolves to `[data-testid="…"]` on web regardless of which wrapper it's on.
  **If gluestack is ever re-vendored/regenerated, this patch is lost and must be re-applied**
  to those five `index.web.tsx` files. `icon`'s `.web.tsx` delegates to a third-party
  `PrimitiveIcon`/`Svg` layer instead of rendering DOM directly and is not patched — don't
  put a testID on an `Icon` element; put it on the `Pressable`/`Button` that wraps it.
- **Per-platform mapping:** web/Electron → `[data-testid="…"]`; Android → an **unprefixed**
  `resource-id`, found via UiAutomator2 (`new UiSelector().resourceId("id")`) — note Appium's
  `id` strategy prepends `<appPackage>:id/` and so never matches; iOS → `accessibilityIdentifier`,
  found via XCUITest's `accessibility id` strategy (`~id`). All three mappings are confirmed
  against real builds (see `apps/e2e/README.md`).
- Don't hand-roll these selectors in specs — use the helpers in `apps/e2e/src/helpers/`, which
  own the mapping.

### DB / Drizzle

- **Never import from `drizzle-orm` directly.** `packages/db` re-exports every operator
  (`eq`, `and`, `desc`, etc.) and the `db` instance — import from `@shannon/db`. Two
  drizzle-orm instances in the dependency tree cause type errors.
- **No `users` table** — the table is `user` (singular), owned by Drizzle like any other
  table (`packages/db/src/schema.ts`), not auto-created by better-auth: it's passed
  explicitly to `drizzleAdapter(db, { schema: { user, session, account, verification } })`
  in `apps/server/src/auth/index.ts`, and its columns (including the admin plugin's `role`/
  `banned`/`banReason`/`banExpires`) go through the normal migration flow. App tables
  reference `user.id`, which is `text`, not `uuid`. The first user to sign up (or any email
  listed in `ADMIN_EMAILS`) gets `role: "admin"` via a `databaseHooks.user.create.before`
  hook — an existing deployment's already-registered user does not retroactively become
  admin; use `ADMIN_EMAILS` or `UPDATE "user" SET role='admin'` to promote one.
- **`banned` is enforced by our own middleware, not by better-auth.** The admin plugin only
  checks it in `session.create.before` (i.e. at sign-in), so a ban applied out of band — the
  `UPDATE "user" SET banned = true` counterpart to the promotion above — would leave every
  live session working. `resolveSession()` in `apps/server/src/auth/middleware.ts` re-checks
  it on every authenticated request (403, expired bans treated as lifted). Route handlers get
  this for free by going through `authenticate`/`requireAdmin`; anything that calls
  `auth.api.getSession` directly does not.
- **Postgres/postgres.js returns `SUM()`/`AVG()` over `integer` columns as strings**
  (bigint/numeric precision preservation). Cast to `::float8` in SQL, not `::int` (avoids a
  32-bit overflow ceiling on lifetime token sums). Columns typed `real` parse natively.
- Migrations auto-run on server startup (`apps/server/src/db/migrate.ts`). Migration folder:
  `packages/db/drizzle/`. Run `pnpm --filter @shannon/db db:generate` after schema changes.

### Inference

- **Set `MOCK_INFERENCE=true`** for dev without llama.cpp. Mock mode drives the full agent
  tool loop too — it emits a real (fake) tool call when the prompt mentions one, so the
  approval/deny/auto/planning paths are all testable without a GGUF.
- Real inference needs llama.cpp started with `--jinja` (native OpenAI tool calling) at
  `INFERENCE_BASE_URL` (default `http://localhost:4002`). See `docs/RUNTIME.md` for the
  per-platform (Mac/Windows/Linux, Metal/CUDA/ROCm) setup matrix.

### Tool loop (Chat and Agent both)

- **Chat and Agent share one tool loop** — `apps/server/src/streams/runs/engine.ts`'s
  `runToolLoop`, parameterized by surface, base prompt, and `incognito`. The two starters
  (`chatRun.ts`, `agentRun.ts`) only differ in conversation setup and which system prompt
  they pass in; `agentRun.ts` additionally exposes planning/manual/auto modes. **Chat has no
  mode selector** — it always runs manual-mode approval semantics (write builtins and
  non-allowlisted MCP tools ask; read-only builtins run free).
- `packages/agent` owns the builtin `TOOLS` plus the `ResolvedTool`/`ToolSource` types; the
  server's per-run `Toolset` (`apps/server/src/mcp/registry.ts`) resolves names, approval
  policy, and dispatch for builtins and MCP tools alike (see "MCP servers" below). The wire
  event union lives in `packages/types` (`StreamEventKind`), not here.
- **"Allow always"**: an MCP tool patches its server's own per-tool policy
  (`PATCH /v1/mcp/servers/:id`, same allowlist the `/mcp` screen manages); a builtin patches
  the user's global allowlist instead — the `user_prefs.tool_allowlist` column, read by
  `buildToolset` (`apps/server/src/mcp/registry.ts`) and exposed via `GET`/`PATCH /v1/prefs`.
  This is global and mode-independent (it clears `requiresApproval`, not the `isWrite` gate),
  so it also silently benefits agent's manual mode — planning mode is unaffected since it
  filters on `isWrite` regardless of approval policy.
- Sandbox execution goes through `apps/server/src/sandbox/provider.ts`'s
  `SandboxHandle`/`SandboxProvider` interface — never a raw `Docker.Container`. Two
  providers: `container-provider.ts` (dockerode; Docker, Podman, OrbStack, Colima — any
  Docker-Engine-API-compatible socket, auto-discovered) and `host-provider.ts` (no
  isolation, agent commands run directly on the host — an explicit `SANDBOX_MODE=host`
  opt-in). Selected via `getSandboxMode()`, resolved at call time — see `docs/RUNTIME.md`.
- **Server-level settings** (`apps/server/src/settings.ts`) back the sandbox mode, engine,
  socket, and network toggle. Precedence is always **env > `server_settings` row >
  default**; an env-pinned field is rejected by the API with a `409` and rendered read-only
  in the GUI. Reads are sync against a cache loaded once at boot (`loadServerSettings()`),
  because `getSandboxMode()` is sync by contract. A failed load **fails closed** (mode
  resolves to `off`), because migrations only warn in non-strict mode and quietly falling
  back to the permissive default would restart execution an admin had disabled. Writes go
  through `PATCH /v1/admin/settings/sandbox`, which is **admin-only** (`requireAdmin`) —
  host mode and sandbox networking are deployment-wide security decisions, not per-user
  preferences, and **nothing may let a caller choose them per request**: `POST /v1/sandboxes`
  once accepted a `provider` field in the body, which let any signed-in user get host
  execution and bypass `mode: "off"` entirely. Derive the kind from `getSandboxMode()`.
- `updateSandboxSettings()` must apply as well as persist, **in this order**: stop the
  affected sandboxes *first*, then `resetEngineCache()`. Stopping a container means
  attaching through the engine that created it, so resetting first sends those calls to the
  new engine, which 404s, marks the row stopped anyway, and orphans a still-running
  container the boot sweep can never find (it only lists the current engine's containers).
  Scope the sweep with `invalidatedKinds()` — a host sandbox's `stop()` **deletes its
  working directory**, so a container-only change must not sweep host sandboxes.
- **Anything that authenticates must go through `apps/server/src/auth/middleware.ts`** —
  `authenticate`/`requireAdmin` for routes, `resolveSessionFromToken` for WebSocket
  handlers. Calling `auth.api.getSession` directly skips the ban re-check and leaves a
  banned user holding live sockets (including a sandbox terminal) until the session expires.
- Sandbox containers are created with **no network** (`NetworkMode: "none"`) unless an admin
  enables `allowNetwork` — everything in them is model-directed, so egress is an
  exfiltration path. Host sandboxes always have the host's network. `web_fetch` is
  unaffected: it always runs server-side behind the SSRF guard, never in the sandbox.
- Sandboxes are per-conversation, lazily created on first tool use, and **survive socket
  close** (reconnecting mid-task keeps the working directory) — see
  `apps/server/src/agent/sandbox-manager.ts`. An idle reaper stops them after 30 minutes.
  A sandbox row (`sandboxes` table) records which provider it belongs to; a mode switch
  mid-deployment makes old rows unusable rather than silently reattaching to the wrong kind.
  Ephemeral (incognito) conversations get a sandbox with **no Postgres row** — it is tracked
  only in-process — so a crashed server's leftover containers are only findable by their
  `shannon.sandbox` label; `sweepOrphanSandboxes()` does that sweep at boot (container
  provider only — host sandboxes are plain directories), alongside the stream log's own
  orphan recovery.
- `web_fetch` always runs on the **server**, never in the sandbox — container sandboxes
  have no network (`NetworkMode: none`) and host-mode ones deliberately aren't trusted with
  an unfiltered fetch either. It has a real SSRF guard (DNS-resolves and rejects
  private/loopback/link-local answers, follows redirects manually so every hop is
  re-checked).
- The container sandbox image (`shannon-sandbox`) builds itself automatically on first use
  if missing — nothing needs to build it ahead of time (`ensureImage()` in
  `container-provider.ts`).
- Incognito conversations are tool-capable too. `loadEphemeralHistory` (`engine.ts`) rebuilds
  the OpenAI message list — including resolved tool_call/tool_result pairs, dangling calls
  stripped exactly like the Postgres loader — from the stream log's folded snapshots rather
  than a DB query, since incognito writes nothing conversation-scoped to Postgres.

### File attachments

- **Uploaded bytes live on disk under `UPLOADS_DIR`; only metadata is in Postgres**
  (`attachments` table — `{id, owner_id, mime, size_bytes, filename, extract_status,
  extract_bytes, created_at}`). `UPLOADS_DIR` unset falls back to `<cwd>/uploads`, which in a
  checkout means `apps/server/uploads` — **inside the working tree, and gitignored for exactly
  that reason** (#65). Docker compose and the desktop supervisor both set it explicitly (the
  supervisor puts it under `dataDir` beside the Postgres data, never in the installed bundle,
  which an update would replace). A document's extracted text is cached beside the original as
  `<ref>.txt` — see extraction, below.
- **Client-supplied refs are validated at exactly one chokepoint**, `assertAttachmentsOwned`
  (`streams/authz.ts`), and it must run **before** any conversation/message write. It returns
  the mime **and filename** from the DB row — the client's copies are advisory and are
  discarded — de-duplicates repeated refs (the same ref four times is one attachment, not a 4×
  prompt), and renders unknown and not-yours as the same `NotFoundError`. `name` is omitted
  entirely (not sent as `""`) for a row predating documents.
- **`isValidRef` takes `unknown` and type-guards, deliberately.** `RegExp.test` stringifies,
  so a `string`-typed parameter is not a guard: `test(["<uuid>"])` coerces the single-element
  array back to the uuid and returns true. Anything arriving off a socket is a claim, not a
  fact — `validateSendAttachments` type-checks elements for the same reason.
- **Nothing is served with a caller-influenced content type**, and disposition now splits by
  class. Upload allowlists a mime (`IMAGE_MIMES`/`TEXT_MIMES`/`DOCUMENT_MIMES`, or an
  extension fallback via `resolveAttachmentMime` for browsers that report `""`), then
  `verifyStoredBytes` confirms it against the actual bytes — magic bytes for images/PDF
  (`sniffMime`), a streamed fatal-mode UTF-8 decode with no NUL byte for text — and the serve
  route adds `nosniff` and `Content-Security-Policy: default-src 'none'; sandbox` regardless of
  class. **Only images get `Content-Disposition: inline`; everything else is forced to
  `attachment`.** This split is load-bearing, not cosmetic: `text/html` and `text/xml` are
  extractable text mimes, and this endpoint is same-origin with the web app, so serving either
  `inline` would be same-origin stored XSS the day someone reaches for it. **SVG stays absent
  from every mime list for the same reason.**
- **Filenames are sanitized once, at upload** (`sanitizeFilename` — basename only, control
  characters stripped, length-capped) and read back from the DB row everywhere downstream: the
  model's prompt, the UI chip, and the `Content-Disposition` header. The client's copy is never
  trusted for any of the three.
- **Parsing runs inside a sandbox, never in the server process.** Text formats
  (`TEXT_MIMES`) are just UTF-8 bytes, decoded in-process — no parser, so they work with
  `SANDBOX_MODE=off`. Everything in `DOCUMENT_MIMES` (PDF, DOCX/XLSX/PPTX, ODT, RTF, EPUB)
  needs a real parser over a file the server did not author; `files/extract.ts` runs it in a
  pooled per-user sandbox — argv-safe `pdftotext` for PDF, the `shannon-extract` script baked
  into the image (`infra/docker/sandbox/extract.py`) for the rest — and the upload route
  **rejects document mimes outright when no sandbox is configured**, with a 415 naming why.
  Extraction reads and never executes: no macro, embedded script, or PDF JavaScript runs, and
  the container has no network to reach regardless.
- **Every document format except PDF and RTF is a zip container, so `extract.py` runs a
  decompression-bomb guard before opening one** — entry count, total declared uncompressed
  size, and per-entry compression ratio, all read from the central directory so nothing is
  inflated to reject it. The container's memory limit would eventually stop a bomb anyway, but
  as an OOM kill after burning the whole timeout; this fails in milliseconds with a reason.
  **Deliberately not markitdown**, which was the original plan: it takes `magika` (and so
  onnxruntime, numpy, pandas) as a *base* dependency — measured at 326 MB / 30 packages versus
  63 MB / 20 for the individual libraries — and ships no extras for ODT, RTF, or EPUB, so it
  would have cost 5× the image for fewer formats.
- **The sandbox copy of an upload is named for its format** (`<uuid>.xlsx`, not `<uuid>.in`).
  Several of these libraries dispatch on the *filename*, not the content: openpyxl flatly
  refuses a file that doesn't end in a spreadsheet extension, so a valid .xlsx silently
  extracted to `failed` until this was fixed. The extension comes from our own mime table,
  never from the user's filename.
- **A sandbox extractor writes to a file, and the result is read back in chunks** — never
  straight off stdout. `exec` caps what it returns at `MAX_OUTPUT_BYTES` (256 KB), well below
  what a long document legitimately extracts to, so reading stdout truncated mid-document *and*
  spliced the exec layer's own `[output truncated]` notice into the text cached as the
  document's. Chunks are base64'd because `exec` hands back an already-decoded string, and a
  chunk boundary landing mid-UTF-8-sequence would corrupt that character on every large file.
- **Documents need a *container*, and host mode does not count.** The upload gate is
  `mode === "container" && available`, not "some provider is configured": host mode has none of
  the container's protections — no `NetworkMode: none`, no uid separation, and the host provider
  ignores the resource limits entirely — so parsing an untrusted PDF there is parsing it on the
  server. Without a container the upload is **rejected** (415, `code: "sandbox_required"`) rather
  than stored as a file nothing can read, and the client renders that as a modal explaining why.
  Text formats are unaffected and still work with no sandbox at all. Extraction scratch files go
  under **`handle.root`**, never an absolute `/tmp` path: on the host provider that would be the
  real, shared host `/tmp`, briefly exposing one user's document bytes to anything else on the
  machine.
- **The extraction pool is a second set of live sandboxes**, independent of the conversation
  ones in `agent/sandbox-manager.ts`. `applySandboxSettings` has to stop *both* — before
  `resetEngineCache()`, per the ordering rule below — or an engine change strands pooled
  containers where the boot sweep can never find them, and a host→container switch leaks
  per-user directories still holding uploaded documents.
- **Extraction is cached at a different, larger ceiling than what reaches the prompt.**
  `MAX_CACHED_EXTRACTION_BYTES` (4 MB) bounds the `<ref>.txt` sidecar written at upload time;
  `MAX_EXTRACTED_BYTES` (256 KB) is the separate, smaller cap `attachmentContentParts` truncates
  to before a document's text enters a prompt. Collapsing these into one constant was a real
  bug here: caching at the smaller number would leave nothing for sandbox paging (below) to
  ever page through.
- **Document text enters the prompt wrapped in `<attached-file>` provenance markers**
  (`storage.ts`'s `wrapDocument`, modelled on `mcp/sanitize.ts`'s `wrapResult`) — a literal
  closing marker inside the body is neutralized with a zero-width space so the content can't
  escape its own wrapper, and a sibling system-prompt addendum tells the model the content is
  untrusted. A user's own upload still gets this treatment: they may not have written it.
- **Two independent prompt budgets, spent newest-first, never shared.** `MAX_HISTORY_IMAGE_BYTES`
  bounds images by raw bytes (their prompt cost is backend-specific patch embeddings, which is
  why `context.ts` refuses to tally them at all). `MAX_HISTORY_DOCUMENT_TOKENS` bounds documents
  by estimated tokens (they *are* tallied, via `textOfContent`) and is **derived from**, not
  independent of, the token-cost of one document at `MAX_EXTRACTED_BYTES` — it was once a flat
  number smaller than that single-document cost, meaning a user's very first attachment could
  exceed the whole budget and vanish from the turn that sent it. `selectAffordableAttachments`
  also caps a document's *measured* size at `MAX_EXTRACTED_BYTES` before estimating, since
  that's the ceiling on what actually reaches the prompt regardless of how large the cache is.
- **A truncated document can be paged through the sandbox, but only if one is already live.**
  When a document overflows `MAX_EXTRACTED_BYTES` and the conversation already has an active
  sandbox, `engine.ts`'s `writeOverflowToSandbox` writes the *full* cached text to
  `<sandbox>/attachments/<ref-prefix>-<name>.txt` and the truncation note names the path. The
  gate is "is a sandbox already active in this process" — `hasActiveSandbox`/
  `attachActiveSandbox` in `sandbox-manager.ts` — **never** "which surface", because chat and
  agent share one tool loop and either can have a sandbox; it must never *create* one, since an
  overflowing document is not sufficient reason to spin up a container. Uses `writeFileBinary`,
  not `writeFile` — the container provider's `writeFile` passes its payload as a bash argv
  element, capped by `ARG_MAX`, which a multi-megabyte document routinely exceeds.
- **`fs_read` pages by line via `offset`/`limit`, executed inside the sandbox, not read-then-sliced
  in JS.** The container provider's `readFile` is `cat` through `execInContainer`, itself capped
  at `MAX_OUTPUT_BYTES` (256 KB) — reading a large file fully before slicing in JS would hit that
  cap first and silently fail to page past it. Implemented as one `awk` pass that prints the
  requested range (numbered) to stdout and the total line count to stderr from its `END` block,
  so only the small requested slice needs to cross the output cap.
- **The sandbox image tag is a hash of `sandbox.Dockerfile`, not a fixed name.**
  `ensureImage()` only builds when the image is *absent*, so a fixed tag would mean a Dockerfile
  change (e.g. adding `poppler-utils` for `pdftotext`) never reaches a deployment that already
  built once — every PDF would then fail with a bare, undiagnosable exit 127. Confirmed this
  exact failure mode directly before the content-hash fix went in.
- **The orphan sweep (`files/reaper.ts`) is the only reclaim path there is** — no DELETE
  route, no cascade from message deletion. It collects uploads no message references after a
  grace period, which covers both the picked-then-abandoned upload and **every incognito
  attachment**: an incognito run writes no message rows, so nothing ever references its
  attachments, yet the upload row already records who uploaded them. The default grace matches
  `STREAM_TTL_SECONDS`' own 24h, so the sweep **bounds** that trace to the grace window
  rather than preventing it (#64). It also removes a document's `<ref>.txt` sidecar alongside
  the original — **the sweep's SQL keys on `block->>'kind' = 'attachment'`, so a future new
  block kind (rather than discriminating on mime within this one) would silently stop
  protecting those files from deletion.**
- **`?token=` on `/v1/files/:ref` is a full session token in a URL.** It exists because
  `<img>` can't set headers (same precedent as `/ws/chat?token=`), and the header is
  preferred when present. Fastify's default logger would write it to stdout on every
  thumbnail, so `logging.ts`'s `redactUrl` is installed as the `req` serializer — **any new
  route taking a credential in the query string must use a parameter name that module
  already knows.** Redaction covers the log only — the token is also live in the DOM as an
  `<img>` src for as long as a thread with images is open (#63).

### MCP servers

- The tool loop resolves tools through a per-run `Toolset` (`apps/server/src/mcp/registry.ts`),
  not the static union: builtins from `packages/agent` plus the user's enabled MCP servers
  (`mcp_servers` table), namespaced `slug__tool` (no builtin contains `__`, so they can't shadow).
- **Everything an MCP server produces is untrusted.** Descriptions/schemas are capped and
  control-stripped (`mcp/sanitize.ts`), results are byte-capped and wrapped in
  `<mcp-tool-result …>` provenance markers with escape attempts neutralized, and a system-prompt
  addendum tells the model to never follow instructions found inside. Model-produced arguments
  are ajv-validated against the declared schema before anything reaches the server.
- MCP tools ask for approval in **every** mode — auto included — until the user allowlists the
  specific tool; planning mode only offers tools the user marked read-only (server
  `readOnlyHint` annotations are display-only, never trusted). Tool-change detection
  (`mcp/change-detection.ts`) revokes allowlists when a tool's description/schema hash changes.
- Credentials are AES-256-GCM-encrypted at rest (`mcp/secrets.ts`, key from
  `MCP_ENCRYPTION_KEY`, fallback `BETTER_AUTH_SECRET`) and `redact()`-ed out of every error
  path. stdio children get a minimal env (`PATH`/`HOME` + row env + secrets), never
  `process.env`. HTTP transports re-run the SSRF guard per request unless the user confirmed
  `allowPrivateNetwork` in the GUI.
- Connections are cached per `userId:serverId` with an idle reaper (`mcp/client-manager.ts`,
  mirrors sandbox-manager); a dead/hung server fails only its own tool calls, never the run.
- Brave Search ships as a built-in catalog entry (`mcp/catalog.ts`) pinned to the official
  `@brave/brave-search-mcp-server` — spawned from the installed package's bin, never `npx`.
  The GUI lives at `/mcp` (mobile/web); per-conversation server switches are in the agent
  Inspector (`conversations.mcpOverrides`).
- Testing: `test-fixtures/mock-mcp-server.ts` is a deliberately hostile stdio fixture;
  `MOCK_INFERENCE=true` triggers `mockmcp__*` tool calls only when the registry actually
  offered them (see `MOCK_TOOL_TRIGGERS`); `src/mcp/__tests__/` covers units + a full-loop e2e.

### Electron

- Never `loadFile()`/`file://` for the packaged build — expo-router's client-side routing
  needs the History API and every asset path is absolute (`/_expo/...`), both of which
  break under `file://`. Use `electron-serve`'s `app://` scheme (already wired in
  `apps/desktop/src/main.js`).
- There's no server at the renderer's origin (`app://` in prod, `localhost:8081` in dev),
  so unlike the mobile/web builds Electron can't assume same-origin. The main process
  resolves the real API URL and hands it to the renderer via a `contextBridge` preload
  script (`window.shannon.apiBaseUrl`) — see `apps/mobile/lib/endpoint.ts`.
- **`"asar": false`** in `apps/desktop/package.json`'s electron-builder config, deliberately.
  Electron patches `child_process.execFile` to transparently read out of `app.asar`, but not
  `spawn` — and `embedded-postgres` `spawn`s `initdb`/`postgres` from paths its own package
  exports (no custom-binary-dir option), while its postinstall also creates symlinks that
  asar-packing would silently drop. The app's own source is tiny (a handful of files), so
  nothing meaningful is lost by shipping unpacked.
- **`SHANNON_LISTENING <port>`** is a stdout handshake line the bundled server prints once
  `app.listen()` resolves (`apps/server/src/index.ts`) — the desktop supervisor
  (`apps/desktop/src/supervisor/server.js`) greps for it via `readline` instead of polling
  `/health`, mirroring the `tsnet-proxy` sidecar's own `LISTENING <addr>` handshake. Don't
  remove or reformat that `console.log` without updating the supervisor.
- **Release build vs `pnpm dev` never collide on one host, by construction**: the
  self-contained app defaults to port `4100` (`SHANNON_PORT`) with an embedded Postgres on
  an ephemeral localhost port, data under the platform user-data dir; the dev stack keeps
  `4000`/`5432`/compose volumes. The packaged app never reads the repo's `.env` — its child
  env is built entirely by the supervisor. See `docs/DEPLOY.md`'s ports/data-dir table.

## Conventions

- pnpm workspaces + Turborepo; packages scoped `@shannon/*`; TypeScript strict.
- Minimal changes; match existing file style; don't add deps without a reason.
- Ports (dev): server 4000, inference 4002, ntfy 4003, Postgres 5432, Expo web 8081.
  Self-contained desktop app (a separate deployment, coexists with dev on one host): server
  4100 (`SHANNON_PORT`), Postgres on an ephemeral localhost port — see `docs/DEPLOY.md`.
- **Semantic gluestack tokens only** for UI colors (`text-foreground`, `bg-primary`, etc.)
  — never numbered Tailwind colors (`gray-500`) or raw hex in className. `react-native-svg`
  can't resolve CSS custom properties, so SVG fills/strokes are the one exception: literal
  hex is correct there (see `ContextRing`, `TokensChart`).

## Theme system

- **Preference hook:** `apps/mobile/hooks/useTheme.ts` — `useThemePreference()` returns
  `[pref, setPref]`, `pref: 'light' | 'dark' | 'system'`. Persistence key: `shannon-theme`.
  Feed the value into `GluestackUIProvider`'s `mode` prop.
- **Tokens:** Tailwind v4 CSS-first config in `apps/mobile/global.css` (`@theme inline`,
  `@variant light`/`@variant dark`) — no separate design-tokens package. Dark is the
  design default. UniWind applies the active variant at runtime via `Uniwind.setTheme()`.
- The original static prototype under `design/` is a historical reference for the palette
  and layout, not something anything imports or builds against anymore.
