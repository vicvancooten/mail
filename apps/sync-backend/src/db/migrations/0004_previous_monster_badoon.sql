ALTER TABLE "mail_accounts" ADD COLUMN "sync_state" text DEFAULT 'stopped' NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD COLUMN "last_progress_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD COLUMN "last_sync_error" text;