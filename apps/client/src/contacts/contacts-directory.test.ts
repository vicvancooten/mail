import type { Contact, ContactLink } from "@mail/shared";
import { findDuplicateContactIds } from "@mail/shared";
import { describe, expect, it } from "vitest";
import { makeContact } from "../test-support/mail-fixtures.js";
import { contactsDirectoryGroups } from "./contacts-directory.js";

/**
 * The grid's own selection rules (#211/#222) without a router or a rendered
 * card — `contacts-directory.ts`'s own doc comment on why the three steps
 * run in the order they do is exactly what this file pins down.
 */

function email(value: string) {
  return { id: `e-${value}`, type: "home", value, primary: false };
}

const LOCAL = "book-local";
const GOOGLE = "book-google";

const FILTERS = {
  selectedAddressBookIds: new Set<string>(),
  query: "",
  duplicatesOnly: false,
  sortOrder: "given" as const,
  defaultAddressBookId: LOCAL,
};

function link(contactIds: string[], overrides: Partial<ContactLink> = {}): ContactLink {
  return {
    id: "link-1",
    contactIds,
    frontContactId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function duplicatesOf(contacts: readonly Contact[]) {
  return findDuplicateContactIds(contacts);
}

describe("contactsDirectoryGroups (#222)", () => {
  const local = makeContact("c-local", LOCAL, {
    name: { given: "Ada", family: "Lovelace" },
    emails: [email("ada@example.com")],
  });
  const google = makeContact("c-google", GOOGLE, {
    name: { given: "Ada", family: "Lovelace" },
    emails: [email("ada@example.com")],
    updatedAt: "2026-06-01T00:00:00.000Z",
  });
  const other = makeContact("c-other", LOCAL, {
    name: { given: "Grace", family: "Hopper" },
    emails: [email("grace@example.com")],
  });
  const contacts = [local, google, other];

  it("shows two cards for an unlinked possible-duplicate pair, and one once linked", () => {
    const unlinked = contactsDirectoryGroups(contacts, [], duplicatesOf(contacts), FILTERS);
    expect(unlinked).toHaveLength(3);

    const linked = contactsDirectoryGroups(
      contacts,
      [link(["c-local", "c-google"])],
      duplicatesOf(contacts),
      FILTERS,
    );
    expect(linked).toHaveLength(2);
    const person = linked.find((group) => group.link !== null);
    expect(person?.front.id).toBe("c-local");
    expect(person?.members.map((member) => member.id)).toEqual(["c-local", "c-google"]);
  });

  it("narrows to possible duplicates on the Duplicates filter", () => {
    const groups = contactsDirectoryGroups(contacts, [], duplicatesOf(contacts), {
      ...FILTERS,
      duplicatesOnly: true,
    });
    expect(groups.map((group) => group.front.id).sort()).toEqual(["c-google", "c-local"]);
  });

  it("keeps the Duplicates filter empty once the pair is linked — the suggestion is answered", () => {
    // `duplicateCandidatesInScope` (`store/contact-links.ts`) is what drops
    // an already-linked pair; the directory simply honours whatever map it's
    // handed, which is what this asserts.
    const groups = contactsDirectoryGroups(contacts, [link(["c-local", "c-google"])], new Map(), {
      ...FILTERS,
      duplicatesOnly: true,
    });
    expect(groups).toEqual([]);
  });

  it("renders the visible half of a group whose partner an Address Book chip hides", () => {
    const groups = contactsDirectoryGroups(
      contacts,
      [link(["c-local", "c-google"])],
      duplicatesOf(contacts),
      { ...FILTERS, selectedAddressBookIds: new Set([GOOGLE]) },
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.link).toBeNull();
    expect(groups[0]?.front.id).toBe("c-google");
  });

  it("fronts the most recently edited record when no member is in the Default Address Book", () => {
    const groups = contactsDirectoryGroups(contacts, [link(["c-local", "c-google"])], new Map(), {
      ...FILTERS,
      defaultAddressBookId: "book-somewhere-else",
    });
    expect(groups.find((group) => group.link !== null)?.front.id).toBe("c-google");
  });

  it("sorts people by the union's name, not by whichever record fronts them", () => {
    const namelessFront = makeContact("c-front", GOOGLE, {
      emails: [email("ada@example.com")],
      updatedAt: "2026-09-01T00:00:00.000Z",
    });
    const named = makeContact("c-named", "book-third", {
      name: { given: "Ada", family: "Lovelace" },
    });
    const groups = contactsDirectoryGroups(
      [namelessFront, named, other],
      [link(["c-front", "c-named"])],
      new Map(),
      { ...FILTERS, defaultAddressBookId: GOOGLE },
    );
    // "Ada Lovelace" before "Grace Hopper", even though the fronting record
    // has no name of its own.
    expect(groups.map((group) => group.front.id)).toEqual(["c-front", "c-other"]);
  });

  it("matches the search text against any record of a person", () => {
    const groups = contactsDirectoryGroups(contacts, [link(["c-local", "c-google"])], new Map(), {
      ...FILTERS,
      query: "grace",
    });
    expect(groups.map((group) => group.front.id)).toEqual(["c-other"]);
  });
});
