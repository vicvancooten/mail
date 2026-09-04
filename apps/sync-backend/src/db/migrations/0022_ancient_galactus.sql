ALTER TABLE "threads" ADD COLUMN "folder_role" text DEFAULT 'inbox' NOT NULL;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "has_sent_message" boolean DEFAULT false NOT NULL;