import { and, inArray, isNotNull, lte } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { userCollectionRegistry } from "./collection-registry.js";
import { recordTombstones } from "./tombstones.js";

/**
 * The Recently Deleted purge sweep (#194's own acceptance line: "purged for
 * good 30 days after deletion"), generalised by #257 to read the collection
 * registry (`collection-registry.ts`'s `retention` field) rather than naming
 * `notes` by hand — `Note`, `TaskList` and `Task` all declare one today, and
 * a later App's own soft-deleted collection joins this same sweep by
 * declaring its own `retention` rather than standing up a second loop.
 *
 * A soft-deleted row (`deletedAt` set by that collection's own trash intent)
 * stays an ordinary synced row until this runs — this is the one place that
 * finally does what a hard delete does for a permanent one: remove the row
 * and record the tombstone `sync/collection-registry.ts`'s
 * `userScopedCollection` reads back, so every Client's next `POST /sync`
 * drops it from its Local Cache the same way any other destroyed entity
 * does.
 *
 * Every retention-bearing collection purges independently and in whichever
 * order `userCollectionRegistry` happens to declare them — deliberately not
 * a correctness dependency, because `Task`'s own row can also vanish before
 * its own turn comes: `deleteTaskList` (`sync/mutations.ts`) stamps the same
 * `deletedAt` on a List and every Task it cascades onto, so if `TaskList`'s
 * own purge reaches the List first, Postgres's `ON DELETE CASCADE`
 * (`db/schema.ts#tasks`) physically removes those Task rows as a side
 * effect, ahead of `Task`'s own turn in this loop. Each collection's ids to
 * purge are therefore selected *before* any collection's rows are deleted —
 * every id past its own retention window gets its own tombstone regardless
 * of which cascade got there first — and each delete then targets exactly
 * that already-selected id list (by primary key, not by re-matching
 * `deletedAt`), which is a harmless no-op for an id a different collection's
 * cascade already removed.
 */
export async function purgeExpiredTombstones(db: Db, now: Date = new Date()): Promise<number> {
  const retentionBearing = userCollectionRegistry.filter((descriptor) => descriptor.retention);

  const toPurge = await Promise.all(
    retentionBearing.map(async (descriptor) => {
      const retention = descriptor.retention;
      if (!retention) return { descriptor, ids: [] as string[] };
      const cutoff = new Date(now.getTime() - retention.days * 24 * 60 * 60 * 1000);
      const rows = await db
        .select({ id: retention.id })
        .from(descriptor.table)
        .where(and(isNotNull(retention.deletedAt), lte(retention.deletedAt, cutoff)));
      return { descriptor, ids: rows.map((row) => row.id as string) };
    }),
  );

  let purged = 0;
  for (const { descriptor, ids } of toPurge) {
    const retention = descriptor.retention;
    if (!retention || ids.length === 0) continue;
    await db.delete(descriptor.table).where(inArray(retention.id, ids));
    await recordTombstones(db, {
      mailAccountId: null,
      collection: descriptor.name,
      entityIds: ids,
    });
    purged += ids.length;
  }
  return purged;
}
