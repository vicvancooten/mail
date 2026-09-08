-- #199 (ADR-0022): Connected Accounts own the credential. Deliberately
-- half-done by design — this is the schema-only half a `.sql` migration can
-- do: the new tables, plus `mail_accounts.credential`/`status` relaxed to
-- nullable and a nullable `connected_account_id` added alongside them, but
-- `mail_accounts.credential`/`status` are NOT dropped and
-- `connected_account_id` is NOT yet `NOT NULL UNIQUE` here.
--
-- The rest — reading every existing Mail Account's `credential` back out,
-- re-sealing it under a fresh Connected Account id, and only then tightening
-- `mail_accounts` the rest of the way to what `db/schema.ts` declares — needs
-- this instance's own `MAIL_CREDENTIAL_KEY` to unseal/reseal with, which no
-- migration file has access to. `connected-accounts/boot-upgrade.ts` does
-- that part, once, from the app's own boot path (`main.ts`), immediately
-- after this migration runs and before anything else touches the database.
CREATE TABLE "connected_account_facets" (
	"id" text PRIMARY KEY NOT NULL,
	"connected_account_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"scopes_last_granted_at" timestamp with time zone,
	"dav_principal_url" text,
	"dav_home_set_url" text,
	"dav_supports_scheduling" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connected_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"identity" text NOT NULL,
	"credential" jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"server_address" text,
	"dave_username" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mail_accounts" ALTER COLUMN "credential" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_accounts" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "mail_accounts" ALTER COLUMN "status" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD COLUMN "connected_account_id" text;--> statement-breakpoint
ALTER TABLE "connected_account_facets" ADD CONSTRAINT "connected_account_facets_connected_account_id_connected_accounts_id_fk" FOREIGN KEY ("connected_account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connected_accounts" ADD CONSTRAINT "connected_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connected_account_facets_account_kind_key" ON "connected_account_facets" USING btree ("connected_account_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "connected_accounts_user_provider_identity_key" ON "connected_accounts" USING btree ("user_id","provider","identity");--> statement-breakpoint
CREATE INDEX "connected_accounts_user_id_idx" ON "connected_accounts" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD CONSTRAINT "mail_accounts_connected_account_id_connected_accounts_id_fk" FOREIGN KEY ("connected_account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE cascade ON UPDATE no action;