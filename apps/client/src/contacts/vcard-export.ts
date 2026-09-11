import {
  type Contact,
  contactDisplayName,
  contactWritableFieldsToVCard,
  type ParsedVCardPhoto,
} from "@mail/shared";
import { contactPhotoUrl } from "../api/contact-photos.js";

/**
 * vCard export (#225, `docs/contacts-spec.md` §Export): one vCard 4.0 file
 * with photos inlined, for a single Contact or a whole Address Book — the
 * first client-generated download this app makes (no `createObjectURL`
 * anywhere else, `AttachmentList.tsx`'s own downloads are all same-origin
 * server URLs instead), since there is no server route that already holds
 * "every Contact of this book, as one vCard file" the way an attachment's
 * bytes already sit behind one.
 */

async function fetchPhotoForExport(
  contact: Pick<Contact, "id" | "photo">,
): Promise<ParsedVCardPhoto | null> {
  if (!contact.photo) return null;
  const response = await fetch(contactPhotoUrl(contact.id), { credentials: "include" });
  if (!response.ok) return null;
  const buffer = await response.arrayBuffer();
  return { mimeType: contact.photo.mimeType, base64: arrayBufferToBase64(buffer) };
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** One vCard 4.0 file's worth of text for `contacts`, in the order given — a single-Contact export is just this called with one entry. */
export async function contactsToVCardFile(contacts: readonly Contact[]): Promise<string> {
  const cards = await Promise.all(
    contacts.map(async (contact) => {
      const photo = await fetchPhotoForExport(contact);
      return contactWritableFieldsToVCard(contact, photo);
    }),
  );
  return cards.join("\r\n");
}

/** A filesystem-safe stand-in for a Contact/Address Book's own display name — never empty, since an all-punctuation name would otherwise produce an unusable filename. */
export function vCardFileName(name: string): string {
  const slug = name
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug.length > 0 ? slug : "contacts"}.vcf`;
}

export function contactVCardFileName(contact: Contact): string {
  return vCardFileName(contactDisplayName(contact));
}

/**
 * Hands the browser `vcard` as a file download — the sandboxed artifact
 * preview this app itself never runs in, so a plain `<a download>` off a
 * `Blob` URL is the ordinary, safe way to do this in a real browser tab
 * (unlike an Artifact's own viewer, nothing here disables it).
 */
export function downloadVCardFile(filename: string, vcard: string): void {
  const blob = new Blob([vcard], { type: "text/vcard" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoked on a delay, not immediately — some browsers haven't finished
  // starting the download yet by the time `click()` returns.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
