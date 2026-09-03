CREATE TABLE "bulk_triage_batches" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"action" text NOT NULL,
	"affected_thread_ids" text[] DEFAULT '{}' NOT NULL,
	"accounts" jsonb NOT NULL,
	"undone_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bulk_triage_batches" ADD CONSTRAINT "bulk_triage_batches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bulk_triage_batches_user_idx" ON "bulk_triage_batches" USING btree ("user_id");