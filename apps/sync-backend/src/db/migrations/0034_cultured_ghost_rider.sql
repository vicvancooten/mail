CREATE TABLE "gmail_labels" (
	"id" text PRIMARY KEY NOT NULL,
	"mail_account_id" text NOT NULL,
	"name" text NOT NULL,
	"path" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sync_rev" bigint DEFAULT 0 NOT NULL,
	"sync_created_rev" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "gmail_label_ids" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "gmail_labels" ADD CONSTRAINT "gmail_labels_mail_account_id_mail_accounts_id_fk" FOREIGN KEY ("mail_account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gmail_labels_sync_rev_idx" ON "gmail_labels" USING btree ("mail_account_id","sync_rev");--> statement-breakpoint
-- Same delta sync API stamping as `labels`/`threads` (migration 0006):
-- `gmail_labels` joins the shared `sync_rev_seq` order so its own ADR-0011
-- collection (#126) can page the same way theirs do.
CREATE TRIGGER "gmail_labels_bump_sync_rev" BEFORE INSERT OR UPDATE ON "gmail_labels"
  FOR EACH ROW EXECUTE FUNCTION bump_sync_rev();