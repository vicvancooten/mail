ALTER TABLE "messages" ADD COLUMN "recipient_alias" text;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "held_recipient_alias" text;--> statement-breakpoint
CREATE INDEX "threads_held_recipient_alias_idx" ON "threads" USING btree ("mail_account_id","held_recipient_alias") WHERE "threads"."held_recipient_alias" is not null;