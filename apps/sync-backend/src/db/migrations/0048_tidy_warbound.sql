CREATE TABLE "address_books" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"connected_account_id" text,
	"name" text NOT NULL,
	"capability_table_id" text NOT NULL,
	"mirrored" boolean DEFAULT false NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"google_sync_token" text,
	"google_sync_token_minted_at" timestamp with time zone,
	"microsoft_folder_id" text,
	"microsoft_delta_link" text,
	"carddav_collection_url" text,
	"carddav_sync_token" text,
	"carddav_ctag" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sync_rev" bigint DEFAULT 0 NOT NULL,
	"sync_created_rev" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_carddav_write_backs" (
	"id" text PRIMARY KEY NOT NULL,
	"contact_id" text NOT NULL,
	"address_book_id" text NOT NULL,
	"kind" text NOT NULL,
	"previous_photo" jsonb,
	"carddav_href" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_google_write_backs" (
	"id" text PRIMARY KEY NOT NULL,
	"contact_id" text NOT NULL,
	"connected_account_id" text NOT NULL,
	"kind" text NOT NULL,
	"previous_photo" jsonb,
	"google_resource_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_links" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"contact_ids" text[] DEFAULT '{}' NOT NULL,
	"front_contact_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sync_rev" bigint DEFAULT 0 NOT NULL,
	"sync_created_rev" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_photo_blobs" (
	"id" text PRIMARY KEY NOT NULL,
	"mime_type" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_rollbacks" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"contact_id" text NOT NULL,
	"contact_name" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sync_rev" bigint DEFAULT 0 NOT NULL,
	"sync_created_rev" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" text PRIMARY KEY NOT NULL,
	"address_book_id" text NOT NULL,
	"user_id" text NOT NULL,
	"connected_account_id" text,
	"name" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"emails" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"phones" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"addresses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"websites" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"organizations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"birthday" jsonb,
	"notes" text DEFAULT '' NOT NULL,
	"label_ids" text[] DEFAULT '{}' NOT NULL,
	"custom_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"banner" jsonb,
	"categories" text[] DEFAULT '{}' NOT NULL,
	"photo" jsonb,
	"google_resource_name" text,
	"google_etag" text,
	"google_payload" jsonb,
	"microsoft_id" text,
	"microsoft_change_key" text,
	"microsoft_payload" jsonb,
	"carddav_href" text,
	"carddav_etag" text,
	"carddav_raw_vcard" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sync_rev" bigint DEFAULT 0 NOT NULL,
	"sync_created_rev" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "microsoft_contact_writes" (
	"id" text PRIMARY KEY NOT NULL,
	"address_book_id" text NOT NULL,
	"contact_id" text,
	"kind" text NOT NULL,
	"microsoft_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sync_tombstones" ADD COLUMN "connected_account_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "contacts_sort_order" text DEFAULT 'given' NOT NULL;--> statement-breakpoint
ALTER TABLE "address_books" ADD CONSTRAINT "address_books_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "address_books" ADD CONSTRAINT "address_books_connected_account_id_connected_accounts_id_fk" FOREIGN KEY ("connected_account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_carddav_write_backs" ADD CONSTRAINT "contact_carddav_write_backs_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_carddav_write_backs" ADD CONSTRAINT "contact_carddav_write_backs_address_book_id_address_books_id_fk" FOREIGN KEY ("address_book_id") REFERENCES "public"."address_books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_google_write_backs" ADD CONSTRAINT "contact_google_write_backs_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_google_write_backs" ADD CONSTRAINT "contact_google_write_backs_connected_account_id_connected_accounts_id_fk" FOREIGN KEY ("connected_account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_links" ADD CONSTRAINT "contact_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_rollbacks" ADD CONSTRAINT "contact_rollbacks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_rollbacks" ADD CONSTRAINT "contact_rollbacks_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_address_book_id_address_books_id_fk" FOREIGN KEY ("address_book_id") REFERENCES "public"."address_books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_connected_account_id_connected_accounts_id_fk" FOREIGN KEY ("connected_account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "microsoft_contact_writes" ADD CONSTRAINT "microsoft_contact_writes_address_book_id_address_books_id_fk" FOREIGN KEY ("address_book_id") REFERENCES "public"."address_books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "microsoft_contact_writes" ADD CONSTRAINT "microsoft_contact_writes_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "address_books_user_local_key" ON "address_books" USING btree ("user_id") WHERE "address_books"."connected_account_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "address_books_connected_account_google_key" ON "address_books" USING btree ("connected_account_id") WHERE "address_books"."capability_table_id" = 'google';--> statement-breakpoint
CREATE UNIQUE INDEX "address_books_connected_account_microsoft_folder_key" ON "address_books" USING btree ("connected_account_id","microsoft_folder_id") WHERE "address_books"."capability_table_id" = 'microsoft' and "address_books"."microsoft_folder_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "address_books_connected_account_carddav_collection_key" ON "address_books" USING btree ("connected_account_id","carddav_collection_url") WHERE "address_books"."capability_table_id" = 'caldav_carddav' and "address_books"."carddav_collection_url" is not null;--> statement-breakpoint
CREATE INDEX "address_books_user_id_idx" ON "address_books" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "address_books_user_sync_rev_idx" ON "address_books" USING btree ("user_id","sync_rev");--> statement-breakpoint
CREATE INDEX "address_books_connected_account_id_idx" ON "address_books" USING btree ("connected_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_carddav_write_backs_contact_kind_key" ON "contact_carddav_write_backs" USING btree ("contact_id","kind");--> statement-breakpoint
CREATE INDEX "contact_carddav_write_backs_address_book_idx" ON "contact_carddav_write_backs" USING btree ("address_book_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_google_write_backs_contact_kind_key" ON "contact_google_write_backs" USING btree ("contact_id","kind");--> statement-breakpoint
CREATE INDEX "contact_google_write_backs_account_idx" ON "contact_google_write_backs" USING btree ("connected_account_id","created_at");--> statement-breakpoint
CREATE INDEX "contact_links_user_id_idx" ON "contact_links" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "contact_links_user_sync_rev_idx" ON "contact_links" USING btree ("user_id","sync_rev");--> statement-breakpoint
CREATE INDEX "contact_rollbacks_user_id_idx" ON "contact_rollbacks" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "contact_rollbacks_user_sync_rev_idx" ON "contact_rollbacks" USING btree ("user_id","sync_rev");--> statement-breakpoint
CREATE INDEX "contacts_address_book_id_idx" ON "contacts" USING btree ("address_book_id");--> statement-breakpoint
CREATE INDEX "contacts_user_id_idx" ON "contacts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "contacts_user_sync_rev_idx" ON "contacts" USING btree ("user_id","sync_rev");--> statement-breakpoint
CREATE INDEX "contacts_connected_account_id_idx" ON "contacts" USING btree ("connected_account_id");--> statement-breakpoint
CREATE INDEX "contacts_deleted_at_idx" ON "contacts" USING btree ("deleted_at") WHERE "contacts"."deleted_at" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_address_book_google_resource_key" ON "contacts" USING btree ("address_book_id","google_resource_name") WHERE "contacts"."google_resource_name" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_address_book_microsoft_id_key" ON "contacts" USING btree ("address_book_id","microsoft_id") WHERE "contacts"."microsoft_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_address_book_carddav_href_key" ON "contacts" USING btree ("address_book_id","carddav_href") WHERE "contacts"."carddav_href" is not null;--> statement-breakpoint
CREATE INDEX "microsoft_contact_writes_address_book_id_idx" ON "microsoft_contact_writes" USING btree ("address_book_id");--> statement-breakpoint
ALTER TABLE "sync_tombstones" ADD CONSTRAINT "sync_tombstones_connected_account_id_connected_accounts_id_fk" FOREIGN KEY ("connected_account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sync_tombstones_connected_account_scope_idx" ON "sync_tombstones" USING btree ("connected_account_id","collection","sync_rev");--> statement-breakpoint
-- #209/#216/#222 (ADR-0023, ADR-0026): `AddressBook`, `Contact`,
-- `ContactLink` and `ContactRollback` join the collection registry — the
-- same delta-sync stamping every other registered collection carries
-- (`sync_rev`/`sync_created_rev`, the shared `bump_sync_rev` trigger from
-- migration 0006) and its own Sync Hint fanout (migration 0016/0037/0038/0042/0043).
--
-- All four carry `user_id` directly (denormalized even for a mirrored row,
-- `db/schema.ts`'s own doc comment), so all four fit the same simple
-- `notify_sync_hint` branch `mail_accounts`/`labels`/`notes`/
-- `connected_accounts` already share — no join through `connected_accounts`
-- needed, unlike `connected_account_facets`. `contact_google_write_backs`/
-- `contact_carddav_write_backs`/`microsoft_contact_writes`/`contact_photo_blobs`
-- are deliberately absent from both triggers: each is a Sync Backend-only
-- outbox or blob store, never a collection any Client sees or asks about.
-- `contact_rollbacks` is append-only (never updated), so its own
-- `notify_sync_hint` trigger fires on INSERT only, unlike the other three.
CREATE TRIGGER "address_books_bump_sync_rev" BEFORE INSERT OR UPDATE ON "address_books"
  FOR EACH ROW EXECUTE FUNCTION bump_sync_rev();--> statement-breakpoint
CREATE TRIGGER "contacts_bump_sync_rev" BEFORE INSERT OR UPDATE ON "contacts"
  FOR EACH ROW EXECUTE FUNCTION bump_sync_rev();--> statement-breakpoint
CREATE TRIGGER "contact_links_bump_sync_rev" BEFORE INSERT OR UPDATE ON "contact_links"
  FOR EACH ROW EXECUTE FUNCTION bump_sync_rev();--> statement-breakpoint
CREATE TRIGGER "contact_rollbacks_bump_sync_rev" BEFORE INSERT OR UPDATE ON "contact_rollbacks"
  FOR EACH ROW EXECUTE FUNCTION bump_sync_rev();--> statement-breakpoint
CREATE OR REPLACE FUNCTION notify_sync_hint() RETURNS trigger AS $$
DECLARE
  target_user_id text;
BEGIN
  IF TG_TABLE_NAME IN ('mail_accounts', 'labels', 'notes', 'connected_accounts', 'address_books', 'contacts', 'contact_links', 'contact_rollbacks') THEN
    target_user_id := COALESCE(NEW.user_id, OLD.user_id);
  ELSIF TG_TABLE_NAME = 'connected_account_facets' THEN
    SELECT user_id INTO target_user_id FROM connected_accounts
      WHERE id = COALESCE(NEW.connected_account_id, OLD.connected_account_id);
  ELSIF TG_TABLE_NAME = 'sync_tombstones' THEN
    -- User-scoped tombstones (a null mail_account_id) have no caller today
    -- (`sync/tombstones.ts`); nothing to resolve a User from until one exists.
    IF NEW.mail_account_id IS NULL THEN
      RETURN NEW;
    END IF;
    SELECT user_id INTO target_user_id FROM mail_accounts WHERE id = NEW.mail_account_id;
  ELSE
    SELECT user_id INTO target_user_id FROM mail_accounts
      WHERE id = COALESCE(NEW.mail_account_id, OLD.mail_account_id);
  END IF;

  IF target_user_id IS NOT NULL THEN
    PERFORM pg_notify('mail_sync_hint', target_user_id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "address_books_notify_sync_hint" AFTER INSERT OR UPDATE ON "address_books"
  FOR EACH ROW EXECUTE FUNCTION notify_sync_hint();--> statement-breakpoint
CREATE TRIGGER "contacts_notify_sync_hint" AFTER INSERT OR UPDATE ON "contacts"
  FOR EACH ROW EXECUTE FUNCTION notify_sync_hint();--> statement-breakpoint
CREATE TRIGGER "contact_links_notify_sync_hint" AFTER INSERT OR UPDATE ON "contact_links"
  FOR EACH ROW EXECUTE FUNCTION notify_sync_hint();--> statement-breakpoint
CREATE TRIGGER "contact_rollbacks_notify_sync_hint" AFTER INSERT ON "contact_rollbacks"
  FOR EACH ROW EXECUTE FUNCTION notify_sync_hint();