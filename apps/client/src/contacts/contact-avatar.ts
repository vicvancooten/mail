import type { Contact } from "@mail/shared";
import { normalizeCorrespondentAddress } from "@mail/shared";
import { useMemo } from "react";
import { useContacts } from "../store/contacts.js";
import { buildContactAddressIndex } from "./contact-address-index.js";
import { contactPhotoSrc } from "./contact-photo.js";

/**
 * #221's reverse lookup: a Thread/compose address is never itself a Contact
 * reference (a Thread only ever carries `{name, address}` off the message
 * headers, ADR-0011), so pinning a Contact's photo to it is a local match of
 * the normalized address against the whole replicated Contacts collection —
 * "no round trip", this ticket's own acceptance line.
 *
 * A `Map<normalized address, photo URL>` rather than `Map<address, Contact>`:
 * every caller here only ever wants `Avatar`'s `photoUrl` prop, and building
 * the same-origin URL once (`contactPhotoSrc`) up front means a lookup miss
 * (no Contact, or a Contact with no photo) and a lookup hit are both a single
 * `Map#get`, with no `null` photo ever taking up a slot in the index —
 * `buildContactAddressIndex`'s `valueFor` returning `undefined` for a
 * photo-less Contact is what keeps it out of the index.
 */
export function buildContactPhotoIndex(contacts: readonly Contact[]): Map<string, string> {
  return buildContactAddressIndex(contacts, (contact) => contactPhotoSrc(contact) ?? undefined);
}

/** `null` for an unmatched address, or a matched Contact with no photo — both read as "still initials-only" by every `Avatar` caller. */
export function contactPhotoForAddress(index: Map<string, string>, address: string): string | null {
  return index.get(normalizeCorrespondentAddress(address)) ?? null;
}

/**
 * The live index every mail surface (Thread rows, the Reader) reads off —
 * one `useContacts` subscription per surface rather than per row, so a
 * virtualized list of hundreds of rows still builds this once per render
 * rather than once per row.
 */
export function useContactPhotoIndex(): Map<string, string> {
  const contacts = useContacts();
  return useMemo(() => buildContactPhotoIndex(contacts ?? []), [contacts]);
}
