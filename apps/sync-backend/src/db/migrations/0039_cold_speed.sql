CREATE TABLE "notes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"document" jsonb NOT NULL,
	"label_ids" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sync_rev" bigint DEFAULT 0 NOT NULL,
	"sync_created_rev" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notes_sync_rev_idx" ON "notes" USING btree ("user_id","sync_rev");--> statement-breakpoint
-- Same delta sync API stamping as `labels`/`threads` (migration 0006):
-- `notes` joins the shared `sync_rev_seq` order so its own ADR-0011
-- collection (#192) can page the same way theirs does.
CREATE TRIGGER "notes_bump_sync_rev" BEFORE INSERT OR UPDATE ON "notes"
  FOR EACH ROW EXECUTE FUNCTION bump_sync_rev();--> statement-breakpoint
-- ADR-0023's "App collections emit Sync Hints through the same LISTEN/NOTIFY
-- path" (ADR-0015): `notes` carries `user_id` directly, the same as
-- `mail_accounts`/`labels` (migration 0037's own comment), so it joins that
-- branch rather than the `mail_accounts`-join one every Mail-Account-scoped
-- table falls through to. Replaced whole, same reason migration 0037 gives:
-- a plpgsql function has no in-place edit.
CREATE OR REPLACE FUNCTION notify_sync_hint() RETURNS trigger AS $$
DECLARE
  target_user_id text;
BEGIN
  IF TG_TABLE_NAME IN ('mail_accounts', 'labels', 'notes') THEN
    target_user_id := COALESCE(NEW.user_id, OLD.user_id);
  ELSIF TG_TABLE_NAME = 'sync_tombstones' THEN
    -- User-scoped tombstones (a null mail_account_id) have no caller today
    -- (`sync/tombstones.ts`); nothing to resolve a User from until one exists.
    IF NEW.mail_account_id IS NULL THEN
      RETURN NEW;
    END IF;
    SELECT user_id INTO target_user_id FROM mail_accounts WHERE id = NEW.mail_account_id;
  ELSE
    SELECT user_id INTO target_user_id FROM mail_accounts
      WHERE id = COALESCE(NEW.mail_account_id, OLD.mail_account_id);
  END IF;

  IF target_user_id IS NOT NULL THEN
    PERFORM pg_notify('mail_sync_hint', target_user_id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;