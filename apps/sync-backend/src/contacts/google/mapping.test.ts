import { describe, expect, it } from "vitest";
import {
  buildGooglePersonPatch,
  GOOGLE_PERSON_WRITE_FIELDS,
  googlePersonToContactFields,
} from "./mapping.js";

/**
 * `mapping.ts` (#216): the projection (read) and field-masked patch builder
 * (write) both directions of Google's Person resource ⇄
 * `ContactWritableFields` — this ticket's own acceptance lines "field-masked
 * to exactly the modelled families, so unmodelled properties survive" and
 * the read-side gap `contacts/store.ts#upsertGoogleContact`'s own doc
 * comment names.
 */

describe("googlePersonToContactFields", () => {
  it("projects an empty ContactWritableFields off a Person with no family present", () => {
    expect(googlePersonToContactFields({ resourceName: "people/c1", etag: "e1" })).toEqual({
      name: {},
      emails: [],
      phones: [],
      addresses: [],
      websites: [],
      organizations: [],
      birthday: null,
      notes: "",
      customFields: [],
    });
  });

  it("projects the singleton names[0], never a second entry", () => {
    const fields = googlePersonToContactFields({
      names: [
        { givenName: "Ada", familyName: "Lovelace", honorificPrefix: "Countess" },
        { givenName: "Second" },
      ],
    });
    expect(fields.name).toEqual({
      prefix: "Countess",
      given: "Ada",
      middle: undefined,
      family: "Lovelace",
      suffix: undefined,
    });
  });

  it("projects emails with a synthetic per-entry id and metadata.primary", () => {
    const fields = googlePersonToContactFields({
      emailAddresses: [
        { value: "ada@example.com", type: "home", metadata: { primary: true } },
        { value: "work@example.com", type: "work" },
      ],
    });
    expect(fields.emails).toEqual([
      { id: "g:emailAddresses:0", type: "home", value: "ada@example.com", primary: true },
      { id: "g:emailAddresses:1", type: "work", value: "work@example.com", primary: false },
    ]);
  });

  it('keeps a Google email with an arbitrary type, and defaults a type-less one to "home" (#283)', () => {
    const fields = googlePersonToContactFields({
      emailAddresses: [
        { value: "kid@school.example", type: "school" },
        { value: "solo@example.com" },
      ],
    });
    expect(fields.emails).toEqual([
      { id: "g:emailAddresses:0", type: "school", value: "kid@school.example", primary: false },
      { id: "g:emailAddresses:1", type: "home", value: "solo@example.com", primary: false },
    ]);
  });

  it("projects an address's modelled sub-fields only, dropping poBox/countryCode from the returned shape", () => {
    const fields = googlePersonToContactFields({
      addresses: [
        {
          type: "home",
          streetAddress: "1 Main St",
          city: "London",
          region: "Greater London",
          postalCode: "SW1A 1AA",
          country: "UK",
          poBox: "PO 99",
          countryCode: "GB",
        },
      ],
    });
    expect(fields.addresses).toEqual([
      {
        id: "g:addresses:0",
        type: "home",
        primary: false,
        street: "1 Main St",
        city: "London",
        region: "Greater London",
        postalCode: "SW1A 1AA",
        country: "UK",
      },
    ]);
  });

  it("projects a birthday's year as null when Google omits it", () => {
    expect(
      googlePersonToContactFields({ birthdays: [{ date: { month: 4, day: 15 } }] }).birthday,
    ).toEqual({ month: 4, day: 15, year: null });
    expect(
      googlePersonToContactFields({ birthdays: [{ date: { month: 4, day: 15, year: 1990 } }] })
        .birthday,
    ).toEqual({ month: 4, day: 15, year: 1990 });
  });

  it('projects userDefined as Custom Fields, always type "text" — Google carries no type of its own', () => {
    const fields = googlePersonToContactFields({
      userDefined: [{ key: "Boat phone", value: "+1 555 0100" }],
    });
    expect(fields.customFields).toEqual([
      { id: "g:userDefined:0", label: "Boat phone", type: "text", value: "+1 555 0100" },
    ]);
  });
});

