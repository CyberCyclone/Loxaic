CREATE TABLE "local_models" (
	"id" text NOT NULL,
	"host_id" text DEFAULT '' NOT NULL,
	"repo" text NOT NULL,
	"revision" text NOT NULL,
	"quant" text NOT NULL,
	"files" jsonb NOT NULL,
	"mmproj" jsonb,
	"size_bytes" bigint NOT NULL,
	"status" text NOT NULL,
	"bytes_done" bigint DEFAULT 0 NOT NULL,
	"error" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"load_settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"display_name" text NOT NULL,
	"publisher" text NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "local_models_host_id_id_pk" PRIMARY KEY("host_id","id")
);
--> statement-breakpoint
ALTER TABLE "local_models" ADD CONSTRAINT "local_models_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;