ALTER TABLE "local_models" ADD COLUMN "mtp_head" jsonb;--> statement-breakpoint
ALTER TABLE "usage_records" ADD COLUMN "draft_tokens" integer;--> statement-breakpoint
ALTER TABLE "usage_records" ADD COLUMN "draft_accepted_tokens" integer;