import { describe, expect, it } from "vitest";
import { parseVcard, serializeVcard } from "./vcard.js";

const SAMPLE_VCARD = [
  "BEGIN:VCARD",
  "VERSION:3.0",
  "UID:abc-123",
  "FN:Ada Lovelace",
  "N:Lovelace;Ada;;;",
  "EMAIL;TYPE=home:ada@example.com",
  "TEL;TYPE=work,pref:+1 555 0100",
  "ADR;TYPE=home:;;12 Analytics Way;London;;SW1;UK",
  "ORG:Analytical Engines Ltd;Research",
  "TITLE:Mathematician",
  "BDAY:1815-12-10",
  "CATEGORIES:Friends,VIP",
  "NOTE:Met at the salon\\, lovely person",
  "GEO:51.5;-0.1",
  "X-ABLabel:Boat",
  "SOUND:some sound data",
  "END:VCARD",
].join("\r\n");

describe("parseVcard", () => {
  it("maps modelled properties into ContactWritableFields", () => {
    const result = parseVcard(SAMPLE_VCARD);
    expect(result.uid).toBe("abc-123");
    expect(result.fields.name).toEqual({ family: "Lovelace", given: "Ada" });
    expect(result.fields.emails).toEqual([
      { id: expect.any(String), type: "home", value: "ada@example.com", primary: false },
    ]);
    expect(result.fields.phones).toEqual([
      { id: expect.any(String), type: "work", value: "+1 555 0100", primary: true },
    ]);
    expect(result.fields.addresses[0]).toMatchObject({
      type: "home",
      street: "12 Analytics Way",
      city: "London",
      postalCode: "SW1",
      country: "UK",
    });
    expect(result.fields.organizations[0]).toMatchObject({
      name: "Analytical Engines Ltd",
      department: "Research",
      title: "Mathematician",
    });
    expect(result.fields.birthday).toEqual({ year: 1815, month: 12, day: 10 });
    expect(result.categories).toEqual(["Friends", "VIP"]);
    expect(result.fields.notes).toBe("Met at the salon, lovely person");
  });

  it("demotes a non-standard TYPE label to a Custom Field", () => {
    const raw = ["BEGIN:VCARD", "VERSION:3.0", "TEL;TYPE=x-boat:+1 555 0199", "END:VCARD"].join(
      "\r\n",
    );
    const result = parseVcard(raw);
    expect(result.fields.phones).toEqual([]);
    expect(result.fields.customFields).toEqual([
      { id: expect.any(String), label: "boat", type: "phone", value: "+1 555 0199" },
    ]);
  });

  it("reads the bundled Wicket custom-fields property", () => {
    const raw = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      'X-WICKET-CUSTOMFIELDS:[{"id"\\:"1"\\,"label"\\:"Anniversary"\\,"type"\\:"date"\\,"value"\\:"2020-01-01"}]',
      "END:VCARD",
    ].join("\r\n");
    // The property value itself must escape `,`/`;` per RFC 6350 §3.4 — build
    // it through JSON.stringify + the same escaping `serializeVcard` applies,
    // rather than hand-writing an already-escaped literal above twice over.
    const fields = { id: "1", label: "Anniversary", type: "date" as const, value: "2020-01-01" };
    const jsonEscaped = JSON.stringify([fields]).replace(/,/g, "\\,").replace(/;/g, "\\;");
    const built = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      `X-WICKET-CUSTOMFIELDS:${jsonEscaped}`,
      "END:VCARD",
    ].join("\r\n");
    const result = parseVcard(built);
    expect(result.fields.customFields).toEqual([fields]);
    void raw; // kept for readability of the escaped-shape example above
  });

  it("decodes an embedded base64 PHOTO and ignores a URI-referenced one", () => {
    const embedded = parseVcard(
      ["BEGIN:VCARD", "VERSION:3.0", "PHOTO;ENCODING=b;TYPE=JPEG:aGVsbG8=", "END:VCARD"].join(
        "\r\n",
      ),
    );
    expect(embedded.photo).toEqual({ mimeType: "image/jpeg", bytes: Buffer.from("hello") });

    const referenced = parseVcard(
      ["BEGIN:VCARD", "VERSION:3.0", "PHOTO;VALUE=uri:https://example.com/a.jpg", "END:VCARD"].join(
        "\r\n",
      ),
    );
    expect(referenced.photo).toBeNull();
  });

  it("parses a year-less vCard 4 BDAY", () => {
    const result = parseVcard(
      ["BEGIN:VCARD", "VERSION:4.0", "BDAY:--12-10", "END:VCARD"].join("\r\n"),
    );
    expect(result.fields.birthday).toEqual({ year: null, month: 12, day: 10 });
  });
});

