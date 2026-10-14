# apps/server

The Fastify API, WebSockets, run engine, sandboxes and llama.cpp runtime. These rules apply to every file in the server package and its vitest suite.

## Settings

- Precedence is env > `server_settings` row > default (`settings.ts`); an env-pinned field answers 409 from the API and is read-only in the GUI.
- Reads are sync against the cache `loadServerSettings()` fills at boot; a failed load fails closed (sandbox mode `off`).
- Read env vars at call time, never at module load — tests set them per case in a shared process.
- Patch a settings row in one statement (`value || excluded.value`) and set the cache from the returned row; never merge onto the cache and write it back (a failed boot read leaves it `{}`).
- A successful write clears that group's read-failure flag; `retentionUnknown()` consults only its own flag, never the sandbox group's `loadFailed`.
- Sandbox `reapAfterMs` must exceed `idleStopMs` (env pins are in milliseconds) or the two timers race over one sandbox.

## Database

- Any positional read (`.at(-1)`, `[0]`, "the last assistant row") needs an `orderBy` — messages order by `lamport, created_at`; heap order is not insertion order.
- Inside a correlated subquery, name the outer table literally: drizzle renders a single-table select's column without its table (see `listSubagents`).
- Every new `messages` query that feeds the model or a decision must filter `isNull(messages.deletedAt)`. Only the admin transcript reads stamped rows (`loadMessagePage`'s `includeRemoved`).

## Tests (one vitest process, one shared Postgres)

- `process.env` is shared across files: pin every env a test relies on, defaults included (another file sets `SANDBOX_IDLE_STOP_MS=1`).
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
