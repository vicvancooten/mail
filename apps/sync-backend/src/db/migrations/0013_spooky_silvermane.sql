ALTER TABLE "compositions" ADD COLUMN "in_reply_to" text;--> statement-breakpoint
ALTER TABLE "compositions" ADD COLUMN "references" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD COLUMN "signature" text;