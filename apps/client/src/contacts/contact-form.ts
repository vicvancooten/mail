import type {
  Contact,
  ContactAddress,
  ContactBirthday,
  ContactCapabilityTable,
  ContactEmail,
  ContactName,
  ContactOrganization,
  ContactPhone,
  ContactTypedFieldInput,
  ContactWebsite,
  ContactWritableFields,
  CustomField,
} from "@mail/shared";
import {
  contactFieldFamilyIsSupported,
  contactFieldFamilyLimit,
  demoteContactAddress,
  EMPTY_CONTACT_NAME,
  splitTypedContactFields,
} from "@mail/shared";

/**
 * `ContactDialog`'s own in-progress state (#210) — one field per family,
 * shaped close to `ContactWritableFields` but keeping every typed family
 * (`email`/`phone`/`website`) as the row shape the form actually edits
 * (`type` free text, not yet sorted into "standard" vs "Custom Field") —
 * that sort only happens once, at Save (`buildContactWritableFields`), the
 * same way `splitTypedContactFields`/`demoteContactAddress`
 * (`@mail/shared#contacts.ts`) are meant to be called.
 */
export interface ContactFormState {
  name: ContactName;
  emails: ContactEmail[];
  phones: ContactPhone[];
  websites: ContactWebsite[];
  addresses: ContactAddress[];
  organizations: ContactOrganization[];
  birthday: ContactBirthday | null;
  notes: string;
  customFields: CustomField[];
}

export const EMPTY_CONTACT_FORM_STATE: ContactFormState = {
  name: EMPTY_CONTACT_NAME,
  emails: [],
  phones: [],
  websites: [],
  addresses: [],
  organizations: [],
  birthday: null,
  notes: "",
  customFields: [],
};

/** An existing Contact's fields, as the form edits them — every family already matches the form's own row shape, so this is a plain projection. */
export function contactToFormState(contact: Contact): ContactFormState {
  return {
    name: contact.name,
    emails: contact.emails,
    phones: contact.phones,
    websites: contact.websites,
    addresses: contact.addresses,
    organizations: contact.organizations,
    birthday: contact.birthday,
    notes: contact.notes,
    customFields: contact.customFields,
  };
}

/**
 * Which sections the edit form shows for a given Address Book's capability
 * table (this ticket's own acceptance line: "one declaration read by both
 * the edit form and the write path... a field the table omits is absent
 * from the form, not greyed"). `name` and `notes` are not gated — every
 * Origin ADR-0026 describes holds a name and free-text notes; the
 * capability table only ever varies the repeatable families, birthday and
 * Custom Fields.
 */
export interface ContactFormVisibility {
  emails: boolean;
  phones: boolean;
  addresses: boolean;
  websites: boolean;
  organizations: boolean;
  birthday: boolean;
  customFields: boolean;
  /**
   * How many Organizations this Origin's table allows (#227's Graph table:
   * `1`) — `undefined` for every Origin that leaves it unbounded (Local,
   * Google). `OrganizationSection`'s own "Add organization" button reads
   * this against its current row count so a Graph Contact's edit form
   * "offers no second organisation" (this ticket's acceptance line) by
   * disabling Add at the cap, rather than accepting a second row Save would
   * only reject.
   */
  organizationsLimit: number | undefined;
}

export function contactFormVisibility(table: ContactCapabilityTable): ContactFormVisibility {
  return {
    emails: contactFieldFamilyIsSupported(table, "email"),
    phones: contactFieldFamilyIsSupported(table, "phone"),
    addresses: contactFieldFamilyIsSupported(table, "address"),
    websites: contactFieldFamilyIsSupported(table, "website"),
    organizations: contactFieldFamilyIsSupported(table, "organization"),
    birthday: table.hasBirthday,
    customFields: table.customFields,
    organizationsLimit: contactFieldFamilyIsSupported(table, "organization")
      ? contactFieldFamilyLimit(table, "organization")
      : undefined,
  };
}

/**
 * The union of several records' visibilities (#222) — a linked card's own
 * Details view shows every family *any* of its records can hold, since the
 * union is one person's fields drawn from records of different Origins
 * (ADR-0026). Edit mode never uses this: an edit always targets exactly one
 * record and so draws on that record's Origin alone, which is what keeps "a
 * Graph Contact never offers a second organisation" true on a linked card
 * too.
 */
export function mergeContactFormVisibility(
  visibilities: readonly ContactFormVisibility[],
): ContactFormVisibility {
  return {
    emails: visibilities.some((entry) => entry.emails),
    phones: visibilities.some((entry) => entry.phones),
    addresses: visibilities.some((entry) => entry.addresses),
    websites: visibilities.some((entry) => entry.websites),
    organizations: visibilities.some((entry) => entry.organizations),
    birthday: visibilities.some((entry) => entry.birthday),
    customFields: visibilities.some((entry) => entry.customFields),
    // Unused by Details (#222's own doc comment on this function: edit mode
    // never draws on the merged visibility, only Details does, and Details
    // renders every organisation it's handed rather than capping the row
    // count) — the most restrictive of any member's own limit (#227),
    // `undefined` when none of them cap it at all.
    organizationsLimit: visibilities.reduce<number | undefined>(
      (min, entry) =>
        entry.organizationsLimit === undefined
          ? min
          : min === undefined
            ? entry.organizationsLimit
            : Math.min(min, entry.organizationsLimit),
      undefined,
    ),
  };
}

function toTypedInput(entry: {
  id: string;
  type: string;
  value: string;
  primary: boolean;
}): ContactTypedFieldInput {
  return { id: entry.id, label: entry.type, value: entry.value, primary: entry.primary };
}

/**
 * The form's own Save step: sorts every typed-family row into its standard
 * family or a demoted Custom Field (ADR-0026: "a standard-family value
 * whose label falls outside the fixed vocabulary becomes a Custom Field of
 * that type") and assembles the whole `ContactWritableFields`
 * `updateContact`/`createContact` carry.
 */
export function buildContactWritableFields(form: ContactFormState): ContactWritableFields {
  const emailSplit = splitTypedContactFields("email", form.emails.map(toTypedInput));
  const phoneSplit = splitTypedContactFields("phone", form.phones.map(toTypedInput));
  const websiteSplit = splitTypedContactFields("website", form.websites.map(toTypedInput));
  const addressResults = form.addresses.map((address) => demoteContactAddress(address));

  return {
    name: form.name,
    emails: emailSplit.standard as ContactEmail[],
    phones: phoneSplit.standard as ContactPhone[],
    websites: websiteSplit.standard as ContactWebsite[],
    addresses: addressResults
      .map((result) => result.standard)
      .filter((address): address is ContactAddress => address !== null),
    organizations: form.organizations,
    birthday: form.birthday,
    notes: form.notes,
    customFields: [
      ...emailSplit.custom,
      ...phoneSplit.custom,
      ...websiteSplit.custom,
      ...addressResults
        .map((result) => result.custom)
        .filter((field): field is CustomField => field !== null),
      ...form.customFields,
    ],
  };
}
