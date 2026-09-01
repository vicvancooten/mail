CREATE TABLE "applied_mutations" (
	"id" text PRIMARY KEY NOT NULL,
	"mail_account_id" text NOT NULL,
	"intent_type" text NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "applied_mutations" ADD CONSTRAINT "applied_mutations_mail_account_id_mail_accounts_id_fk" FOREIGN KEY ("mail_account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "applied_mutations_account_idx" ON "applied_mutations" USING btree ("mail_account_id");