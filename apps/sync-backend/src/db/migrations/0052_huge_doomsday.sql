ALTER TABLE "users" ADD COLUMN "region_locale" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "clock_format" text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "first_day_of_week" text DEFAULT 'monday' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "default_calendar_view" text DEFAULT 'week' NOT NULL;