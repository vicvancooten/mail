import type { AddressBook } from "@mail/shared";
import { useLiveQuery } from "dexie-react-hooks";
import { localCache } from "./local-cache.js";
import { enqueueUserMutation } from "./user-mutation-queue.js";

/**
 * The Local Address Book (#210) — `db.addressBooks` is one flat table across
 * every Origin (`db.ts`'s own doc comment), so this reads it with a plain
 * filter rather than an index, the same "small collection" posture
 * `server-writes.ts#addressBookIdsWhere` already takes. There is exactly one
 * per User (ADR-0026: "created on first use, never deletable"), minted
 * server-side the first time anything asks for the `AddressBook` collection
 * (`address-books/store.ts#ensureLocalAddressBook`) — `undefined` here means
 * that sync round hasn't landed yet, not that the User has none.
 */
export function useLocalAddressBook(): AddressBook | undefined {
  return useLiveQuery(() => readLocalAddressBook(), []);
}

export async function readLocalAddressBook(): Promise<AddressBook | undefined> {
  const books = await localCache().addressBooks.toArray();
  return books.find((book) => book.origin.kind === "local");
}

/**
 * Every Address Book this User has, across every Origin — the card
 * directory's own filter row (#211), name-ordered the same way `readLabels`
 * orders its own whole-replicated collection. Narrowing to Account Scope
 * (which mirrored books are actually shown) is the grid's own job
 * (`useAccountScope.ts#deriveAddressBookScope`), not this read's: the Local
 * Address Book is always in the answer, in or out of any particular Scope.
 */
export function useAddressBooks(): AddressBook[] | undefined {
  return useLiveQuery(() => readAddressBooks(), []);
}

export async function readAddressBooks(): Promise<AddressBook[]> {
  const books = await localCache().addressBooks.toArray();
  return books.sort((left, right) => left.name.localeCompare(right.name));
}

/** One Address Book by id — `ContactDialogRoute.tsx`'s own lookup, resolving the capability table a Contact's edit form draws its fields from. */
export function useAddressBook(id: string | null): AddressBook | undefined {
  return useLiveQuery(() => readAddressBook(id), [id]);
}

export async function readAddressBook(id: string | null): Promise<AddressBook | undefined> {
  if (id === null) return undefined;
  return localCache().addressBooks.get(id);
}

/** The Default Address Book (#211) — whichever row currently carries `isDefault`, falling back to the Local one while that hasn't synced (there is always exactly one Local Address Book, `readLocalAddressBook`'s own doc comment, and it starts out the default). `NewContactRoute.tsx`'s own "which book does a fresh Contact land in" answer. */
export function useDefaultAddressBook(): AddressBook | undefined {
  return useLiveQuery(() => readDefaultAddressBook(), []);
}

export async function readDefaultAddressBook(): Promise<AddressBook | undefined> {
  const books = await localCache().addressBooks.toArray();
  return books.find((book) => book.isDefault) ?? books.find((book) => book.origin.kind === "local");
}

/**
 * The Default Address Book (#211): an Optimistic Action on the User-scoped
 * queue (`setDefaultAddressBook` intent) with a direct local merge, the same
 * "component wires the toast (if any), the store stays store" split
 * `updateContact`'s own `mergeContactFieldsLocally` already draws — every
 * row in the local table gets `isDefault` recomputed against `addressBookId`
 * in one pass, since flipping the flag on one row and off every other is
 * one edit, not two independent ones a partial failure could split apart.
 */
export async function setDefaultAddressBook(addressBookId: string): Promise<void> {
  await enqueueUserMutation({ type: "setDefaultAddressBook", addressBookId });
  await markDefaultAddressBookLocally(addressBookId);
}

async function markDefaultAddressBookLocally(addressBookId: string): Promise<void> {
  const db = localCache();
  await db.transaction("rw", db.addressBooks, async () => {
    const books = await db.addressBooks.toArray();
    await db.addressBooks.bulkPut(
      books.map((book) => ({ ...book, isDefault: book.id === addressBookId })),
    );
  });
}

/**
 * Every Address Book a Connected Account's Contacts Facet has ever
 * discovered — mirrored and unmirrored alike (#215's own acceptance line:
 * "Every discovered book gets a row whether or not it is mirrored"), read
 * straight off the ordinary `AddressBook` collection the Local Cache
 * already syncs whole (`store/calendars.ts`'s own sibling doc comment).
 * This is the checklist's read side; `api/address-books.ts` is its write
 * side, a plain request/response pair rather than an Optimistic Action
 * (this ticket's own acceptance line).
 */
export function useAddressBooksForConnectedAccount(
  connectedAccountId: string,
): AddressBook[] | undefined {
  return useLiveQuery(
    () => readAddressBooksForConnectedAccount(connectedAccountId),
    [connectedAccountId],
  );
}

export async function readAddressBooksForConnectedAccount(
  connectedAccountId: string,
): Promise<AddressBook[]> {
  const rows = await localCache().addressBooks.toArray();
  return rows
    .filter(
      (row) =>
        row.origin.kind === "connectedAccount" &&
        row.origin.connectedAccountId === connectedAccountId,
    )
    .sort((left, right) => left.name.localeCompare(right.name));
}
