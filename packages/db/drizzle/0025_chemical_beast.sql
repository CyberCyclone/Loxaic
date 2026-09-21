ALTER TABLE "user_prefs" ADD COLUMN "checkin_timeout_ms" integer;--> statement-breakpoint
ALTER TABLE "user_prefs" ADD COLUMN "approval_timeout_ms" integer;--> statement-breakpoint
ALTER TABLE "user_prefs" ADD COLUMN "adaptive_timeout" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_prefs" ADD COLUMN "checkin_auto_continues" integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_prefs" ADD COLUMN "loop_sensitivity" text DEFAULT 'normal' NOT NULL;