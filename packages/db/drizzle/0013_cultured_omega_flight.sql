CREATE TABLE "conversation_shares" (
	"conversation_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'viewer' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_shares_conversation_id_user_id_pk" PRIMARY KEY("conversation_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "conversation_shares" ADD CONSTRAINT "conversation_shares_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_shares" ADD CONSTRAINT "conversation_shares_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_shares" ADD CONSTRAINT "conversation_shares_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_shares_user_idx" ON "conversation_shares" USING btree ("user_id");