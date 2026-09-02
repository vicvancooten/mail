ALTER TABLE "folders" ADD COLUMN "backfill_cursor_seq" integer;--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN "backfill_complete" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD COLUMN "body_watermark" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD COLUMN "body_sweep_complete" boolean DEFAULT false NOT NULL;