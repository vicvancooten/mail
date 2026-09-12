import type { Contact } from "@mail/shared";
import { EMPTY_CONTACT_NAME } from "@mail/shared";
import { describe, expect, it } from "vitest";
import { findContactByAddress } from "./contact-by-address.js";

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

describe("findContactByAddress (#293)", () => {
  it("is null for an unmatched address", () => {
    expect(findContactByAddress([], "stranger@example.com")).toBeNull();
  });

  it("finds the Contact declaring the address", () => {
    const ann = contact({
      id: "contact-ann",
      emails: [{ id: "e1", type: "work", value: "ann@example.com", primary: true }],
    });
    expect(findContactByAddress([ann], "ann@example.com")).toBe(ann);
  });

  it("matches case-insensitively via normalizeCorrespondentAddress", () => {
    const ann = contact({
      id: "contact-ann",
      emails: [{ id: "e1", type: "work", value: "Ann@Example.com", primary: true }],
    });
    expect(findContactByAddress([ann], "  ann@example.com ")).toBe(ann);
  });

  it("the first Contact declaring a shared address wins, deterministically", () => {
    const first = contact({
      id: "contact-first",
      emails: [{ id: "e1", type: "work", value: "shared@example.com", primary: true }],
    });
    const second = contact({
      id: "contact-second",
      emails: [{ id: "e1", type: "work", value: "shared@example.com", primary: true }],
    });
    expect(findContactByAddress([first, second], "shared@example.com")).toBe(first);
  });
});
