import { z } from "zod";
import type { AddressBookCapabilityTableId } from "./address-books.js";

/**
 * A repeatable field family a Contact may hold (ADR-0026: "which families,
 * how many of each, which types ..."). `birthday` and `customField` are
 * deliberately absent from `ContactCapabilityTable.limits` below — a
 * birthday is at most one and modelled by its own two flags, and a Custom
 * Field's count is unbounded wherever `customFields` is true.
 */
export type ContactFieldFamily = "email" | "phone" | "address" | "organization" | "website";

/**
 * The four families spec's own "typed repeatable ... with one primary" line
 * describes — `organization` is repeatable too but carries neither a `type`
 * nor a `primary` flag (spec: "repeatable organisations", no more). Kept as
 * its own alias so the typed-field helpers below (`CONTACT_FIELD_TYPES`,
 * `splitTypedContactFields`) can't accidentally be reached for `organization`.
 */
export type TypedContactFieldFamily = Exclude<ContactFieldFamily, "organization">;

/**
 * The capability table type "the adapters and the edit form will share"
 * (#209's own acceptance line): which fields a Contact of a given Origin
 * can hold, declared once per `AddressBookCapabilityTableId`
 * (`address-books.ts`) rather than read off the Contact itself, so the edit
 * form draws its fields from the Address Book's table and never offers one
 * an Origin can't hold (ADR-0026: "a Graph Contact never offers a second
 * organisation and a Google Contact does").
 *
 * `limits` — a family **absent** from this map is not held by this Origin at
 * all (the edit form omits it entirely, per this ticket's own acceptance
 * line: "absent from the form, not greyed"); a family **present** with
 * `undefined` is held with no cap. `contactFieldFamilyIsSupported`/
 * `contactFieldFamilyLimit` below are the one place that tells those two
 * apart — never read `limits[family]` directly, since a plain property
 * lookup cannot distinguish "absent" from "present but undefined".
 */
export interface ContactCapabilityTable {
  /** How many of a repeatable family this Origin holds; a family absent from this map is not held at all. `undefined` means unbounded. */
  limits: Partial<Record<ContactFieldFamily, number | undefined>>;
  /** Whether this Origin holds a birthday at all. */
  hasBirthday: boolean;
  /** Whether a birthday on this Origin may omit its year. */
  birthdayYearOptional: boolean;
  /** Whether this Origin holds Custom Fields (ADR-0026's typed, labelled long tail). */
  customFields: boolean;
}

/** Whether `table` holds `family` at all — see `ContactCapabilityTable.limits`'s own doc comment for why this can't be a plain property read. */
export function contactFieldFamilyIsSupported(
  table: ContactCapabilityTable,
  family: ContactFieldFamily,
): boolean {
  return family in table.limits;
}

/** How many of `family` `table` allows — `undefined` means unbounded. Only meaningful once `contactFieldFamilyIsSupported` is true; call that first. */
export function contactFieldFamilyLimit(
  table: ContactCapabilityTable,
  family: ContactFieldFamily,
): number | undefined {
  return table.limits[family];
}

/**
 * Whether `entries.length` has already reached `table`'s own cap for
 * `family` — the edit form's own "offers no second organisation" gate
 * (#227's acceptance line, first exercised by Graph's `organization: 1`):
 * `false` for every family every other Origin declares unbounded, so this
 * is a no-op everywhere but Graph until a future table caps another family.
 * Never meaningful for a family the table doesn't support at all — call
 * `contactFieldFamilyIsSupported` first, same as `contactFieldFamilyLimit`.
 */
export function contactFieldFamilyAtLimit(
  table: ContactCapabilityTable,
  family: ContactFieldFamily,
  entries: readonly unknown[],
): boolean {
  const limit = contactFieldFamilyLimit(table, family);
  return limit !== undefined && entries.length >= limit;
}

/**
 * Local's own table (ADR-0026: "the Local Address Book's table is the
 * superset") — every family unbounded, birthday held with its year
 * optional, Custom Fields held. This ticket's (#210) one populated row;
 * `google`/`microsoft`/`caldav_carddav` are later adapters' own to declare
 * (#214, #226, #227).
 */
export const LOCAL_CONTACT_CAPABILITY_TABLE: ContactCapabilityTable = {
  limits: {
    email: undefined,
    phone: undefined,
    address: undefined,
    organization: undefined,
    website: undefined,
  },
  hasBirthday: true,
  birthdayYearOptional: true,
  customFields: true,
};

