import { describe, expect, it } from "vitest";
import type { GraphContact } from "./client.js";
import {
  contactWritableFieldsToGraphBody,
  graphContactCategories,
  graphContactToWritableFields,
} from "./mapping.js";

/**
 * Graph ⇄ Wicket field mapping (#227) — `graphContactToWritableFields` is
 * the sync engine's own read side (`contacts-sync.test.ts` drives the
 * upsert loop that calls it; this file is the mapping alone),
 * `contactWritableFieldsToGraphBody` the write path's own build step.
 */

function graphContact(overrides: Partial<GraphContact> = {}): GraphContact {
  return { id: "AAMk-c1", changeKey: "ck1", ...overrides };
}

describe("graphContactToWritableFields", () => {
  it("maps name parts, emails, and personalNotes", () => {
    const fields = graphContactToWritableFields(
      graphContact({
        givenName: "Ada",
        surname: "Lovelace",
        title: "Dr.",
        emailAddresses: [{ address: "ada@example.com" }, { address: "second@example.com" }],
        personalNotes: "met at a conference",
      }),
    );

    expect(fields.name).toEqual({
      prefix: "Dr.",
      given: "Ada",
      family: "Lovelace",
      middle: undefined,
      suffix: undefined,
    });
    expect(fields.emails).toEqual([
      { id: "AAMk-c1:email:0", type: "other", value: "ada@example.com", primary: true },
      { id: "AAMk-c1:email:1", type: "other", value: "second@example.com", primary: false },
    ]);
    expect(fields.notes).toBe("met at a conference");
    expect(fields.customFields).toEqual([]);
  });

  it("splits home/business phones and the single mobilePhone by type", () => {
    const fields = graphContactToWritableFields(
      graphContact({
        homePhones: ["+1-home"],
        businessPhones: ["+1-work"],
        mobilePhone: "+1-mobile",
      }),
    );

    expect(fields.phones).toEqual([
      { id: "AAMk-c1:phone:home:0", type: "home", value: "+1-home", primary: true },
      { id: "AAMk-c1:phone:work:0", type: "work", value: "+1-work", primary: false },
      { id: "AAMk-c1:phone:mobile", type: "mobile", value: "+1-mobile", primary: false },
    ]);
  });

  it('maps home/business/other addresses, business onto "work"', () => {
    const fields = graphContactToWritableFields(
      graphContact({
        homeAddress: { street: "1 Home St", city: "Springfield" },
        businessAddress: { street: "1 Work Ave", city: "Metropolis", state: "NY" },
      }),
    );

    expect(fields.addresses).toEqual([
      {
        id: "AAMk-c1:address:home",
        type: "home",
        primary: true,
        street: "1 Home St",
        city: "Springfield",
        region: undefined,
        postalCode: undefined,
        country: undefined,
      },
      {
        id: "AAMk-c1:address:work",
        type: "work",
        primary: false,
        street: "1 Work Ave",
        city: "Metropolis",
        region: "NY",
        postalCode: undefined,
        country: undefined,
      },
    ]);
  });

  it("holds one organisation from companyName/jobTitle/department, or none", () => {
    expect(
      graphContactToWritableFields(
        graphContact({ companyName: "Acme", jobTitle: "Engineer", department: "R&D" }),
      ).organizations,
    ).toEqual([{ id: "AAMk-c1:organization", name: "Acme", title: "Engineer", department: "R&D" }]);
    expect(graphContactToWritableFields(graphContact()).organizations).toEqual([]);
  });

  it('maps businessHomePage onto a single "work" website', () => {
    expect(
      graphContactToWritableFields(graphContact({ businessHomePage: "https://ada.example" }))
        .websites,
    ).toEqual([
      { id: "AAMk-c1:website:0", type: "work", value: "https://ada.example", primary: true },
    ]);
  });

  it("parses a full ISO birthday into month/day/year, always with a year", () => {
    expect(
      graphContactToWritableFields(graphContact({ birthday: "1990-06-15T00:00:00Z" })).birthday,
    ).toEqual({ month: 6, day: 15, year: 1990 });
    expect(graphContactToWritableFields(graphContact()).birthday).toBeNull();
  });

  it("produces byte-identical output across repeated calls (deterministic ids, no churn)", () => {
    const contact = graphContact({ givenName: "Ada", emailAddresses: [{ address: "a@b.com" }] });
    expect(graphContactToWritableFields(contact)).toEqual(graphContactToWritableFields(contact));
  });
});

describe("graphContactCategories", () => {
  it("passes through a string array untouched", () => {
    expect(graphContactCategories(graphContact({ categories: ["Blue Category", "VIP"] }))).toEqual([
      "Blue Category",
      "VIP",
    ]);
  });

  it("is empty when Graph reports none", () => {
    expect(graphContactCategories(graphContact())).toEqual([]);
  });
});

describe("contactWritableFieldsToGraphBody", () => {
  const EMPTY_FIELDS = {
    name: {},
    emails: [],
    phones: [],
    addresses: [],
    websites: [],
    organizations: [],
    birthday: null,
    notes: "",
    customFields: [],
  };

  it("builds home/business phones, mobilePhone, and drops fax/other (no Graph slot)", () => {
    const body = contactWritableFieldsToGraphBody({
      ...EMPTY_FIELDS,
      phones: [
        { id: "p1", type: "home", value: "+1-home", primary: true },
        { id: "p2", type: "work", value: "+1-work", primary: false },
        { id: "p3", type: "mobile", value: "+1-mobile", primary: false },
        { id: "p4", type: "fax", value: "+1-fax", primary: false },
      ],
    });
    expect(body.homePhones).toEqual(["+1-home"]);
    expect(body.businessPhones).toEqual(["+1-work"]);
    expect(body.mobilePhone).toBe("+1-mobile");
  });

  it('maps a "work" address onto businessAddress', () => {
    const body = contactWritableFieldsToGraphBody({
      ...EMPTY_FIELDS,
      addresses: [
        { id: "a1", type: "work", primary: true, street: "1 Work Ave", city: "Metropolis" },
      ],
    });
    expect(body.businessAddress).toEqual({
      street: "1 Work Ave",
      city: "Metropolis",
      state: undefined,
      postalCode: undefined,
      countryOrRegion: undefined,
    });
    expect(body.homeAddress).toBeNull();
  });

  it("builds companyName/jobTitle/department from the one organisation, clearing them when absent", () => {
    const withOrg = contactWritableFieldsToGraphBody({
      ...EMPTY_FIELDS,
      organizations: [{ id: "o1", name: "Acme", title: "Engineer" }],
    });
    expect(withOrg.companyName).toBe("Acme");
    expect(withOrg.jobTitle).toBe("Engineer");

    const withoutOrg = contactWritableFieldsToGraphBody(EMPTY_FIELDS);
    expect(withoutOrg.companyName).toBe("");
  });

  it("builds a UTC birthday timestamp, or null when absent", () => {
    const body = contactWritableFieldsToGraphBody({
      ...EMPTY_FIELDS,
      birthday: { month: 6, day: 15, year: 1990 },
    });
    expect(body.birthday).toBe(new Date(Date.UTC(1990, 5, 15)).toISOString());
    expect(contactWritableFieldsToGraphBody(EMPTY_FIELDS).birthday).toBeNull();
  });

  it("carries personalNotes straight through", () => {
    expect(
      contactWritableFieldsToGraphBody({ ...EMPTY_FIELDS, notes: "met at a conference" })
        .personalNotes,
    ).toBe("met at a conference");
  });
});
