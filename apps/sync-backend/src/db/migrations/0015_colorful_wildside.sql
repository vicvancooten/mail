-- ADR-0016's Search Index: `simple` + `unaccent`, no stemming. `unaccent` is
-- Postgres contrib, shipped with the stock image ADR-0009's deployment
-- already commits to — no custom image needed for this word list.
CREATE EXTENSION IF NOT EXISTS unaccent;
--> statement-breakpoint
CREATE TABLE "message_search" (
	"message_id" text PRIMARY KEY NOT NULL,
	"mail_account_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"folder_id" text NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"doc" "tsvector" NOT NULL,
	"index_version" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "message_search" ADD CONSTRAINT "message_search_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_search" ADD CONSTRAINT "message_search_mail_account_id_mail_accounts_id_fk" FOREIGN KEY ("mail_account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_search" ADD CONSTRAINT "message_search_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_search_doc_idx" ON "message_search" USING gin ("doc");--> statement-breakpoint
CREATE INDEX "message_search_account_recency_idx" ON "message_search" USING btree ("mail_account_id","sent_at");--> statement-breakpoint
CREATE INDEX "message_search_index_version_idx" ON "message_search" USING btree ("index_version");