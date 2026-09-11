import { count, eq } from "drizzle-orm";
import { pruneContactLinkMembers } from "../contacts/link-store.js";
import type { Db, Tx } from "../db/client.js";
import { contacts } from "../db/schema.js";
import { recordTombstones } from "../sync/tombstones.js";

/**
 * What unmirroring an Address Book actually throws away (#215's own
 * acceptance line: "Unmirroring discards that book's Contacts at once").
 * Additive: a future field family living on its own table (rather than
 * `contacts.googlePayload`, #210) adds a field here, not a reshape — the
 * same posture the sibling Calendar epic's `DiscardedMirrorCounts` already
 * took for its own Occurrences.
 */
export interface DiscardedMirrorCounts {
  contacts: number;
}

/**
 * Deletes every Contact one Address Book's mirror holds and tombstones them
 * (ADR-0011's `destroyed` list) so an open Client's next delta actually
 * drops them, rather than relying only on `contacts.addressBookId`'s FK
 * cascade — that cascade fires if the Address Book row itself is later
 * deleted, but unmirroring keeps the row (#215's own acceptance line: "the
 * row stays so it can be re-mirrored"), so nothing else would ever tell the
 * Client these rows are gone.
 *
 * Called from within the same transaction that flips `mirrored` to `false`
 * (`address-books/store.ts#unmirrorAddressBook`) — an unmirror is immediate
 * and un-undoable, never a partial discard left for a retry.
 */
export async function discardMirroredContacts(
  db: Db | Tx,
  addressBookId: string,
): Promise<DiscardedMirrorCounts> {
  const rows = await db
    .select({ id: contacts.id, connectedAccountId: contacts.connectedAccountId })
    .from(contacts)
    .where(eq(contacts.addressBookId, addressBookId));
  if (rows.length === 0) return { contacts: 0 };

  // A `ContactLink` naming a discarded Contact can't cascade (#222,
  // `db/schema.ts#contactLinks`) — pruned before the rows go, while their
  // ids are still what the link and this list agree on.
  await pruneContactLinkMembers(
    db,
    null,
    rows.map((row) => row.id),
  );
  await db.delete(contacts).where(eq(contacts.addressBookId, addressBookId));
  await recordTombstones(db, {
    mailAccountId: null,
    connectedAccountId: rows[0]?.connectedAccountId ?? null,
    collection: "Contact",
    entityIds: rows.map((row) => row.id),
  });
  return { contacts: rows.length };
}

/**
 * A read-only preview of `discardMirroredContacts`' own counts — what the
 * checklist's confirm dialog shows before the User commits to unmirroring
 * (#215's own acceptance line: "confirmed with counts"). Never mutates
 * anything, so it can be called freely while the dialog is open without
 * racing the actual discard.
 */
export async function countMirroredContacts(
  db: Db,
  addressBookId: string,
): Promise<DiscardedMirrorCounts> {
  const [row] = await db
    .select({ total: count() })
    .from(contacts)
    .where(eq(contacts.addressBookId, addressBookId));
  return { contacts: row?.total ?? 0 };
}
