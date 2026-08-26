CREATE TABLE "mcp_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"transport" text NOT NULL,
	"command" text,
	"args" jsonb,
	"url" text,
	"headers" jsonb,
	"env" jsonb,
	"secrets" text,
	"builtin_key" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"allow_private_network" boolean DEFAULT false NOT NULL,
	"tool_policies" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"known_tools" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_connected_at" timestamp,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "mcp_overrides" jsonb;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_servers_owner_slug_idx" ON "mcp_servers" USING btree ("owner_id","slug");