import type { ContactPhoto } from "@mail/shared";
import { generateUlid } from "@mail/shared";
import { asc, eq } from "drizzle-orm";
import type { Db, Tx } from "../db/client.js";
import { contactCarddavWriteBacks, contactGoogleWriteBacks } from "../db/schema.js";

export type ContactGoogleWriteBackRow = typeof contactGoogleWriteBacks.$inferSelect;
export type ContactCarddavWriteBackRow = typeof contactCarddavWriteBacks.$inferSelect;

/**
 * `db/schema.ts#contactGoogleWriteBacks`'s own reads and writes (#216) —
 * `sync/protocol-writes.ts`'s own `enqueueProtocolWrites`/`drainProtocolWrites`
 * split, generalized to a table that (unlike that one) coalesces: at most
 * one still-pending row per Contact per kind, enforced by the table's own
 * unique index rather than a read-check-write race here.
 */

/**
 * Queues a "fields" write-back, or does nothing if one is already pending
 * for this Contact (`onConflictDoNothing`'s own coalescing — see the
 * table's own doc comment). Takes `Db | Tx`: `sync/mutations.ts#applyUserIntent`
 * enqueues this inside the same transaction that applies the optimistic
 * edit, so the two can never disagree about whether an edit that landed
 * also queued its own write-back.
 */
export async function enqueueContactFieldsWriteBack(
  db: Db | Tx,
  args: { contactId: string; connectedAccountId: string },
): Promise<void> {
  await db
    .insert(contactGoogleWriteBacks)
    .values({
      id: generateUlid(),
      contactId: args.contactId,
      connectedAccountId: args.connectedAccountId,
      kind: "fields",
      previousPhoto: null,
    })
    .onConflictDoNothing({
      target: [contactGoogleWriteBacks.contactId, contactGoogleWriteBacks.kind],
    });
}

/**
 * Queues a "photo" write-back with `previousPhoto` as its rollback
 * snapshot — a no-op past the first still-pending edit, same coalescing as
 * `enqueueContactFieldsWriteBack` (the table's own doc comment on why a
 * *second* photo edit must never overwrite the first's snapshot).
 */
export async function enqueueContactPhotoWriteBack(
  db: Db | Tx,
  args: { contactId: string; connectedAccountId: string; previousPhoto: ContactPhoto | null },
): Promise<void> {
  await db
    .insert(contactGoogleWriteBacks)
    .values({
      id: generateUlid(),
      contactId: args.contactId,
      connectedAccountId: args.connectedAccountId,
      kind: "photo",
      previousPhoto: args.previousPhoto,
    })
    .onConflictDoNothing({
      target: [contactGoogleWriteBacks.contactId, contactGoogleWriteBacks.kind],
    });
}

/**
 * Queues a "delete" write-back (#224, `trashContact`) — `googleResourceName`
 * is captured here, at enqueue time, because the Contact row's own copy is
 * cleared in this same transaction (ADR-0029: "removal discards the mirror
 * ... a confirmed act") the same "capture before it's gone" shape
 * `enqueueMicrosoftContactWrite`'s own `kind: "delete"` already takes for
 * `microsoftId`. `onConflictDoNothing` the same coalescing as the two kinds
 * above, though in practice at most one ever queues per Contact: nothing
 * enqueues a second "delete" for an already-trashed Contact.
 */
export async function enqueueContactDeleteWriteBack(
  db: Db | Tx,
  args: { contactId: string; connectedAccountId: string; googleResourceName: string },
): Promise<void> {
  await db
    .insert(contactGoogleWriteBacks)
    .values({
      id: generateUlid(),
      contactId: args.contactId,
      connectedAccountId: args.connectedAccountId,
      kind: "delete",
      previousPhoto: null,
      googleResourceName: args.googleResourceName,
    })
    .onConflictDoNothing({
      target: [contactGoogleWriteBacks.contactId, contactGoogleWriteBacks.kind],
    });
}

/**
 * Queues a "restore" write-back (#224, `restoreContact`) — a fresh upstream
 * `createContact`, never a reactivation: the old `googleResourceName` was
 * already discarded when this Contact was trashed (ADR-0029), so there is
 * nothing left to restore *to*. Carries no captured snapshot of its own —
 * `google/write-back-loop.ts`'s drain re-reads the Contact's current fields
 * fresh, the same "no captured value, just re-read current" shape `"fields"`
 * already takes.
 */
