CREATE TABLE "correspondents" (
	"id" text PRIMARY KEY NOT NULL,
	"mail_account_id" text NOT NULL,
	"normalized_address" text NOT NULL,
	"address" text NOT NULL,
	"name" text,
	"sent_count" integer DEFAULT 0 NOT NULL,
	"received_count" integer DEFAULT 0 NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"score" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sync_rev" bigint DEFAULT 0 NOT NULL,
	"sync_created_rev" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "correspondents" ADD CONSTRAINT "correspondents_mail_account_id_mail_accounts_id_fk" FOREIGN KEY ("mail_account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "correspondents_account_address_key" ON "correspondents" USING btree ("mail_account_id","normalized_address");--> statement-breakpoint
CREATE INDEX "correspondents_account_score_idx" ON "correspondents" USING btree ("mail_account_id","score");--> statement-breakpoint
CREATE INDEX "correspondents_sync_rev_idx" ON "correspondents" USING btree ("mail_account_id","sync_rev");--> statement-breakpoint
-- Same delta sync API stamping as `mail_accounts`/`threads`/`labels`
-- (migrations 0006/0009): `correspondents` joins the shared `sync_rev_seq`
-- order so its own ADR-0011 collection (#49) can page the same way theirs
-- do.
CREATE TRIGGER "correspondents_bump_sync_rev" BEFORE INSERT OR UPDATE ON "correspondents"
  FOR EACH ROW EXECUTE FUNCTION bump_sync_rev();