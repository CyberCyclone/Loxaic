CREATE TABLE "user_sandbox_allocations" (
	"user_id" text PRIMARY KEY NOT NULL,
	"memory_mb" integer,
	"cpus" real,
	"max_running" integer,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_sandbox_allocations" ADD CONSTRAINT "user_sandbox_allocations_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;