import { describe, expect, it } from "vitest";
import { type ContactWritableFields, EMPTY_CONTACT_FIELDS } from "./contacts.js";
import { contactWritableFieldsToVCard, type ParsedVCard, parseVCards } from "./vcard.js";

/**
 * `vcard.ts` (#225): both directions checked against real-world vCard 3.0
 * and 4.0 shapes, plus the round trip export→import produces for the
 * fields this app itself can hold.
 */

/** `parseVCards` always returns an array — this asserts the single-card shape most of these tests expect, rather than an unchecked `[card] = ...` destructure. */
function parseOneVCard(text: string): ParsedVCard {
  const cards = parseVCards(text);
  expect(cards).toHaveLength(1);
  const [card] = cards;
  if (!card) throw new Error("unreachable — length asserted above");
  return card;
}

const VCARD_3_CARD = [
  "BEGIN:VCARD",
  "VERSION:3.0",
  "N:Doe;Jane;;Dr.;",
  "FN:Dr. Jane Doe",
  "EMAIL;TYPE=home:jane@example.com",
  "EMAIL;TYPE=work,pref:jane.doe@work.example.com",
  "TEL;TYPE=cell:+1 555 0100",
  "ADR;TYPE=home:;;123 Main St;Springfield;IL;62701;USA",
  "ORG:Acme Corp;Engineering",
  "TITLE:Senior Engineer",
  "BDAY:--04-15",
  "NOTE:Met at a conference",
  "END:VCARD",
].join("\r\n");

describe("parseVCards", () => {
  it("parses a vCard 3.0 card end to end", () => {
    const card = parseOneVCard(VCARD_3_CARD);
    expect(card.fields.name).toEqual({ family: "Doe", given: "Jane", prefix: "Dr." });
    expect(card.fields.emails).toEqual([
      { id: expect.any(String), type: "home", value: "jane@example.com", primary: false },
      {
        id: expect.any(String),
        type: "work",
        value: "jane.doe@work.example.com",
        primary: true,
      },
    ]);
    expect(card.fields.phones).toEqual([
      { id: expect.any(String), type: "mobile", value: "+1 555 0100", primary: true },
    ]);
    expect(card.fields.addresses).toEqual([
      {
        id: expect.any(String),
        type: "home",
        primary: true,
        street: "123 Main St",
        city: "Springfield",
        region: "IL",
        postalCode: "62701",
        country: "USA",
      },
    ]);
    expect(card.fields.organizations).toEqual([
      {
        id: expect.any(String),
        name: "Acme Corp",
        department: "Engineering",
        title: "Senior Engineer",
      },
    ]);
    expect(card.fields.birthday).toEqual({ month: 4, day: 15, year: null });
    expect(card.fields.notes).toBe("Met at a conference");
    expect(card.photo).toBeNull();
  });

  it("parses multiple cards from one file, in order", () => {
    const text = [
      "BEGIN:VCARD",
      "VERSION:4.0",
      "N:Alpha;A;;;",
      "END:VCARD",
      "BEGIN:VCARD",
      "VERSION:4.0",
      "N:Beta;B;;;",
      "END:VCARD",
    ].join("\n");
    const cards = parseVCards(text);
    expect(cards).toHaveLength(2);
    expect(cards.map((card) => card.fields.name.family)).toEqual(["Alpha", "Beta"]);
  });

  it("unfolds a continued line before parsing it", () => {
    const text = ["BEGIN:VCARD", "VERSION:4.0", "NOTE:one two\r\n  three", "END:VCARD"].join(
      "\r\n",
    );
    expect(parseOneVCard(text).fields.notes).toBe("one two three");
  });

  it("unescapes commas, semicolons and newlines in values", () => {
    const text = [
      "BEGIN:VCARD",
      "VERSION:4.0",
      "NOTE:Line one\\nLine two\\, with a comma\\; and a semicolon",
      "END:VCARD",
    ].join("\r\n");
    expect(parseOneVCard(text).fields.notes).toBe(
      "Line one\nLine two, with a comma; and a semicolon",
    );
  });

  it("falls back to FN when there is no N", () => {
    const text = ["BEGIN:VCARD", "VERSION:4.0", "FN:Jane Doe", "END:VCARD"].join("\r\n");
    expect(parseOneVCard(text).fields.name).toEqual({ given: "Jane", family: "Doe" });
  });

  it("demotes a non-standard TYPE to a Custom Field", () => {
    const text = ["BEGIN:VCARD", "VERSION:4.0", "TEL;TYPE=boat:+1 555 0199", "END:VCARD"].join(
      "\r\n",
    );
    const card = parseOneVCard(text);
    expect(card.fields.phones).toEqual([]);
    expect(card.fields.customFields).toEqual([
      { id: expect.any(String), label: "boat", type: "phone", value: "+1 555 0199" },
    ]);
  });

  it("imports an X- extension property as a text Custom Field", () => {
    const text = ["BEGIN:VCARD", "VERSION:4.0", "X-SKYPE:jane.doe", "END:VCARD"].join("\r\n");
    expect(parseOneVCard(text).fields.customFields).toEqual([
      { id: expect.any(String), label: "Skype", type: "text", value: "jane.doe" },
    ]);
  });

  it("parses a vCard 3.0 inline base64 photo", () => {
    const text = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQ",
      "END:VCARD",
    ].join("\r\n");
    expect(parseOneVCard(text).photo).toEqual({ mimeType: "image/jpeg", base64: "/9j/4AAQ" });
  });

  it("parses a vCard 4.0 data-URI photo", () => {
    const text = [
      "BEGIN:VCARD",
      "VERSION:4.0",
      "PHOTO:data:image/png;base64,iVBORw0KGgo",
      "END:VCARD",
    ].join("\r\n");
    expect(parseOneVCard(text).photo).toEqual({ mimeType: "image/png", base64: "iVBORw0KGgo" });
  });

  it("drops a PHOTO that names a remote URI rather than inline data", () => {
    const text = [
      "BEGIN:VCARD",
      "VERSION:4.0",
      "PHOTO:http://example.com/photo.jpg",
      "END:VCARD",
    ].join("\r\n");
    expect(parseOneVCard(text).photo).toBeNull();
  });

  it("ignores an unterminated card rather than throwing", () => {
    const text = ["BEGIN:VCARD", "VERSION:4.0", "N:Nobody;;;;"].join("\r\n");
    expect(parseVCards(text)).toEqual([]);
  });
});

