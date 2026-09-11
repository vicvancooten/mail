import type { Contact, ContactLink, LinkedContactGroup } from "@mail/shared";
import {
  contactLinkFor,
  findDuplicateContactIds,
  generateUlid,
  resolveLinkedContactGroup,
} from "@mail/shared";
import { useLiveQuery } from "dexie-react-hooks";
import { localCache } from "./local-cache.js";
import { enqueueUserMutation } from "./user-mutation-queue.js";

/**
 * Linked Contacts' own store slice (#222, ADR-0026) — `store/contacts.ts`'s
 * sibling for the `ContactLink` collection. Every action here is an ordinary
 * User-scoped Optimistic Action with a local write ahead of the round trip,
 * `setDefaultAddressBook`'s own shape, and **none of them touches a Contact
 * row**: linking and unlinking change only which records are one person,
 * never the records themselves, which is what makes an unlink restore two
 * cards with nothing to reconstruct.
 *
 * The local write mirrors the Sync Backend's own union rule
 * (`contacts/link-store.ts#linkContacts`) rather than guessing at something
 * simpler: a Client that optimistically wrote a *second* link for a Contact
 * already in one would render an ambiguity — two cards claiming the same
 * record — for the whole round trip, and then have the server disagree with
 * it. Doing the union here keeps the optimistic state a state the server can
 * actually confirm.
 */

/** A fresh link id, mintable before any link exists — `newContactId`'s own shape, and only ever *used* when neither side is already linked (`@mail/shared#userMutationIntentSchema`'s own doc comment on `linkContacts`). */
export function newContactLinkId(): string {
  return generateUlid();
}

export function useContactLinks(): ContactLink[] | undefined {
  return useLiveQuery(() => readContactLinks(), []);
}

export async function readContactLinks(): Promise<ContactLink[]> {
  return localCache().contactLinks.toArray();
}

/**
 * One person as the Person Page sees them (#222) — the Contact at
 * `contactId` alone when it isn't linked, or every record linked into it,
 * front first. Resolves against the Default Address Book, so which record
 * fronts the card follows the User's own default rather than being pinned at
 * link time (`@mail/shared#resolveLinkedContactFront`).
 *
 * Reads the whole Contact collection rather than only the link's own members
 * — the same small, whole-replicated read `readContacts` already is — so a
 * link naming a Contact this Client happens not to hold resolves the same
 * way the grid's own does, rather than erroring on a missing row.
 */
export function useLinkedContactGroup(contactId: string | null): LinkedContactGroup | null {
  return useLiveQuery(() => readLinkedContactGroup(contactId), [contactId]) ?? null;
}

export async function readLinkedContactGroup(
  contactId: string | null,
): Promise<LinkedContactGroup | null> {
  if (contactId === null) return null;
  const db = localCache();
  const [contacts, links, books] = await Promise.all([
    db.contacts.toArray(),
    db.contactLinks.toArray(),
    db.addressBooks.toArray(),
  ]);
  const defaultBook =
    books.find((book) => book.isDefault) ?? books.find((book) => book.origin.kind === "local");
  return resolveLinkedContactGroup(contactId, contacts, links, {
    defaultAddressBookId: defaultBook?.id ?? null,
  });
}

/**
 * Links two Contacts into one person (#222) — the "Link" action on a
 * possible-duplicate suggestion. `linkId` is minted by the caller
 * (`newContactLinkId`) and only used when neither side already belongs to a
 * link; otherwise both the local write and the Sync Backend union into the
 * existing row (this module's own doc comment).
 *
 * Its real inverse (ADR-0019) is `unlinkContact` on either record, which is
 * a real action on the wire rather than a queue cancellation — see
 * `@mail/shared#userMutationIntentSchema` for why the pair's *shapes* are
 * asymmetric even though their effects invert.
 */
export async function linkContacts(
  linkId: string,
  contactId: string,
  otherContactId: string,
): Promise<void> {
  if (contactId === otherContactId) return;
  await enqueueUserMutation({ type: "linkContacts", linkId, contactId, otherContactId });
  await mergeLinkLocally(linkId, contactId, otherContactId);
}

