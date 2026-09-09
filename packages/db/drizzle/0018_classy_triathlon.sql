CREATE TABLE "github_connections" (
	"user_id" text PRIMARY KEY NOT NULL,
	"encrypted_token" text NOT NULL,
	"login" text NOT NULL,
	"name" text,
	"email" text,
	"scopes" text,
	"validated_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "github_connections" ADD CONSTRAINT "github_connections_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;