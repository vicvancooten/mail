import type { Contact } from "@mail/shared";
import { normalizeCorrespondentAddress } from "@mail/shared";
import { useMemo } from "react";
import { useContacts } from "../store/contacts.js";

/**
 * The Contact Card's own reverse lookup (#293) — the same normalized-address
 * match `contact-avatar.ts#buildContactPhotoIndex` already does for a photo
 * URL, just handing back the whole Contact rather than only its photo, since
 * the Card also wants the Contact's name and id (for "Open in Contacts").
 * Deliberately not `resolveLinkedContactGroups`/`unionLinkedContactFields`
 * (`@mail/shared/contact-links.ts`): those are the Contacts App's own "one
 * card per person" concern (ADR-0026), and no other mail surface reaches for
 * them either — `contact-avatar.ts`'s single-record-per-address lookup is
 * this file's precedent, not the Person Page's.
 *
 * `null` for an unmatched address — read the same as `contactPhotoForAddress`'s
 * own `null`, "still a stranger to Contacts" rather than "still loading".
 */
export function findContactByAddress(
  contacts: readonly Contact[],
  address: string,
): Contact | null {
  const normalized = normalizeCorrespondentAddress(address);
  for (const contact of contacts) {
    if (contact.emails.some((email) => normalizeCorrespondentAddress(email.value) === normalized)) {
      return contact;
    }
  }
  return null;
}

/**
 * `undefined` while `useContacts()` itself hasn't resolved yet (the Local
 * Cache's first read), `null` once it has and this address matches no
 * Contact — the same two-states-plus-loading shape the Card's caller
 * (`SenderContactCard.tsx`) needs to tell "still checking" apart from "a
 * stranger".
 */
export function useContactByAddress(address: string | null): Contact | null | undefined {
  const contacts = useContacts();
  return useMemo(() => {
    if (!address || !contacts) return contacts === undefined ? undefined : null;
    return findContactByAddress(contacts, address);
  }, [contacts, address]);
}