describe("buildGooglePersonPatch", () => {
  const baseArgs = {
    resourceName: "people/c1",
    etag: "etag-2",
  };

  it("always uses the fixed field mask, regardless of which families are populated", () => {
    const patch = buildGooglePersonPatch({
      ...baseArgs,
      fields: {
        name: {},
        emails: [],
        phones: [],
        addresses: [],
        websites: [],
        organizations: [],
        birthday: null,
        notes: "",
        customFields: [],
      },
      priorPayload: {},
    });
    expect(patch.updatePersonFields).toBe(GOOGLE_PERSON_WRITE_FIELDS);
  });

  it("carries the resourceName and current etag on the body, for Google's own optimistic-concurrency check", () => {
    const patch = buildGooglePersonPatch({
      ...baseArgs,
      fields: googlePersonToContactFields({}),
      priorPayload: {},
    });
    expect(patch.body.resourceName).toBe("people/c1");
    expect(patch.body.etag).toBe("etag-2");
  });

  it("never mentions a family it doesn't model — an unmodelled family can never be touched by a write", () => {
    const patch = buildGooglePersonPatch({
      ...baseArgs,
      fields: googlePersonToContactFields({}),
      priorPayload: { relations: [{ person: "spouse", type: "spouse" }] },
    });
    expect(patch.body).not.toHaveProperty("relations");
    expect(patch.body).not.toHaveProperty("memberships");
    expect(patch.body).not.toHaveProperty("photos");
  });

  it("preserves an untouched address's own unmodelled sub-fields (poBox) across a write that only changes another entry's field", () => {
    const priorPayload = {
      addresses: [
        {
          type: "home",
          streetAddress: "1 Main St",
          city: "London",
          poBox: "PO 99",
          countryCode: "GB",
        },
      ],
    };
    const projected = googlePersonToContactFields(priorPayload);
    const edited = {
      ...projected,
      addresses: projected.addresses.map((address) => ({ ...address, city: "Westminster" })),
    };

    const patch = buildGooglePersonPatch({ ...baseArgs, fields: edited, priorPayload });

    expect(patch.body.addresses).toEqual([
      {
        type: "home",
        streetAddress: "1 Main St",
        city: "Westminster",
        poBox: "PO 99",
        countryCode: "GB",
        metadata: { primary: false },
      },
    ]);
  });

  it("gives a brand-new entry (no synthetic id match) no leftover raw sub-fields", () => {
    const priorPayload = { addresses: [{ type: "home", street: "old", poBox: "PO 1" }] };
    const edited = googlePersonToContactFields({});
    edited.addresses = [
      { id: "01FRESHULID", type: "work", primary: false, street: "2 New Rd", city: "Leeds" },
    ];

    const patch = buildGooglePersonPatch({ ...baseArgs, fields: edited, priorPayload });

    expect(patch.body.addresses).toEqual([
      {
        type: "work",
        metadata: { primary: false },
        streetAddress: "2 New Rd",
        city: "Leeds",
        region: undefined,
        postalCode: undefined,
        country: undefined,
      },
    ]);
  });

  it("clears biographies when notes is blank, and sets it (preserving contentType) when notes is set", () => {
    const cleared = buildGooglePersonPatch({
      ...baseArgs,
      fields: { ...googlePersonToContactFields({}), notes: "" },
      priorPayload: { biographies: [{ value: "old note", contentType: "TEXT_PLAIN" }] },
    });
    expect(cleared.body.biographies).toEqual([]);

    const set = buildGooglePersonPatch({
      ...baseArgs,
      fields: { ...googlePersonToContactFields({}), notes: "new note" },
      priorPayload: { biographies: [{ contentType: "TEXT_HTML" }] },
    });
    expect(set.body.biographies).toEqual([{ contentType: "TEXT_HTML", value: "new note" }]);
  });

  it("omits the year on a birthday write when the Wicket field carries none", () => {
    const patch = buildGooglePersonPatch({
      ...baseArgs,
      fields: { ...googlePersonToContactFields({}), birthday: { month: 4, day: 15, year: null } },
      priorPayload: {},
    });
    expect(patch.body.birthdays).toEqual([{ date: { month: 4, day: 15 } }]);
  });

  it("writes a Custom Field back onto userDefined as {key, value}, dropping its type (the documented lossy corner)", () => {
    const patch = buildGooglePersonPatch({
      ...baseArgs,
      fields: {
        ...googlePersonToContactFields({}),
        customFields: [{ id: "01FRESHULID", label: "Boat phone", type: "phone", value: "+1 555" }],
      },
      priorPayload: {},
    });
    expect(patch.body.userDefined).toEqual([{ key: "Boat phone", value: "+1 555" }]);
  });
});
