CREATE TABLE "favourite_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_prefs" ADD COLUMN "favourites_seeded_at" timestamp;--> statement-breakpoint
ALTER TABLE "favourite_questions" ADD CONSTRAINT "favourite_questions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "favourite_questions_user_text_idx" ON "favourite_questions" USING btree ("user_id","text");