/**
 * Google's own table (#214, ADR-0026, `docs/research/0010-contacts-sync-and-model.md`
 * §1.3/§1.6): every repeatable family Google's Person resource holds
 * (`emailAddresses`, `phoneNumbers`, `addresses`, `organizations`, `urls`)
 * is unbounded — **several concurrent organisations are native**
 * (`organizations[]` allows more than one `current: true` entry, unlike
 * Graph's single `companyName`/`jobTitle`), matching this ticket's own
 * acceptance line. `birthdays[].date.year` is optional (§1.3: "year is
 * optional"), and Google's free-typed families (`userDefined`/`clientData`
 * plus any label outside the fixed vocabulary) are this Origin's Custom
 * Fields (ADR-0026: "free-typed labels become Custom Fields").
 */
export const GOOGLE_CONTACT_CAPABILITY_TABLE: ContactCapabilityTable = {
  limits: {
    email: undefined,
    phone: undefined,
    address: undefined,
    organization: undefined,
    website: undefined,
  },
  hasBirthday: true,
  birthdayYearOptional: true,
  customFields: true,
};

/**
 * Graph's own table (#227, `docs/contacts-spec.md` §The capability tables):
 * deliberately the **thinnest** of the three — **one** organisation
 * (`limits.organization: 1`, unlike Local's/Google's unbounded), **no**
 * year-less birthday (`birthdayYearOptional: false` — Graph's `birthday` is
 * always a full date), home/business/other addresses only (Graph's own
 * fixed `homeAddress`/`businessAddress`/`otherAddress` triple — the
 * Microsoft adapter maps `business` onto this app's own `"work"` label so it
 * lands as a standard address rather than a demoted Custom Field), and
 * **no** Custom Fields at all — `customFields: false` here, not merely
 * "zero today", since Graph open extensions are out of scope (this ticket's
 * own acceptance line) and there is nowhere else a free-typed value could
 * land. The fewer fields this table declares, the less the write path's own
 * lost-update caveat (`contacts/microsoft/client.ts`'s own doc comment) can
 * ever cost.
 */
export const MICROSOFT_CONTACT_CAPABILITY_TABLE: ContactCapabilityTable = {
  limits: {
    email: undefined,
    phone: undefined,
    address: undefined,
    organization: 1,
    website: undefined,
  },
  hasBirthday: true,
  birthdayYearOptional: false,
  customFields: false,
};

/**
 * CardDAV's own table (#226, RFC 6352 §6.1, `docs/contacts-spec.md` §The
 * capability tables): the closest to Local's superset of the three upstream
 * adapters — a vCard holds every repeatable family unbounded (`EMAIL`,
 * `TEL`, `ADR`, `ORG`, `URL` all repeat freely, unlike Graph's single
 * `companyName`), a year-less `BDAY` is a real vCard 4 shape
 * (`--MMDD`, RFC 6350 §4.3.1), and Custom Fields are held (`hasBirthday`/
 * `customFields` both true) because a generic CardDAV server has no fixed
 * vocabulary of its own to be *thinner* than — free-typed `TYPE=x-…`
 * parameters and one Wicket-namespaced `X-` property are exactly what
 * carries a Custom Field through a vCard (`contacts/carddav/mapping.ts`'s
 * own doc comment), never a reason to cap or close a family.
 */
export const CARDDAV_CONTACT_CAPABILITY_TABLE: ContactCapabilityTable = {
  limits: {
    email: undefined,
    phone: undefined,
    address: undefined,
    organization: undefined,
    website: undefined,
  },
  hasBirthday: true,
  birthdayYearOptional: true,
  customFields: true,
};

/**
 * One row per `AddressBookCapabilityTableId` (`address-books.ts`) — every
 * adapter this app ships has now declared its own table (#210, #214, #226,
 * #227); still a `Partial` rather than a full `Record` so a future Origin
 * added here without its own table yet is a real gap `getContactCapabilityTable`
 * below can fall back from, rather than a guessed-at placeholder.
 */
export const CONTACT_CAPABILITY_TABLES: Partial<
  Record<AddressBookCapabilityTableId, ContactCapabilityTable>
