CREATE TABLE "command_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"pattern" text NOT NULL,
	"action" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "usage_records" ADD COLUMN "purpose" text;--> statement-breakpoint
ALTER TABLE "user_prefs" ADD COLUMN "bash_grant_retired_at" timestamp;--> statement-breakpoint
ALTER TABLE "command_rules" ADD CONSTRAINT "command_rules_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "command_rules_user_pattern_action_idx" ON "command_rules" USING btree ("user_id","pattern","action");--> statement-breakpoint
-- An "allow always" for the whole bash tool allowed every command, forever.
-- Grants are per command now (apps/server/src/permissions/bash/rules.ts);
-- the old one is retired, and the permissions screen says so once.
UPDATE "user_prefs" SET "tool_allowlist" = "tool_allowlist" - 'bash', "bash_grant_retired_at" = now() WHERE jsonb_typeof("tool_allowlist") = 'array' AND "tool_allowlist" ? 'bash';
