ALTER TABLE "mcp_servers" ADD COLUMN "on_in_chat" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "on_in_agent" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "on_in_routines" boolean DEFAULT true NOT NULL;