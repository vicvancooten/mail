import type {
  ContactAddress,
  ContactBirthday,
  ContactEmail,
  ContactName,
  ContactOrganization,
  ContactPhone,
  ContactWebsite,
  ContactWritableFields,
} from "@mail/shared";
import { EMPTY_CONTACT_NAME } from "@mail/shared";
import type { GraphContact } from "./client.js";

/**
 * Graph ⇄ Wicket field mapping (#227) — the one place both sync directions
 * cross Graph's own shape: `graphContactToWritableFields`/
 * `graphContactCategories` pull a synced-down `GraphContact` into the
 * families `@mail/shared#ContactWritableFields` declares (the sync engine's
 * own read side), `contactWritableFieldsToGraphBody` pushes an edited
 * `ContactWritableFields` back the other way (the write path's own build
 * step, `contacts-sync.ts#drainMicrosoftContactWrites`). A field this
 * module doesn't touch (`assistantName`, `spouseName`, `children`, ...) is
 * never sent on a write — a `PATCH` with a field omitted leaves Graph's own
 * value alone, so nothing Wicket doesn't understand is ever clobbered.
 *
 * IDs are deterministic, derived from the Graph contact's own `id` plus the
 * family/slot, never freshly minted per sync round — Graph's own families
 * are mostly single values or arrays with no id of their own (unlike our
 * own repeatable-with-`id` shape), so a fresh `generateUlid()` on every
 * sync tick would make an unchanged upstream Contact look different every
 * round and needlessly bump its `syncRev`. Deterministic ids keep an
 * unchanged Contact's mapped rows byte-identical across rounds.
 */

interface GraphPhysicalAddress {
  street?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  countryOrRegion?: string;
}

