import type {
  ContactAddress,
  ContactBirthday,
  ContactEmail,
  ContactName,
  ContactOrganization,
  ContactPhone,
  ContactWebsite,
  ContactWritableFields,
  CustomField,
} from "@mail/shared";
import { EMPTY_CONTACT_NAME } from "@mail/shared";
import type { GooglePerson } from "./client.js";

/**
 * Google Person ⇄ `ContactWritableFields`, both directions (#216,
 * `docs/research/0010-contacts-sync-and-model.md` §1.3/§1.4 — fetched off
 * `research/caldav-carddav-sync`, not yet merged into this branch; this
 * ticket's own report names that gap). Read direction
 * (`googlePersonToContactFields`) is the projection #214/#210's own doc
 * comments on `db/schema.ts#contacts.googlePayload` describe as "a later
 * ticket['s] own deliverable" and left undone — necessary groundwork here
 * because a field-masked write of a family this Client never actually
 * loaded (a blank `emails` array, say) would otherwise *wipe* that family
 * upstream rather than leave it untouched. Write direction
 * (`buildGooglePersonPatch`) is the acceptance line "field-masked to
 * exactly the modelled families, so unmodelled properties survive": every
 * family this module never mentions (`relations`, `nicknames`, `imClients`,
 * `events`, `occupations`, `interests`, `locales`, `memberships`,
 * `clientData`, `genders`, `photos`) is never in `GOOGLE_PERSON_WRITE_FIELDS`
 * at all, so it can never be touched by a write regardless of what this
 * Client does or doesn't model. *Within* a modelled family this module
 * preserves whatever sub-property Wicket itself has no field for (an
 * address's `poBox`, an organization's `jobDescription`, ...) by overlaying
 * only the modelled sub-fields onto the matching raw entry from
 * `contacts.googlePayload` rather than rebuilding the family from scratch —
 * see `syntheticEntryId`'s own doc comment for how a Wicket entry is matched
 * back to "the same" raw entry across a read-then-write round trip.
 */

/**
 * The fixed field mask every write-back PATCH sends, mirroring
 * `people-sync.ts#GOOGLE_PERSON_FIELDS`'s own "one constant, reused
 * verbatim" shape for the read side. Exactly the families
 * `ContactWritableFields` models plus Custom Fields' own upstream home
 * (`userDefined` — see `customFieldsFromUserDefined`'s doc comment on the
 * lossy part of that mapping); every other writable family Google's
 * `updatePersonFields` accepts (`relations`, `memberships`, ...) is
 * deliberately never included, so Wicket can never touch it.
 */
export const GOOGLE_PERSON_WRITE_FIELDS = [
  "names",
  "emailAddresses",
  "phoneNumbers",
  "addresses",
  "organizations",
  "biographies",
  "birthdays",
  "urls",
  "userDefined",
].join(",");

/**
 * A Wicket entry's own synthetic id for a raw Google array entry it was
 * projected from — `g:<family>:<index>`, minted once by
 * `googlePersonToContactFields` and carried unchanged on the `ContactXxx.id`
 * field for as long as the User leaves that row untouched in the edit form.
 * `buildGooglePersonPatch` parses this back to find "the same" raw entry to
 * overlay onto; a row whose `id` doesn't match this shape (the edit form
 * minted it fresh via `generateUlid()`, `ContactDialog.tsx`'s own
 * `TypedFieldSection`) is a brand-new entry with no raw counterpart to
 * preserve anything from. Index-keyed rather than content-keyed: Google's
 * own array entries carry no id of their own to match on, and the two
 * families this matters most for (`addresses`, `organizations`) are edited
 * as a whole list by the same form, so the raw array's order is exactly
 * what a not-yet-saved edit still reflects.
 */
function syntheticEntryId(family: string, index: number): string {
  return `g:${family}:${index}`;
}

function syntheticEntryIndex(family: string, id: string): number | null {
  const prefix = `g:${family}:`;
  if (!id.startsWith(prefix)) return null;
  const index = Number(id.slice(prefix.length));
  return Number.isInteger(index) && index >= 0 ? index : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isPrimary(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { metadata?: { primary?: unknown } }).metadata?.primary === true
  );
}

