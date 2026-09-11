import { describe, expect, it } from "vitest";
import {
  contactsAreMergeable,
  mergeContactFields,
  pickContactMergeSurvivor,
} from "./contact-merge.js";
import {
  type Contact,
  type ContactCapabilityTable,
  LOCAL_CONTACT_CAPABILITY_TABLE,
  MICROSOFT_CONTACT_CAPABILITY_TABLE,
} from "./contacts.js";

/**
 * `contact-merge.ts` (#223) — "the older record survives and takes the
 * other's fields; the other is deleted", checked against exactly the
 * capability-table edge cases `contact-duplicates.test.ts`/
 * `contact-links.test.ts` already exercise for the same field families.
 */

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

function email(value: string, overrides: Record<string, unknown> = {}) {
  return { id: `e-${value}`, type: "home", value, primary: false, ...overrides };
}

describe("contactsAreMergeable", () => {
  it("is true for two different records in the same Address Book", () => {
    expect(contactsAreMergeable(contact("a"), contact("b"))).toBe(true);
  });

  it("is false for the same record, and for two different Address Books", () => {
    expect(contactsAreMergeable(contact("a"), contact("a"))).toBe(false);
    expect(contactsAreMergeable(contact("a"), contact("b", { addressBookId: "book-2" }))).toBe(
      false,
    );
  });
});

describe("pickContactMergeSurvivor", () => {
  it("the earlier createdAt survives, regardless of argument order", () => {
    const older = contact("a", { createdAt: "2025-01-01T00:00:00.000Z" });
    const newer = contact("b", { createdAt: "2026-01-01T00:00:00.000Z" });

    expect(pickContactMergeSurvivor(older, newer)).toEqual({ survivor: older, loser: newer });
    expect(pickContactMergeSurvivor(newer, older)).toEqual({ survivor: older, loser: newer });
  });

  it("breaks a tied createdAt on id, as a total order", () => {
    const a = contact("a", { createdAt: "2026-01-01T00:00:00.000Z" });
    const b = contact("b", { createdAt: "2026-01-01T00:00:00.000Z" });

    expect(pickContactMergeSurvivor(a, b)).toEqual({ survivor: a, loser: b });
    expect(pickContactMergeSurvivor(b, a)).toEqual({ survivor: a, loser: b });
  });
});

describe("mergeContactFields", () => {
  const table = LOCAL_CONTACT_CAPABILITY_TABLE;

  it("unions repeatable families, survivor's own entries first", () => {
    const survivor = contact("a", { emails: [email("ada@example.com")] });
    const loser = contact("b", { emails: [email("ada@lovelace.example")] });

    const merged = mergeContactFields(survivor, loser, table);

    expect(merged.emails.map((entry) => entry.value)).toEqual([
      "ada@example.com",
      "ada@lovelace.example",
    ]);
  });

  it("drops a duplicate email the two records already share", () => {
    const survivor = contact("a", { emails: [email("ada@example.com", { primary: true })] });
    const loser = contact("b", { emails: [email("Ada@Example.com ")] });

    const merged = mergeContactFields(survivor, loser, table);

    expect(merged.emails).toHaveLength(1);
    expect(merged.emails[0]?.primary).toBe(true);
  });

  it("demotes the loser's primary when both records have one for the same family", () => {
    const survivor = contact("a", {
      emails: [email("ada@example.com", { primary: true })],
    });
    const loser = contact("b", {
      emails: [email("ada@lovelace.example", { primary: true })],
    });

    const merged = mergeContactFields(survivor, loser, table);

    expect(merged.emails).toEqual([
      expect.objectContaining({ value: "ada@example.com", primary: true }),
      expect.objectContaining({ value: "ada@lovelace.example", primary: false }),
    ]);
  });

  it("truncates a unioned family to the capability table's own cap, survivor's entries first", () => {
    const survivor = contact("a", {
      organizations: [{ id: "org-1", name: "Cogworks" }],
    });
    const loser = contact("b", {
      organizations: [{ id: "org-2", name: "Analytical Engines Ltd" }],
    });

    const merged = mergeContactFields(survivor, loser, MICROSOFT_CONTACT_CAPABILITY_TABLE);

    expect(merged.organizations).toEqual([{ id: "org-1", name: "Cogworks" }]);
  });

  it("empties a family the capability table doesn't support at all", () => {
    const noCustomFields: ContactCapabilityTable = {
      ...LOCAL_CONTACT_CAPABILITY_TABLE,
      customFields: false,
    };
    const survivor = contact("a", {
      customFields: [{ id: "c-1", label: "Boat", type: "text", value: "Enigma" }],
    });
    const loser = contact("b");

    const merged = mergeContactFields(survivor, loser, noCustomFields);

    expect(merged.customFields).toEqual([]);
  });

  it("takes the loser's name only when the survivor has none", () => {
    const named = contact("a", { name: { given: "Ada" } });
    const unnamed = contact("b", { organizations: [{ id: "org-1", name: "Cogworks" }] });

    expect(mergeContactFields(named, unnamed, table).name).toEqual({ given: "Ada" });
    expect(mergeContactFields(unnamed, named, table).name).toEqual({ given: "Ada" });
  });

  it("takes the loser's birthday only when the survivor has none", () => {
    const birthday = { month: 12, day: 10, year: 1815 };
    const withBirthday = contact("a", { birthday });
    const withoutBirthday = contact("b");

    expect(mergeContactFields(withBirthday, withoutBirthday, table).birthday).toEqual(birthday);
    expect(mergeContactFields(withoutBirthday, withBirthday, table).birthday).toEqual(birthday);
  });

  it("keeps the survivor's notes untouched when the loser wrote none", () => {
    const survivor = contact("a", { notes: "met at a conference" });
    const loser = contact("b");

    expect(mergeContactFields(survivor, loser, table).notes).toBe("met at a conference");
  });

  it("folds the loser's notes in when both wrote something different", () => {
    const survivor = contact("a", { notes: "met at a conference" });
    const loser = contact("b", { notes: "works at Cogworks" });

    expect(mergeContactFields(survivor, loser, table).notes).toBe(
      "met at a conference\n\nworks at Cogworks",
    );
  });

  it("never doubles up identical notes", () => {
    const survivor = contact("a", { notes: "met at a conference" });
    const loser = contact("b", { notes: "met at a conference" });

    expect(mergeContactFields(survivor, loser, table).notes).toBe("met at a conference");
  });

  it("never touches labelIds, banner or photo — they ride their own intents, not updateContact", () => {
    const survivor = contact("a", { labelIds: ["l-1"] });
    const loser = contact("b", { labelIds: ["l-2"] });

    const merged = mergeContactFields(survivor, loser, table) as unknown as Record<string, unknown>;

    expect(merged.labelIds).toBeUndefined();
    expect(merged.banner).toBeUndefined();
    expect(merged.photo).toBeUndefined();
  });
});
