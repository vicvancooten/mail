CREATE TABLE "task_lists" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"sections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"order" double precision DEFAULT 0 NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sync_rev" bigint DEFAULT 0 NOT NULL,
	"sync_created_rev" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"task_list_id" text NOT NULL,
	"section_id" text,
	"title" text NOT NULL,
	"document" jsonb NOT NULL,
	"completed" boolean DEFAULT false NOT NULL,
	"completed_at" timestamp with time zone,
	"due_date" timestamp with time zone,
	"due_time" text,
	"label_ids" text[] DEFAULT '{}' NOT NULL,
	"thread_link" jsonb,
	"order" double precision DEFAULT 0 NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sync_rev" bigint DEFAULT 0 NOT NULL,
	"sync_created_rev" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task_lists" ADD CONSTRAINT "task_lists_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_task_list_id_task_lists_id_fk" FOREIGN KEY ("task_list_id") REFERENCES "public"."task_lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_lists_sync_rev_idx" ON "task_lists" USING btree ("user_id","sync_rev");--> statement-breakpoint
CREATE INDEX "task_lists_deleted_at_idx" ON "task_lists" USING btree ("deleted_at") WHERE "task_lists"."deleted_at" is not null;--> statement-breakpoint
CREATE INDEX "tasks_sync_rev_idx" ON "tasks" USING btree ("user_id","sync_rev");--> statement-breakpoint
CREATE INDEX "tasks_task_list_id_idx" ON "tasks" USING btree ("task_list_id");--> statement-breakpoint
CREATE INDEX "tasks_deleted_at_idx" ON "tasks" USING btree ("deleted_at") WHERE "tasks"."deleted_at" is not null;--> statement-breakpoint
-- #251: `task_lists`/`tasks` join the shared `sync_rev_seq` order, the same
-- delta-sync API stamping `notes`/`labels`/`threads`/`contacts` already
-- carry (migration 0006's own comment).
CREATE TRIGGER "task_lists_bump_sync_rev" BEFORE INSERT OR UPDATE ON "task_lists"
  FOR EACH ROW EXECUTE FUNCTION bump_sync_rev();--> statement-breakpoint
CREATE TRIGGER "tasks_bump_sync_rev" BEFORE INSERT OR UPDATE ON "tasks"
  FOR EACH ROW EXECUTE FUNCTION bump_sync_rev();--> statement-breakpoint
-- ADR-0015's fanout (migration 0016), extended per ADR-0023's "App
-- collections emit Sync Hints through the same LISTEN/NOTIFY path": both
-- carry `user_id` directly, the same as `mail_accounts`/`labels`/`notes`/
-- `contacts` and siblings (migration 0037/0049's own comments), so they join
-- that branch rather than the `mail_accounts`-join one every
-- Mail-Account-scoped table falls through to. Replaced whole, same reason
-- migrations 0037/0038/0042/0047/0049 already give: a plpgsql function has
-- no in-place edit.
CREATE OR REPLACE FUNCTION notify_sync_hint() RETURNS trigger AS $$
DECLARE
  target_user_id text;
BEGIN
  IF TG_TABLE_NAME IN ('mail_accounts', 'labels', 'notes', 'connected_accounts', 'address_books', 'contacts', 'contact_links', 'contact_rollbacks', 'task_lists', 'tasks') THEN
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
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "task_lists_notify_sync_hint" AFTER INSERT OR UPDATE ON "task_lists"
  FOR EACH ROW EXECUTE FUNCTION notify_sync_hint();--> statement-breakpoint
CREATE TRIGGER "tasks_notify_sync_hint" AFTER INSERT OR UPDATE ON "tasks"
  FOR EACH ROW EXECUTE FUNCTION notify_sync_hint();