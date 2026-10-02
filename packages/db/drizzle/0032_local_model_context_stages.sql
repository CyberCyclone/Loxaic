ALTER TABLE "local_models" ADD COLUMN "context_stages" jsonb;--> statement-breakpoint
ALTER TABLE "local_models" ADD COLUMN "active_stage" integer DEFAULT 0 NOT NULL;