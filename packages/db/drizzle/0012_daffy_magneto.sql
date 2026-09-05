CREATE TABLE "hosts" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"advertise_url" text NOT NULL,
	"inference_base_url" text,
	"version" text,
	"last_heartbeat_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
