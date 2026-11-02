ALTER TABLE "conversations" ADD COLUMN "step_limit_off" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "loop_check_off" boolean DEFAULT false NOT NULL;