> = {
  local: LOCAL_CONTACT_CAPABILITY_TABLE,
  google: GOOGLE_CONTACT_CAPABILITY_TABLE,
  microsoft: MICROSOFT_CONTACT_CAPABILITY_TABLE,
  caldav_carddav: CARDDAV_CONTACT_CAPABILITY_TABLE,
};

/** A table with nothing in it — every family unsupported, no birthday, no Custom Fields. What `getContactCapabilityTable` hands back for an `AddressBookCapabilityTableId` no adapter has declared a table for yet. */
export const CLOSED_CONTACT_CAPABILITY_TABLE: ContactCapabilityTable = {
  limits: {},
  hasBirthday: false,
  birthdayYearOptional: false,
  customFields: false,
};

/** The one place the edit form and the write path both call (this ticket's own acceptance line: "one declaration read by both"). */
export function getContactCapabilityTable(
  id: AddressBookCapabilityTableId,
): ContactCapabilityTable {
  return CONTACT_CAPABILITY_TABLES[id] ?? CLOSED_CONTACT_CAPABILITY_TABLE;
}

/**
 * A structured name (spec: "structured name"). Every part optional — a
 * business-only Contact may carry only an Organization and no name at all.
 */
export const contactNameSchema = z.object({
  prefix: z.string().optional(),
  given: z.string().optional(),
  middle: z.string().optional(),
  family: z.string().optional(),
  suffix: z.string().optional(),
});
export type ContactName = z.infer<typeof contactNameSchema>;
export const EMPTY_CONTACT_NAME: ContactName = {};

/**
 * The fixed type vocabulary per typed family (ADR-0026's "labelled with a
 * label outside the fixed vocabulary" line implies one exists) — a label
 * outside this list is what makes an entry a Custom Field instead
 * (`splitTypedContactFields` below), never a rejected value: the type
 * itself is a free string on the wire (`contactEmailSchema` etc.), and
 * this list is what the edit form and `isStandardContactFieldLabel` check
 * it against.
 */
export const CONTACT_FIELD_TYPES = {
  email: ["home", "work", "other"],
  phone: ["home", "work", "mobile", "fax", "other"],
  address: ["home", "work", "other"],
  website: ["homepage", "work", "other"],
} as const satisfies Record<TypedContactFieldFamily, readonly string[]>;

export function isStandardContactFieldLabel(
  family: TypedContactFieldFamily,
  label: string,
): boolean {
  return (CONTACT_FIELD_TYPES[family] as readonly string[]).includes(label);
}

/** One typed, repeatable, single-value field (email/phone/website) — `type` is a free string, checked against `CONTACT_FIELD_TYPES` by `isStandardContactFieldLabel`, never itself an enum (so a Custom label survives a round trip before `splitTypedContactFields` ever runs). */
const typedSingleValueFieldSchema = z.object({
  id: z.string(),
  type: z.string(),
  value: z.string(),
  primary: z.boolean(),
});

export const contactEmailSchema = typedSingleValueFieldSchema;
export type ContactEmail = z.infer<typeof contactEmailSchema>;

export const contactPhoneSchema = typedSingleValueFieldSchema;
export type ContactPhone = z.infer<typeof contactPhoneSchema>;

export const contactWebsiteSchema = typedSingleValueFieldSchema;
export type ContactWebsite = z.infer<typeof contactWebsiteSchema>;

/** A typed, repeatable postal address — structured, unlike the single-value families above, so it carries its own `type`/`primary` rather than reusing `typedSingleValueFieldSchema`. */
export const contactAddressSchema = z.object({
  id: z.string(),
  type: z.string(),
  primary: z.boolean(),
  street: z.string().optional(),
  city: z.string().optional(),
  region: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().optional(),
});
export type ContactAddress = z.infer<typeof contactAddressSchema>;

/** Repeatable, but neither typed nor primary (spec: "repeatable organisations", nothing more). */
export const contactOrganizationSchema = z.object({
  id: z.string(),
  name: z.string(),
  title: z.string().optional(),
  department: z.string().optional(),
});
export type ContactOrganization = z.infer<typeof contactOrganizationSchema>;

/**
 * Birthday stays a native field (this ticket's own acceptance line) — every
 * other date a User might want is a Custom Field of type `date` instead
 * (below), never a second native date family. `year` is nullable rather
 * than optional: a birthday with a month/day but no year is a real, common
 * shape (ADR-0026: "whether a birthday may omit its year"), not merely an
 * unset field — `birthdayYearOptional` on the capability table is what
 * governs whether that null is allowed for a given Origin.
 */
