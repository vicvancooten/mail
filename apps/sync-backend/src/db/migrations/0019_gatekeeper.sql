CREATE TABLE "gatekeeper_verdicts" (
	"id" text PRIMARY KEY NOT NULL,
	"mail_account_id" text NOT NULL,
	"scope" text NOT NULL,
	"value" text NOT NULL,
	"verdict" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD COLUMN "gatekeeper_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD COLUMN "gatekeeper_cutoff" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "held_sender" text;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "held_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "gatekeeper_verdicts" ADD CONSTRAINT "gatekeeper_verdicts_mail_account_id_mail_accounts_id_fk" FOREIGN KEY ("mail_account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gatekeeper_verdicts_lookup_idx" ON "gatekeeper_verdicts" USING btree ("mail_account_id","scope","value");--> statement-breakpoint
CREATE INDEX "gatekeeper_verdicts_blocked_idx" ON "gatekeeper_verdicts" USING btree ("mail_account_id","updated_at") WHERE "gatekeeper_verdicts"."verdict" = 'blocked';--> statement-breakpoint
CREATE INDEX "threads_held_sender_idx" ON "threads" USING btree ("mail_account_id","held_sender") WHERE "threads"."held_sender" is not null;