/** Every raw entry of one array-shaped family off a `GooglePerson`, or `[]` when the family is absent — every family this module reads is optional on the wire. */
function rawFamily(person: GooglePerson | Record<string, unknown>, family: string): unknown[] {
  const value = (person as Record<string, unknown>)[family];
  return Array.isArray(value) ? value : [];
}

// ---------------------------------------------------------------------------
// Read direction: GooglePerson -> ContactWritableFields
// ---------------------------------------------------------------------------

function projectName(person: GooglePerson | Record<string, unknown>): ContactName {
  // "This field is a singleton for contact sources" (research doc §1.3) —
  // despite the array shape, a contact-sourced Person has at most one.
  const raw = rawFamily(person, "names")[0] as Record<string, unknown> | undefined;
  if (!raw) return EMPTY_CONTACT_NAME;
  return {
    prefix: asString(raw.honorificPrefix),
    given: asString(raw.givenName),
    middle: asString(raw.middleName),
    family: asString(raw.familyName),
    suffix: asString(raw.honorificSuffix),
  };
}

function projectTypedSingleValue(
  person: GooglePerson | Record<string, unknown>,
  family: string,
  fallbackType = "other",
): { id: string; type: string; value: string; primary: boolean }[] {
  return rawFamily(person, family).map((entry, index) => {
    const raw = entry as Record<string, unknown>;
    return {
      id: syntheticEntryId(family, index),
      type: asString(raw.type) ?? fallbackType,
      value: asString(raw.value) ?? "",
      primary: isPrimary(raw),
    };
  });
}

function projectAddresses(person: GooglePerson | Record<string, unknown>): ContactAddress[] {
  return rawFamily(person, "addresses").map((entry, index) => {
    const raw = entry as Record<string, unknown>;
    return {
      id: syntheticEntryId("addresses", index),
      type: asString(raw.type) ?? "other",
      primary: isPrimary(raw),
      street: asString(raw.streetAddress),
      city: asString(raw.city),
      region: asString(raw.region),
      postalCode: asString(raw.postalCode),
      country: asString(raw.country),
    };
  });
}

function projectOrganizations(
  person: GooglePerson | Record<string, unknown>,
): ContactOrganization[] {
  return rawFamily(person, "organizations").map((entry, index) => {
    const raw = entry as Record<string, unknown>;
    return {
      id: syntheticEntryId("organizations", index),
      name: asString(raw.name) ?? "",
      title: asString(raw.title),
      department: asString(raw.department),
    };
  });
}

function projectBirthday(person: GooglePerson | Record<string, unknown>): ContactBirthday | null {
  const raw = rawFamily(person, "birthdays")[0] as
    | { date?: { year?: number; month?: number; day?: number } }
    | undefined;
  const date = raw?.date;
  if (!date?.month || !date.day) return null;
  // A `year` of `0` or an absent field both mean "no year" (research doc
  // §1.3) — never a literal year 0 on the wire.
  return { month: date.month, day: date.day, year: date.year ? date.year : null };
}

function projectNotes(person: GooglePerson | Record<string, unknown>): string {
  const raw = rawFamily(person, "biographies")[0] as { value?: unknown } | undefined;
  return asString(raw?.value) ?? "";
}

/**
 * Google's `userDefined[]` (`{key, value}`) has no `type` of its own — every
 * Custom Field read back off a Google Contact is `type: "text"` regardless
 * of what it was set to before a prior write-back round-tripped it through
 * Google, the one documented lossy corner of this whole mapping (this
 * ticket's own report names it rather than silently losing the distinction).
 */
function projectCustomFields(person: GooglePerson | Record<string, unknown>): CustomField[] {
  return rawFamily(person, "userDefined").map((entry, index) => {
    const raw = entry as Record<string, unknown>;
    return {
      id: syntheticEntryId("userDefined", index),
      label: asString(raw.key) ?? "",
      type: "text",
      value: asString(raw.value) ?? "",
    };
  });
}

