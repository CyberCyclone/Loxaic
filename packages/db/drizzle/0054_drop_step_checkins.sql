ALTER TABLE "conversations" DROP COLUMN "step_limit_off";--> statement-breakpoint
ALTER TABLE "conversations" DROP COLUMN "loop_check_off";--> statement-breakpoint
ALTER TABLE "user_prefs" DROP COLUMN "max_iterations";--> statement-breakpoint
ALTER TABLE "user_prefs" DROP COLUMN "checkin_timeout_ms";--> statement-breakpoint
ALTER TABLE "user_prefs" DROP COLUMN "checkin_auto_continues";--> statement-breakpoint
ALTER TABLE "user_prefs" DROP COLUMN "loop_sensitivity";