export const contactBirthdaySchema = z.object({
  month: z.int().min(1).max(12),
  day: z.int().min(1).max(31),
  year: z.int().nullable(),
});
export type ContactBirthday = z.infer<typeof contactBirthdaySchema>;

/** ADR-0026's "typed (text, date, number, phone, location, website)" — `location` is what a demoted `address` becomes (`ADDRESS_CUSTOM_FIELD_TYPE`), there is no dedicated `email` custom type (a demoted email becomes `text`, `CUSTOM_FIELD_TYPE_BY_FAMILY`'s own doc comment). */
export const customFieldTypeSchema = z.enum([
  "text",
  "date",
  "number",
  "phone",
  "location",
  "website",
]);
export type CustomFieldType = z.infer<typeof customFieldTypeSchema>;

/** A labelled, typed long-tail value (ADR-0026, this ticket's own acceptance line) — `value` is always a string on the wire regardless of `type`; parsing/formatting a `date`/`number` for display is the edit form's job, not this schema's. */
export const customFieldSchema = z.object({
  id: z.string(),
  label: z.string(),
  type: customFieldTypeSchema,
  value: z.string(),
});
export type CustomField = z.infer<typeof customFieldSchema>;

/**
 * Which `CustomFieldType` a demoted typed-family entry becomes
 * (`splitTypedContactFields`) — `phone`/`website` map onto their own
 * matching Custom Field type, `address` maps onto `location` (ADR-0026 names
 * `location` as the family's custom counterpart), and `email` has no
 * matching Custom Field type of its own, so it falls back to `text`.
 */
const CUSTOM_FIELD_TYPE_BY_FAMILY: Record<TypedContactFieldFamily, CustomFieldType> = {
  email: "text",
  phone: "phone",
  address: "location",
  website: "website",
};

export function contactFieldFamilyCustomType(family: TypedContactFieldFamily): CustomFieldType {
  return CUSTOM_FIELD_TYPE_BY_FAMILY[family];
}

/** One row of a typed single-value family as the edit form collects it, before `splitTypedContactFields` sorts it into `contactEmailSchema`/... or a demoted `CustomField`. */
export interface ContactTypedFieldInput {
  id: string;
  /** Free text: one of `CONTACT_FIELD_TYPES[family]`, or anything else (a Custom label, e.g. CONTEXT.md's own "a phone labelled 'Boat'"). */
  label: string;
  value: string;
  primary: boolean;
}

/**
 * ADR-0026: "a standard-family value whose label falls outside the fixed
 * vocabulary becomes a Custom Field of that type" — the one place that rule
 * is actually applied, shared by the local edit form (a User typing a
 * Custom label into a phone/email/website row) and every future importer
 * (#225's vCard, #214/#226/#227's own upstream labels) that needs the same
 * split. `address` is excluded: its entries are a structured shape,
 * not a single `value` string, so its own demotion path is
 * `demoteContactAddress` below.
 */
export function splitTypedContactFields(
  family: Exclude<TypedContactFieldFamily, "address">,
  entries: ContactTypedFieldInput[],
): { standard: ContactEmail[] | ContactPhone[] | ContactWebsite[]; custom: CustomField[] } {
  const standard: { id: string; type: string; value: string; primary: boolean }[] = [];
  const custom: CustomField[] = [];
  for (const entry of entries) {
    if (isStandardContactFieldLabel(family, entry.label)) {
      standard.push({
        id: entry.id,
        type: entry.label,
        value: entry.value,
        primary: entry.primary,
      });
    } else {
      custom.push({
        id: entry.id,
        label: entry.label,
        type: contactFieldFamilyCustomType(family),
        value: entry.value,
      });
    }
  }
  return { standard, custom };
}

/**
 * `contactAddressSchema`'s own demotion path (`splitTypedContactFields`'s
 * doc comment) — an address has no single `value` to carry into a `location`
 * Custom Field, so this joins its non-empty parts into one display string
 * instead, the same way any address is normally rendered as one line.
 */
export function demoteContactAddress(
  entry: { id: string; type: string; primary: boolean } & Omit<
    ContactAddress,
    "id" | "type" | "primary"
  >,
): { standard: ContactAddress | null; custom: CustomField | null } {
  if (isStandardContactFieldLabel("address", entry.type)) {
    return { standard: entry, custom: null };
  }
  const value = [entry.street, entry.city, entry.region, entry.postalCode, entry.country]
    .filter((part): part is string => Boolean(part && part.trim().length > 0))
    .join(", ");
  return {
    standard: null,
    custom: { id: entry.id, label: entry.type, type: "location", value },
  };
}

