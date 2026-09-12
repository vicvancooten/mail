import {
  CLOSED_CONTACT_CAPABILITY_TABLE,
  LOCAL_CONTACT_CAPABILITY_TABLE,
  MICROSOFT_CONTACT_CAPABILITY_TABLE,
} from "@mail/shared";
import { describe, expect, it } from "vitest";
import { makeContact } from "../test-support/mail-fixtures.js";
import {
  buildContactWritableFields,
  contactFormVisibility,
  contactToFormState,
  EMPTY_CONTACT_FORM_STATE,
} from "./contact-form.js";

describe("contactToFormState", () => {
  it("projects every family straight off the Contact", () => {
    const contact = makeContact("c1", "book-1", { notes: "hi", name: { given: "Ada" } });

    expect(contactToFormState(contact)).toEqual({
      name: { given: "Ada" },
      emails: [],
      phones: [],
      websites: [],
      addresses: [],
      organizations: [],
      birthday: null,
      notes: "hi",
      customFields: [],
    });
  });
});

describe("contactFormVisibility", () => {
  it("shows every family for Local's full-set table", () => {
    expect(contactFormVisibility(LOCAL_CONTACT_CAPABILITY_TABLE)).toEqual({
      emails: true,
      phones: true,
      addresses: true,
      websites: true,
      organizations: true,
      birthday: true,
      customFields: true,
      organizationsLimit: undefined,
    });
  });

  it("hides everything for a closed table (this ticket's own acceptance line: absent, not greyed)", () => {
    expect(contactFormVisibility(CLOSED_CONTACT_CAPABILITY_TABLE)).toEqual({
      emails: false,
      phones: false,
      addresses: false,
      websites: false,
      organizations: false,
      birthday: false,
      customFields: false,
      organizationsLimit: undefined,
    });
  });

  it("caps organizationsLimit at 1 for Graph's own table (#227), offering no second organisation", () => {
    expect(contactFormVisibility(MICROSOFT_CONTACT_CAPABILITY_TABLE)).toMatchObject({
      organizations: true,
      organizationsLimit: 1,
      customFields: false,
    });
  });
});

describe("buildContactWritableFields", () => {
  it("keeps standard-labelled entries in their own family", () => {
    const form = {
      ...EMPTY_CONTACT_FORM_STATE,
      emails: [{ id: "e1", type: "home", value: "a@example.com", primary: true }],
    };

    const fields = buildContactWritableFields(form);

    expect(fields.emails).toEqual([
      { id: "e1", type: "home", value: "a@example.com", primary: true },
    ]);
    expect(fields.customFields).toEqual([]);
  });

  it("keeps a Custom-labelled email as an email instead of demoting it (#283)", () => {
    const form = {
      ...EMPTY_CONTACT_FORM_STATE,
      emails: [{ id: "e1", type: "School", value: "kid@school.example", primary: true }],
    };

    const fields = buildContactWritableFields(form);

    expect(fields.emails).toEqual([
      { id: "e1", type: "School", value: "kid@school.example", primary: true },
    ]);
    expect(fields.customFields).toEqual([]);
  });

  it('defaults a blank email label to "home" instead of demoting it (#283)', () => {
    const form = {
      ...EMPTY_CONTACT_FORM_STATE,
      emails: [{ id: "e1", type: "", value: "kid@school.example", primary: true }],
    };

    const fields = buildContactWritableFields(form);

    expect(fields.emails).toEqual([
      { id: "e1", type: "home", value: "kid@school.example", primary: true },
    ]);
    expect(fields.customFields).toEqual([]);
  });

  it("demotes a Custom-labelled phone into customFields (ADR-0026)", () => {
    const form = {
      ...EMPTY_CONTACT_FORM_STATE,
      phones: [{ id: "p1", type: "Boat", value: "+1555", primary: false }],
    };

    const fields = buildContactWritableFields(form);

    expect(fields.phones).toEqual([]);
    expect(fields.customFields).toEqual([
      { id: "p1", label: "Boat", type: "phone", value: "+1555" },
    ]);
  });

  it("demotes a Custom-labelled address into a joined location Custom Field", () => {
    const form = {
      ...EMPTY_CONTACT_FORM_STATE,
      addresses: [
        { id: "a1", type: "Cabin", primary: false, street: "1 Main St", city: "Springfield" },
      ],
    };

    const fields = buildContactWritableFields(form);

    expect(fields.addresses).toEqual([]);
    expect(fields.customFields).toEqual([
      { id: "a1", label: "Cabin", type: "location", value: "1 Main St, Springfield" },
    ]);
  });

  it("carries organizations, birthday, notes and explicit customFields straight through", () => {
    const form = {
      ...EMPTY_CONTACT_FORM_STATE,
      organizations: [{ id: "o1", name: "Acme" }],
      birthday: { month: 1, day: 2, year: null },
      notes: "met at a conference",
      customFields: [
        { id: "c1", label: "Anniversary", type: "date" as const, value: "2020-01-01" },
      ],
    };

    const fields = buildContactWritableFields(form);

    expect(fields.organizations).toEqual([{ id: "o1", name: "Acme" }]);
    expect(fields.birthday).toEqual({ month: 1, day: 2, year: null });
    expect(fields.notes).toBe("met at a conference");
    expect(fields.customFields).toEqual([
      { id: "c1", label: "Anniversary", type: "date", value: "2020-01-01" },
    ]);
  });
});