export function googlePersonToContactFields(
  person: GooglePerson | Record<string, unknown>,
): ContactWritableFields {
  return {
    name: projectName(person),
    // "home" rather than the other families' "other" fallback (#283) — a
    // Google email is never demoted to a Custom Field regardless of its
    // `type`, and a `type`-less entry defaults its label the same way a
    // blank one does anywhere else this app reads an email from.
    emails: projectTypedSingleValue(person, "emailAddresses", "home") as ContactEmail[],
    phones: projectTypedSingleValue(person, "phoneNumbers") as ContactPhone[],
    addresses: projectAddresses(person),
    websites: projectTypedSingleValue(person, "urls") as ContactWebsite[],
    organizations: projectOrganizations(person),
    birthday: projectBirthday(person),
    notes: projectNotes(person),
    customFields: projectCustomFields(person),
  };
}

// ---------------------------------------------------------------------------
// Write direction: ContactWritableFields -> a field-masked GooglePerson PATCH
// ---------------------------------------------------------------------------

/**
 * Overlays `overlay` onto the raw entry `fields.id` names (via
 * `syntheticEntryId`), or starts fresh when `id` names none (a brand-new
 * row) — the one place a sub-property Wicket doesn't model (an address's
 * `poBox`, an organization's `jobDescription`, ...) survives a write it
 * never touched.
 */
function overlayEntry(
  priorEntries: unknown[],
  family: string,
  id: string,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const index = syntheticEntryIndex(family, id);
  const raw = index !== null ? priorEntries[index] : undefined;
  const base = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return { ...base, ...overlay };
}

function buildTypedSingleValueFamily(
  entries: { id: string; type: string; value: string; primary: boolean }[],
  priorEntries: unknown[],
  family: string,
): Record<string, unknown>[] {
  return entries.map((entry) =>
    overlayEntry(priorEntries, family, entry.id, {
      type: entry.type,
      value: entry.value,
      metadata: { primary: entry.primary },
    }),
  );
}

function buildAddressesFamily(
  entries: ContactAddress[],
  priorEntries: unknown[],
): Record<string, unknown>[] {
  return entries.map((entry) =>
    overlayEntry(priorEntries, "addresses", entry.id, {
      type: entry.type,
      metadata: { primary: entry.primary },
      streetAddress: entry.street,
      city: entry.city,
      region: entry.region,
      postalCode: entry.postalCode,
      country: entry.country,
    }),
  );
}

function buildOrganizationsFamily(
  entries: ContactOrganization[],
  priorEntries: unknown[],
): Record<string, unknown>[] {
  return entries.map((entry) =>
    overlayEntry(priorEntries, "organizations", entry.id, {
      name: entry.name,
      title: entry.title,
      department: entry.department,
    }),
  );
}

/** Google's own free `{key, value}` shape — see `projectCustomFields`'s doc comment on the `type` it never carries. */
function buildUserDefinedFamily(
  entries: CustomField[],
  priorEntries: unknown[],
): Record<string, unknown>[] {
  return entries.map((entry) =>
    overlayEntry(priorEntries, "userDefined", entry.id, {
      key: entry.label,
      value: entry.value,
    }),
  );
}

function buildName(name: ContactName, priorNames: unknown[]): Record<string, unknown>[] {
  const hasAnyPart = Boolean(
    name.given || name.family || name.middle || name.prefix || name.suffix,
  );
  if (!hasAnyPart) return [];
  const base = priorNames[0] && typeof priorNames[0] === "object" ? priorNames[0] : {};
  return [
    {
      ...(base as Record<string, unknown>),
      givenName: name.given,
      familyName: name.family,
      middleName: name.middle,
      honorificPrefix: name.prefix,
      honorificSuffix: name.suffix,
    },
  ];
}

function buildBirthdays(
  birthday: ContactBirthday | null,
  priorBirthdays: unknown[],
): Record<string, unknown>[] {
  if (!birthday) return [];
  const base = priorBirthdays[0] && typeof priorBirthdays[0] === "object" ? priorBirthdays[0] : {};
  return [
    {
      ...(base as Record<string, unknown>),
      // "Clients should always set the `date` field when mutating
      // birthdays" (research doc §1.4); `year` omitted entirely means "no
      // year" on the way out, the same as on the way in.
      date: {
        month: birthday.month,
        day: birthday.day,
        ...(birthday.year ? { year: birthday.year } : {}),
      },
    },
  ];
}