/**
 * The fields a User actually edits — everything on `Contact` but its
 * identity (`id`/`addressBookId`), its Labels (their own `labelContact`/
 * `unlabelContact` intents, `sync.ts#userMutationIntentSchema`'s own doc
 * comment — the same split `Note`'s `labelIds` already has from its
 * structural fields) and its timestamps. `updateContact`
 * (`sync.ts#userMutationIntentSchema`) carries exactly this shape: a whole
 * replacement of every writable field in one intent, never a per-family
 * patch — the same "one form, one save" posture `noteSaveSchema` takes for
 * a Note's body, just via the ordinary Optimistic Action queue instead of a
 * coalescing channel, since unlike a Note's freeform document a Contact's
 * fields are exactly what needs a real inverse (this ticket's own
 * acceptance line): re-applying the previous `ContactWritableFields` through
 * this same intent type **is** that inverse (ADR-0019 — "a real inverse
 * intent on the wire", not necessarily a distinct paired type; nothing about
 * a boolean toggle applies to an arbitrary field-set edit), captured by
 * whoever calls `updateContact` before the edit, the same "component wires
 * the toast, the store stays store" split `trashNote`/`restoreNote`'s own
 * callers already draw.
 */
export const contactWritableFieldsSchema = z.object({
  name: contactNameSchema,
  emails: z.array(contactEmailSchema),
  phones: z.array(contactPhoneSchema),
  addresses: z.array(contactAddressSchema),
  websites: z.array(contactWebsiteSchema),
  organizations: z.array(contactOrganizationSchema),
  birthday: contactBirthdaySchema.nullable(),
  notes: z.string(),
  customFields: z.array(customFieldSchema),
});
export type ContactWritableFields = z.infer<typeof contactWritableFieldsSchema>;

export const EMPTY_CONTACT_FIELDS: ContactWritableFields = {
  name: EMPTY_CONTACT_NAME,
  emails: [],
  phones: [],
  addresses: [],
  websites: [],
  organizations: [],
  birthday: null,
  notes: "",
  customFields: [],
};

/**
 * The Person Page's own "Change banner" set (#212, spec's own §Banner): a
 * fixed swatch keyed off `@mail/design-tokens`' five avatar-tile tints
 * (`--tile-a-bg`..`--tile-e-bg`, `mail/Avatar.tsx`'s own `TILES`) so the
 * banner picker never grows its own separate palette, plus a raw image URL
 * for a User who wants a real photo behind the avatar. Never a capability
 * table entry (this ticket's own acceptance line: "Banner is Wicket-only and
 * never part of a capability table") — it is the app's own decoration on a
 * Contact, not something any Origin's Person resource holds, so it rides
 * its own `setContactBanner` intent (`sync.ts`) exactly the way `labelIds`
 * rides `labelContact`/`unlabelContact`, on any Contact regardless of Origin,
 * never written upstream.
 */
export const CONTACT_BANNER_SWATCHES = ["a", "b", "c", "d", "e"] as const;
export type ContactBannerSwatch = (typeof CONTACT_BANNER_SWATCHES)[number];

export const contactBannerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("swatch"), swatch: z.enum(CONTACT_BANNER_SWATCHES) }),
  z.object({ kind: z.literal("image"), url: z.url() }),
]);
export type ContactBanner = z.infer<typeof contactBannerSchema>;

/**
 * A Contact's photo (#213, `docs/contacts-spec.md` §Photos): a reference to
 * the Sync Backend's own Blob Store, never the bytes themselves and never a
 * remote URL — the same "never a remote-image fetch from the Client" posture
 * `mail/Avatar.tsx`'s own doc comment already holds for a correspondent's
 * mark, now with a real image behind it once a User uploads one. `blobId` is
 * the photo's own content hash (`contact-photos/photo-store.ts` on the Sync
 * Backend computes it), not a random id — content-addressing is what lets
 * two Contacts who happen to share the exact same bytes share one blob row,
 * and is half of what makes an unreferenced blob "collectable" rather than
 * merely "deletable" (this ticket's own acceptance line). `mimeType` rides
 * alongside since the blob table has no column of its own the wire schema
 * exposes; the download route reads it back off the blob row directly.
 */
