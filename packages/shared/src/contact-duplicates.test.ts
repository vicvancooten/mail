import { describe, expect, it } from "vitest";
import {
  contactDuplicateKeys,
  contactEmailMatchKey,
  contactPhoneMatchKey,
  findDuplicateContactIds,
} from "./contact-duplicates.js";
import type { Contact } from "./contacts.js";

function contact(id: string, overrides: Partial<Contact> = {}): Contact {
  return {
    id,
    addressBookId: "book-1",
    name: {},
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

function email(value: string) {
  return { id: `e-${value}`, type: "home", value, primary: false };
}

function phone(value: string) {
  return { id: `p-${value}`, type: "mobile", value, primary: false };
}

describe("contactEmailMatchKey (#222)", () => {
  it("normalises case and surrounding space", () => {
    expect(contactEmailMatchKey("  Ada@Example.COM ")).toBe("ada@example.com");
  });

  it("rejects a value that isn't an address at all, so it never pairs", () => {
    expect(contactEmailMatchKey("")).toBeNull();
    expect(contactEmailMatchKey("ada")).toBeNull();
    expect(contactEmailMatchKey("@example.com")).toBeNull();
    expect(contactEmailMatchKey("ada@")).toBeNull();
  });
});

describe("contactPhoneMatchKey (#222)", () => {
  it("keeps an E.164 number's own key, dropping punctuation and spacing", () => {
    expect(contactPhoneMatchKey("+31 (6) 1234-5678")).toBe("+31612345678");
  });

  it("folds a 00-prefixed international number onto the same E.164 key", () => {
    expect(contactPhoneMatchKey("0031612345678")).toBe("+31612345678");
  });

  it("keys a national-format number on its bare digits", () => {
    expect(contactPhoneMatchKey("06 1234 5678")).toBe("0612345678");
  });

  it("refuses anything too short to be a real subscriber number", () => {
    expect(contactPhoneMatchKey("204")).toBeNull();
    expect(contactPhoneMatchKey("+1 12")).toBeNull();
  });
});

describe("contactDuplicateKeys (#222)", () => {
  it("prefixes by family, so a phone can never pair with an email", () => {
    expect(
      contactDuplicateKeys({ emails: [email("ada@example.com")], phones: [phone("+31612345678")] }),
    ).toEqual(["email:ada@example.com", "phone:+31612345678"]);
  });

  it("skips unusable values", () => {
    expect(contactDuplicateKeys({ emails: [email("nope")], phones: [phone("12")] })).toEqual([]);
  });
});

describe("findDuplicateContactIds (#222)", () => {
  it("pairs two Contacts sharing a normalised email", () => {
    const map = findDuplicateContactIds([
      contact("a", { emails: [email("Ada@Example.com")] }),
      contact("b", { emails: [email("ada@example.com")] }),
      contact("c", { emails: [email("grace@example.com")] }),
    ]);
    expect(map.get("a")).toEqual(["b"]);
    expect(map.get("b")).toEqual(["a"]);
    expect(map.has("c")).toBe(false);
  });

  it("pairs two Contacts sharing an E.164 phone across Address Books", () => {
    const map = findDuplicateContactIds([
      contact("a", { addressBookId: "local", phones: [phone("+31612345678")] }),
      contact("b", { addressBookId: "google", phones: [phone("0031 6 123 456 78")] }),
    ]);
    expect(map.get("a")).toEqual(["b"]);
  });

  it("never pairs on a name alone (this ticket's own acceptance line)", () => {
    const map = findDuplicateContactIds([
      contact("a", { name: { given: "Ada", family: "Lovelace" } }),
      contact("b", { name: { given: "Ada", family: "Lovelace" } }),
    ]);
    expect(map.size).toBe(0);
  });

  it("pairs all three when three Contacts share one address", () => {
    const map = findDuplicateContactIds([
      contact("a", { emails: [email("ada@example.com")] }),
      contact("b", { emails: [email("ada@example.com")] }),
      contact("c", { emails: [email("ada@example.com")] }),
    ]);
    expect(map.get("a")).toEqual(["b", "c"]);
    expect(map.get("c")).toEqual(["a", "b"]);
  });

  it("never reports a Contact as its own duplicate, even holding one address twice", () => {
    const map = findDuplicateContactIds([
      contact("a", {
        emails: [email("ada@example.com"), { ...email("x"), value: "ADA@example.com" }],
      }),
    ]);
    expect(map.size).toBe(0);
  });
});
