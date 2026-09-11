import type { AddressBook, Contact } from "@mail/shared";
import { getContactCapabilityTable, mapContactFieldsToCapabilityTable } from "@mail/shared";
import { useMemo, useState } from "react";
import { Button } from "../components/ui/button.js";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "../components/ui/dialog.js";
import { addressBookOriginLabel } from "./address-book-origin.js";

/**
 * "Copy all to…" per Address Book (#225, ADR-0026) — `ContactCopyMoveDialog.tsx`'s
 * own shape, one level up: instead of one Contact's own drops, this
 * aggregates across every Contact `sourceContacts` holds, since a whole book
 * can be dozens of records each dropping a different family. "N of M
 * Contacts lose …" is the sheet's own honest middle ground between naming
 * every record's own drops (too much to read before confirming a bulk
 * action) and naming nothing at all (this ticket's own acceptance line: the
 * fields it will drop, named before the User confirms).
 */
export function ContactBookCopyDialog({
  sourceBook,
  sourceContacts,
  addressBooks,
  onConfirm,
  onClose,
}: {
  sourceBook: AddressBook;
  sourceContacts: readonly Contact[];
  addressBooks: readonly AddressBook[];
  onConfirm: (target: AddressBook) => void;
  onClose: () => void;
}) {
  const options = useMemo(
    () => addressBooks.filter((book) => book.id !== sourceBook.id),
    [addressBooks, sourceBook.id],
  );
  const [targetId, setTargetId] = useState(options[0]?.id ?? "");
  const target = options.find((book) => book.id === targetId) ?? null;

  const dropSummary = useMemo(() => {
    if (!target) return [];
    const table = getContactCapabilityTable(target.capabilityTableId);
    const counts = new Map<string, { label: string; count: number }>();
    for (const contact of sourceContacts) {
      const { dropped } = mapContactFieldsToCapabilityTable(contact, table);
      const seen = new Set<string>();
      for (const drop of dropped) {
        if (seen.has(drop.family)) continue;
        seen.add(drop.family);
        const entry = counts.get(drop.family);
        counts.set(drop.family, { label: drop.label, count: (entry?.count ?? 0) + 1 });
      }
    }
    return [...counts.values()];
  }, [target, sourceContacts]);

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="contact-copy-move-dialog">
        <DialogTitle>Copy {sourceBook.name} to…</DialogTitle>
        {options.length === 0 ? (
          <p>There's no other Address Book to copy this into.</p>
        ) : (
          <>
            <label className="contact-copy-move-target">
              To
              <select
                aria-label="Target Address Book"
                value={targetId}
                onChange={(event) => setTargetId(event.target.value)}
              >
                {options.map((book) => (
                  <option key={book.id} value={book.id}>
                    {book.name} ({addressBookOriginLabel(book.capabilityTableId)})
                  </option>
                ))}
              </select>
            </label>
            {dropSummary.length > 0 ? (
              <div className="contact-copy-move-drops">
                <span className="contact-dialog-legend">
                  Won&rsquo;t carry over for every Contact
                </span>
                <ul>
                  {dropSummary.map((entry) => (
                    <li key={entry.label}>
                      {entry.count} of {sourceContacts.length} Contacts lose {entry.label}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          {target ? (
            <Button type="button" onClick={() => onConfirm(target)}>
              Copy {sourceContacts.length} Contacts
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
