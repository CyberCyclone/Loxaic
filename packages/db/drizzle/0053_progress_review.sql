ALTER TABLE "conversations" ADD COLUMN "progress_review_off" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_prefs" ADD COLUMN "progress_review" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_prefs" ADD COLUMN "progress_check_ms" integer;--> statement-breakpoint
ALTER TABLE "user_prefs" ADD COLUMN "progress_check_steps" integer;--> statement-breakpoint
ALTER TABLE "user_prefs" ADD COLUMN "progress_review_prompt" text;