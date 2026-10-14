ALTER TABLE "conversations" ADD COLUMN "skill_catalog" jsonb;--> statement-breakpoint
ALTER TABLE "user_prefs" ADD COLUMN "skill_usage" jsonb DEFAULT '{}'::jsonb NOT NULL;