export const contactPhotoSchema = z.object({
  blobId: z.string(),
  mimeType: z.string(),
});
export type ContactPhoto = z.infer<typeof contactPhotoSchema>;

/** The image MIME types the upload route accepts (#213's own "type ... bounded server-side" acceptance line) — anything else is a 415, never silently coerced. */
export const CONTACT_PHOTO_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type ContactPhotoMimeType = (typeof CONTACT_PHOTO_MIME_TYPES)[number];

export function isContactPhotoMimeType(value: string): value is ContactPhotoMimeType {
  return (CONTACT_PHOTO_MIME_TYPES as readonly string[]).includes(value);
}

/** The upload route's own size bound (#213's "size ... bounded server-side" acceptance line) — a photo, not an attachment corpus, so this is deliberately far below `ATTACHMENT_BUDGET_BYTES`. */
export const CONTACT_PHOTO_MAX_BYTES = 5 * 1024 * 1024;

/**
 * `Contact` (#209/#210, ADR-0023, ADR-0026): a registry descriptor on both
 * sides, riding the same Sync Scope as its Address Book — the User slot for
 * a Local Contact, its Connected Account's slot for a mirrored one. Every
 * field family ADR-0026 describes now lives here (#209 shipped only `id`/
 * `addressBookId`, deliberately, leaving the rest to this ticket).
 * `labelIds` mirrors `Note.labelIds` — a User-owned tag, never written
 * upstream (CONTEXT.md's own **Label** entry) — and is the one writable
 * piece not inside `ContactWritableFields` above, edited through its own
 * `labelContact`/`unlabelContact` intents instead of `updateContact`. `banner`
 * (#212) is the same shape again: `null` until a User sets one, edited
 * through its own `setContactBanner` intent, never through `updateContact`.
 * `photo` (#213) is a third side-channel, `banner`'s own shape once more:
 * `null` until a User uploads one, but set through the Blob Store's REST
 * upload route (`routes/contact-photos.ts`) rather than any sync intent at
 * all — the bytes never ride `POST /sync`, only this reference does, riding
 * along on the Contact row's own ordinary replication once the upload route
 * bumps its `syncRev` the same direct-write way `updateContactBanner` does.
 * A synced-down Graph photo (#227) rides this exact same column, set by the
 * sync engine calling the same `photo-store.ts#putContactPhoto` a User's own
 * upload does. `categories` (#227) is the opposite direction from both:
 * Origin-owned, never Wicket-owned — Graph's own Outlook Categories,
 * mirrored down read-only (the edit form never offers them, this ticket's
 * own acceptance line: "Graph categories render as read-only chips") and
 * always empty for every Contact that isn't a Graph mirror.
 *
 * `deletedAt` (#224): soft delete and Recently Deleted, `notes.ts#noteSchema`'s
 * own `deletedAt` shape — set by `trashContact`, cleared by its real inverse
 * `restoreContact` (`sync.ts#userMutationIntentSchema`, ADR-0019). The row
 * keeps syncing normally while this is set (an ordinary field, not a
 * tombstone); `store/contacts.ts#readContacts` filters it out and
 * `readDeletedContacts` is the one reader that wants it.
 * `CONTACT_TRASH_RETENTION_DAYS` after this is stamped,
 * `contacts/contact-purge.ts` on the Sync Backend physically deletes the row
 * and records the ordinary tombstone `deleteContact` already would. Unlike a
 * Note, a synced Contact's own upstream mirror is discarded the instant this
 * is set (ADR-0029: "removal discards the mirror ... a confirmed act") —
 * `googleResourceName`/`microsoftId` and their own siblings are cleared
 * server-side in the same write, which is what makes `restoreContact`
 * re-create the upstream record fresh rather than reactivate the old one.
 */
