CREATE TABLE "protocol_writes" (
	"id" text PRIMARY KEY NOT NULL,
	"mail_account_id" text NOT NULL,
	"message_id" text NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "in_inbox" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "protocol_writes" ADD CONSTRAINT "protocol_writes_mail_account_id_mail_accounts_id_fk" FOREIGN KEY ("mail_account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "protocol_writes" ADD CONSTRAINT "protocol_writes_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "protocol_writes_account_idx" ON "protocol_writes" USING btree ("mail_account_id","created_at");