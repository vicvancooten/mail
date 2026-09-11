import {
  CONTACT_PHOTO_MAX_BYTES,
  CONTACT_PHOTO_MIME_TYPES,
  type Contact,
  isContactPhotoMimeType,
} from "@mail/shared";
import { contactPhotoUrl } from "../api/contact-photos.js";

/**
 * The Person Page's own photo picker (#213) — `contact-banner.ts`'s sibling:
 * this Contact's real uploaded photo once one exists, and the client-side
 * mirror of the upload route's own bounds, checked before ever calling
 * `uploadContactPhoto` (`api/contact-photos.ts`) the same "refused at
 * selection time" way compose-spec's attachment budget already is.
 */

/** This Contact's photo URL, or `null` for "still initials-only" — `ContactCard.tsx`/`ContactDialog.tsx`'s own avatar rendering both read this rather than reaching into `contact.photo` directly. */
export function contactPhotoSrc(contact: Pick<Contact, "id" | "photo">): string | null {
  return contact.photo ? contactPhotoUrl(contact.id) : null;
}

export type ContactPhotoRejection =
  | { kind: "unsupported_type" }
  | { kind: "too_large"; maxBytes: number };

/** `null` means the file is fine to upload. */
export function checkContactPhotoFile(file: File): ContactPhotoRejection | null {
  if (!isContactPhotoMimeType(file.type)) return { kind: "unsupported_type" };
  if (file.size > CONTACT_PHOTO_MAX_BYTES) {
    return { kind: "too_large", maxBytes: CONTACT_PHOTO_MAX_BYTES };
  }
  return null;
}

export function contactPhotoRejectionMessage(rejection: ContactPhotoRejection): string {
  if (rejection.kind === "unsupported_type") {
    return `Use one of: ${CONTACT_PHOTO_MIME_TYPES.join(", ")}`;
  }
  return `Over the ${Math.round(rejection.maxBytes / (1024 * 1024))}MB photo limit`;
}

/**
 * Re-downloads a Contact's own photo bytes as a fresh `File` (#225,
 * Copy/Move's own reuse of the existing upload round trip rather than a new
 * "attach an existing blobId to a different Contact" endpoint): the Blob
 * Store is content-addressed (`contacts.ts#contactPhotoSchema`'s own doc
 * comment), so re-uploading the identical bytes for the copy simply finds
 * the same blob row rather than duplicating it. `null` for anything that
 * keeps this from happening — no photo to begin with, or the fetch itself
 * failing — since every caller (`store/contacts.ts#copyContact`) already
 * treats a photo as best-effort.
 */
export async function fetchContactPhotoAsFile(
  contact: Pick<Contact, "id" | "photo">,
): Promise<File | null> {
  if (!contact.photo) return null;
  const response = await fetch(contactPhotoUrl(contact.id), { credentials: "include" });
  if (!response.ok) return null;
  const blob = await response.blob();
  return new File([blob], contact.id, { type: contact.photo.mimeType });
}
