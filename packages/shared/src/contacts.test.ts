import { describe, expect, it } from "vitest";
import type { AddressBookCapabilityTableId } from "./address-books.js";
import {
  CARDDAV_CONTACT_CAPABILITY_TABLE,
  CLOSED_CONTACT_CAPABILITY_TABLE,
  type Contact,
  type ContactWritableFields,
  contactDisplayName,
  contactFieldFamilyAtLimit,
  contactMatchesQuery,
  contactOrganizationLine,
  contactSortKey,
  demoteContactAddress,
  EMPTY_CONTACT_FIELDS,
  GOOGLE_CONTACT_CAPABILITY_TABLE,
  getContactCapabilityTable,
  isStandardContactFieldLabel,
  LOCAL_CONTACT_CAPABILITY_TABLE,
  MICROSOFT_CONTACT_CAPABILITY_TABLE,
  splitTypedContactFields,
  validateContactFields,
} from "./contacts.js";

function contact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: "c1",
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
    banner: null,
    photo: null,
    categories: [],
    deletedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("getContactCapabilityTable", () => {
  it("hands back Local's own full-set table", () => {
    expect(getContactCapabilityTable("local")).toBe(LOCAL_CONTACT_CAPABILITY_TABLE);
  });

  it("hands back Google's own table (#214)", () => {
    expect(getContactCapabilityTable("google")).toBe(GOOGLE_CONTACT_CAPABILITY_TABLE);
  });

  it("hands back Graph's own thinnest table (#227)", () => {
    expect(getContactCapabilityTable("microsoft")).toBe(MICROSOFT_CONTACT_CAPABILITY_TABLE);
    expect(MICROSOFT_CONTACT_CAPABILITY_TABLE).toEqual({
      limits: {
        email: undefined,
        phone: undefined,
        address: undefined,
        organization: 1,
        website: undefined,
      },
      hasBirthday: true,
      birthdayYearOptional: false,
      customFields: false,
    });
  });

  it("hands back CardDAV's own near-superset table (#226)", () => {
    expect(getContactCapabilityTable("caldav_carddav")).toBe(CARDDAV_CONTACT_CAPABILITY_TABLE);
    expect(CARDDAV_CONTACT_CAPABILITY_TABLE).toEqual({
      limits: {
        email: undefined,
        phone: undefined,
        address: undefined,
        organization: undefined,
        website: undefined,
      },
      hasBirthday: true,
      birthdayYearOptional: true,
      customFields: true,
    });
  });

  it("hands back a closed table for an Origin no adapter has declared yet", () => {
    expect(getContactCapabilityTable("not_yet_declared" as AddressBookCapabilityTableId)).toEqual(
      CLOSED_CONTACT_CAPABILITY_TABLE,
    );
  });
});

describe("contactFieldFamilyAtLimit", () => {
  it("is never at limit for an unbounded family", () => {
    expect(
      contactFieldFamilyAtLimit(LOCAL_CONTACT_CAPABILITY_TABLE, "organization", [{}, {}, {}]),
    ).toBe(false);
  });

  it("is at limit once Graph's own organization cap (1) is reached", () => {
    expect(contactFieldFamilyAtLimit(MICROSOFT_CONTACT_CAPABILITY_TABLE, "organization", [])).toBe(
      false,
    );
    expect(
      contactFieldFamilyAtLimit(MICROSOFT_CONTACT_CAPABILITY_TABLE, "organization", [{}]),
    ).toBe(true);
  });
});

describe("isStandardContactFieldLabel", () => {
  it("recognizes each family's fixed vocabulary", () => {
    expect(isStandardContactFieldLabel("email", "home")).toBe(true);
    expect(isStandardContactFieldLabel("phone", "mobile")).toBe(true);
    expect(isStandardContactFieldLabel("address", "work")).toBe(true);
    expect(isStandardContactFieldLabel("website", "homepage")).toBe(true);
  });

  it("rejects a label outside the vocabulary", () => {
    expect(isStandardContactFieldLabel("phone", "Boat")).toBe(false);
  });
});

