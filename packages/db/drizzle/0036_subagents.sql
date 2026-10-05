ALTER TABLE "conversations" ADD COLUMN "parent_conversation_id" uuid;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "parent_message_id" uuid;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "parent_call_id" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "subagent" jsonb;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "subagent_models" jsonb;--> statement-breakpoint
ALTER TABLE "user_prefs" ADD COLUMN "subagent_model_mode" text DEFAULT 'choose' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_prefs" ADD COLUMN "subagent_model" text;--> statement-breakpoint
CREATE INDEX "conversations_parent_idx" ON "conversations" USING btree ("parent_conversation_id");