function buildBiographies(notes: string, priorBiographies: unknown[]): Record<string, unknown>[] {
  if (notes.trim().length === 0) return [];
  const base =
    priorBiographies[0] && typeof priorBiographies[0] === "object" ? priorBiographies[0] : {};
  return [{ contentType: "TEXT_PLAIN", ...(base as Record<string, unknown>), value: notes }];
}

export interface GooglePersonPatch {
  /** The PATCH body — `resourceName`/`etag` plus every family `GOOGLE_PERSON_WRITE_FIELDS` names. */
  body: Record<string, unknown>;
  updatePersonFields: typeof GOOGLE_PERSON_WRITE_FIELDS;
}

/**
 * Builds one `people.updateContact` request (#216, research doc §1.4): the
 * etag rides in the body (`etag`'s own top-level field on a Person
 * resource, echoing `person.metadata.sources.etag`'s own comparison
 * research doc §1.4 describes) so Google's optimistic-concurrency check
 * fires against exactly the state this write was computed from —
 * `google/write-back-loop.ts` reads that etag fresh off `contacts.googleEtag`
 * immediately before calling this, never a value captured earlier.
 * `priorPayload` is `contacts.googlePayload`, read the same fresh way — the
 * merge base every family's `overlayEntry` reads an unmodelled sub-property
 * off.
 */
export function buildGooglePersonPatch(args: {
  fields: ContactWritableFields;
  priorPayload: GooglePerson | Record<string, unknown>;
  resourceName: string;
  etag: string;
}): GooglePersonPatch {
  const { fields, priorPayload, resourceName, etag } = args;
  const body: Record<string, unknown> = {
    resourceName,
    etag,
    names: buildName(fields.name, rawFamily(priorPayload, "names")),
    emailAddresses: buildTypedSingleValueFamily(
      fields.emails,
      rawFamily(priorPayload, "emailAddresses"),
      "emailAddresses",
    ),
    phoneNumbers: buildTypedSingleValueFamily(
      fields.phones,
      rawFamily(priorPayload, "phoneNumbers"),
      "phoneNumbers",
    ),
    addresses: buildAddressesFamily(fields.addresses, rawFamily(priorPayload, "addresses")),
    organizations: buildOrganizationsFamily(
      fields.organizations,
      rawFamily(priorPayload, "organizations"),
    ),
    biographies: buildBiographies(fields.notes, rawFamily(priorPayload, "biographies")),
    birthdays: buildBirthdays(fields.birthday, rawFamily(priorPayload, "birthdays")),
    urls: buildTypedSingleValueFamily(fields.websites, rawFamily(priorPayload, "urls"), "urls"),
    userDefined: buildUserDefinedFamily(
      fields.customFields,
      rawFamily(priorPayload, "userDefined"),
    ),
  };
  return { body, updatePersonFields: GOOGLE_PERSON_WRITE_FIELDS };
}

/**
 * A brand-new upstream Person body (#224, the Restore write-back's own
 * request): `buildGooglePersonPatch`'s own family builders, called with an
 * empty prior payload — there is no "last raw entry" to overlay an unmodelled
 * sub-property onto, since this Contact never had one upstream to begin
 * with — and no `resourceName`/`etag`, which `people:createContact` doesn't
 * take on the way in (both come back fresh on the response). Every family
 * `ContactWritableFields` models rides along, the same set
 * `GOOGLE_PERSON_WRITE_FIELDS` masks an update to; Google assigns
 * `resourceName`/`etag` and whatever server-side normalization it always
 * applies (`confirmGoogleContactCreate`'s own doc comment reads them back
 * off the response, never assumed to already match what this Client sent).
 */
export function buildGooglePersonCreateBody(
  fields: ContactWritableFields,
): Record<string, unknown> {
  return {
    names: buildName(fields.name, []),
    emailAddresses: buildTypedSingleValueFamily(fields.emails, [], "emailAddresses"),
    phoneNumbers: buildTypedSingleValueFamily(fields.phones, [], "phoneNumbers"),
    addresses: buildAddressesFamily(fields.addresses, []),
    organizations: buildOrganizationsFamily(fields.organizations, []),
    biographies: buildBiographies(fields.notes, []),
    birthdays: buildBirthdays(fields.birthday, []),
    urls: buildTypedSingleValueFamily(fields.websites, [], "urls"),
    userDefined: buildUserDefinedFamily(fields.customFields, []),
  };
}
