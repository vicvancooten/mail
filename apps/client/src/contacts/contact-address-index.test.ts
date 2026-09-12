import type { Contact } from "@mail/shared";
import { EMPTY_CONTACT_NAME } from "@mail/shared";
import { describe, expect, it } from "vitest";
import { buildContactAddressIndex } from "./contact-address-index.js";

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

describe("buildContactAddressIndex (#293)", () => {
  it("indexes every email address a Contact declares to whatever valueFor returns", () => {
    const ann = contact({
      id: "contact-ann",
      emails: [
        { id: "e1", type: "home", value: "home@example.com", primary: false },
        { id: "e2", type: "work", value: "work@example.com", primary: true },
      ],
    });
    const index = buildContactAddressIndex([ann], (c) => c.id);
    expect(index.get("home@example.com")).toBe("contact-ann");
    expect(index.get("work@example.com")).toBe("contact-ann");
  });

  it("matches case-insensitively via normalizeCorrespondentAddress", () => {
    const ann = contact({
      emails: [{ id: "e1", type: "work", value: "Ann@Example.com", primary: true }],
    });
    const index = buildContactAddressIndex([ann], (c) => c.id);
    expect(index.get("ann@example.com")).toBe(ann.id);
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
    const index = buildContactAddressIndex([first, second], (c) => c.id);
    expect(index.get("shared@example.com")).toBe("contact-first");
  });

  it("skips a Contact whose valueFor returns undefined, leaving its addresses unclaimed", () => {
    const skipped = contact({
      id: "contact-skipped",
      emails: [{ id: "e1", type: "work", value: "shared@example.com", primary: true }],
    });
    const kept = contact({
      id: "contact-kept",
      emails: [{ id: "e1", type: "work", value: "shared@example.com", primary: true }],
    });
    const index = buildContactAddressIndex([skipped, kept], (c) =>
      c.id === "contact-skipped" ? undefined : c.id,
    );
    expect(index.get("shared@example.com")).toBe("contact-kept");
  });
});
