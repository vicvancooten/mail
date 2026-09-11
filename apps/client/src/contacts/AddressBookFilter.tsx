import type { AddressBook } from "@mail/shared";
import { addressBookOriginLabel } from "./address-book-origin.js";

/**
 * The grid's own Address Book chip row (#211's own acceptance line: "Address
 * Book is a filter chip", never a separate screen) — `NotesLabelFilter.tsx`'s
 * own shape, OR semantics: no chip selected shows every Address Book in
 * Account Scope, and multiple selected shows a Contact from *any* of them.
 * The Origin label (`addressBookOriginLabel`) rides alongside a mirrored
 * book's own name so two Google-mirrored books (once #226/#227 allow more
 * than one Origin) still read apart.
 */
export function AddressBookFilter({
  addressBooks,
  selectedAddressBookIds,
  onToggle,
}: {
  addressBooks: readonly AddressBook[];
  selectedAddressBookIds: ReadonlySet<string>;
  onToggle: (addressBookId: string) => void;
}) {
  if (addressBooks.length === 0) return null;

  const sorted = [...addressBooks].sort((left, right) => left.name.localeCompare(right.name));

  return (
    <fieldset className="address-book-filter" aria-label="Filter Contacts by Address Book">
      {sorted.map((book) => {
        const selected = selectedAddressBookIds.has(book.id);
        return (
          <button
            key={book.id}
            type="button"
            className={`address-book-chip${selected ? " selected" : ""}`}
            aria-pressed={selected}
            onClick={() => onToggle(book.id)}
          >
            {book.name}
            {book.origin.kind === "connectedAccount" ? (
              <span className="address-book-chip-origin">
                {addressBookOriginLabel(book.capabilityTableId)}
              </span>
            ) : null}
          </button>
        );
      })}
    </fieldset>
  );
}
