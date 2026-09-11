import {
  LOCAL_CONTACT_CAPABILITY_TABLE,
  MICROSOFT_CONTACT_CAPABILITY_TABLE,
  mergeContactFields,
  pickContactMergeSurvivor,
  validateContactFields,
} from "@mail/shared";
import { addressBookCapabilityTableId } from "../address-books/store.js";
import type { Db } from "../db/client.js";
import { recordTombstones } from "../sync/tombstones.js";
import { pruneContactLinkMembers } from "./link-store.js";
import {
  type ContactRow,
  contactRowForUser,
  deleteContactRow,
  enqueueMicrosoftContactWrite,
  toWireContact,
  updateContactFields,
} from "./store.js";

/**
 * Merge within one Address Book (#223, ADR-0026) — the Sync Backend half of
 * a real, destructive Merge: the survivor's fields are whole-replaced
 * exactly `updateContactFields` already does for `updateContact`, the loser
 * is permanently deleted exactly `deleteContactRow` already does for
 * `deleteContact` — both intents' own write paths, called here in one
 * transaction rather than routed around, which is what makes this "reach
 * upstream through the ordinary write path" (this ticket's own acceptance
 * line) true of the code: a Graph-mirrored survivor's edit still enqueues
 * Graph's own write-through outbox (`enqueueMicrosoftContactWrite`), and a
 * Graph-mirrored loser's delete still does too, the same two branches
 * `sync/mutations.ts`'s own `updateContact`/`deleteContact` cases already
 * take.
 */
export type MergeContactsResult =
  | { ok: true; survivorId: string }
  | {
      ok: false;
      reason: "contact_not_found" | "same_contact" | "different_address_book" | string;
    };

export async function mergeContacts(
  db: Db,
  args: { userId: string; contactId: string; otherContactId: string },
): Promise<MergeContactsResult> {
  const { userId, contactId, otherContactId } = args;
  if (contactId === otherContactId) return { ok: false, reason: "same_contact" };

  return db.transaction(async (tx) => {
    const [a, b] = await Promise.all([
      contactRowForUser(tx, userId, contactId),
      contactRowForUser(tx, userId, otherContactId),
    ]);
    if (!a || !b) return { ok: false, reason: "contact_not_found" };
    if (a.addressBookId !== b.addressBookId) {
      return { ok: false, reason: "different_address_book" };
    }

    const { survivor, loser } = pickContactMergeSurvivor(toWireContact(a), toWireContact(b));
    const survivorRow: ContactRow = survivor.id === a.id ? a : b;
    const loserRow: ContactRow = survivor.id === a.id ? b : a;

    // The same table selection `sync/mutations.ts`'s own `updateContact` case
    // makes: a `microsoft` Address Book validates against Graph's own thin
    // table, every other Origin (Google included) against Local's — Google's
    // own write-back is #216's, not this ticket's, so this stays unchanged
    // rather than guessing at a Google capability table `updateContact`
    // itself doesn't enforce yet.
    const capabilityTableId = await addressBookCapabilityTableId(tx, survivorRow.addressBookId);
    const table =
      capabilityTableId === "microsoft"
        ? MICROSOFT_CONTACT_CAPABILITY_TABLE
        : LOCAL_CONTACT_CAPABILITY_TABLE;

    const mergedFields = mergeContactFields(survivor, loser, table);
    const validation = validateContactFields(mergedFields, table);
    if (!validation.ok) return { ok: false, reason: validation.reason };

    await updateContactFields(tx, survivorRow.id, mergedFields);
    if (capabilityTableId === "microsoft") {
      await enqueueMicrosoftContactWrite(tx, {
        addressBookId: survivorRow.addressBookId,
        contactId: survivorRow.id,
        kind: "upsert",
      });
    }

    const deleted = await deleteContactRow(tx, userId, loserRow.id);
    if (deleted) {
      // `ContactLink`'s own `text[]` members carry no foreign key
      // (`link-store.ts`'s own doc comment) — the loser leaving is exactly
      // the shape `deleteContact` already prunes for.
      await pruneContactLinkMembers(tx, userId, [loserRow.id]);
      await recordTombstones(tx, {
        mailAccountId: null,
        collection: "Contact",
        entityIds: [loserRow.id],
      });
      if (loserRow.microsoftId) {
        await enqueueMicrosoftContactWrite(tx, {
          addressBookId: loserRow.addressBookId,
          microsoftId: loserRow.microsoftId,
          kind: "delete",
        });
      }
    }

    return { ok: true, survivorId: survivorRow.id };
  });
}
