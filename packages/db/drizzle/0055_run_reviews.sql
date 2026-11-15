CREATE TABLE "run_reviews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"lamport" bigint NOT NULL,
	"step" integer NOT NULL,
	"worked_ms" bigint NOT NULL,
	"mode" text,
	"trigger" text NOT NULL,
	"verdict" text,
	"reason" text DEFAULT '' NOT NULL,
	"action" text NOT NULL,
	"forced" boolean DEFAULT false NOT NULL,
	"digest" text DEFAULT '' NOT NULL,
	"model" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"prompt_ms" integer,
	"generation_ms" integer,
	"total_ms" integer NOT NULL,
	"started_at" timestamp NOT NULL,
	"ended_at" timestamp NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE INDEX "run_reviews_conversation_lamport_idx" ON "run_reviews" USING btree ("conversation_id","lamport");