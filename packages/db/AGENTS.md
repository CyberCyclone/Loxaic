# packages/db

The Drizzle schema (`src/schema.ts`), the shared `db` instance and re-exported query operators (`src/index.ts`), and the migrations in `drizzle/`.

## Using it

- Never import from `drizzle-orm` directly anywhere in the repo; import operators and `db` from `@loxaic/db`. Two drizzle-orm instances cause type errors.
- This package has no build step: relative imports must carry the `.ts` extension (`./schema.ts`); production runs it under Node's native TypeScript.
- Cast `SUM()`/`AVG()` over `integer` columns to `::float8`, never `::int`: postgres.js returns them as strings, and `::int` overflows lifetime sums.

## Migrations

- After a schema change run `pnpm --filter @loxaic/db db:generate`. Migrations run automatically at server startup (`apps/server/src/db/migrate.ts`).
- A fix to what a stored instructions snapshot may contain needs a migration clearing old snapshots: `ensureInstructions` reuses a stored snapshot forever.

## Schema facts

- The users table is `user` (singular), Drizzle-owned and passed explicitly to `drizzleAdapter` in `apps/server/src/auth/index.ts`; its columns go through normal migrations. `user.id` is `text`, not `uuid`.
- Only `conversation_shares` has a foreign key to `conversations`. `messages`, `usage_records`, `sandboxes`, `checkpoint_files` and `conversations.parent_conversation_id` have none, so deleting a conversation must clean them explicitly (`apps/server/src/conversations/delete.ts`).
- `checkpoint_files` holds only the manifest; its `created_at` uses the app's clock, like messages, because rewinds compare the two.
- Every last-turn or context reader of `usage_records` (`lastTurnTokens`, `conversationTokens`, `recentUses`) filters out `purpose = 'permission_check'` rows.
