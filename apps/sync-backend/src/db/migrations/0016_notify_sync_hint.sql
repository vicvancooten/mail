-- ADR-0015's fanout: `pg_notify` on channel `mail_sync_hint`, payload the
-- affected User's id, fired from an AFTER trigger on every sync-tracked
-- table so it runs *inside* the writing transaction and only ever reaches a
-- listener on commit (Postgres's own NOTIFY semantics) — never from an
-- in-process emitter, which the ADR rejects outright.
--
-- Deliberately the **same payload** (just `user_id`) from every table: when
-- one transaction touches several sync-tracked rows for the same User —
-- ordinary for a multi-message IDLE batch — Postgres folds repeated
-- same-channel-same-payload NOTIFYs from one transaction into a single
-- delivery, so "one NOTIFY per transaction" falls out of this for free
-- rather than needing its own bookkeeping. The ~500ms/User coalescing across
-- *separate* transactions is the fanout listener's job
-- (`src/realtime/sync-hints.ts`), not this trigger's.
CREATE FUNCTION notify_sync_hint() RETURNS trigger AS $$
DECLARE
  target_user_id text;
BEGIN
  IF TG_TABLE_NAME = 'mail_accounts' THEN
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
--> statement-breakpoint
CREATE TRIGGER "mail_accounts_notify_sync_hint" AFTER INSERT OR UPDATE ON "mail_accounts"
  FOR EACH ROW EXECUTE FUNCTION notify_sync_hint();
--> statement-breakpoint
CREATE TRIGGER "threads_notify_sync_hint" AFTER INSERT OR UPDATE ON "threads"
  FOR EACH ROW EXECUTE FUNCTION notify_sync_hint();
--> statement-breakpoint
CREATE TRIGGER "labels_notify_sync_hint" AFTER INSERT OR UPDATE ON "labels"
  FOR EACH ROW EXECUTE FUNCTION notify_sync_hint();
--> statement-breakpoint
CREATE TRIGGER "compositions_notify_sync_hint" AFTER INSERT OR UPDATE ON "compositions"
  FOR EACH ROW EXECUTE FUNCTION notify_sync_hint();
--> statement-breakpoint
CREATE TRIGGER "correspondents_notify_sync_hint" AFTER INSERT OR UPDATE ON "correspondents"
  FOR EACH ROW EXECUTE FUNCTION notify_sync_hint();
--> statement-breakpoint
-- Thread merges and Composition/Correspondent housekeeping delete rows
-- outright rather than updating them (`sync/threading.ts`), so their
-- `recordTombstones` insert is the only write left in that transaction to
-- carry the hint.
CREATE TRIGGER "sync_tombstones_notify_sync_hint" AFTER INSERT ON "sync_tombstones"
  FOR EACH ROW EXECUTE FUNCTION notify_sync_hint();
