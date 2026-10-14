# apps/server/src/routes

REST routes. These rules cover authorization, the prefs and settings routes, and the git, GitHub, skills and routine endpoints.

## Authorization

- Authenticate through `authenticate`/`requireAdmin` (`auth/middleware.ts`), never `auth.api.getSession` directly — that skips the ban and must-change-password checks.
- `routes/auth.ts` calls `auth.api.*` directly so a flagged user can still sign in, read the session, change password and sign out; a new `/api/auth/*` route a flagged user must not reach has to go through the middleware.
- Authorize conversation access with `hasRole`, never an inlined ownership predicate: reading needs viewer; model/MCP prefs and delete are owner-only; sandbox and git routes are owner-only.
- Every route touching `inference_providers` is `requireAdmin` — one key pays for every user's requests.
- **Never let a request choose sandbox kind or network**: derive the kind from `getSandboxMode()`; `PATCH /v1/admin/settings/sandbox` is `requireAdmin`.
- `POST /v1/sandboxes` requires owner role on its `conversation_id` (404 otherwise).

## Passwords

- change-password refuses `newPassword === currentPassword` (`PASSWORD_UNCHANGED`) before verifying the current password.
- change-password always passes `revokeOtherSessions: true`, which revokes the caller's session too; the response's `token` is the caller's new session.

## Prefs and settings

- `PATCH /v1/prefs` is partial: absent keys untouched, present ones validated, an empty patch is a 400.
- Refuse server-owned or removed keys by name (`recentModels`, `autoCompact`) rather than ignoring them, so a client cannot believe it changed them.
- Silently drop `"bash"` from `toolAllowlist` (older clients send it back); bash grants are command rules.
- Reject an out-of-range `maxIterations` on write; `clampMaxIterations` also clamps on read, and a failed lookup falls back to the default, never unlimited.
- `PATCH /v1/admin/settings/inference` must call `kickScheduler()` after the write — `pump()` otherwise runs only on a release.
- A provider's slug is fixed at creation and `PATCH` refuses it — it is stored in every message that used its models.
- An MCP server PATCH that changes only per-kind defaults must not restamp `updatedAt` or drop connections; `POST` honours and validates the same keys.

## Conversations, routines, stats

- `GET /v1/conversations` excludes `kind: "routine"` (and sub-agents).
- `POST /v1/routines/:id/run` answers 409 when no run was created, never `200 {ok: true}`.
- Compact-then-switch (`context-stage.ts`) must `waitForRunEnd` before starting the stage run — the compaction announces its end before releasing the conversation.
- The sub-agent listing carries `server_now`; clients time running children from it.
- Stats aggregate `reusable_tokens` over `SUM(input_tokens) FILTER (WHERE reusable_tokens IS NOT NULL)`; an empty window is null, never 0.
- Instructions text never reaches a client: `publicConversation` replaces it with a summary, and `GET /v1/conversations` selects `INSTRUCTIONS_SUMMARY_COLUMN`, never `SELECT *`.

## Skills

- No route may change a built-in skill; overriding one means adding a personal skill of the same name.
- Map a unique violation to 409 (`isUniqueViolation`) — `nameTaken` is a racy pre-check; an edit of a skill deleted mid-request is 404.
- `GET /v1/skills` returns the conversation owner's list only to an editor (`catalogForRequest`); viewers and admins get their own.
- Bump `user_prefs.skill_usage` in one SQL statement, and only when a person runs a skill, never when the model loads one.

## GitHub and git

- Redact the token from error messages in `routes/github.ts` as well as in `github/client.ts`.
- `PUT /v1/github/connection` validates with `getViewer` before storing anything.
- `routes/git.ts` push and PR run real `git push`/`gh pr create` through the egress proxy; answer 503 with a sentence when `runningEgressProxy()` is null.
- Every git route is owner-only; commit, push and PR answer 409 while a run is active (`getRunByConversation`), and `GET …/git/status` has no side effects.
- Reuse the cloned sandbox (`findSandboxRow` + `attachRunningSandbox`); `findSandboxRow` is scoped to the owner's rows. `GET status` has no side effects and reports `cloned: false` from workspace fields alone.
- **Push refuses (409) unless `git remote get-url origin` equals the workspace's `cloneUrl`** — the model can rewrite `.git/config`.
- Resolve commit identity at commit time from the live GitHub connection, never the clone's config.
- Opening a PR is idempotent: once `workspace.pr` is set (`setWorkspacePr`) return it without asking GitHub; when `gh` reports an existing PR for the branch, record that one.
- Status checks both exit codes: a failed `git status` is a 500; a failed rev-list reports `ahead`/`behind` as `null`, never 0.
- Git route tests run the real `gh` through the real proxy against `GhMock`; `gh` must be on PATH.
