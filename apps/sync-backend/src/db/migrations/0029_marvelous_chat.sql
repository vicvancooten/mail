ALTER TABLE "provider_registrations" ADD COLUMN "last_refresh_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "provider_registrations" ADD COLUMN "last_refresh_error" text;