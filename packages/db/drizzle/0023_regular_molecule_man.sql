CREATE TABLE "inference_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"preset" text,
	"base_url" text NOT NULL,
	"encrypted_api_key" text,
	"headers" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"max_concurrent_runs" integer,
	"model_allowlist" jsonb,
	"last_checked_at" timestamp,
	"last_error" text,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_prefs" DROP CONSTRAINT "user_prefs_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "user_prefs" ADD COLUMN "recent_models" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "inference_providers" ADD CONSTRAINT "inference_providers_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inference_providers_slug_idx" ON "inference_providers" USING btree ("slug");--> statement-breakpoint
ALTER TABLE "user_prefs" ADD CONSTRAINT "user_prefs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;