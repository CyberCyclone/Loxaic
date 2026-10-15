# apps/server

The Fastify API, WebSockets, run engine, sandboxes and llama.cpp runtime. These rules apply to every file in the server package and its vitest suite.

## Settings

- Precedence is env > `server_settings` row > default (`settings.ts`); an env-pinned field answers 409 from the API and is read-only in the GUI.
- Reads are sync against the cache `loadServerSettings()` fills at boot; a failed load fails closed (sandbox mode `off`).
- Read env vars at call time, never at module load — tests set them per case in a shared process.
- Patch a settings row in one statement (`value || excluded.value`) and set the cache from the returned row; never merge onto the cache and write it back (a failed boot read leaves it `{}`).
- On any per-request path, decrypt with a cached scrypt-derived key (as `github/connection.ts` and `inference/provider-secrets.ts` do), never an uncached `scryptSync`: it blocks the event loop and every other user's stream.

## Database

- Any positional read (`.at(-1)`, `[0]`, "the last assistant row") needs an `orderBy` — messages order by `lamport, created_at`; heap order is not insertion order.
- Inside a correlated subquery, name the outer table literally: drizzle renders a single-table select's column without its table (see `listSubagents`).
- Every new `messages` query that feeds the model or a decision must filter `isNull(messages.deletedAt)`. Only the admin transcript reads stamped rows (`loadMessagePage`'s `includeRemoved`).

## Tests (one vitest process, one shared Postgres)

- `process.env` is shared across files: pin every env a test relies on, defaults included (another file sets `SANDBOX_IDLE_STOP_MS=1`). pnpm also sets `npm_package_version` for every script, so a test can pass under `npx vitest` and fail under `pnpm test`.
- Never call `resetServerSettingsCache()` in a test that runs beside others; pin an env read at call time instead.
- Scope every cleanup to the suite's own rows: pass `{ ownerId }` to `sweepOrphanSandboxes` and `ownerId` (and `kind`) to `reapAbandonedSandboxes`, tear down with `destroyConversationSandboxes(id)`; never an unscoped `db.delete(sandboxes)` or `stopAllSandboxes` (it stops every `running` row).
- Never assert on a global sweep's return count; assert on the rows the test created.
- After changing what a janitor covers, run `docker ps -a --filter label=loxaic.sandbox` after the suite and expect nothing of the suite's left.
- Keep `prompt-prefix.test.ts` green on any change to request building or history replay — it is the only guard against prefix-breaking serialisation mismatches.
- Booting a throwaway server on the same container engine destroys other installs' paused sandboxes (its boot orphan sweep); stop them or accept losing them first.

## Process and packaging

- Never add `node-pty` or any native module: the desktop runs the server and executor under Electron's Node with `npmRebuild: false`.
- Keep the `LOXAIC_LISTENING <port>` stdout line in `src/index.ts` byte-for-byte unless `apps/desktop/src/supervisor/server.js` changes with it.
- A route taking a credential in the query string must use a parameter name `redactUrl` (`logging.ts`) already redacts.
- CLIs end with `process.exitCode`, never `process.exit()` — exit drops unflushed stdout on a pipe (the reset CLI's temporary password).
- A Postgres `42703` from the reset CLI means the server has not yet started once on this version.

## Routes (`src/routes/`)

### Authorization

- Authenticate through `authenticate`/`requireAdmin` (`auth/middleware.ts`), never `auth.api.getSession` directly — that skips the ban and must-change-password checks.
- `routes/auth.ts` calls `auth.api.*` directly so a flagged user can still sign in, read the session, change password and sign out; a new `/api/auth/*` route a flagged user must not reach has to go through the middleware.
- Authorize conversation access with `hasRole`, never an inlined ownership predicate: reading needs viewer; model/MCP prefs and delete are owner-only; sandbox and git routes are owner-only.
- Every route touching `inference_providers` is `requireAdmin` — one key pays for every user's requests.
- **Never let a request choose sandbox kind or network**: derive the kind from `getSandboxMode()`; `PATCH /v1/admin/settings/sandbox` is `requireAdmin`.
- `POST /v1/sandboxes` requires owner role on its `conversation_id` (404 otherwise).

### Passwords

- change-password refuses `newPassword === currentPassword` (`PASSWORD_UNCHANGED`) before verifying the current password.
- change-password always passes `revokeOtherSessions: true`, which revokes the caller's session too; the response's `token` is the caller's new session.

### Prefs and settings

- Refuse server-owned or removed keys by name (`recentModels`, `autoCompact`) rather than ignoring them, so a client cannot believe it changed them.
- Silently drop `"bash"` from `toolAllowlist` (older clients send it back); bash grants are command rules.

### Conversations

- Instructions text never reaches a client: `publicConversation` replaces it with a summary, and `GET /v1/conversations` selects `INSTRUCTIONS_SUMMARY_COLUMN`, never `SELECT *`.

### Skills

- `GET /v1/skills` returns the conversation owner's list only to an editor (`catalogForRequest`); viewers and admins get their own.

### GitHub and git

- Redact the token from error messages in `routes/github.ts` as well as in `github/client.ts`.
- Every git route is owner-only; commit, push and PR answer 409 while a run is active (`getRunByConversation`).
- Reuse the cloned sandbox (`findSandboxRow` + `attachRunningSandbox`); `findSandboxRow` is scoped to the owner's rows. `GET status` has no side effects and reports `cloned: false` from workspace fields alone.
- **Push refuses (409) unless `git remote get-url origin` equals the workspace's `cloneUrl`** — the model can rewrite `.git/config`.
- Git route tests run the real `gh` through the real proxy against `GhMock`; `gh` must be on PATH.

## Conversations (`src/conversations/`)

### Deleting a conversation

- `delete.ts` is the only code that deletes or stamps a whole conversation (`rewind.ts` stamps only a rewound suffix's sub-agent children). Delete is owner-only and answers the identical `200 {ok:true}` to everyone else, admins included.

### Rewind and retry

- `rewind.ts` is the only code that removes part of a conversation. Rewind removes a message and everything after; retry removes everything after the newest typed message and answers that row again.
- Return a rewound message's attachments only to their uploader, refreshing `created_at` so the reaper's grace restarts.

### Elsewhere, about conversation rows

- Listings and the admin list exclude `kind: "subagent"`; `/v1/stats/conversations` groups a child's usage under its parent (totals include children; `model`/`avgTtftMs` are the thread's own).

## Routines (`src/routines/`)

### Running a routine

- A routine run uses its owner's prefs and wait settings (approval window, check-in ladder); that is what keeps an unattended run bounded.
- **A routine's chats use only `routines.model`.** A null or unresolvable model records the run `failed` with an error assistant row; never fall back to the built-in default or `recent_models[0]` (that spends a provider key on a model nobody picked).

### Deleting a routine

- DELETE answers 404 for a routine that is not yours or does not exist.

### Scheduling and listing

- Every routine-scoped listing inner-joins `conversations` on `deletedAt IS NULL`.
- The scheduler is single-process: cron fires on every instance, and the reconcile would fail another instance's live runs.

## GitHub connection (`src/github/`)

### The token

- One PAT per user (`github_connections`, `userId` primary key) — a PAT, not OAuth.
- Encrypt it with the `mcp/secrets.ts` AES-256-GCM scheme, kept in its own module (`connection.ts`), same key (`MCP_ENCRYPTION_KEY`, fallback `BETTER_AUTH_SECRET`). `getOwnerToken()` is the only decrypt site outside tests.
- A token that can no longer be decrypted is `GithubTokenUnreadableError`, never a 500: repo and branch routes answer 409 "disconnect and reconnect", workspace creation a 400.
- Disconnecting hard-deletes the row, and must call `forgetEgressToken` (the egress proxy caches tokens 30 s).
- GitHub access belongs to the conversation owner, never the sender.
- Redact the token from every error message here, and again in `routes/github.ts`.

### The client (`client.ts`)

- A missing `X-OAuth-Scopes` (fine-grained PAT) is stored as null and means "unknown", never "no access".
- `listRepos`/`listBranches` follow `rel="next"` up to ten pages, only on the API's own origin.
