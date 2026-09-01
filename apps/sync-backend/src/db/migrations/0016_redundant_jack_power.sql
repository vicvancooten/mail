ALTER TABLE "applied_mutations" ALTER COLUMN "mail_account_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "applied_mutations" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD COLUMN "notifications_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "theme" text DEFAULT 'system' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "auto_advance_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "auto_advance_direction" text DEFAULT 'older' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "sync_rev" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "sync_created_rev" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "applied_mutations" ADD CONSTRAINT "applied_mutations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "applied_mutations_user_idx" ON "applied_mutations" USING btree ("user_id");--> statement-breakpoint
-- The `Preference` collection's revision cursor (#54, ADR-0011): `users`
-- joins the same `bump_sync_rev()` trigger `mail_accounts`/`threads` already
-- use (migration 0006) — no new function needed, one row per User is exactly
-- the shape it already handles.
CREATE TRIGGER "users_bump_sync_rev" BEFORE INSERT OR UPDATE ON "users"
  FOR EACH ROW EXECUTE FUNCTION bump_sync_rev();