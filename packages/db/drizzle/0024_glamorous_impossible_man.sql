--> Hand-added ahead of the foreign key below: a run row whose routine no longer
--> exists cannot satisfy the constraint, and nothing has ever cleaned these up
--> (DELETE /v1/routines only disabled the routine, so any orphan here came from
--> a hand-run DELETE). The conversations they name are left alone — they are
--> real chats, and erasing them is a decision for the delete route, not a
--> migration.
DELETE FROM "routine_runs" rr WHERE NOT EXISTS (SELECT 1 FROM "routines" r WHERE r."id" = rr."routine_id");--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "created_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "routine_runs" ADD CONSTRAINT "routine_runs_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "routine_runs_routine_started_idx" ON "routine_runs" USING btree ("routine_id","started_at");--> statement-breakpoint
CREATE INDEX "routine_runs_conversation_idx" ON "routine_runs" USING btree ("conversation_id");