interface GraphEmailAddress {
  name?: string;
  address?: string;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function graphName(contact: GraphContact): ContactName {
  const name: ContactName = {
    prefix: asString(contact.title),
    given: asString(contact.givenName),
    middle: asString(contact.middleName),
    family: asString(contact.surname),
    suffix: asString(contact.generation),
  };
  return Object.values(name).some((value) => value !== undefined) ? name : EMPTY_CONTACT_NAME;
}

function graphEmails(contact: GraphContact): ContactEmail[] {
  const entries = Array.isArray(contact.emailAddresses)
    ? (contact.emailAddresses as GraphEmailAddress[])
    : [];
  return entries
    .filter((entry): entry is GraphEmailAddress & { address: string } => Boolean(entry.address))
    .map((entry, index) => ({
      id: `${contact.id}:email:${index}`,
      // Graph's emailAddress carries no type of its own (unlike our fixed
      // home/work/other vocabulary) — "other" is the closest honest label,
      // never invented as "home"/"work".
      type: "other",
      value: entry.address,
      primary: index === 0,
    }));
}

/**
 * `homePhones`/`businessPhones` are arrays, `mobilePhone` a single string —
 * Graph has no slot for `fax`/`other` (our own fixed vocabulary's other two
 * phone types), so a phone the User adds under either label on a Graph
 * Contact has nowhere to land on `contactWritableFieldsToGraphBody`'s own
 * write and is dropped there, documented at that function instead (the
 * write path's own concern, not this read side's).
 */
function graphPhones(contact: GraphContact): ContactPhone[] {
  const home = Array.isArray(contact.homePhones) ? (contact.homePhones as string[]) : [];
  const business = Array.isArray(contact.businessPhones)
    ? (contact.businessPhones as string[])
    : [];
  const mobile = asString(contact.mobilePhone);
  const phones: ContactPhone[] = [];
  home.forEach((value, index) => {
    if (value)
      phones.push({ id: `${contact.id}:phone:home:${index}`, type: "home", value, primary: false });
  });
  business.forEach((value, index) => {
    if (value) {
      phones.push({ id: `${contact.id}:phone:work:${index}`, type: "work", value, primary: false });
    }
  });
  if (mobile)
    phones.push({
      id: `${contact.id}:phone:mobile`,
      type: "mobile",
      value: mobile,
      primary: false,
    });
  const first = phones[0];
  if (first && !phones.some((phone) => phone.primary)) first.primary = true;
  return phones;
}

const ADDRESS_SLOTS: readonly [keyof GraphContact, string][] = [
  ["homeAddress", "home"],
  ["businessAddress", "work"],
  ["otherAddress", "other"],
];

/** Graph's own fixed home/business/other triple (this ticket's own capability-table line) — `business` maps onto our `"work"` label so it lands as a standard address rather than a demoted Custom Field. */
function graphAddresses(contact: GraphContact): ContactAddress[] {
  const addresses: ContactAddress[] = [];
  for (const [field, type] of ADDRESS_SLOTS) {
    const raw = contact[field] as GraphPhysicalAddress | undefined;
    if (!raw || typeof raw !== "object") continue;
    const hasAnyPart = [raw.street, raw.city, raw.state, raw.postalCode, raw.countryOrRegion].some(
      (part) => Boolean(part && part.trim().length > 0),
    );
    if (!hasAnyPart) continue;
    addresses.push({
      id: `${contact.id}:address:${type}`,
      type,
      primary: addresses.length === 0,
      street: asString(raw.street),
      city: asString(raw.city),
      region: asString(raw.state),
      postalCode: asString(raw.postalCode),
      country: asString(raw.countryOrRegion),
    });
  }
  return addresses;
}

/** `companyName`/`jobTitle`/`department` — Graph's single organisation (this ticket's own capability-table line: `organization: 1`), never an array on Graph's side. */
function graphOrganizations(contact: GraphContact): ContactOrganization[] {
  const name = asString(contact.companyName);
  if (!name) return [];
  return [
    {
      id: `${contact.id}:organization`,
      name,
      title: asString(contact.jobTitle),
      department: asString(contact.department),
    },
  ];
}

/** `businessHomePage` — Graph's own single website field, mapped as a `"work"` website (`CONTACT_FIELD_TYPES.website` includes `"work"`); extra websites the User might add in the form have nowhere else to land on write, same limitation as `graphPhones`. */
function graphWebsites(contact: GraphContact): ContactWebsite[] {
  const page = asString(contact.businessHomePage);
  if (!page) return [];
  return [{ id: `${contact.id}:website:0`, type: "work", value: page, primary: true }];
}

/** Graph's `birthday` is always a full ISO 8601 date-time in UTC — never year-less (`MICROSOFT_CONTACT_CAPABILITY_TABLE.birthdayYearOptional: false`), unlike Local's/Google's own optional-year birthday. */
function graphBirthday(contact: GraphContact): ContactBirthday | null {
  const raw = asString(contact.birthday);
  if (!raw) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  return { month: date.getUTCMonth() + 1, day: date.getUTCDate(), year: date.getUTCFullYear() };
}

/** The sync engine's own read side (`contacts-sync.ts`) — a synced-down `GraphContact` projected into every family the edit form and card directory read, per this ticket's acceptance line ("the edit form ... offers no second organisation and no Custom Fields" implies the fields that *are* offered are real, not blank). `customFields` is always empty: Graph's own capability table forbids them entirely (`@mail/shared#MICROSOFT_CONTACT_CAPABILITY_TABLE`). */
export function graphContactToWritableFields(contact: GraphContact): ContactWritableFields {
  return {
    name: graphName(contact),
    emails: graphEmails(contact),
    phones: graphPhones(contact),
    addresses: graphAddresses(contact),
    websites: graphWebsites(contact),
    organizations: graphOrganizations(contact),
    birthday: graphBirthday(contact),
    notes: asString(contact.personalNotes) ?? "",
    customFields: [],
  };
}

/** Graph's own Outlook Categories (#227) — read-only, mirrored straight onto `Contact.categories` (`@mail/shared#contactSchema`'s own doc comment), never folded into `ContactWritableFields`. */
export function graphContactCategories(contact: GraphContact): string[] {
  return Array.isArray(contact.categories)
    ? contact.categories.filter((entry): entry is string => typeof entry === "string")
    : [];
}

const ADDRESS_TYPE_TO_GRAPH_FIELD: Record<string, keyof GraphContact | undefined> = {
  home: "homeAddress",
  work: "businessAddress",
  other: "otherAddress",
};

function graphAddressBody(address: ContactAddress | undefined): GraphPhysicalAddress | null {
  if (!address) return null;
  return {
    street: address.street,
    city: address.city,
    state: address.region,
    postalCode: address.postalCode,
    countryOrRegion: address.country,
  };
}

/**
 * The write path's own build step (`contacts-sync.ts#drainMicrosoftContactWrites`):
 * an edited `ContactWritableFields` back into a Graph contact `PATCH`/`POST`
 * body. Lossy in both directions this codebase never claims otherwise —
 * a phone labelled `fax`/`other`, a second website, or an address typed
 * outside home/business/other has no Graph field to land in and is
 * silently dropped from the outgoing body (this is the same "Graph's table
 * is deliberately the thinnest" trade-off the capability table itself
 * documents, just visible here at the one seam where a locally-typed value
 * meets Graph's own narrower shape). A family absent from `fields`
 * (empty array/`null`) clears its Graph field(s) explicitly (`null`/`""`)
 * rather than omitting them, since `updateContact`'s own whole-replace
 * semantics (`@mail/shared#contactWritableFieldsSchema`'s own doc comment)
 * mean an empty array here really does mean "the User cleared this".
 */
export function contactWritableFieldsToGraphBody(
  fields: ContactWritableFields,
): Record<string, unknown> {
  const home = fields.phones.filter((phone) => phone.type === "home").map((phone) => phone.value);
  const business = fields.phones
    .filter((phone) => phone.type === "work")
    .map((phone) => phone.value);
  const mobile = fields.phones.find((phone) => phone.type === "mobile")?.value ?? null;

  const organization = fields.organizations[0];
  const website = fields.websites[0];
  const addressBySlot = Object.fromEntries(
    fields.addresses.map((address) => [ADDRESS_TYPE_TO_GRAPH_FIELD[address.type], address]),
  ) as Partial<Record<keyof GraphContact, ContactAddress>>;

  return {
    title: fields.name.prefix ?? "",
    givenName: fields.name.given ?? "",
    middleName: fields.name.middle ?? "",
    surname: fields.name.family ?? "",
    generation: fields.name.suffix ?? "",
    emailAddresses: fields.emails.map((email) => ({ address: email.value })),
    homePhones: home,
    businessPhones: business,
    mobilePhone: mobile,
    homeAddress: graphAddressBody(addressBySlot.homeAddress),
    businessAddress: graphAddressBody(addressBySlot.businessAddress),
    otherAddress: graphAddressBody(addressBySlot.otherAddress),
    companyName: organization?.name ?? "",
    jobTitle: organization?.title ?? "",
    department: organization?.department ?? "",
    businessHomePage: website?.value ?? "",
    birthday: fields.birthday
      ? new Date(
          Date.UTC(fields.birthday.year ?? 1, fields.birthday.month - 1, fields.birthday.day),
        ).toISOString()
      : null,
    personalNotes: fields.notes,
  };
}
