CREATE TABLE "compose_save_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"composition_id" text NOT NULL,
	"status" text NOT NULL,
	"version" integer NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compositions" (
	"id" text PRIMARY KEY NOT NULL,
	"mail_account_id" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"document" jsonb NOT NULL,
	"to_addresses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cc_addresses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"bcc_addresses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"imap_draft_uid" bigint,
	"imap_draft_folder_id" text,
	"pushed_content_hash" text,
	"last_pushed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "compositions" ADD CONSTRAINT "compositions_mail_account_id_mail_accounts_id_fk" FOREIGN KEY ("mail_account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compositions" ADD CONSTRAINT "compositions_imap_draft_folder_id_folders_id_fk" FOREIGN KEY ("imap_draft_folder_id") REFERENCES "public"."folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "compose_save_ledger_composition_idx" ON "compose_save_ledger" USING btree ("composition_id");--> statement-breakpoint
CREATE INDEX "compositions_account_status_idx" ON "compositions" USING btree ("mail_account_id","status");--> statement-breakpoint
CREATE INDEX "compositions_push_pending_idx" ON "compositions" USING btree ("mail_account_id","updated_at") WHERE "compositions"."status" = 'draft';