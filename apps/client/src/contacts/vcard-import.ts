import type { AddressBook } from "@mail/shared";
import {
  getContactCapabilityTable,
  mapContactFieldsToCapabilityTable,
  parseVCards,
} from "@mail/shared";
import { uploadContactPhoto } from "../api/contact-photos.js";
import { announceUndoableAction } from "../mail/undo-toast.js";
import {
  createContact,
  deleteContact,
  newContactId,
  recordContactPhoto,
} from "../store/contacts.js";

/**
 * vCard import (#225, `docs/contacts-spec.md` §Import): `.vcf` 3.0/4.0,
 * multi-card, into one chosen Address Book — "each imported card is an
 * ordinary create" (this ticket's own acceptance line) means every card
 * goes through the exact same `createContact` a User's own New Contact
 * Save does, fields trimmed to the target's own capability table first
 * (`mapContactFieldsToCapabilityTable`) exactly as Copy/Move already are.
 *
 * Duplicate detection runs **afterwards**, never during (this ticket's own
 * acceptance line: "an import that silently dropped cards would be worse
 * than one that flags them") — nothing here calls it at all, since
 * `duplicateCandidatesInScope` (`store/contact-links.ts`) is already a pure,
 * derived read of whatever Contacts the Client currently holds
 * (`ContactDialog.tsx`'s own doc comment on that function): the grid's chip
 * and every Person Page's own suggestions section reflect a freshly
 * imported batch the moment it lands, with nothing new to wire here.
 */

export interface ImportVCardResult {
  /** How many cards actually created a Contact — the toast's own count. */
  count: number;
}

/** A base64-encoded photo (`ParsedVCardPhoto`) as a `File` the existing upload route already accepts — `contact-photo.ts#fetchContactPhotoAsFile`'s own inverse: bytes in hand already, nothing to fetch first. */
function base64ToFile(photo: { mimeType: string; base64: string }, filename: string): File {
  const binary = atob(photo.base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], filename, { type: photo.mimeType });
}

/**
 * Imports every card in `text` into `targetAddressBook`, one `createContact`
 * per card — each call is announced through the same `contactImport` undo
 * bucket (`mail/undo-toast.ts`), which is what turns a tight loop of many
 * cards into "one toast with the count; Undo deletes the whole batch" (this
 * ticket's own acceptance line) with no batching logic of its own here.
 */
export async function importVCardFile(
  file: File,
  targetAddressBook: AddressBook,
): Promise<ImportVCardResult> {
  const text = await file.text();
  const cards = parseVCards(text);
  const table = getContactCapabilityTable(targetAddressBook.capabilityTableId);

  let count = 0;
  for (const card of cards) {
    const { fields } = mapContactFieldsToCapabilityTable(card.fields, table);
    const id = newContactId();
    await createContact(id, targetAddressBook.id, fields);
    if (card.photo) {
      try {
        const photoFile = base64ToFile(card.photo, id);
        const photo = await uploadContactPhoto(id, photoFile);
        await recordContactPhoto(id, photo);
      } catch {
        // A bad or oversized photo shouldn't fail the whole card — the rest
        // of it already landed.
      }
    }
    announceUndoableAction("contactImport", () => deleteContact(id));
    count += 1;
  }
  return { count };
}
