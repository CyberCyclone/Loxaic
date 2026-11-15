-- A chat whose owner had turned off both the step limit and the loop check
-- chose to let its runs go on with nothing stopping them. The progress review
-- replaces both, so that choice carries over to its switch before the old
-- columns go. One of the two alone does not: such a chat was still bounded by
-- the other, and stays reviewed. `user_prefs.loop_sensitivity = 'off'` does not
-- either, for the same reason: those users kept their step limit.
UPDATE "conversations"
SET "progress_review_off" = true
WHERE "step_limit_off" AND "loop_check_off" AND "kind" IN ('chat', 'agent');--> statement-breakpoint
ALTER TABLE "conversations" DROP COLUMN "step_limit_off";--> statement-breakpoint
ALTER TABLE "conversations" DROP COLUMN "loop_check_off";--> statement-breakpoint
ALTER TABLE "user_prefs" DROP COLUMN "max_iterations";--> statement-breakpoint
ALTER TABLE "user_prefs" DROP COLUMN "checkin_timeout_ms";--> statement-breakpoint
ALTER TABLE "user_prefs" DROP COLUMN "checkin_auto_continues";--> statement-breakpoint
ALTER TABLE "user_prefs" DROP COLUMN "loop_sensitivity";