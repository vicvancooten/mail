-- #204 (ADR-0022): "Needs Reauth has two levels, one name" reaches the
-- Notifier. `notifier_outbox.mail_account_id` was `NOT NULL` because every
-- kind so far was Mail-only; a `needs_reauth` notification for a Calendar or
-- Contacts Facet has no `mail_accounts` row to name, so it becomes nullable.
-- `connected_account_id`/`facet` are `needs_reauth`'s own new columns — the
-- deep link's real target, set for every `needs_reauth` row going forward,
-- Mail Facet included, so the delivery loop and the notification-click
-- router have one shape to read regardless of which Facet parked.
ALTER TABLE "notifier_outbox" ALTER COLUMN "mail_account_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "notifier_outbox" ADD COLUMN "connected_account_id" text;--> statement-breakpoint
ALTER TABLE "notifier_outbox" ADD COLUMN "facet" text;--> statement-breakpoint
ALTER TABLE "notifier_outbox" ADD CONSTRAINT "notifier_outbox_connected_account_id_connected_accounts_id_fk" FOREIGN KEY ("connected_account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE cascade ON UPDATE no action;
