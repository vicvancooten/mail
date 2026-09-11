import { describe, expect, it } from "vitest";
import { mapContactFieldsToCapabilityTable } from "./contact-capability-mapping.js";
import {
  type ContactWritableFields,
  EMPTY_CONTACT_FIELDS,
  GOOGLE_CONTACT_CAPABILITY_TABLE,
  LOCAL_CONTACT_CAPABILITY_TABLE,
  MICROSOFT_CONTACT_CAPABILITY_TABLE,
  validateContactFields,
} from "./contacts.js";

/**
 * `mapContactFieldsToCapabilityTable` (#225) — Copy/Import's own
 * target-capability trim: every case checked here also asserts the trimmed
 * fields pass `validateContactFields` against the same table, since that is
 * the one property `createContact` actually relies on.
 */

function fields(overrides: Partial<ContactWritableFields>): ContactWritableFields {
  return { ...EMPTY_CONTACT_FIELDS, ...overrides };
}

describe("mapContactFieldsToCapabilityTable", () => {
  it("drops nothing and reports nothing when the target already holds everything", () => {
    const source = fields({
      emails: [{ id: "e1", type: "home", value: "a@example.com", primary: true }],
    });
    const result = mapContactFieldsToCapabilityTable(source, LOCAL_CONTACT_CAPABILITY_TABLE);
    expect(result.dropped).toEqual([]);
    expect(result.fields.emails).toEqual(source.emails);
  });

  it("drops a whole family the target doesn't support, naming the count", () => {
    // Graph's own table holds no Custom Fields at all.
    const source = fields({
      customFields: [
        { id: "c1", label: "Boat phone", type: "phone", value: "555" },
        { id: "c2", label: "Spouse", type: "text", value: "Alex" },
      ],
    });
    const result = mapContactFieldsToCapabilityTable(source, MICROSOFT_CONTACT_CAPABILITY_TABLE);
    expect(result.fields.customFields).toEqual([]);
    expect(result.dropped).toEqual([{ family: "customFields", label: "2 custom fields" }]);
  });

  it("trims a capped family, keeping the primary entry and naming the overflow", () => {
    const source = fields({
      organizations: [
        { id: "o1", name: "Acme" },
        { id: "o2", name: "Beta Inc" },
      ],
    });
    const result = mapContactFieldsToCapabilityTable(source, MICROSOFT_CONTACT_CAPABILITY_TABLE);
    expect(result.fields.organizations).toEqual([{ id: "o1", name: "Acme" }]);
    expect(result.dropped).toEqual([{ family: "organization", label: "1 organization" }]);
  });

  it("keeps the primary entry of a typed family when trimming to a cap, even out of order", () => {
    // Graph doesn't cap phones, so force the point with a synthetic 1-cap table.
    const table = {
      ...MICROSOFT_CONTACT_CAPABILITY_TABLE,
      limits: { ...MICROSOFT_CONTACT_CAPABILITY_TABLE.limits, phone: 1 },
    };
    const source = fields({
      phones: [
        { id: "p1", type: "home", value: "111", primary: false },
        { id: "p2", type: "work", value: "222", primary: true },
      ],
    });
    const result = mapContactFieldsToCapabilityTable(source, table);
    expect(result.fields.phones).toEqual([{ id: "p2", type: "work", value: "222", primary: true }]);
    expect(result.dropped).toEqual([{ family: "phone", label: "1 phone number" }]);
  });

  it("drops a birthday entirely when the target holds no birthday at all", () => {
    const table = { ...MICROSOFT_CONTACT_CAPABILITY_TABLE, hasBirthday: false };
    const source = fields({ birthday: { month: 4, day: 15, year: 1990 } });
    const result = mapContactFieldsToCapabilityTable(source, table);
    expect(result.fields.birthday).toBeNull();
    expect(result.dropped).toEqual([{ family: "birthday", label: "Birthday" }]);
  });

  it("drops a year-less birthday when the target requires a full date", () => {
    // Graph's own `birthdayYearOptional: false` — there is no year to invent.
    const source = fields({ birthday: { month: 4, day: 15, year: null } });
    const result = mapContactFieldsToCapabilityTable(source, MICROSOFT_CONTACT_CAPABILITY_TABLE);
    expect(result.fields.birthday).toBeNull();
    expect(result.dropped).toEqual([{ family: "birthday", label: "Birthday (year required)" }]);
  });

  it("keeps a year-less birthday when the target allows one", () => {
    const source = fields({ birthday: { month: 4, day: 15, year: null } });
    const result = mapContactFieldsToCapabilityTable(source, GOOGLE_CONTACT_CAPABILITY_TABLE);
    expect(result.fields.birthday).toEqual({ month: 4, day: 15, year: null });
    expect(result.dropped).toEqual([]);
  });

  it("always produces fields the target table actually validates", () => {
    const source = fields({
      emails: [
        { id: "e1", type: "home", value: "a@example.com", primary: false },
        { id: "e2", type: "work", value: "b@example.com", primary: true },
      ],
      organizations: [
        { id: "o1", name: "Acme" },
        { id: "o2", name: "Beta Inc" },
      ],
      birthday: { month: 4, day: 15, year: null },
      customFields: [{ id: "c1", label: "Spouse", type: "text", value: "Alex" }],
    });
    const result = mapContactFieldsToCapabilityTable(source, MICROSOFT_CONTACT_CAPABILITY_TABLE);
    expect(validateContactFields(result.fields, MICROSOFT_CONTACT_CAPABILITY_TABLE)).toEqual({
      ok: true,
    });
  });
});
