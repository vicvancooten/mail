import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { syncTombstones } from "../db/schema.js";

/**
 * Records that entities have left a collection (ADR-0011's `destroyed`
 * list) — `sync/threading.ts`'s Thread merge losers and empty-Thread cleanup
 * are the only callers today. A no-op for an empty list so call sites never
 * need their own guard.
 *
 * Each row draws its own `sync_rev` from the sequence every sync-tracked
 * table shares (`db/schema.ts`'s `bump_sync_rev` trigger), one `nextval()`
 * per entity rather than one shared value for the whole batch — sharing a
 * revision across several tombstones would let `collection-sync.ts`'s
 * page-boundary `> cursor` query split a same-revision batch across two
 * pages and silently drop whichever half landed in the first one.
 */
export async function recordTombstones(
  db: Db,
  params: { mailAccountId: string | null; collection: string; entityIds: string[] },
): Promise<void> {
  const { mailAccountId, collection, entityIds } = params;
  if (entityIds.length === 0) return;

  const revs = await nextSyncRevs(db, entityIds.length);
  await db.insert(syncTombstones).values(
    entityIds.map((entityId, index) => ({
      id: randomUUID(),
      mailAccountId,
      collection,
      entityId,
      // `nextSyncRevs` returns exactly `entityIds.length` values in order.
      syncRev: revs[index] as number,
    })),
  );
}

async function nextSyncRevs(db: Db, count: number): Promise<number[]> {
  const rows = await db.execute<{ rev: string }>(
    sql`select nextval('sync_rev_seq') as rev from generate_series(1, ${count})`,
  );
  return [...rows].map((row) => Number(row.rev));
}
