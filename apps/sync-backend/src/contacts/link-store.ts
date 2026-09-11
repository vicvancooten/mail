import type { ContactLink } from "@mail/shared";
import { and, arrayOverlaps, asc, eq, gt, inArray } from "drizzle-orm";
import type { Db, Tx } from "../db/client.js";
import { contactLinks, contacts } from "../db/schema.js";
import { recordTombstones } from "../sync/tombstones.js";

export type ContactLinkRow = typeof contactLinks.$inferSelect;

/**
 * `ContactLink`'s own store (#222, ADR-0026) — the Sync Backend half of
 * Linked Contacts. Every function here writes `contact_links` and nothing
 * else: no path in this file touches a `contacts` row, which is what makes
 * "a User-scoped link, never a change to any record" a property of the code
 * rather than a promise in a doc comment.
 *
 * The one invariant every reader relies on is that **a Contact belongs to at
 * most one link** (`@mail/shared#contactLinkSchema`). `linkContacts` below
 * is where it is maintained, by unioning whatever links the two sides
 * already belong to rather than refusing the link — two separately-linked
 * pairs meeting is a real thing a User does, and one group of four is the
 * only answer to it that a reader can make sense of.
 */

/** `ContactLink`'s registry read (`sync/collection-registry.ts`) — `selectContactsForUser`'s sibling, minus its Local/mirrored split: a link has only ever one scope. */
export function selectContactLinksForUser(db: Db, userId: string, cursorRev: number) {
  return db
    .select()
    .from(contactLinks)
    .where(and(eq(contactLinks.userId, userId), gt(contactLinks.syncRev, cursorRev)))
    .orderBy(asc(contactLinks.syncRev));
}

/** Every link naming any of these Contacts — the overlap query the union and the prune both start from. Ordered by id so a union of several is deterministic about which row survives. */
async function selectLinksTouching(
  db: Db | Tx,
  userId: string,
  contactIds: string[],
): Promise<ContactLinkRow[]> {
  if (contactIds.length === 0) return [];
  return db
    .select()
    .from(contactLinks)
    .where(and(eq(contactLinks.userId, userId), arrayOverlaps(contactLinks.contactIds, contactIds)))
    .orderBy(asc(contactLinks.id));
}

/**
 * Every member of the link `contactId` belongs to, `contactId` itself
 * included — or just `[contactId]` when it isn't linked at all. `trashContact`/
 * `restoreContact` (#224) are this function's own callers: ADR-0026's
 * "Delete on a linked card deletes every linked record, one Undo restores
 * all" reads a link's membership rather than asking the Client to resolve
 * and fan out N intents of its own, so a single Client-issued intent against
 * any one member cascades the same way regardless of which member it named.
 */
export async function contactLinkMembersFor(
  db: Db | Tx,
  userId: string,
  contactId: string,
): Promise<string[]> {
  const links = await selectLinksTouching(db, userId, [contactId]);
  const link = links.find((row) => row.contactIds.includes(contactId));
  return link ? link.contactIds : [contactId];
}

/** Whether both ids name Contacts this User actually owns — `linkContacts`' own ownership check, one query rather than two `contactRowForUser` round trips. */
async function ownsBothContacts(
  db: Db | Tx,
  userId: string,
  contactIds: string[],
): Promise<boolean> {
  const rows = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.userId, userId), inArray(contacts.id, contactIds)));
  return new Set(rows.map((row) => row.id)).size === new Set(contactIds).size;
}

export type LinkContactsResult =
  | { ok: true; linkId: string }
  | { ok: false; reason: "contact_not_found" | "same_contact" | "already_linked" };

/**
 * Links two Contacts into one person (`linkContacts`, ADR-0026) — creating
 * the link under the Client-proposed `linkId` when neither side belongs to
 * one yet, and otherwise **unioning**: every link either side already
 * belongs to is folded into the lowest-id survivor, the rest deleted and
 * tombstoned, so the "at most one link per Contact" invariant holds through
 * every ordering of concurrent links.
 *
 * Idempotent, the same tolerance `insertContact`'s own `onConflictDoNothing`
 * gives a retried id: two Contacts already in the same link answer
 * `already_linked` rather than writing anything, so a replayed intent (a
 * dropped response, an Undo racing a redo) neither errors nor bumps a
 * `syncRev` for a change that didn't happen.
 *
 * `frontContactId` is preserved from the surviving link when it still names
 * a member and dropped otherwise, so a union never leaves a card fronted by
 * a record no longer in it (`@mail/shared#resolveLinkedContactFront` also
 * tolerates that, but there is no reason to write the state it tolerates).
 */
