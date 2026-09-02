CREATE TABLE "folders" (
	"id" text PRIMARY KEY NOT NULL,
	"mail_account_id" text NOT NULL,
	"path" text NOT NULL,
	"name" text NOT NULL,
	"delimiter" text,
	"role" text,
	"subscribed" boolean DEFAULT true NOT NULL,
	"selectable" boolean DEFAULT true NOT NULL,
	"uid_validity" bigint,
	"uid_next" bigint,
	"highest_modseq" bigint,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"mail_account_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"folder_id" text NOT NULL,
	"uid" bigint NOT NULL,
	"uid_validity" bigint,
	"message_id_header" text,
	"in_reply_to" text,
	"references" text[] DEFAULT '{}' NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"from_name" text,
	"from_address" text,
	"to_addresses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cc_addresses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reply_to_addresses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"seen" boolean DEFAULT false NOT NULL,
	"flagged" boolean DEFAULT false NOT NULL,
	"answered" boolean DEFAULT false NOT NULL,
	"draft" boolean DEFAULT false NOT NULL,
	"flags" text[] DEFAULT '{}' NOT NULL,
	"size_bytes" integer,
	"has_attachments" boolean DEFAULT false NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"snippet" text,
	"body_text" text,
	"body_html" text,
	"body_fetched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thread_message_ids" (
	"mail_account_id" text NOT NULL,
	"message_id_header" text NOT NULL,
	"thread_id" text NOT NULL,
	CONSTRAINT "thread_message_ids_mail_account_id_message_id_header_pk" PRIMARY KEY("mail_account_id","message_id_header")
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" text PRIMARY KEY NOT NULL,
	"mail_account_id" text NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"participants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"snippet" text,
	"last_message_id" text,
	"first_message_at" timestamp with time zone,
	"last_message_at" timestamp with time zone,
	"message_count" integer DEFAULT 0 NOT NULL,
	"unread_count" integer DEFAULT 0 NOT NULL,
	"starred" boolean DEFAULT false NOT NULL,
	"has_attachments" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_mail_account_id_mail_accounts_id_fk" FOREIGN KEY ("mail_account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_mail_account_id_mail_accounts_id_fk" FOREIGN KEY ("mail_account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_message_ids" ADD CONSTRAINT "thread_message_ids_mail_account_id_mail_accounts_id_fk" FOREIGN KEY ("mail_account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_message_ids" ADD CONSTRAINT "thread_message_ids_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_mail_account_id_mail_accounts_id_fk" FOREIGN KEY ("mail_account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "folders_account_path_key" ON "folders" USING btree ("mail_account_id","path");--> statement-breakpoint
CREATE INDEX "folders_account_role_idx" ON "folders" USING btree ("mail_account_id","role");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_folder_uid_key" ON "messages" USING btree ("folder_id","uid");--> statement-breakpoint
CREATE INDEX "messages_thread_idx" ON "messages" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "messages_account_received_idx" ON "messages" USING btree ("mail_account_id","received_at");--> statement-breakpoint
CREATE INDEX "messages_account_message_id_idx" ON "messages" USING btree ("mail_account_id","message_id_header");--> statement-breakpoint
CREATE INDEX "messages_body_pending_idx" ON "messages" USING btree ("mail_account_id","received_at") WHERE "messages"."body_fetched_at" is null;--> statement-breakpoint
CREATE INDEX "thread_message_ids_thread_idx" ON "thread_message_ids" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "threads_account_last_message_idx" ON "threads" USING btree ("mail_account_id","last_message_at");