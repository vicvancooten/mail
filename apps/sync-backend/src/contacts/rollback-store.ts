import type { ContactRollback, ContactRollbackReason } from "@mail/shared";
import { generateUlid } from "@mail/shared";
import { and, asc, eq, gt } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { contactRollbacks } from "../db/schema.js";

export type ContactRollbackRow = typeof contactRollbacks.$inferSelect;

/**
 * `db/schema.ts#contactRollbacks`'s own reads and writes (#216) —
 * `contacts/store.ts`'s sibling for the write-back "upstream wins" event
 * rather than the Contact itself. `recordContactRollback` is
 * `google/write-back-loop.ts`'s only writer; `selectContactRollbacksForUser`
 * is `sync/collection-registry.ts`'s `userScopedCollection` read.
 */

export async function recordContactRollback(
  db: Db,
  args: { userId: string; contactId: string; contactName: string; reason: ContactRollbackReason },
): Promise<void> {
  await db.insert(contactRollbacks).values({
    id: generateUlid(),
    userId: args.userId,
    contactId: args.contactId,
    contactName: args.contactName,
    reason: args.reason,
  });
}

export function selectContactRollbacksForUser(db: Db, userId: string, cursorRev: number) {
  return db
    .select()
    .from(contactRollbacks)
    .where(and(eq(contactRollbacks.userId, userId), gt(contactRollbacks.syncRev, cursorRev)))
    .orderBy(asc(contactRollbacks.syncRev));
}

export function toWireContactRollback(row: ContactRollbackRow): ContactRollback {
  return {
    id: row.id,
    contactId: row.contactId,
    contactName: row.contactName,
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
  };
}
