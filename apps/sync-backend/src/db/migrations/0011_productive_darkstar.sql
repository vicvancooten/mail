ALTER TABLE "compositions" ADD COLUMN "submit_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "compositions" ADD COLUMN "message_id" text;--> statement-breakpoint
ALTER TABLE "compositions" ADD COLUMN "send_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "compositions" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "compositions" ADD COLUMN "send_error" text;--> statement-breakpoint
ALTER TABLE "compositions" ADD COLUMN "sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "compositions" ADD COLUMN "sync_rev" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "compositions" ADD COLUMN "sync_created_rev" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "undo_send_delay_seconds" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
CREATE INDEX "compositions_send_due_idx" ON "compositions" USING btree ("submit_after") WHERE "compositions"."status" in ('pending', 'submitting');--> statement-breakpoint
CREATE INDEX "compositions_sync_rev_idx" ON "compositions" USING btree ("mail_account_id","sync_rev");--> statement-breakpoint
-- Same delta sync API stamping as `mail_accounts`/`threads`/`labels`
-- (migrations 0006, 0009): `compositions` joins the shared `sync_rev_seq`
-- order so the `Composition` collection (#46) — what makes a Pending Send
-- visible on every device (ADR-0007) — pages the way the others do.
CREATE TRIGGER "compositions_bump_sync_rev" BEFORE INSERT OR UPDATE ON "compositions"
  FOR EACH ROW EXECUTE FUNCTION bump_sync_rev();
