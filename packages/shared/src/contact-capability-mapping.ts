import type {
  ContactAddress,
  ContactCapabilityTable,
  ContactEmail,
  ContactFieldFamily,
  ContactOrganization,
  ContactPhone,
  ContactWebsite,
  ContactWritableFields,
} from "./contacts.js";
import { contactFieldFamilyIsSupported, contactFieldFamilyLimit } from "./contacts.js";

/**
 * Copy and Import's own target-capability mapping (#225, ADR-0026: "fields
 * mapped to the target Origin's capability table with unmappable ones
 * dropped and named in the sheet before the User confirms"). A pure
 * function over an already-valid `ContactWritableFields` and the target
 * Address Book's own `ContactCapabilityTable` — `contact-merge.ts`'s own
 * `normalizeFamily` does the same per-family trim for a Merge's *unioned*
 * fields; this is its single-source sibling, extended to name what it
 * dropped rather than silently discard it, since a Merge never asks a
 * User to confirm anything a Copy or an Import both must.
 *
 * The trimmed fields are always valid against `table`
 * (`validateContactFields` would accept them outright) — this is what lets
 * `createContact` (`sync/mutations.ts`) apply them without a second,
 * possibly-disagreeing trim of its own.
 */

export interface ContactFieldDrop {
  family: ContactFieldFamily | "birthday" | "customFields";
  /** A human-readable summary of what this drop cost — "2 phone numbers", "Birthday", "Custom fields" — the sheet's own list item text. */
  label: string;
}

export interface ContactFieldMappingResult {
  fields: ContactWritableFields;
  /** Empty when the target table already holds everything `fields` did. */
  dropped: ContactFieldDrop[];
}

const FAMILY_NAMES: Record<
  Exclude<ContactFieldFamily, "organization">,
  { one: string; many: string }
> = {
  email: { one: "email address", many: "email addresses" },
  phone: { one: "phone number", many: "phone numbers" },
  address: { one: "address", many: "addresses" },
  website: { one: "website", many: "websites" },
};

function pluralize(count: number, names: { one: string; many: string }): string {
  return `${count} ${count === 1 ? names.one : names.many}`;
}

function trimTypedFamily<Value extends { primary: boolean }>(
  entries: readonly Value[],
  table: ContactCapabilityTable,
  family: Exclude<ContactFieldFamily, "organization">,
): { entries: Value[]; dropped: ContactFieldDrop | null } {
  if (entries.length === 0) return { entries: [], dropped: null };
  if (!contactFieldFamilyIsSupported(table, family)) {
    return {
      entries: [],
      dropped: { family, label: pluralize(entries.length, FAMILY_NAMES[family]) },
    };
  }
  const limit = contactFieldFamilyLimit(table, family);
  if (limit === undefined || entries.length <= limit) {
    return { entries: [...entries], dropped: null };
  }
  // The primary entry survives the trim first (if there is one), then
  // whichever others come first — the same "the one entry a User singled
  // out never gets to be the one that silently disappears" reasoning
  // `contact-merge.ts#normalizeFamily` already applies to a Merge's own cap.
  const primaryIndex = entries.findIndex((entry) => entry.primary);
  const ordered =
    primaryIndex <= 0
      ? entries
      : [entries[primaryIndex], ...entries.filter((_, index) => index !== primaryIndex)];
  const kept = ordered.slice(0, limit);
  return {
    entries: kept as Value[],
    dropped: { family, label: pluralize(entries.length - kept.length, FAMILY_NAMES[family]) },
  };
}

function trimOrganizations(
  entries: readonly ContactOrganization[],
  table: ContactCapabilityTable,
): { entries: ContactOrganization[]; dropped: ContactFieldDrop | null } {
  if (entries.length === 0) return { entries: [], dropped: null };
  if (!contactFieldFamilyIsSupported(table, "organization")) {
    return {
      entries: [],
      dropped: {
        family: "organization",
        label: pluralize(entries.length, { one: "organization", many: "organizations" }),
      },
    };
  }
  const limit = contactFieldFamilyLimit(table, "organization");
  if (limit === undefined || entries.length <= limit)
    return { entries: [...entries], dropped: null };
  return {
    entries: entries.slice(0, limit),
    dropped: {
      family: "organization",
      label: pluralize(entries.length - limit, { one: "organization", many: "organizations" }),
    },
  };
}

/**
 * Trims `fields` to whatever `table` can actually hold, naming every family
 * that lost something along the way (empty when nothing did) — the sheet's
 * own preview, and the fields `createContact` actually writes once the User
 * confirms.
 */
export function mapContactFieldsToCapabilityTable(
  fields: ContactWritableFields,
  table: ContactCapabilityTable,
): ContactFieldMappingResult {
  const dropped: ContactFieldDrop[] = [];

  const emails = trimTypedFamily<ContactEmail>(fields.emails, table, "email");
  const phones = trimTypedFamily<ContactPhone>(fields.phones, table, "phone");
  const websites = trimTypedFamily<ContactWebsite>(fields.websites, table, "website");
  const addresses = trimTypedFamily<ContactAddress>(fields.addresses, table, "address");
  const organizations = trimOrganizations(fields.organizations, table);
  for (const result of [emails, phones, websites, addresses, organizations]) {
    if (result.dropped) dropped.push(result.dropped);
  }

  let birthday = fields.birthday;
  if (birthday !== null) {
    if (!table.hasBirthday) {
      dropped.push({ family: "birthday", label: "Birthday" });
      birthday = null;
    } else if (birthday.year === null && !table.birthdayYearOptional) {
      // The target Origin always requires a full date (Graph's own
      // `birthdayYearOptional: false`) — there is no year to fabricate, so
      // the whole birthday drops rather than just its year.
      dropped.push({ family: "birthday", label: "Birthday (year required)" });
      birthday = null;
    }
  }

  let customFields = fields.customFields;
  if (customFields.length > 0 && !table.customFields) {
    dropped.push({
      family: "customFields",
      label: pluralize(customFields.length, { one: "custom field", many: "custom fields" }),
    });
    customFields = [];
  }

  return {
    fields: {
      name: fields.name,
      emails: emails.entries,
      phones: phones.entries,
      websites: websites.entries,
      addresses: addresses.entries,
      organizations: organizations.entries,
      birthday,
      notes: fields.notes,
      customFields,
    },
    dropped,
  };
}
