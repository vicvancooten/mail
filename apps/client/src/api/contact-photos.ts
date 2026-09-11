import { type ContactPhoto, contactPhotoSchema, isContactPhotoMimeType } from "@mail/shared";
import { ApiError, deleteRequest, errorCode } from "./auth.js";

/**
 * A Contact photo's own Blob Store HTTP surface (#213) —
 * `api/attachments.ts`'s own shape, minus the upload-progress plumbing:
 * a Person Page photo pick is one small file, not a compose attachment
 * batch, so a plain `fetch` is enough.
 */

export class UnsupportedContactPhotoTypeError extends Error {
  constructor() {
    super("unsupported_mime_type");
  }
}

export class ContactPhotoTooLargeError extends Error {
  maxBytes: number;
  constructor(maxBytes: number) {
    super("photo_too_large");
    this.maxBytes = maxBytes;
  }
}

/** Uploads one image as `contactId`'s photo, resolving to its stored reference. Rejects with `UnsupportedContactPhotoTypeError`/`ContactPhotoTooLargeError` for the backend's own 415/413 (defense in depth — the picker is expected to have already refused the file, `contact-photo-picker.ts`), or `ApiError` otherwise. */
export async function uploadContactPhoto(contactId: string, file: File): Promise<ContactPhoto> {
  const mimeType = file.type;
  if (!isContactPhotoMimeType(mimeType)) {
    throw new UnsupportedContactPhotoTypeError();
  }

  const response = await fetch(
    `/contacts/${encodeURIComponent(contactId)}/photo?mimeType=${encodeURIComponent(mimeType)}`,
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": mimeType },
      body: file,
    },
  );
  if (response.status === 415) throw new UnsupportedContactPhotoTypeError();
  if (response.status === 413) {
    const body = (await response.json()) as { maxBytes: number };
    throw new ContactPhotoTooLargeError(body.maxBytes);
  }
  if (!response.ok) {
    throw new ApiError(response.status, await errorCode(response));
  }
  return contactPhotoSchema.parse(await response.json());
}

export function removeContactPhoto(contactId: string): Promise<void> {
  return deleteRequest(`/contacts/${encodeURIComponent(contactId)}/photo`);
}

/** Same-origin, session-cookie-scoped — named by `contactId`, never by `Contact.photo.blobId` directly, so it always resolves to whatever photo is current rather than baking in the id a caller happened to read (`routes/contact-photos.ts`'s own doc comment on why the download route is shaped this way). */
export function contactPhotoUrl(contactId: string): string {
  return `/contacts/${encodeURIComponent(contactId)}/photo`;
}
