CREATE TABLE "registry_logins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text,
	"registry" text NOT NULL,
	"username" text NOT NULL,
	"encrypted_secret" text NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sandbox_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text,
	"reference" text NOT NULL,
	"label" text NOT NULL,
	"status" text DEFAULT 'pulling' NOT NULL,
	"error" text,
	"digest" text,
	"uid" integer,
	"gid" integer,
	"check" jsonb,
	"limits" jsonb,
	"pulled_at" timestamp,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "registry_logins" ADD CONSTRAINT "registry_logins_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_logins" ADD CONSTRAINT "registry_logins_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_images" ADD CONSTRAINT "sandbox_images_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_images" ADD CONSTRAINT "sandbox_images_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "registry_logins_owner_registry_idx" ON "registry_logins" USING btree ("owner_id","registry") WHERE owner_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "registry_logins_shared_registry_idx" ON "registry_logins" USING btree ("registry") WHERE owner_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_images_owner_reference_idx" ON "sandbox_images" USING btree ("owner_id","reference") WHERE owner_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_images_shared_reference_idx" ON "sandbox_images" USING btree ("reference") WHERE owner_id IS NULL;