describe("contactWritableFieldsToVCard", () => {
  it("round-trips name, a typed family and an address through parseVCards", () => {
    const fields: ContactWritableFields = {
      ...EMPTY_CONTACT_FIELDS,
      name: { given: "Jane", family: "Doe" },
      emails: [{ id: "e1", type: "home", value: "jane@example.com", primary: true }],
      addresses: [
        {
          id: "a1",
          type: "home",
          primary: true,
          street: "123 Main St",
          city: "Springfield",
          country: "USA",
        },
      ],
      birthday: { month: 4, day: 15, year: 1990 },
      notes: "Met at a conference, briefly; memorable",
    };
    const vcard = contactWritableFieldsToVCard(fields);
    expect(vcard).toContain("VERSION:4.0");

    const reparsed = parseOneVCard(vcard);
    expect(reparsed.fields.name).toEqual({ given: "Jane", family: "Doe" });
    expect(reparsed.fields.emails).toEqual([
      { id: expect.any(String), type: "home", value: "jane@example.com", primary: true },
    ]);
    expect(reparsed.fields.addresses).toEqual([
      {
        id: expect.any(String),
        type: "home",
        primary: true,
        street: "123 Main St",
        city: "Springfield",
        country: "USA",
      },
    ]);
    expect(reparsed.fields.birthday).toEqual({ month: 4, day: 15, year: 1990 });
    expect(reparsed.fields.notes).toBe("Met at a conference, briefly; memorable");
  });

  it("inlines a photo as a data URI that parseVCards reads back", () => {
    const vcard = contactWritableFieldsToVCard(EMPTY_CONTACT_FIELDS, {
      mimeType: "image/png",
      base64: "iVBORw0KGgo",
    });
    expect(parseOneVCard(vcard).photo).toEqual({ mimeType: "image/png", base64: "iVBORw0KGgo" });
  });

  it("falls back to a placeholder FN for a Contact with no name or organization", () => {
    const vcard = contactWritableFieldsToVCard(EMPTY_CONTACT_FIELDS);
    expect(vcard).toContain("FN:Unnamed contact");
  });
});
