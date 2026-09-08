-- #186: a Label moves from Mail Account scope to User scope (ADR-0023).
--
-- Data-preserving by hand, past the generated DDL: drizzle-kit's own diff
-- would have added `user_id NOT NULL` to a populated table and dropped
-- `mail_account_id` with the labelling still pointing at it. The generated
-- statements are all still here, in the same shape; the backfill and the
-- per-User merge are interleaved between them.
--
-- No message loses a Label. Each User's same-named Labels across their Mail
-- Accounts collapse **case-insensitively** into one surviving row, and every
-- `threads.label_ids` entry is remapped onto that survivor before the losers
-- are deleted — so a User who had "Follow up" on three accounts ends with one
-- Label carrying every Thread that had any of them.
--
-- The survivor is the group's most recently used row (`updated_at`, then
-- `created_at`, then `id` for a stable tie-break) and its own casing is the
-- one that lives on. "Keeping the most recently used row's colour" (#186) is
-- exactly this rule; there is no colour column at PoC scope
-- (`db/schema.ts#labels`), so the survivor's `name` casing is all there is to
-- keep today, and the ordering is already the one a colour would ride.
ALTER TABLE "labels" DROP CONSTRAINT "labels_mail_account_id_mail_accounts_id_fk";
--> statement-breakpoint
DROP INDEX "labels_account_name_key";--> statement-breakpoint
DROP INDEX "labels_sync_rev_idx";--> statement-breakpoint
-- Nullable for the length of this migration only; `SET NOT NULL` lands below,
-- once every row has been backfilled from its Mail Account's owner.
ALTER TABLE "labels" ADD COLUMN "user_id" text;--> statement-breakpoint
UPDATE "labels" AS l
  SET "user_id" = ma."user_id"
  FROM "mail_accounts" AS ma
  WHERE ma."id" = l."mail_account_id";--> statement-breakpoint
-- Remap the membership side first, while the losing rows are still around to
-- be named. `array_agg(DISTINCT ...)` is what collapses "this Thread carried
-- two of the merged Labels" into the survivor appearing once.
WITH "ranked" AS (
  SELECT
    "id" AS "old_id",
    "user_id",
    first_value("name") OVER (
      PARTITION BY "user_id", lower("name")
      ORDER BY "updated_at" DESC, "created_at" DESC, "id" DESC
    ) AS "survivor_name"
  FROM "labels"
), "label_map" AS (
  SELECT "old_id", "user_id" || ':' || "survivor_name" AS "new_id" FROM "ranked"
)
UPDATE "threads" AS t
  SET "label_ids" = (
    SELECT coalesce(array_agg(DISTINCT coalesce(m."new_id", e."old_id")), '{}'::text[])
    FROM unnest(t."label_ids") AS e("old_id")
    LEFT JOIN "label_map" AS m ON m."old_id" = e."old_id"
  )
  WHERE coalesce(array_length(t."label_ids", 1), 0) > 0;--> statement-breakpoint
WITH "ranked" AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "user_id", lower("name")
      ORDER BY "updated_at" DESC, "created_at" DESC, "id" DESC
    ) AS "rank"
  FROM "labels"
)
DELETE FROM "labels" WHERE "id" IN (SELECT "id" FROM "ranked" WHERE "rank" > 1);--> statement-breakpoint
-- Re-key the survivors onto `labelId(userId, name)`. Via a throwaway prefix
-- rather than in one statement: Postgres checks the primary key per row, not
-- per statement, so an old id and some other row's new id colliding
-- mid-update would abort. Nothing can collide with `wicket-186-migrating:`,
-- and no final id starts with it.
UPDATE "labels" SET "id" = 'wicket-186-migrating:' || "id";--> statement-breakpoint
UPDATE "labels" SET "id" = "user_id" || ':' || "name";--> statement-breakpoint
-- No route ever wrote one (`db/schema.ts#syncTombstones`), but a Label
-- tombstone recorded under the old scope would be keyed by a Mail Account the
-- User-scoped delta query no longer looks at — and by a now-rewritten id.
DELETE FROM "sync_tombstones" WHERE "collection" = 'Label';--> statement-breakpoint
ALTER TABLE "labels" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "labels_user_name_key" ON "labels" USING btree ("user_id","name");--> statement-breakpoint
CREATE INDEX "labels_sync_rev_idx" ON "labels" USING btree ("user_id","sync_rev");--> statement-breakpoint
ALTER TABLE "labels" DROP COLUMN "mail_account_id";--> statement-breakpoint
-- ADR-0015's sync-hint fanout (migration 0016) resolves a row's User by
-- joining `mail_accounts` on `NEW.mail_account_id`, which `labels` no longer
-- has — a `labels` write would raise `record "new" has no field
-- "mail_account_id"` outright. `labels` now carries the User directly, the
-- same as `mail_accounts` does, so it joins that branch. Replaced whole
-- rather than patched: a plpgsql function has no in-place edit, and the
-- triggers below it are unaffected by a `CREATE OR REPLACE`.
CREATE OR REPLACE FUNCTION notify_sync_hint() RETURNS trigger AS $$
DECLARE
  target_user_id text;
BEGIN
  IF TG_TABLE_NAME IN ('mail_accounts', 'labels') THEN
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