describe("splitTypedContactFields", () => {
  it("keeps a standard-labelled entry in its own family", () => {
    const { standard, custom } = splitTypedContactFields("phone", [
      { id: "p1", label: "mobile", value: "+15551234567", primary: true },
    ]);
    expect(standard).toEqual([{ id: "p1", type: "mobile", value: "+15551234567", primary: true }]);
    expect(custom).toEqual([]);
  });

  it("demotes a non-standard label to a Custom Field of the family's own type (ADR-0026)", () => {
    const { standard, custom } = splitTypedContactFields("phone", [
      { id: "p1", label: "Boat", value: "+15551234567", primary: false },
    ]);
    expect(standard).toEqual([]);
    expect(custom).toEqual([{ id: "p1", label: "Boat", type: "phone", value: "+15551234567" }]);
  });

  it("demotes a non-standard email label to a text Custom Field — email has no Custom Field type of its own", () => {
    const { standard, custom } = splitTypedContactFields("email", [
      { id: "e1", label: "school", value: "kid@school.example", primary: false },
    ]);
    expect(standard).toEqual([]);
    expect(custom).toEqual([
      { id: "e1", label: "school", type: "text", value: "kid@school.example" },
    ]);
  });

  it("demotes a non-standard website label to a website Custom Field", () => {
    const { standard, custom } = splitTypedContactFields("website", [
      { id: "w1", label: "portfolio", value: "https://example.com", primary: false },
    ]);
    expect(standard).toEqual([]);
    expect(custom).toEqual([
      { id: "w1", label: "portfolio", type: "website", value: "https://example.com" },
    ]);
  });
});

describe("demoteContactAddress", () => {
  it("keeps a standard-labelled address as a structured address", () => {
    const result = demoteContactAddress({
      id: "a1",
      type: "home",
      primary: true,
      street: "1 Main St",
      city: "Springfield",
    });
    expect(result.custom).toBeNull();
    expect(result.standard).toEqual({
      id: "a1",
      type: "home",
      primary: true,
      street: "1 Main St",
      city: "Springfield",
    });
  });

  it("demotes a non-standard-labelled address to a joined `location` Custom Field", () => {
    const result = demoteContactAddress({
      id: "a1",
      type: "Cabin",
      primary: false,
      street: "1 Main St",
      city: "Springfield",
      region: undefined,
      postalCode: "",
      country: "US",
    });
    expect(result.standard).toBeNull();
    expect(result.custom).toEqual({
      id: "a1",
      label: "Cabin",
      type: "location",
      value: "1 Main St, Springfield, US",
    });
  });
});

describe("validateContactFields", () => {
  function fields(overrides: Partial<ContactWritableFields>): ContactWritableFields {
    return { ...EMPTY_CONTACT_FIELDS, ...overrides };
  }

  it("accepts everything against Local's full-set table", () => {
    const result = validateContactFields(
      fields({
        emails: [{ id: "e1", type: "home", value: "a@example.com", primary: true }],
        birthday: { month: 1, day: 2, year: null },
        customFields: [{ id: "c1", label: "Anniversary", type: "date", value: "2020-01-01" }],
      }),
      LOCAL_CONTACT_CAPABILITY_TABLE,
    );
    expect(result).toEqual({ ok: true });
  });

  it("rejects a family the table omits entirely", () => {
    const result = validateContactFields(
      fields({ emails: [{ id: "e1", type: "home", value: "a@example.com", primary: false }] }),
      CLOSED_CONTACT_CAPABILITY_TABLE,
    );
    expect(result).toEqual({ ok: false, reason: "email_not_supported" });
  });

  it("rejects more entries than the table's limit allows", () => {
    const table = { ...LOCAL_CONTACT_CAPABILITY_TABLE, limits: { email: 1 } };
    const result = validateContactFields(
      fields({
        emails: [
          { id: "e1", type: "home", value: "a@example.com", primary: false },
          { id: "e2", type: "work", value: "b@example.com", primary: false },
        ],
      }),
      table,
    );
    expect(result).toEqual({ ok: false, reason: "too_many_email" });
  });

  it("rejects more than one primary within a family", () => {
    const result = validateContactFields(
      fields({
        phones: [
          { id: "p1", type: "home", value: "1", primary: true },
          { id: "p2", type: "work", value: "2", primary: true },
        ],
      }),
      LOCAL_CONTACT_CAPABILITY_TABLE,
    );
    expect(result).toEqual({ ok: false, reason: "multiple_primary_phone" });
  });

  it("rejects a birthday when the table holds none", () => {
    const result = validateContactFields(
      fields({ birthday: { month: 1, day: 1, year: 2000 } }),
      CLOSED_CONTACT_CAPABILITY_TABLE,
    );
    expect(result).toEqual({ ok: false, reason: "birthday_not_supported" });
  });

  it("rejects a year-less birthday when the table requires one", () => {
    const table = { ...LOCAL_CONTACT_CAPABILITY_TABLE, birthdayYearOptional: false };
    const result = validateContactFields(
      fields({ birthday: { month: 1, day: 1, year: null } }),
      table,
    );
    expect(result).toEqual({ ok: false, reason: "birthday_year_required" });
  });

  it("rejects Custom Fields when the table holds none", () => {
    const result = validateContactFields(
      fields({ customFields: [{ id: "c1", label: "Boat", type: "phone", value: "1" }] }),
      CLOSED_CONTACT_CAPABILITY_TABLE,
    );
    expect(result).toEqual({ ok: false, reason: "custom_fields_not_supported" });
  });

  it("(#227) rejects a second organisation against Graph's own table", () => {
    const result = validateContactFields(
      fields({
        organizations: [
          { id: "o1", name: "Acme" },
          { id: "o2", name: "Widgets Inc" },
        ],
      }),
      MICROSOFT_CONTACT_CAPABILITY_TABLE,
    );
    expect(result).toEqual({ ok: false, reason: "too_many_organization" });
  });

  it("(#227) rejects a year-less birthday and Custom Fields against Graph's own table", () => {
    expect(
      validateContactFields(
        fields({ birthday: { month: 6, day: 1, year: null } }),
        MICROSOFT_CONTACT_CAPABILITY_TABLE,
      ),
    ).toEqual({ ok: false, reason: "birthday_year_required" });
    expect(
      validateContactFields(
        fields({ customFields: [{ id: "c1", label: "Boat", type: "phone", value: "1" }] }),
        MICROSOFT_CONTACT_CAPABILITY_TABLE,
      ),
    ).toEqual({ ok: false, reason: "custom_fields_not_supported" });
  });
});

