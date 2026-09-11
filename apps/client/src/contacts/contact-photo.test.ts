import { CONTACT_PHOTO_MAX_BYTES } from "@mail/shared";
import { describe, expect, it } from "vitest";
import {
  checkContactPhotoFile,
  contactPhotoRejectionMessage,
  contactPhotoSrc,
} from "./contact-photo.js";

describe("contactPhotoSrc", () => {
  it("is null for a Contact with no photo", () => {
    expect(contactPhotoSrc({ id: "c1", photo: null })).toBeNull();
  });

  it("names the download route by contactId once a photo exists", () => {
    expect(contactPhotoSrc({ id: "c1", photo: { blobId: "hash-1", mimeType: "image/png" } })).toBe(
      "/contacts/c1/photo",
    );
  });
});

describe("checkContactPhotoFile", () => {
  function file(type: string, size: number): File {
    return new File([new Uint8Array(size)], "photo", { type });
  }

  it("passes a supported, in-budget file", () => {
    expect(checkContactPhotoFile(file("image/png", 1024))).toBeNull();
  });

  it("rejects an unsupported mime type", () => {
    expect(checkContactPhotoFile(file("text/plain", 1024))).toEqual({ kind: "unsupported_type" });
  });

  it("rejects a file over the size bound", () => {
    expect(checkContactPhotoFile(file("image/png", CONTACT_PHOTO_MAX_BYTES + 1))).toEqual({
      kind: "too_large",
      maxBytes: CONTACT_PHOTO_MAX_BYTES,
    });
  });
});

describe("contactPhotoRejectionMessage", () => {
  it("names the supported types for an unsupported one", () => {
    expect(contactPhotoRejectionMessage({ kind: "unsupported_type" })).toBe(
      "Use one of: image/jpeg, image/png, image/webp",
    );
  });

  it("names the limit in MB for an over-budget one", () => {
    expect(contactPhotoRejectionMessage({ kind: "too_large", maxBytes: 5 * 1024 * 1024 })).toBe(
      "Over the 5MB photo limit",
    );
  });
});
