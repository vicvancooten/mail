CREATE TABLE "calendar_mirror_sync_state" (
	"connected_account_id" text PRIMARY KEY NOT NULL,
	"last_calendar_list_sync_at" timestamp with time zone,
	"last_event_sync_at" timestamp with time zone,
	"poll_requested_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "calendar_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"calendar_id" text NOT NULL,
	"series_id" text NOT NULL,
	"operation" text NOT NULL,
	"send_invitations" boolean DEFAULT true NOT NULL,
	"response_status" text,
	"move_from_series_id" text,
	"base_etag" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"deadline" timestamp with time zone NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_outbox_series_id_unique" UNIQUE("series_id")
);
--> statement-breakpoint
CREATE TABLE "calendar_watch_channels" (
	"channel_id" text PRIMARY KEY NOT NULL,
	"resource_id" text NOT NULL,
	"connected_account_id" text NOT NULL,
	"expiration" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendars" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"time_zone" text NOT NULL,
	"origin_type" text NOT NULL,
	"connected_account_id" text,
	"color" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"mail_account_id" text,
	"mirrored" boolean DEFAULT true NOT NULL,
	"capabilities" jsonb NOT NULL,
	"google_sync_token" text,
	"graph_delta_link" text,
	"graph_change_key" text,
	"dav_ctag" text,
	"dav_sync_token" text,
	"missing_confirmations" integer DEFAULT 0 NOT NULL,
	"reminders_enabled" boolean DEFAULT true NOT NULL,
	"reminder_default" jsonb DEFAULT '{"timed":[],"allDay":[]}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sync_rev" bigint DEFAULT 0 NOT NULL,
	"sync_created_rev" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"calendar_id" text NOT NULL,
	"series_id" text NOT NULL,
	"upstream_event_id" text,
	"original_start" timestamp with time zone NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"all_day" boolean DEFAULT false NOT NULL,
	"tzid" text,
	"floating" boolean DEFAULT false NOT NULL,
	"title" text NOT NULL,
	"location" text,
	"status" text DEFAULT 'confirmed' NOT NULL,
	"transparency" text DEFAULT 'opaque' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sync_rev" bigint DEFAULT 0 NOT NULL,
	"sync_created_rev" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "imip_replies" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"series_id" text NOT NULL,
	"mail_account_id" text NOT NULL,
	"organizer_address" text NOT NULL,
	"organizer_name" text,
	"attendee_address" text NOT NULL,
	"uid" text NOT NULL,
	"sequence" integer NOT NULL,
	"response_status" text NOT NULL,
	"event_title" text,
	"ics_text" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"submit_after" timestamp with time zone NOT NULL,
	"send_attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"send_error" text,
	"message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "imip_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"series_id" text NOT NULL,
	"mail_account_id" text NOT NULL,
	"method" text NOT NULL,
	"organizer_address" text NOT NULL,
	"organizer_name" text,
	"attendee_address" text NOT NULL,
	"attendee_name" text,
	"uid" text NOT NULL,
	"sequence" integer NOT NULL,
	"recurrence_id" text DEFAULT '' NOT NULL,
	"event_title" text,
	"ics_text" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"submit_after" timestamp with time zone NOT NULL,
	"send_attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"send_error" text,
	"message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"mail_account_id" text NOT NULL,
	"message_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"kind" text NOT NULL,
	"method" text NOT NULL,
	"source" text NOT NULL,
	"uid" text NOT NULL,
	"recurrence_id" text DEFAULT '' NOT NULL,
	"sequence" integer DEFAULT 0 NOT NULL,
	"dtstamp" timestamp with time zone NOT NULL,
	"organizer" jsonb,
	"attendees" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"vevent" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "overrides" (
	"id" text PRIMARY KEY NOT NULL,
	"series_id" text NOT NULL,
	"original_start" timestamp with time zone NOT NULL,
	"start" timestamp with time zone,
	"end" timestamp with time zone,
	"title" text,
	"location" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reminder_due" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"calendar_id" text NOT NULL,
	"series_id" text NOT NULL,
	"event_id" text NOT NULL,
	"original_start" timestamp with time zone NOT NULL,
	"minutes_before" integer NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"fired_at" timestamp with time zone,
	"snoozed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rollbacks" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"collection" text NOT NULL,
	"entity_id" text NOT NULL,
	"reason" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sync_rev" bigint DEFAULT 0 NOT NULL,
	"sync_created_rev" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "series" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"calendar_id" text NOT NULL,
	"uid" text NOT NULL,
	"sequence" integer DEFAULT 0 NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"location" text,
	"all_day" boolean DEFAULT false NOT NULL,
	"floating" boolean DEFAULT false NOT NULL,
	"tzid" text,
	"dtstart" timestamp with time zone NOT NULL,
	"duration_ms" bigint NOT NULL,
	"rrules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rdates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"exdates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"transparency" text DEFAULT 'opaque' NOT NULL,
	"attendees" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reminders" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"upstream_id" text,
	"etag" text,
	"upstream_snapshot" jsonb,
	"dav_schedule_tag" text,
	"deleted_at" timestamp with time zone,
	"organizer_first_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notifier_outbox" ADD COLUMN "ready_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "answer_notifications_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_outbox" ADD CONSTRAINT "calendar_outbox_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_outbox" ADD CONSTRAINT "calendar_outbox_calendar_id_calendars_id_fk" FOREIGN KEY ("calendar_id") REFERENCES "public"."calendars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_outbox" ADD CONSTRAINT "calendar_outbox_series_id_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."series"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_outbox" ADD CONSTRAINT "calendar_outbox_move_from_series_id_series_id_fk" FOREIGN KEY ("move_from_series_id") REFERENCES "public"."series"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendars" ADD CONSTRAINT "calendars_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendars" ADD CONSTRAINT "calendars_mail_account_id_mail_accounts_id_fk" FOREIGN KEY ("mail_account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_calendar_id_calendars_id_fk" FOREIGN KEY ("calendar_id") REFERENCES "public"."calendars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imip_replies" ADD CONSTRAINT "imip_replies_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imip_replies" ADD CONSTRAINT "imip_replies_series_id_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."series"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imip_replies" ADD CONSTRAINT "imip_replies_mail_account_id_mail_accounts_id_fk" FOREIGN KEY ("mail_account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imip_requests" ADD CONSTRAINT "imip_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imip_requests" ADD CONSTRAINT "imip_requests_series_id_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."series"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imip_requests" ADD CONSTRAINT "imip_requests_mail_account_id_mail_accounts_id_fk" FOREIGN KEY ("mail_account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_mail_account_id_mail_accounts_id_fk" FOREIGN KEY ("mail_account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overrides" ADD CONSTRAINT "overrides_series_id_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."series"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_due" ADD CONSTRAINT "reminder_due_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_due" ADD CONSTRAINT "reminder_due_calendar_id_calendars_id_fk" FOREIGN KEY ("calendar_id") REFERENCES "public"."calendars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_due" ADD CONSTRAINT "reminder_due_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rollbacks" ADD CONSTRAINT "rollbacks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series" ADD CONSTRAINT "series_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series" ADD CONSTRAINT "series_calendar_id_calendars_id_fk" FOREIGN KEY ("calendar_id") REFERENCES "public"."calendars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "calendar_outbox_due_idx" ON "calendar_outbox" USING btree ("next_attempt_at");--> statement-breakpoint
CREATE INDEX "calendars_sync_rev_idx" ON "calendars" USING btree ("user_id","sync_rev");--> statement-breakpoint
CREATE INDEX "events_sync_rev_idx" ON "events" USING btree ("user_id","sync_rev");--> statement-breakpoint
CREATE INDEX "events_calendar_id_idx" ON "events" USING btree ("calendar_id");--> statement-breakpoint
CREATE INDEX "events_series_id_idx" ON "events" USING btree ("series_id");--> statement-breakpoint
CREATE INDEX "events_upstream_event_id_idx" ON "events" USING btree ("calendar_id","upstream_event_id") WHERE "events"."upstream_event_id" is not null;--> statement-breakpoint
CREATE INDEX "imip_replies_status_submit_after_idx" ON "imip_replies" USING btree ("status","submit_after");--> statement-breakpoint
CREATE INDEX "imip_replies_series_idx" ON "imip_replies" USING btree ("series_id");--> statement-breakpoint
CREATE INDEX "imip_requests_status_submit_after_idx" ON "imip_requests" USING btree ("status","submit_after");--> statement-breakpoint
CREATE INDEX "imip_requests_series_idx" ON "imip_requests" USING btree ("series_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_message_uid_recurrence_key" ON "invitations" USING btree ("message_id","uid","recurrence_id");--> statement-breakpoint
CREATE INDEX "invitations_thread_uid_revision_idx" ON "invitations" USING btree ("thread_id","uid","sequence","dtstamp");--> statement-breakpoint
CREATE UNIQUE INDEX "overrides_series_id_original_start_idx" ON "overrides" USING btree ("series_id","original_start");--> statement-breakpoint
CREATE INDEX "reminder_due_series_id_idx" ON "reminder_due" USING btree ("series_id");--> statement-breakpoint
CREATE INDEX "reminder_due_pending_idx" ON "reminder_due" USING btree ("due_at") WHERE "reminder_due"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "rollbacks_sync_rev_idx" ON "rollbacks" USING btree ("user_id","sync_rev");--> statement-breakpoint
CREATE INDEX "series_calendar_id_idx" ON "series" USING btree ("calendar_id");--> statement-breakpoint
CREATE INDEX "series_user_id_idx" ON "series" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "series_deleted_at_idx" ON "series" USING btree ("deleted_at") WHERE "series"."deleted_at" is not null;