export async function linkContacts(
  db: Db,
  args: { userId: string; linkId: string; contactId: string; otherContactId: string },
): Promise<LinkContactsResult> {
  const { userId, linkId, contactId, otherContactId } = args;
  if (contactId === otherContactId) return { ok: false, reason: "same_contact" };

  return db.transaction(async (tx) => {
    if (!(await ownsBothContacts(tx, userId, [contactId, otherContactId]))) {
      return { ok: false, reason: "contact_not_found" };
    }

    const existing = await selectLinksTouching(tx, userId, [contactId, otherContactId]);
    if (
      existing.some(
        (link) => link.contactIds.includes(contactId) && link.contactIds.includes(otherContactId),
      )
    ) {
      return { ok: false, reason: "already_linked" };
    }

    const members = new Set<string>([contactId, otherContactId]);
    for (const link of existing) for (const id of link.contactIds) members.add(id);

    const survivor = existing[0];
    if (!survivor) {
      await tx
        .insert(contactLinks)
        .values({ id: linkId, userId, contactIds: [...members], frontContactId: null })
        .onConflictDoNothing({ target: contactLinks.id });
      return { ok: true, linkId };
    }

    const superseded = existing.slice(1);
    if (superseded.length > 0) {
      await tx.delete(contactLinks).where(
        inArray(
          contactLinks.id,
          superseded.map((link) => link.id),
        ),
      );
      await recordTombstones(tx, {
        mailAccountId: null,
        collection: "ContactLink",
        entityIds: superseded.map((link) => link.id),
      });
    }

    const front =
      survivor.frontContactId && members.has(survivor.frontContactId)
        ? survivor.frontContactId
        : null;
    await tx
      .update(contactLinks)
      .set({ contactIds: [...members], frontContactId: front, updatedAt: new Date() })
      .where(eq(contactLinks.id, survivor.id));
    return { ok: true, linkId: survivor.id };
  });
}

/**
 * Removes one Contact from whichever link it belongs to (`unlinkContact`,
 * this ticket's own acceptance line: "Unlink restores two cards") — the link
 * row is deleted outright once fewer than two members remain, since a group
 * of one is not a linked person, only a Contact with a stray row attached.
 *
 * A Contact in no link at all is a harmless no-op, the same tolerance
 * `deleteContact`/`unlabelContact` already give a replayed intent.
 */
export async function unlinkContact(
  db: Db,
  userId: string,
  contactId: string,
): Promise<{ ok: true }> {
  await pruneContactLinkMembers(db, userId, [contactId]);
  return { ok: true };
}

/** `setLinkedContactFront`'s own write (#222): an absolute set on one link, `contacts/store.ts#updateContactBanner`'s own shape. `null` returns the card to deriving its front. Answers `false` when this User has no such link, which the intent handler reports rather than silently succeeding. */
export async function setContactLinkFront(
  db: Db,
  userId: string,
  linkId: string,
  contactId: string | null,
): Promise<boolean> {
  const [row] = await db
    .select({ contactIds: contactLinks.contactIds })
    .from(contactLinks)
    .where(and(eq(contactLinks.id, linkId), eq(contactLinks.userId, userId)))
    .limit(1);
  if (!row) return false;
  if (contactId !== null && !row.contactIds.includes(contactId)) return false;

  await db
    .update(contactLinks)
    .set({ frontContactId: contactId, updatedAt: new Date() })
    .where(eq(contactLinks.id, linkId));
  return true;
}

/**
 * Drops these Contacts out of every link they belong to, deleting (and
 * tombstoning) any link left with fewer than two members. `unlinkContact`
 * above is this called for one id on the User's own behalf; every other
 * caller is a path that *removes* a Contact and would otherwise leave a link
 * naming a row that no longer exists — the `deleteContact` intent
 * (`sync/mutations.ts`), an unmirrored book's discard
 * (`address-books/mirror-discard.ts`), an upstream tombstone
 * (`contacts/store.ts#deleteGoogleContactsByResourceName`) and a Contacts
 * Facet's removal (`connected-accounts/removal.ts`). None of those can
 * cascade into `contact_links`, whose members are a `text[]` with no foreign
 * key of its own (`db/schema.ts`'s own doc comment).
 *
 * `userId` is optional precisely because two of those callers are working
 * from a set of Contact ids inside a scope they've already established and
 * don't hold the User in hand; the ids are ULIDs, so the overlap query is
 * exact either way, and the tombstone's own scope is a User-scoped one
 * regardless (both scope columns null).
 */
export async function pruneContactLinkMembers(
  db: Db | Tx,
  userId: string | null,
  contactIds: string[],
): Promise<void> {
  if (contactIds.length === 0) return;
  const removed = new Set(contactIds);

  const rows = await db
    .select()
    .from(contactLinks)
    .where(
      userId === null
        ? arrayOverlaps(contactLinks.contactIds, contactIds)
        : and(eq(contactLinks.userId, userId), arrayOverlaps(contactLinks.contactIds, contactIds)),
    );
  if (rows.length === 0) return;

  const dissolved: string[] = [];
  for (const row of rows) {
    const remaining = row.contactIds.filter((id) => !removed.has(id));
    if (remaining.length < 2) {
      dissolved.push(row.id);
      continue;
    }
    const front =
      row.frontContactId && remaining.includes(row.frontContactId) ? row.frontContactId : null;
    await db
      .update(contactLinks)
      .set({ contactIds: remaining, frontContactId: front, updatedAt: new Date() })
      .where(eq(contactLinks.id, row.id));
  }

  if (dissolved.length > 0) {
    await db.delete(contactLinks).where(inArray(contactLinks.id, dissolved));
    await recordTombstones(db, {
      mailAccountId: null,
      collection: "ContactLink",
      entityIds: dissolved,
    });
  }
}

export function toWireContactLink(row: ContactLinkRow): ContactLink {
  return {
    id: row.id,
    contactIds: row.contactIds,
    frontContactId: row.frontContactId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
