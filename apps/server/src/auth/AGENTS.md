# apps/server/src/auth

better-auth setup (`index.ts`), the session middleware (`middleware.ts`), the ban predicate (`ban.ts`) and admin/CLI password resets (`password-reset.ts`).

## Authenticating

- **All authentication goes through `middleware.ts`**: `authenticate`/`requireAdmin` for routes, `resolveSessionFromToken` for sockets. Never call `auth.api.getSession` directly; it skips the ban and password-change checks.
- `banned` is enforced by `resolveSession()` on every authenticated request (403; expired bans count as lifted). better-auth checks it only at sign-in, so an out-of-band ban would leave live sessions working.
- `must_change_password` is enforced in the same places: `verifyToken` answers 403 `password_change_required`, `resolveSessionFromToken` returns null.
- `GET /api/auth/session` (`routes/auth.ts`) is served outside the middleware so a flagged user can learn who they are; it must check `isBanned` itself and answer 401 `account_suspended`. A new `/api/auth/*` route that a flagged user must not reach has to authenticate through the middleware.
- `isBanned` in `ban.ts` is the only ban predicate (it honours `banExpires`). Keep it pure and out of `middleware.ts`: route tests mock that module whole.

## Users and roles

- The first sign-up, or any email in `ADMIN_EMAILS`, gets `role: "admin"` via `databaseHooks.user.create.before`. Existing users are not promoted retroactively; use `ADMIN_EMAILS` or SQL.

## Passwords

- There is no mail transport and better-auth's `requestPasswordReset` is unused (it fails without `sendResetPassword`). Resets are by an admin (`POST /v1/admin/users/:id/reset-password`) or the CLI (`pnpm --filter @loxaic/server reset-password`, desktop `--headless --reset-password`).
- A reset sets `user.must_change_password`. It reaches clients through `user.additionalFields` in `index.ts`, with `input: false` so a sign-up body cannot set it.
- `password-reset.ts` is bundled by the CLI: it must never import fastify, the server entry, or `index.ts` (which reads `BETTER_AUTH_SECRET` at import). `cli/__tests__/isolation.test.ts` enforces this.
- Hash with `better-auth/crypto`'s `hashPassword`, and never set `emailAndPassword.password.hash`, or CLI-reset passwords stop verifying.