describe("contactDisplayName (#211)", () => {
  it("joins given and family name", () => {
    expect(contactDisplayName(contact({ name: { given: "Ada", family: "Lovelace" } }))).toBe(
      "Ada Lovelace",
    );
  });

  it("falls back to the first Organization for a business-only Contact", () => {
    expect(
      contactDisplayName(contact({ organizations: [{ id: "o1", name: "Analytical Engines" }] })),
    ).toBe("Analytical Engines");
  });

  it("falls back to the primary email when there is no name or Organization", () => {
    expect(
      contactDisplayName(
        contact({
          emails: [
            { id: "e1", type: "home", value: "a@example.com", primary: false },
            { id: "e2", type: "work", value: "b@example.com", primary: true },
          ],
        }),
      ),
    ).toBe("b@example.com");
  });

  it("falls back to a fixed placeholder rather than rendering blank", () => {
    expect(contactDisplayName(contact())).toBe("Unnamed contact");
  });
});

describe("contactOrganizationLine (#211)", () => {
  it("is undefined with no Organization", () => {
    expect(contactOrganizationLine(contact())).toBeUndefined();
  });

  it("joins the title and the Organization's name", () => {
    expect(
      contactOrganizationLine(
        contact({ organizations: [{ id: "o1", name: "Acme", title: "Engineer" }] }),
      ),
    ).toBe("Engineer at Acme");
  });

  it("is just the name with no title", () => {
    expect(contactOrganizationLine(contact({ organizations: [{ id: "o1", name: "Acme" }] }))).toBe(
      "Acme",
    );
  });
});

describe("contactSortKey (#211)", () => {
  it('sorts given-first when order is "given"', () => {
    const key = contactSortKey(contact({ name: { given: "Ada", family: "Lovelace" } }), "given");
    expect(key).toBe("ada lovelace");
  });

  it('sorts family-first when order is "family"', () => {
    const key = contactSortKey(contact({ name: { given: "Ada", family: "Lovelace" } }), "family");
    expect(key).toBe("lovelace ada");
  });

  it("falls back to the display name for a Contact with nothing to sort by that order", () => {
    const businessOnly = contact({ organizations: [{ id: "o1", name: "Acme" }] });
    expect(contactSortKey(businessOnly, "family")).toBe("acme");
  });
});

describe("contactMatchesQuery (#211)", () => {
  it("matches on the display name", () => {
    expect(
      contactMatchesQuery(contact({ name: { given: "Ada", family: "Lovelace" } }), "lovelace"),
    ).toBe(true);
  });

  it("matches on an email address", () => {
    expect(
      contactMatchesQuery(
        contact({ emails: [{ id: "e1", type: "home", value: "ada@example.com", primary: true }] }),
        "example.com",
      ),
    ).toBe(true);
  });

  it("matches on an Organization's name", () => {
    expect(
      contactMatchesQuery(contact({ organizations: [{ id: "o1", name: "Acme Corp" }] }), "acme"),
    ).toBe(true);
  });

  it("matches on a postal address's city", () => {
    expect(
      contactMatchesQuery(
        contact({ addresses: [{ id: "a1", type: "home", primary: true, city: "Amsterdam" }] }),
        "amsterdam",
      ),
    ).toBe(true);
  });

  it("is case-insensitive and ignores surrounding whitespace", () => {
    expect(contactMatchesQuery(contact({ name: { given: "Ada" } }), "  ADA  ")).toBe(true);
  });

  it("matches everything on an empty query", () => {
    expect(contactMatchesQuery(contact(), "")).toBe(true);
  });

  it("does not match unrelated text", () => {
    expect(contactMatchesQuery(contact({ name: { given: "Ada" } }), "grace")).toBe(false);
  });
});
