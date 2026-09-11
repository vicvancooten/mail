import type { AddressBook } from "@mail/shared";
import { useRef, useState } from "react";
import { Button } from "../components/ui/button.js";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "../components/ui/dialog.js";
import { addressBookOriginLabel } from "./address-book-origin.js";
import { importVCardFile } from "./vcard-import.js";

/** `.vcf` only (this ticket's own acceptance line: "CSV import is not offered") — a hint for the OS picker, `contact-photo.ts#CONTACT_PHOTO_ACCEPT`'s own shape, not a security boundary. */
const VCARD_ACCEPT = ".vcf,text/vcard";

/**
 * Import (#225, `docs/contacts-spec.md` §Import): pick a `.vcf` file and the
 * Address Book it lands in, Default preselected. Duplicate detection is
 * deliberately absent from this dialog (`vcard-import.ts`'s own doc comment
 * — it runs afterwards, as a derived read the grid and every Person Page
 * already show, not a step here); this sheet's only jobs are the file, the
 * target, and the one toast the import raises once it's done.
 */
export function ContactImportDialog({
  addressBooks,
  defaultAddressBookId,
  onClose,
}: {
  addressBooks: readonly AddressBook[];
  defaultAddressBookId: string | null;
  onClose: () => void;
}) {
  const [targetId, setTargetId] = useState(defaultAddressBookId ?? addressBooks[0]?.id ?? "");
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleImport = async () => {
    const file = fileInputRef.current?.files?.[0];
    const target = addressBooks.find((book) => book.id === targetId);
    if (!file || !target) return;
    setImporting(true);
    setError(null);
    try {
      const result = await importVCardFile(file, target);
      if (result.count === 0) setError("No cards found in that file.");
      else onClose();
    } catch {
      setError("Import failed — check the file and try again.");
    } finally {
      setImporting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="contact-import-dialog">
        <DialogTitle>Import Contacts</DialogTitle>
        <label className="contact-import-file">
          vCard file (.vcf)
          <input ref={fileInputRef} type="file" accept={VCARD_ACCEPT} aria-label="vCard file" />
        </label>
        <label className="contact-import-target">
          Into
          <select
            aria-label="Address Book"
            value={targetId}
            onChange={(event) => setTargetId(event.target.value)}
          >
            {addressBooks.map((book) => (
              <option key={book.id} value={book.id}>
                {book.name} ({addressBookOriginLabel(book.capabilityTableId)})
              </option>
            ))}
          </select>
        </label>
        {error ? <p className="contact-import-error">{error}</p> : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" disabled={importing} onClick={() => void handleImport()}>
            {importing ? "Importing…" : "Import"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
