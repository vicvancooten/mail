import { CONTACT_TRASH_RETENTION_DAYS } from "@mail/shared";
import { and, inArray, isNotNull, lte } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { contacts } from "../db/schema.js";
import { recordTombstones } from "../sync/tombstones.js";
import { pruneContactLinkMembers } from "./link-store.js";

/**
 * The Recently Deleted purge sweep (#224, `sync/note-purge.ts`'s own shape:
 * "purged for good 30 days after deletion"). A soft-deleted Contact
 * (`deletedAt` set by `sync/mutations.ts`'s `trashContact`) stays an
 * ordinary synced row until this runs — this is the one place that finally
 * does what `deleteContact` does for a permanent delete: remove the row and
 * record the tombstone `sync/collection-registry.ts`'s `userScopedCollection`
 * reads back, so every Client's next `POST /sync` drops it from its Local
 * Cache the same way any other destroyed entity does.
 *
 * Unlike a Note, a Contact can belong to a `ContactLink` — `pruneContactLinkMembers`
 * is called first, the same "every path that removes a Contact" rule
 * `deleteContact`/`deleteGoogleContactsByResourceName` already follow
 * (`link-store.ts`'s own doc comment lists this sweep among its callers): a
 * link naming a just-purged Contact would otherwise dangle.
 *
 * Nothing here owes Google/Graph an upstream delete — that already happened
 * the instant `trashContact` ran (ADR-0029: "removal discards the mirror
 * ... a confirmed act"), so by the time a row reaches this sweep its own
 * mirror identity is already null.
 *
 * Account-wide, not scoped to one User — `note-purge.ts`'s own "a plain
 * Postgres background loop" shape. `contacts_deleted_at_idx`
 * (`db/schema.ts`) keeps this a narrow index scan rather than a table scan
 * of every Contact.
 */
export async function purgeExpiredContacts(db: Db, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - CONTACT_TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const expired = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(isNotNull(contacts.deletedAt), lte(contacts.deletedAt, cutoff)));
  if (expired.length === 0) return 0;

  const ids = expired.map((row) => row.id);
  await pruneContactLinkMembers(db, null, ids);
  const purged = await db
    .delete(contacts)
    .where(inArray(contacts.id, ids))
    .returning({ id: contacts.id });

  if (purged.length > 0) {
    await recordTombstones(db, {
      mailAccountId: null,
      collection: "Contact",
      entityIds: purged.map((row) => row.id),
    });
  }
  return purged.length;
}