export const contactSchema = z.object({
  id: z.string(),
  addressBookId: z.string(),
  name: contactNameSchema,
  emails: z.array(contactEmailSchema),
  phones: z.array(contactPhoneSchema),
  addresses: z.array(contactAddressSchema),
  websites: z.array(contactWebsiteSchema),
  organizations: z.array(contactOrganizationSchema),
  birthday: contactBirthdaySchema.nullable(),
  notes: z.string(),
  labelIds: z.array(z.string()),
  customFields: z.array(customFieldSchema),
  banner: contactBannerSchema.nullable(),
  photo: contactPhotoSchema.nullable(),
  categories: z.array(z.string()),
  deletedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Contact = z.infer<typeof contactSchema>;

/** How long a soft-deleted Contact stays in Recently Deleted before `contacts/contact-purge.ts` purges it for good (#224, the same 30 days `NOTE_TRASH_RETENTION_DAYS` already gives a Note). */
export const CONTACT_TRASH_RETENTION_DAYS = 30;

/**
 * `updateContact`/`createContact`'s own write-path guard
 * (`sync/contacts.ts` on the Sync Backend) — the same table
 * `getContactCapabilityTable` hands the edit form, read here instead so the
 * two "cannot disagree" (this ticket's own acceptance line). A rejection
 * reason names the one family/flag it failed on, mirroring
 * `sync/mutations.ts`'s own short machine-readable `IntentResult` reasons.
 */
export type ContactFieldsValidation = { ok: true } | { ok: false; reason: string };

const TYPED_FAMILY_ENTRIES: readonly [ContactFieldFamily, keyof ContactWritableFields][] = [
  ["email", "emails"],
  ["phone", "phones"],
  ["address", "addresses"],
  ["organization", "organizations"],
  ["website", "websites"],
];

const FAMILIES_WITH_PRIMARY: readonly ContactFieldFamily[] = [
  "email",
  "phone",
  "address",
  "website",
];

export function validateContactFields(
  fields: ContactWritableFields,
  table: ContactCapabilityTable,
): ContactFieldsValidation {
  for (const [family, key] of TYPED_FAMILY_ENTRIES) {
    const entries = fields[key] as { primary?: boolean }[];
    if (entries.length === 0) continue;
    if (!contactFieldFamilyIsSupported(table, family)) {
      return { ok: false, reason: `${family}_not_supported` };
    }
    const limit = contactFieldFamilyLimit(table, family);
    if (limit !== undefined && entries.length > limit) {
      return { ok: false, reason: `too_many_${family}` };
    }
    if (FAMILIES_WITH_PRIMARY.includes(family)) {
      const primaryCount = entries.filter((entry) => entry.primary === true).length;
      if (primaryCount > 1) return { ok: false, reason: `multiple_primary_${family}` };
    }
  }
  if (fields.birthday !== null) {
    if (!table.hasBirthday) return { ok: false, reason: "birthday_not_supported" };
    if (fields.birthday.year === null && !table.birthdayYearOptional) {
      return { ok: false, reason: "birthday_year_required" };
    }
  }
  if (fields.customFields.length > 0 && !table.customFields) {
    return { ok: false, reason: "custom_fields_not_supported" };
  }
  return { ok: true };
}

/**
 * The card directory's own sort preference (#211): first name or last name
 * first, defaulting to first — the User-scoped `Preference` field
 * (`sync.ts#preferenceSchema`), not a per-Address-Book or per-device
 * setting, since a User expects the same order everywhere they sign in.
 */
export const contactsSortOrderSchema = z.enum(["given", "family"]);
export type ContactsSortOrder = z.infer<typeof contactsSortOrderSchema>;
export const DEFAULT_CONTACTS_SORT_ORDER: ContactsSortOrder = "given";

/**
 * The one line a card/list row shows for a Contact's name (#211's own
 * "name" line) — falls back to the primary/first Organization's name for a
 * business-only Contact (no name family at all, `ContactName`'s own doc
 * comment), then to the primary/first email, then to a fixed placeholder
 * so a card never renders visibly blank.
 */
export function contactDisplayName(
  contact: Pick<Contact, "name" | "organizations" | "emails">,
): string {
  const name = [contact.name.given, contact.name.family].filter(Boolean).join(" ").trim();
  if (name.length > 0) return name;
  const organization = contact.organizations[0]?.name;
  if (organization && organization.trim().length > 0) return organization;
  const email = contact.emails.find((entry) => entry.primary) ?? contact.emails[0];
  if (email) return email.value;
  return "Unnamed contact";
}

/** The card's own organisation line — the primary Organization if one is flagged (Organization carries no `primary` flag itself, so this is simply the first), else nothing. */
export function contactOrganizationLine(
  contact: Pick<Contact, "organizations">,
): string | undefined {
  const organization = contact.organizations[0];
  if (!organization) return undefined;
  return organization.title ? `${organization.title} at ${organization.name}` : organization.name;
}

/**
 * The card directory's own search field (#211's acceptance line: "Search
 * filters the whole-replicated collection on name, address and
 * organisation") — every email counts as an "address" here (a User
 * searching "gmail.com" expects a hit), alongside every postal address's
 * own parts and every Organization's name/title. Exported on its own (not
 * only via `contactMatchesQuery` below) so the Command Palette's own
 * `LocalHitSource.matchText` (`local-hits.ts`) can reuse the exact same
 * haystack rather than growing a second, possibly-diverging definition of
 * "a Contact's searchable text".
 */
export function contactSearchText(contact: Contact): string {
  return [
    contactDisplayName(contact),
    ...contact.emails.map((entry) => entry.value),
    ...contact.organizations.flatMap((entry) => [entry.name, entry.title]),
    ...contact.addresses.flatMap((entry) => [
      entry.street,
      entry.city,
      entry.region,
      entry.postalCode,
      entry.country,
    ]),
  ]
    .filter((part): part is string => Boolean(part))
    .join(" ");
}

/** The card directory's own filter predicate — `contactSearchText` reduced to a plain "does this Contact match?" the grid can call in a `.filter()`. */
export function contactMatchesQuery(contact: Contact, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  return contactSearchText(contact).toLowerCase().includes(needle);
}

/**
 * The grid's own sort key for `order` (#211's "sort order (first or last
 * name, defaulting to first)"): given-name-first sorts on given then
 * family, family-first sorts the other way round — either falls back to
 * `contactDisplayName` for a Contact `order`'s own family is blank on (a
 * business-only Contact under "family" order, say), so it never sorts
 * behind every named Contact regardless of the chosen order.
 */
export function contactSortKey(
  contact: Pick<Contact, "name" | "organizations" | "emails">,
  order: ContactsSortOrder,
): string {
  const primary = order === "given" ? contact.name.given : contact.name.family;
  const secondary = order === "given" ? contact.name.family : contact.name.given;
  const parts = [primary, secondary].filter(Boolean);
  if (parts.length === 0) return contactDisplayName(contact).toLowerCase();
  return parts.join(" ").toLowerCase();
}

/**
 * Write-back's own "upstream wins" event (#216, spec's own §Sync): recorded
 * whenever a queued upstream write for a mirrored Contact is rejected or
 * loses a conditional write, so every device — not only the one that made
 * the edit — can show a Rollback toast (the Sync Backend reverting the
 * mirror already reaches every device through the ordinary `Contact` delta,
 * ADR-0011; this collection is the *narration* of that revert, which an
 * ordinary field delta carries no signal for on its own). `contactId` names
 * the Contact the write concerned — still present and reverted, never
 * deleted by this — and `contactName` is a display-name snapshot taken at
 * the moment of the revert, so the toast still reads sensibly if the
 * Contact's name changes again before the User sees it. Append-only: rows
 * are never updated or destroyed, so `CollectionDelta.updated`/`destroyed`
 * stay empty for this collection (`sync.ts#contactRollbackDeltaSchema`).
 */
export const contactRollbackReasonSchema = z.enum([
  /** A conditional write lost — Google's own etag no longer matched (research doc §1.4's `failedPrecondition`), the edit or a concurrent one from elsewhere reached Google first. */
  "google_conflict",
  /** The Contact was gone upstream by the time the write reached Google (deleted directly in Google, outside Wicket). */
  "google_not_found",
  /** Any other definitive 4xx Google gave for the write. */
  "google_rejected",
  /** A conditional write lost (#226) — the vCard's `If-Match` etag no longer matched (RFC 4918 §12.1's `412 Precondition Failed`), the edit or a concurrent one from elsewhere reached the CardDAV server first. */
  "carddav_conflict",
  /** The vCard was gone upstream by the time the write reached the server (deleted directly on the CardDAV server, outside Wicket). */
  "carddav_not_found",
  /** Any other definitive 4xx the CardDAV server gave for the write. */
  "carddav_rejected",
]);
export type ContactRollbackReason = z.infer<typeof contactRollbackReasonSchema>;

export const contactRollbackSchema = z.object({
  id: z.string(),
  contactId: z.string(),
  contactName: z.string(),
  reason: contactRollbackReasonSchema,
  createdAt: z.iso.datetime(),
});
export type ContactRollback = z.infer<typeof contactRollbackSchema>;
