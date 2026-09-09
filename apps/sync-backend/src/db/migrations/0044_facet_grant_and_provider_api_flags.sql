-- #202 (ADR-0022): two additive columns for turning on a Calendar or
-- Contacts Facet by incremental consent — `oauth_sign_in_attempts` gains the
-- `add_facet` purpose's own two nullable columns (`connected_account_id`,
-- `facet`), and `provider_registrations` gains the Owner's own unvalidated
-- "the Calendar/Contacts API is enabled on my Registration" declaration
-- (`calendar_api_enabled`/`contacts_api_enabled`, both defaulting `false` —
-- a fresh Registration offers Mail only until the Owner says otherwise).
--
-- Also finishes #199's own deferred tightening (migrations 0041/0042's
-- comments: "waits on `connected-accounts/boot-upgrade.ts` having run
-- everywhere first ... not this ticket's [business]"), swept in by this
-- migration's own `drizzle-kit generate` diffing the actual schema.ts
-- against a migration history that never caught up: `mail_accounts.credential`/
-- `status` are dropped for good and `connected_account_id` becomes `NOT NULL
-- UNIQUE`, exactly what `db/schema.ts` has declared since #199 merged and
-- every route has read since. Safe now that boot-upgrade has had three
-- merged tickets' worth of boots to run on every existing instance.
ALTER TABLE "mail_accounts" ALTER COLUMN "connected_account_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_sign_in_attempts" ADD COLUMN "connected_account_id" text;--> statement-breakpoint
ALTER TABLE "oauth_sign_in_attempts" ADD COLUMN "facet" text;--> statement-breakpoint
ALTER TABLE "provider_registrations" ADD COLUMN "calendar_api_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_registrations" ADD COLUMN "contacts_api_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_sign_in_attempts" ADD CONSTRAINT "oauth_sign_in_attempts_connected_account_id_connected_accounts_id_fk" FOREIGN KEY ("connected_account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_accounts" DROP COLUMN "credential";--> statement-breakpoint
ALTER TABLE "mail_accounts" DROP COLUMN "status";--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD CONSTRAINT "mail_accounts_connected_account_id_unique" UNIQUE("connected_account_id");