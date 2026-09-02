CREATE TABLE "sync_tombstones" (
	"id" text PRIMARY KEY NOT NULL,
	"mail_account_id" text,
	"collection" text NOT NULL,
	"entity_id" text NOT NULL,
	"sync_rev" bigint NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD COLUMN "threads_epoch" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD COLUMN "sync_rev" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD COLUMN "sync_created_rev" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "sync_rev" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "sync_created_rev" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_tombstones" ADD CONSTRAINT "sync_tombstones_mail_account_id_mail_accounts_id_fk" FOREIGN KEY ("mail_account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sync_tombstones_scope_idx" ON "sync_tombstones" USING btree ("mail_account_id","collection","sync_rev");--> statement-breakpoint
CREATE INDEX "mail_accounts_sync_rev_idx" ON "mail_accounts" USING btree ("user_id","sync_rev");--> statement-breakpoint
CREATE INDEX "threads_sync_rev_idx" ON "threads" USING btree ("mail_account_id","sync_rev");--> statement-breakpoint
-- The delta sync API's (#37) shared revision counter. One sequence across
-- every sync-tracked table (mail_accounts, threads, sync_tombstones) so an
-- upsert and a destroy recorded around the same instant never share a
-- revision number — see sync_tombstones' doc comment in schema.ts.
CREATE SEQUENCE "sync_rev_seq" AS bigint;--> statement-breakpoint
-- Stamps NEW.sync_rev on every insert or update, and freezes
-- NEW.sync_created_rev at the row's first stamp so `sync/collection-sync.ts`
-- can tell "new since token X" apart from "changed since token X" without a
-- second timestamp column. Existing rows keep their column default of 0
-- until they are next touched — harmless, since a bootstrap (no token yet)
-- reads every row regardless of its revision, and a resumed token can only
-- ever be a revision this trigger itself issued.
CREATE FUNCTION bump_sync_rev() RETURNS trigger AS $$
BEGIN
  NEW.sync_rev := nextval('sync_rev_seq');
  IF TG_OP = 'INSERT' THEN
    NEW.sync_created_rev := NEW.sync_rev;
  ELSE
    NEW.sync_created_rev := OLD.sync_created_rev;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "mail_accounts_bump_sync_rev" BEFORE INSERT OR UPDATE ON "mail_accounts"
  FOR EACH ROW EXECUTE FUNCTION bump_sync_rev();--> statement-breakpoint
CREATE TRIGGER "threads_bump_sync_rev" BEFORE INSERT OR UPDATE ON "threads"
  FOR EACH ROW EXECUTE FUNCTION bump_sync_rev();