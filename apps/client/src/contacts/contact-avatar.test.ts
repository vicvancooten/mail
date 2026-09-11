import type { Contact } from "@mail/shared";
import { EMPTY_CONTACT_NAME } from "@mail/shared";
import { describe, expect, it } from "vitest";
import { buildContactPhotoIndex, contactPhotoForAddress } from "./contact-avatar.js";

function contact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: "contact-1",
    addressBookId: "book-1",
    name: EMPTY_CONTACT_NAME,
    emails: [],
    phones: [],
    addresses: [],
    websites: [],
    organizations: [],
    birthday: null,
    notes: "",
    labelIds: [],
    customFields: [],
    categories: [],
    deletedAt: null,
    banner: null,
    photo: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildContactPhotoIndex / contactPhotoForAddress (#221)", () => {
  it("is empty for Contacts with no photo", () => {
    const index = buildContactPhotoIndex([
      contact({ emails: [{ id: "e1", type: "work", value: "ann@example.com", primary: true }] }),
    ]);
    expect(contactPhotoForAddress(index, "ann@example.com")).toBeNull();
  });

  it("maps a photographed Contact's address to its download route", () => {
    const index = buildContactPhotoIndex([
      contact({
        id: "contact-ann",
        emails: [{ id: "e1", type: "work", value: "ann@example.com", primary: true }],
        photo: { blobId: "hash-1", mimeType: "image/png" },
      }),
    ]);
    expect(contactPhotoForAddress(index, "ann@example.com")).toBe("/contacts/contact-ann/photo");
  });

  it("matches case-insensitively via normalizeCorrespondentAddress", () => {
    const index = buildContactPhotoIndex([
      contact({
        id: "contact-ann",
        emails: [{ id: "e1", type: "work", value: "Ann@Example.com", primary: true }],
        photo: { blobId: "hash-1", mimeType: "image/png" },
      }),
    ]);
    expect(contactPhotoForAddress(index, "  ann@example.com ")).toBe("/contacts/contact-ann/photo");
  });

  it("is null for an unmatched address", () => {
    const index = buildContactPhotoIndex([]);
    expect(contactPhotoForAddress(index, "stranger@example.com")).toBeNull();
  });

  it("every address on a multi-email Contact resolves to the same photo", () => {
    const index = buildContactPhotoIndex([
      contact({
        id: "contact-multi",
        emails: [
          { id: "e1", type: "home", value: "home@example.com", primary: false },
          { id: "e2", type: "work", value: "work@example.com", primary: true },
        ],
        photo: { blobId: "hash-1", mimeType: "image/png" },
      }),
    ]);
    expect(contactPhotoForAddress(index, "home@example.com")).toBe("/contacts/contact-multi/photo");
    expect(contactPhotoForAddress(index, "work@example.com")).toBe("/contacts/contact-multi/photo");
  });

  it("the first Contact declaring a shared address wins, deterministically", () => {
    const first = contact({
      id: "contact-first",
      emails: [{ id: "e1", type: "work", value: "shared@example.com", primary: true }],
      photo: { blobId: "hash-1", mimeType: "image/png" },
    });
    const second = contact({
      id: "contact-second",
      emails: [{ id: "e1", type: "work", value: "shared@example.com", primary: true }],
      photo: { blobId: "hash-2", mimeType: "image/png" },
    });
    const index = buildContactPhotoIndex([first, second]);
    expect(contactPhotoForAddress(index, "shared@example.com")).toBe(
      "/contacts/contact-first/photo",
    );
  });
});
