ALTER TABLE "attachments" ADD COLUMN "filename" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "extract_status" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "extract_bytes" integer DEFAULT 0 NOT NULL;