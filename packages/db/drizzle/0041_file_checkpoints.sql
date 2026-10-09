CREATE TABLE "checkpoint_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"turn_message_id" uuid NOT NULL,
	"path" text NOT NULL,
	"state" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "checkpoint_files_turn_path_idx" ON "checkpoint_files" USING btree ("conversation_id","turn_message_id","path");--> statement-breakpoint
CREATE INDEX "checkpoint_files_conversation_idx" ON "checkpoint_files" USING btree ("conversation_id","created_at");