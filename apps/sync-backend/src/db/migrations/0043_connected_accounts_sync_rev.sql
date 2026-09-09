-- #200 (ADR-0023): `ConnectedAccount` joins the User-scoped collection
-- registry, whole-replicated (id, Provider, identity, status, Facets,
-- createdAt — never a credential). Gives `connected_accounts` the same
-- delta-sync stamping every other User-scoped collection carries
-- (`sync_rev`/`sync_created_rev`, the shared `bump_sync_rev` trigger from
-- migration 0006) and its own Sync Hint fanout (migration 0016/0037/0038).
--
-- `connected_account_facets` carries no `sync_rev` of its own — Facets ride
-- this collection's payload embedded, not a collection of their own — so a
-- Facet-only change (its own `status` flip) instead bumps its *parent* row's
-- `sync_rev` directly, via a second, narrower trigger
-- (`bump_connected_account_facet_sync_rev`). That is what makes "a Client
-- that misses the hint picks the change up on its next poll" (#200's own
-- acceptance line) true for a Facet edit exactly the way it already is for
-- an account-level one: the next delta round pages `connected_accounts` by
-- `sync_rev`, and a Facet-only edit is now a `sync_rev` bump on that same row.
--
-- Deliberately leaves `mail_accounts.credential`/`status`/`connected_account_id`
-- exactly as migration 0041 left them (nullable, not yet dropped) — the rest
-- of that tightening waits on `connected-accounts/boot-upgrade.ts` having run
-- everywhere first (0041's own doc comment), which is #199's unfinished
-- business, not this ticket's.
ALTER TABLE "connected_accounts" ADD COLUMN "sync_rev" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "connected_accounts" ADD COLUMN "sync_created_rev" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "connected_accounts_sync_rev_idx" ON "connected_accounts" USING btree ("user_id","sync_rev");--> statement-breakpoint
CREATE TRIGGER "connected_accounts_bump_sync_rev" BEFORE INSERT OR UPDATE ON "connected_accounts"
  FOR EACH ROW EXECUTE FUNCTION bump_sync_rev();--> statement-breakpoint
CREATE FUNCTION bump_connected_account_facet_sync_rev() RETURNS trigger AS $$
BEGIN
  UPDATE "connected_accounts" SET "sync_rev" = nextval('sync_rev_seq')
    WHERE "id" = NEW."connected_account_id";
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "connected_account_facets_bump_parent_sync_rev" AFTER INSERT OR UPDATE ON "connected_account_facets"
  FOR EACH ROW EXECUTE FUNCTION bump_connected_account_facet_sync_rev();--> statement-breakpoint
-- Widen the fanout (migration 0038's own comment on why this is
-- `CREATE OR REPLACE` whole rather than patched): `connected_accounts`
-- carries `user_id` directly, the same branch `mail_accounts`/`labels`/
-- `notes` already share; `connected_account_facets` carries none, so it gets
-- its own branch resolving the owning User by joining `connected_accounts`.
CREATE OR REPLACE FUNCTION notify_sync_hint() RETURNS trigger AS $$
DECLARE
  target_user_id text;
BEGIN
  IF TG_TABLE_NAME IN ('mail_accounts', 'labels', 'notes', 'connected_accounts') THEN
    target_user_id := COALESCE(NEW.user_id, OLD.user_id);
  ELSIF TG_TABLE_NAME = 'connected_account_facets' THEN
    SELECT user_id INTO target_user_id FROM connected_accounts
      WHERE id = COALESCE(NEW.connected_account_id, OLD.connected_account_id);
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
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "connected_accounts_notify_sync_hint" AFTER INSERT OR UPDATE ON "connected_accounts"
  FOR EACH ROW EXECUTE FUNCTION notify_sync_hint();--> statement-breakpoint
CREATE TRIGGER "connected_account_facets_notify_sync_hint" AFTER INSERT OR UPDATE ON "connected_account_facets"
  FOR EACH ROW EXECUTE FUNCTION notify_sync_hint();