export async function enqueueContactRestoreWriteBack(
  db: Db | Tx,
  args: { contactId: string; connectedAccountId: string },
): Promise<void> {
  await db
    .insert(contactGoogleWriteBacks)
    .values({
      id: generateUlid(),
      contactId: args.contactId,
      connectedAccountId: args.connectedAccountId,
      kind: "restore",
      previousPhoto: null,
      googleResourceName: null,
    })
    .onConflictDoNothing({
      target: [contactGoogleWriteBacks.contactId, contactGoogleWriteBacks.kind],
    });
}

/** One Connected Account's own queue, oldest first — `google/write-back-loop.ts`'s "sequential per Connected Account, never fanned out" read (this ticket's own acceptance line). */
export async function listWriteBacksForConnectedAccount(
  db: Db,
  connectedAccountId: string,
): Promise<ContactGoogleWriteBackRow[]> {
  return db
    .select()
    .from(contactGoogleWriteBacks)
    .where(eq(contactGoogleWriteBacks.connectedAccountId, connectedAccountId))
    .orderBy(asc(contactGoogleWriteBacks.createdAt));
}

/** Drains one row once the write-back loop has resolved it, confirmed or rolled back alike — the same "either outcome dequeues" shape `resolveMutationOutcomes` already gives the Optimistic Action queue. */
export async function deleteWriteBack(db: Db, id: string): Promise<void> {
  await db.delete(contactGoogleWriteBacks).where(eq(contactGoogleWriteBacks.id, id));
}

// --- CardDAV's own outbox (#226) — `contactCarddavWriteBacks`'s own doc
// comment: the Google functions above's exact shape, keyed to
// `addressBookId` rather than `connectedAccountId` since one CardDAV
// Connected Account legitimately mirrors several address books.

export async function enqueueContactCarddavFieldsWriteBack(
  db: Db | Tx,
  args: { contactId: string; addressBookId: string },
): Promise<void> {
  await db
    .insert(contactCarddavWriteBacks)
    .values({
      id: generateUlid(),
      contactId: args.contactId,
      addressBookId: args.addressBookId,
      kind: "fields",
      previousPhoto: null,
    })
    .onConflictDoNothing({
      target: [contactCarddavWriteBacks.contactId, contactCarddavWriteBacks.kind],
    });
}

export async function enqueueContactCarddavPhotoWriteBack(
  db: Db | Tx,
  args: { contactId: string; addressBookId: string; previousPhoto: ContactPhoto | null },
): Promise<void> {
  await db
    .insert(contactCarddavWriteBacks)
    .values({
      id: generateUlid(),
      contactId: args.contactId,
      addressBookId: args.addressBookId,
      kind: "photo",
      previousPhoto: args.previousPhoto,
    })
    .onConflictDoNothing({
      target: [contactCarddavWriteBacks.contactId, contactCarddavWriteBacks.kind],
    });
}

export async function enqueueContactCarddavDeleteWriteBack(
  db: Db | Tx,
  args: { contactId: string; addressBookId: string; carddavHref: string },
): Promise<void> {
  await db
    .insert(contactCarddavWriteBacks)
    .values({
      id: generateUlid(),
      contactId: args.contactId,
      addressBookId: args.addressBookId,
      kind: "delete",
      previousPhoto: null,
      carddavHref: args.carddavHref,
    })
    .onConflictDoNothing({
      target: [contactCarddavWriteBacks.contactId, contactCarddavWriteBacks.kind],
    });
}

export async function enqueueContactCarddavRestoreWriteBack(
  db: Db | Tx,
  args: { contactId: string; addressBookId: string },
): Promise<void> {
  await db
    .insert(contactCarddavWriteBacks)
    .values({
      id: generateUlid(),
      contactId: args.contactId,
      addressBookId: args.addressBookId,
      kind: "restore",
      previousPhoto: null,
      carddavHref: null,
    })
    .onConflictDoNothing({
      target: [contactCarddavWriteBacks.contactId, contactCarddavWriteBacks.kind],
    });
}

/** One Address Book's own queue, oldest first — `write-back-loop.ts`'s "sequential per collection" read, `listWriteBacksForConnectedAccount`'s own shape. */
export async function listCarddavWriteBacksForAddressBook(
  db: Db,
  addressBookId: string,
): Promise<ContactCarddavWriteBackRow[]> {
  return db
    .select()
    .from(contactCarddavWriteBacks)
    .where(eq(contactCarddavWriteBacks.addressBookId, addressBookId))
    .orderBy(asc(contactCarddavWriteBacks.createdAt));
}

export async function deleteCarddavWriteBack(db: Db, id: string): Promise<void> {
  await db.delete(contactCarddavWriteBacks).where(eq(contactCarddavWriteBacks.id, id));
}
