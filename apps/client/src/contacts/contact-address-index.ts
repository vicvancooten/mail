import type { Contact } from "@mail/shared";
import { normalizeCorrespondentAddress } from "@mail/shared";

/**
 * The one "normalized address → some per-Contact value" indexing strategy
 * both `contact-avatar.ts#buildContactPhotoIndex` (address → photo URL) and
 * `contact-by-address.ts#findContactByAddress` (address → Contact) build off
 * of, so a shared address never gets resolved two different ways depending
 * on which of those two call sites asked.
 *
 * `valueFor` lets a Contact opt out of the index entirely (`undefined`) —
 * the photo index's "no photo, no entry" — while still keeping the "first
 * Contact to claim an address wins" iteration order for everyone else.
 */
export function buildContactAddressIndex<T>(
  contacts: readonly Contact[],
  valueFor: (contact: Contact) => T | undefined,
): Map<string, T> {
  const index = new Map<string, T>();
  for (const contact of contacts) {
    const value = valueFor(contact);
    if (value === undefined) continue;
    for (const email of contact.emails) {
      const normalized = normalizeCorrespondentAddress(email.value);
      // First Contact declaring an address wins a rare duplicate — same
      // "no signal for which is right, just be deterministic" posture as
      // `recipients.ts#mergeContactsIntoCorrespondents`.
      if (!index.has(normalized)) index.set(normalized, value);
    }
  }
  return index;
}
