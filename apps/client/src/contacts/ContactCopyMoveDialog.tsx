import type { AddressBook, Contact } from "@mail/shared";
import {
  contactDisplayName,
  getContactCapabilityTable,
  mapContactFieldsToCapabilityTable,
} from "@mail/shared";
import { useMemo, useState } from "react";
import { Button } from "../components/ui/button.js";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "../components/ui/dialog.js";
import { addressBookOriginLabel } from "./address-book-origin.js";

/**
 * Copy to…/Move to… (#225, ADR-0026): a target Address Book picker plus the
 * fields it will drop, named before the User can confirm (this ticket's own
 * acceptance line) — `ContactDialog.tsx`'s own Merge-confirm `Dialog` shape,
 * a second nested `Dialog` rather than a route, since this is a short,
 * single-decision step over a Contact already open in one.
 */
export function ContactCopyMoveDialog({
  mode,
  contact,
  addressBooks,
  onConfirm,
  onClose,
}: {
  mode: "copy" | "move";
  contact: Contact;
  /** Every Address Book the User owns, this Contact's own excluded — copying/moving into the same book it already lives in is never offered. */
  addressBooks: readonly AddressBook[];
  onConfirm: (target: AddressBook) => void;
  onClose: () => void;
}) {
  const options = useMemo(
    () => addressBooks.filter((book) => book.id !== contact.addressBookId),
    [addressBooks, contact.addressBookId],
  );
  const [targetId, setTargetId] = useState(options[0]?.id ?? "");
  const target = options.find((book) => book.id === targetId) ?? null;

  const dropped = useMemo(() => {
    if (!target) return [];
    const table = getContactCapabilityTable(target.capabilityTableId);
    return mapContactFieldsToCapabilityTable(contact, table).dropped;
  }, [target, contact]);

  const name = contactDisplayName(contact);
  const verb = mode === "copy" ? "Copy" : "Move";

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="contact-copy-move-dialog">
        <DialogTitle>
          {verb} {name}
        </DialogTitle>
        {options.length === 0 ? (
          <p>There's no other Address Book to {mode === "copy" ? "copy" : "move"} this into.</p>
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
            {dropped.length > 0 ? (
              <div className="contact-copy-move-drops">
                <span className="contact-dialog-legend">Won&rsquo;t carry over</span>
                <ul>
                  {dropped.map((drop) => (
                    <li key={`${drop.family}`}>{drop.label}</li>
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
              {verb}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
