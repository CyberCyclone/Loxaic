-- The default process limit went from 100 to 4096. A shared image's row was
-- given the defaults whole when it was added, so every one added before then
-- stores pids 100 whether or not an admin chose it; 100 is what made a test
-- run starve its sandbox. Rows still on exactly 100 move to the new default.
-- Their sandboxes follow on their next wake (syncProcessLimit).
UPDATE "sandbox_images"
SET "limits" = jsonb_set("limits", '{pids}', '4096'::jsonb)
WHERE "owner_id" IS NULL AND "limits"->>'pids' = '100';
