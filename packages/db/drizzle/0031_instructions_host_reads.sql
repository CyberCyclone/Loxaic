-- Snapshots and notices the unconfined instructions reads may have produced.
--
-- Before this release, the project-instructions reads that run shell commands
-- followed a symlink wherever it pointed, and a container-isolated local
-- folder was read on the host rather than in its container. A repository whose
-- AGENTS.md linked to `../../.ssh/id_ed25519` therefore had the key stored here
-- and sent in every system prompt. The reads are fixed; this removes what they
-- may already have stored, so a stored snapshot is not reused unread forever.
--
-- Snapshots cleared (NULL is "not looked yet", so the next run reads again,
-- confined):
--   * every local workspace's: each was read through the folder ref, on the
--     host, with no real-path check;
--   * any carrying `cksums` or `latest`: those came from a shell read, such as
--     a GitHub checkout in a host-mode sandbox, where a symlink could reach the
--     server's own files.
-- A GitHub snapshot read only through the contents API is kept: that API
-- serves nothing outside the repository.
--
-- The instructions notices appended to user messages go too, all of them: the
-- per-run check that writes them shipped in the same unreleased window and
-- read the same way. A notice is a hint to the model, and its message keeps
-- its text. Each affected conversation re-reads its prompt once.
UPDATE "conversations"
SET "instructions" = NULL
WHERE "instructions" IS NOT NULL
  AND (
    "workspace"->>'kind' = 'local'
    OR "instructions" ? 'cksums'
    OR "instructions" ? 'latest'
  );--> statement-breakpoint
UPDATE "messages"
SET "content" = COALESCE(
  (
    SELECT jsonb_agg(block ORDER BY position)
    FROM jsonb_array_elements("content") WITH ORDINALITY AS blocks(block, position)
    WHERE block->>'kind' IS DISTINCT FROM 'instructions_update'
  ),
  '[]'::jsonb
)
WHERE "content" @> '[{"kind": "instructions_update"}]'::jsonb;