describe("serializeVcard", () => {
  it("preserves unmodelled lines (GEO, X-ABLabel, SOUND) verbatim across an edit", () => {
    const parsed = parseVcard(SAMPLE_VCARD);
    const result = serializeVcard({
      previousRawVcard: SAMPLE_VCARD,
      fields: { ...parsed.fields, notes: "Updated note" },
      categories: parsed.categories,
      uid: parsed.uid ?? "fallback-uid",
    });
    expect(result).toContain("GEO:51.5;-0.1");
    expect(result).toContain("X-ABLabel:Boat");
    expect(result).toContain("SOUND:some sound data");
    expect(result).toContain("NOTE:Updated note");
    expect(result).not.toContain("Met at the salon");
    // The original UID survives rather than a freshly minted one.
    expect(result).toContain("UID:abc-123");
  });

  it("mints a fresh UID and VERSION:3.0 for a brand-new vCard", () => {
    const result = serializeVcard({
      previousRawVcard: null,
      fields: {
        name: { given: "New", family: "Person" },
        emails: [],
        phones: [],
        addresses: [],
        websites: [],
        organizations: [],
        birthday: null,
        notes: "",
        customFields: [],
      },
      categories: [],
      uid: "fresh-uid",
    });
    expect(result).toContain("VERSION:3.0");
    expect(result).toContain("UID:fresh-uid");
    expect(result).toContain("FN:New Person");
  });

  it("round-trips a phone Custom Field through TYPE=x-<label>", () => {
    const result = serializeVcard({
      previousRawVcard: null,
      fields: {
        name: {},
        emails: [],
        phones: [],
        addresses: [],
        websites: [],
        organizations: [],
        birthday: null,
        notes: "",
        customFields: [{ id: "1", label: "Boat", type: "phone", value: "+1 555 0199" }],
      },
      categories: [],
      uid: "uid-1",
    });
    expect(result).toContain("TEL;TYPE=x-Boat:+1 555 0199");

    // vCard TYPE parameter values are case-insensitive tokens (RFC 6350
    // §5.6) — a full round trip through the wire normalizes the label to
    // lowercase the same way any real CardDAV server would, so this is the
    // one place a Custom Field's exact casing isn't preserved.
    const reparsed = parseVcard(result);
    expect(reparsed.fields.customFields).toEqual([
      { id: expect.any(String), label: "boat", type: "phone", value: "+1 555 0199" },
    ]);
  });

  it("bundles a text Custom Field into X-WICKET-CUSTOMFIELDS and round-trips it", () => {
    const customFields = [
      { id: "1", label: "Favourite food", type: "text" as const, value: "Tacos" },
    ];
    const result = serializeVcard({
      previousRawVcard: null,
      fields: {
        name: {},
        emails: [],
        phones: [],
        addresses: [],
        websites: [],
        organizations: [],
        birthday: null,
        notes: "",
        customFields,
      },
      categories: [],
      uid: "uid-2",
    });
    const reparsed = parseVcard(result);
    expect(reparsed.fields.customFields).toEqual(customFields);
  });

  it("folds a line longer than 75 octets and unfolds it back on reparse", () => {
    const longNote = "x".repeat(200);
    const result = serializeVcard({
      previousRawVcard: null,
      fields: { ...emptyFields(), notes: longNote },
      categories: [],
      uid: "uid-3",
    });
    expect(result.split("\r\n").some((line) => Buffer.from(line, "utf8").length > 75)).toBe(false);
    expect(parseVcard(result).fields.notes).toBe(longNote);
  });
});

function emptyFields() {
  return {
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
}
