CREATE TABLE "labels" (
	"id" text PRIMARY KEY NOT NULL,
	"mail_account_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sync_rev" bigint DEFAULT 0 NOT NULL,
	"sync_created_rev" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "pinned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "label_ids" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_mail_account_id_mail_accounts_id_fk" FOREIGN KEY ("mail_account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "labels_account_name_key" ON "labels" USING btree ("mail_account_id","name");--> statement-breakpoint
CREATE INDEX "labels_sync_rev_idx" ON "labels" USING btree ("mail_account_id","sync_rev");--> statement-breakpoint
-- Same delta sync API stamping as `mail_accounts`/`threads` (migration 0006):
-- `labels` joins the shared `sync_rev_seq` order so its own ADR-0011
-- collection (#43) can page the same way theirs do.
CREATE TRIGGER "labels_bump_sync_rev" BEFORE INSERT OR UPDATE ON "labels"
  FOR EACH ROW EXECUTE FUNCTION bump_sync_rev();