async function mergeLinkLocally(
  linkId: string,
  contactId: string,
  otherContactId: string,
): Promise<void> {
  const db = localCache();
  await db.transaction("rw", db.contactLinks, async () => {
    const links = await db.contactLinks.toArray();
    const touching = links
      .filter(
        (link) => link.contactIds.includes(contactId) || link.contactIds.includes(otherContactId),
      )
      .sort((left, right) => left.id.localeCompare(right.id));

    const members = new Set<string>([contactId, otherContactId]);
    for (const link of touching) for (const id of link.contactIds) members.add(id);

    const now = new Date().toISOString();
    const survivor = touching[0];
    if (!survivor) {
      await db.contactLinks.put({
        id: linkId,
        contactIds: [...members],
        frontContactId: null,
        createdAt: now,
        updatedAt: now,
      });
      return;
    }

    if (touching.length > 1) {
      await db.contactLinks.bulkDelete(touching.slice(1).map((link) => link.id));
    }
    const front =
      survivor.frontContactId && members.has(survivor.frontContactId)
        ? survivor.frontContactId
        : null;
    await db.contactLinks.put({
      ...survivor,
      contactIds: [...members],
      frontContactId: front,
      updatedAt: now,
    });
  });
}

/**
 * Removes one Contact from the person it was linked into (#222's own
 * acceptance line: "Unlink restores two cards") — the link row goes
 * altogether once fewer than two members remain, since a group of one is not
 * a linked person. A Contact in no link is a harmless no-op, the same
 * tolerance `unlabelContact` already gives.
 */
export async function unlinkContact(contactId: string): Promise<void> {
  await enqueueUserMutation({ type: "unlinkContact", contactId });
  await dropContactLinkMemberLocally(contactId);
}

/**
 * Drops one Contact out of whichever link it belongs to, locally — the
 * `unlinkContact` mirror above, extracted so a caller removing the Contact
 * itself (`store/contacts.ts#mergeContacts`, the loser half of a Merge, #223)
 * can reuse the exact same local mirror `pruneContactLinkMembers`' own
 * server-side rule already has, without also enqueueing a stray
 * `unlinkContact` intent for a record that is about to be deleted anyway.
 */
export async function dropContactLinkMemberLocally(contactId: string): Promise<void> {
  const db = localCache();
  await db.transaction("rw", db.contactLinks, async () => {
    const links = await db.contactLinks.toArray();
    const link = contactLinkFor(links, contactId);
    if (!link) return;
    const remaining = link.contactIds.filter((id) => id !== contactId);
    if (remaining.length < 2) {
      await db.contactLinks.delete(link.id);
      return;
    }
    await db.contactLinks.put({
      ...link,
      contactIds: remaining,
      frontContactId:
        link.frontContactId && remaining.includes(link.frontContactId) ? link.frontContactId : null,
      updatedAt: new Date().toISOString(),
    });
  });
}

/** Picks which record fronts a linked card, or `null` to go back to deriving it (#222's "the User can pick another") — `setContactBanner`'s own latest-pick-wins shape. */
export async function setLinkedContactFront(
  linkId: string,
  contactId: string | null,
): Promise<void> {
  await enqueueUserMutation({ type: "setLinkedContactFront", linkId, contactId });
  const db = localCache();
  await db.transaction("rw", db.contactLinks, async () => {
    const link = await db.contactLinks.get(linkId);
    if (!link) return;
    if (contactId !== null && !link.contactIds.includes(contactId)) return;
    await db.contactLinks.put({
      ...link,
      frontContactId: contactId,
      updatedAt: new Date().toISOString(),
    });
  });
}

/**
 * Which Contacts each Contact is a possible duplicate of, over the Contacts
 * the caller says are in Account Scope (#222) — `findDuplicateContactIds`
 * with the records already **linked** to this one filtered out, since a pair
 * the User has already answered is no longer a suggestion worth a chip.
 *
 * A pure function over rows the caller already holds rather than a hook of
 * its own: the grid and the Person Page each have the in-scope Contact list
 * in hand for their own reasons, and detection is deliberately never a
 * stored join (`@mail/shared#contact-duplicates.ts`'s own doc comment).
 */
export function duplicateCandidatesInScope(
  contacts: readonly Contact[],
  links: readonly ContactLink[],
): Map<string, readonly string[]> {
  const candidates = findDuplicateContactIds(contacts);
  const out = new Map<string, readonly string[]>();
  for (const [contactId, others] of candidates) {
    const linked = new Set(contactLinkFor(links, contactId)?.contactIds ?? []);
    const remaining = others.filter((id) => !linked.has(id));
    if (remaining.length > 0) out.set(contactId, remaining);
  }
  return out;
}
