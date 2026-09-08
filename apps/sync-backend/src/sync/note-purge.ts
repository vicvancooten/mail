import { NOTE_TRASH_RETENTION_DAYS } from "@mail/shared";
import { and, isNotNull, lte } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { notes } from "../db/schema.js";
import { recordTombstones } from "./tombstones.js";

/**
 * The Recently Deleted purge sweep (#194's own acceptance line: "purged for
 * good 30 days after deletion"). A soft-deleted Note (`deletedAt` set by
 * `sync/mutations.ts`'s `trashNote`) stays an ordinary synced row until this
 * runs — this is the one place that finally does what `deleteNote` does for
 * a permanent delete: remove the row and record the tombstone
 * `sync/collection-registry.ts`'s `userScopedCollection` reads back, so
 * every Client's next `POST /sync` drops it from its Local Cache the same
 * way any other destroyed entity does.
 *
 * Account-wide, not scoped to one User — the same "a plain Postgres
 * background loop" shape `sync/snooze.ts#wakeDueSnoozes` already has for its
 * own one-directional, no-Client-intent sweep. `notes_deleted_at_idx`
 * (`db/schema.ts`) is what keeps this a narrow index scan rather than a
 * table scan of every Note.
 */
export async function purgeExpiredNotes(db: Db, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - NOTE_TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const purged = await db
    .delete(notes)
    .where(and(isNotNull(notes.deletedAt), lte(notes.deletedAt, cutoff)))
    .returning({ id: notes.id });

  if (purged.length > 0) {
    await recordTombstones(db, {
      mailAccountId: null,
      collection: "Note",
      entityIds: purged.map((row) => row.id),
    });
  }
  return purged.length;
}
