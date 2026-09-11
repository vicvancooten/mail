import { describe, expect, it } from "vitest";
import {
  type ContactLink,
  contactLinkFor,
  type LinkedContactGroup,
  linkedContactAddresses,
  resolveLinkedContactFront,
  resolveLinkedContactGroup,
  resolveLinkedContactGroups,
  unionLinkedContactFields,
} from "./contact-links.js";
import type { Contact } from "./contacts.js";

function contact(id: string, overrides: Partial<Contact> = {}): Contact {
  return {
    id,
    addressBookId: "local",
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

function link(overrides: Partial<ContactLink> = {}): ContactLink {
  return {
    id: "link-1",
    contactIds: ["a", "b"],
    frontContactId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** The one group `resolveLinkedContactGroups` returns for a seeded pair — asserted non-empty here so every case below reads without an assertion of its own. */
function onlyGroup(groups: readonly LinkedContactGroup[]): LinkedContactGroup {
  const group = groups.find((entry) => entry.link !== null) ?? groups[0];
  if (!group) throw new Error("onlyGroup: no groups");
  return group;
}

function email(value: string, overrides: Record<string, unknown> = {}) {
  return { id: `e-${value}`, type: "home", value, primary: false, ...overrides };
}

describe("resolveLinkedContactFront (#222)", () => {
  const local = contact("a", { addressBookId: "local", updatedAt: "2026-01-01T00:00:00.000Z" });
  const google = contact("b", { addressBookId: "google", updatedAt: "2026-06-01T00:00:00.000Z" });

  it("fronts the record in the Default Address Book", () => {
    expect(
      resolveLinkedContactFront([local, google], link(), { defaultAddressBookId: "local" }).id,
    ).toBe("a");
  });

  it("falls back to the most recently edited when no member is in the default book", () => {
    expect(
      resolveLinkedContactFront([local, google], link(), { defaultAddressBookId: "other" }).id,
    ).toBe("b");
  });

  it("honours the User's own pick over both", () => {
    expect(
      resolveLinkedContactFront([local, google], link({ frontContactId: "b" }), {
        defaultAddressBookId: "local",
      }).id,
    ).toBe("b");
  });

  it("ignores a pick whose record is no longer a member", () => {
    expect(
      resolveLinkedContactFront([local, google], link({ frontContactId: "gone" }), {
        defaultAddressBookId: "local",
      }).id,
    ).toBe("a");
  });
});

describe("resolveLinkedContactGroups (#222)", () => {
  it("collapses a linked pair into one card and leaves the rest alone", () => {
    const groups = resolveLinkedContactGroups(
      [contact("a"), contact("b", { addressBookId: "google" }), contact("c")],
      [link()],
      { defaultAddressBookId: "local" },
    );
    expect(groups).toHaveLength(2);
    const linked = groups.find((group) => group.link !== null);
    expect(linked?.members.map((member) => member.id)).toEqual(["a", "b"]);
    expect(linked?.front.id).toBe("a");
    expect(groups.find((group) => group.link === null)?.front.id).toBe("c");
  });

  it("restores two cards once the link is gone (Unlink's own outcome)", () => {
    const groups = resolveLinkedContactGroups([contact("a"), contact("b")], []);
    expect(groups.map((group) => group.key).sort()).toEqual(["a", "b"]);
  });

  it("falls back to plain cards when fewer than two members are actually held", () => {
    const groups = resolveLinkedContactGroups([contact("a")], [link()]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.link).toBeNull();
  });

  it("keys a linked group on the link, so fronting a different record keeps one card", () => {
    const contacts = [contact("a"), contact("b")];
    const first = resolveLinkedContactGroups(contacts, [link()]);
    const second = resolveLinkedContactGroups(contacts, [link({ frontContactId: "b" })]);
    expect(first[0]?.key).toBe(second[0]?.key);
    expect(second[0]?.front.id).toBe("b");
  });
});

describe("resolveLinkedContactGroup (#222)", () => {
  it("resolves the same group from either member's id", () => {
    const contacts = [contact("a"), contact("b")];
    const fromA = resolveLinkedContactGroup("a", contacts, [link()]);
    const fromB = resolveLinkedContactGroup("b", contacts, [link()]);
    expect(fromA?.key).toBe(fromB?.key);
    expect(fromB?.members.map((member) => member.id)).toEqual(["a", "b"]);
  });

  it("is null for an id this Client doesn't hold", () => {
    expect(resolveLinkedContactGroup("zz", [contact("a")], [])).toBeNull();
  });
});

describe("contactLinkFor (#222)", () => {
  it("finds the one link a Contact belongs to", () => {
    expect(contactLinkFor([link()], "b")?.id).toBe("link-1");
    expect(contactLinkFor([link()], "c")).toBeNull();
  });
});

describe("unionLinkedContactFields (#222)", () => {
  const local = contact("a", {
    addressBookId: "local",
    name: { given: "Ada", family: "Lovelace" },
    emails: [email("ada@example.com")],
    phones: [{ id: "p1", type: "mobile", value: "+31612345678", primary: true }],
    notes: "local note",
    labelIds: ["label-1"],
  });
  const google = contact("b", {
    addressBookId: "google",
    emails: [email("ADA@example.com"), email("ada@work.example")],
    birthday: { month: 12, day: 10, year: 1815 },
    notes: "google note",
    labelIds: ["label-2"],
    photo: { blobId: "hash", mimeType: "image/png" },
  });
  const group = onlyGroup(
    resolveLinkedContactGroups([local, google], [link()], { defaultAddressBookId: "local" }),
  );

  it("shows every field once, tagged with the record it came from", () => {
    const fields = unionLinkedContactFields(group);
    expect(fields.emails.map((entry) => [entry.entry.value, entry.sourceContactId])).toEqual([
      ["ada@example.com", "a"],
      ["ada@work.example", "b"],
    ]);
    expect(fields.phones).toHaveLength(1);
    expect(fields.phones[0]?.sourceContactId).toBe("a");
  });

  it("takes a single-valued family from whichever record holds one", () => {
    const fields = unionLinkedContactFields(group);
    expect(fields.name).toEqual({ given: "Ada", family: "Lovelace" });
    expect(fields.nameSourceContactId).toBe("a");
    expect(fields.birthday?.entry.year).toBe(1815);
    expect(fields.birthday?.sourceContactId).toBe("b");
    expect(fields.photo?.entry.blobId).toBe("hash");
    expect(fields.photo?.sourceContactId).toBe("b");
  });

  it("keeps one note per record rather than concatenating prose", () => {
    const fields = unionLinkedContactFields(group);
    expect(fields.notes).toEqual([
      { sourceContactId: "a", entry: "local note" },
      { sourceContactId: "b", entry: "google note" },
    ]);
  });

  it("unions Labels, which are Wicket's own and belong to the person", () => {
    expect(unionLinkedContactFields(group).labelIds).toEqual(["label-1", "label-2"]);
  });

  it("takes the name from the front record when both hold one", () => {
    const named = resolveLinkedContactGroups(
      [local, { ...google, name: { given: "A." } }],
      [link({ frontContactId: "b" })],
    );
    expect(unionLinkedContactFields(onlyGroup(named)).nameSourceContactId).toBe("b");
  });
});

describe("linkedContactAddresses (#222)", () => {
  it("covers every address on every linked record, deduped, front first", () => {
    const groups = resolveLinkedContactGroups(
      [
        contact("a", { emails: [email("ada@example.com")] }),
        contact("b", {
          addressBookId: "google",
          emails: [email("Ada@Example.com"), email("ada@work.example"), email("broken")],
        }),
      ],
      [link()],
      { defaultAddressBookId: "local" },
    );
    expect(linkedContactAddresses(onlyGroup(groups))).toEqual([
      "ada@example.com",
      "ada@work.example",
    ]);
  });

  it("is just the Contact's own addresses when it isn't linked", () => {
    const groups = resolveLinkedContactGroups(
      [contact("a", { emails: [email("x@y.example")] })],
      [],
    );
    expect(linkedContactAddresses(onlyGroup(groups))).toEqual(["x@y.example"]);
  });
});
