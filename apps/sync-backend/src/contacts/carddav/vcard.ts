import { randomUUID } from "node:crypto";
import {
  type ContactAddress,
  type ContactBirthday,
  type ContactTypedFieldInput,
  type ContactWritableFields,
  type CustomField,
  contactDisplayName,
  demoteContactAddress,
  EMPTY_CONTACT_FIELDS,
  splitTypedContactFields,
} from "@mail/shared";

/**
 * The ticket's own honesty rule (#226, RFC 6350): "the Sync Backend keeps
 * the last raw vCard per Contact and re-serialises only the modelled
 * properties into it before `PUT`, so a `GEO`, an `X-ABLabel` or a `SOUND`
 * Wicket has no field for is still there after an edit." This module is the
 * whole of that rule — `parseVcard` reads a server's raw text into
 * `ContactWritableFields`/categories/a photo reference; `serializeVcard`
 * takes the *previous* raw vCard (or `null` for a brand-new Local Contact
 * pushed upstream for the first time) and the Contact's *current* fields,
 * and hands back a new raw vCard where only the lines this module itself
 * understands have moved — every other line survives verbatim, in place.
 *
 * The model: a vCard is `BEGIN:VCARD` / `VERSION:x` / a flat list of
 * property lines / `END:VCARD` (RFC 6350 §6.1.1-6.1.4). This module keeps
 * that property-line list as plain unfolded text, one string per property,
 * and only ever inspects the handful of names it maps — never a structured
 * round-trip through a generic vCard object model, which is what would risk
 * losing a property this app was never told to understand in the first
 * place.
 */

/** The one Wicket-namespaced `X-` property every Custom Field this app can't ride a native vCard property for bundles into (#226's own acceptance line) — phone/website Custom Fields ride `TEL`/`URL` with an `x-`-prefixed `TYPE` instead (`buildTypedXTypeLine`'s own doc comment). */
export const CARDDAV_CUSTOM_FIELDS_PROPERTY = "x-wicket-customfields";

const MODELLED_PROPERTY_NAMES = new Set([
  "fn",
  "n",
  "email",
  "tel",
  "adr",
  "org",
  "title",
  "bday",
  "url",
  "categories",
  "note",
  "photo",
  CARDDAV_CUSTOM_FIELDS_PROPERTY,
]);

export interface ParsedVcard {
  fields: ContactWritableFields;
  categories: string[];
  /** An embedded `PHOTO` this vCard carries, decoded — `null` when the vCard has none, or only a remote `PHOTO;VALUE=uri:` this module never fetches (`parseVcard`'s own doc comment). */
  photo: { mimeType: string; bytes: Buffer } | null;
  /** The vCard's own `UID`, if it declared one — `serializeVcard`'s own fallback is a freshly minted one when absent. */
  uid: string | null;
}

/**
 * Reads a server's raw vCard text into this app's own shape. Never throws on
 * a malformed line — an unparseable property is simply left out of every
 * family it might have populated, the same "best-effort, the rest of the
 * round keeps going" tolerance `contacts/microsoft/contacts-sync.ts#syncContactPhoto`
 * already takes for its own single-property failure.
 */
export function parseVcard(raw: string): ParsedVcard {
  const lines = unfoldVcardLines(raw);

  const emails: ContactTypedFieldInput[] = [];
  const phones: ContactTypedFieldInput[] = [];
  const websites: ContactTypedFieldInput[] = [];
  const addressEntries: {
    type: string;
    primary: boolean;
    address: Omit<ContactAddress, "id" | "type" | "primary">;
  }[] = [];
  const organizations: ContactWritableFields["organizations"] = [];
  let name = EMPTY_CONTACT_FIELDS.name;
  let birthday: ContactBirthday | null = null;
  let notes = "";
  let categories: string[] = [];
  let photo: ParsedVcard["photo"] = null;
  let uid: string | null = null;
  let bundledCustomFields: CustomField[] = [];
  let titleValue: string | undefined;

  for (const line of lines) {
    const parsed = parsePropertyLine(line);
    if (!parsed) continue;
    const { name: propName, params, value } = parsed;

    switch (propName) {
      case "n": {
        const parts = splitComponents(value).map(unescapeVcardText);
        name = {
          family: parts[0] || undefined,
          given: parts[1] || undefined,
          middle: parts[2] || undefined,
          prefix: parts[3] || undefined,
          suffix: parts[4] || undefined,
        };
        break;
      }
      case "email":
        emails.push(typedFieldInput(params, value));
        break;
      case "tel":
        phones.push(typedFieldInput(params, value));
        break;
      case "url":
        websites.push(typedFieldInput(params, value));
        break;
      case "adr": {
        const parts = splitComponents(value).map(unescapeVcardText);
        const street = [parts[1], parts[2]].filter(Boolean).join(" ").trim(); // extended + street
        addressEntries.push({
          type: vcardTypeLabel(params),
          primary: hasPrefParam(params),
          address: {
            street: street || undefined,
            city: parts[3] || undefined,
            region: parts[4] || undefined,
            postalCode: parts[5] || undefined,
            country: parts[6] || undefined,
          },
        });
        break;
      }
      case "org": {
        const parts = splitComponents(value).map(unescapeVcardText);
        if (parts[0]) {
          organizations.push({
            id: generateFieldId(),
            name: parts[0],
            department: parts[1] || undefined,
          });
        }
        break;
      }
      case "title":
        titleValue = unescapeVcardText(value);
        break;
      case "bday":
        birthday = parseVcardDate(value);
        break;
      case "categories":
        // A comma-separated *list*, not `splitComponents`' semicolon
        // structured components with comma sub-values (N/ADR/ORG's own
        // shape) — `splitEscapedList` respects an escaped `\,` inside one
        // category name rather than always breaking on it.
        categories = splitEscapedList(value)
          .map(unescapeVcardText)
          .map((c) => c.trim())
          .filter(Boolean);
        break;
      case "note":
        notes = unescapeVcardText(value);
        break;
      case "uid":
        uid = value;
        break;
      case "photo":
        photo = parseVcardPhoto(params, value);
        break;
      case CARDDAV_CUSTOM_FIELDS_PROPERTY:
        bundledCustomFields = parseBundledCustomFields(value);
        break;
      default:
        break;
    }
  }

  if (titleValue && organizations[0]) organizations[0].title = titleValue;

  const emailSplit = splitTypedContactFields("email", emails);
  const phoneSplit = splitTypedContactFields("phone", phones);
  const websiteSplit = splitTypedContactFields("website", websites);
  const addressSplit = addressEntries.reduce<{
    standard: ContactAddress[];
    custom: CustomField[];
  }>(
    (acc, entry) => {
      const demoted = demoteContactAddress({
        id: generateFieldId(),
        type: entry.type,
        primary: entry.primary,
        ...entry.address,
      });
      if (demoted.standard) acc.standard.push(demoted.standard);
      if (demoted.custom) acc.custom.push(demoted.custom);
      return acc;
    },
    { standard: [], custom: [] },
  );

  return {
    fields: {
      name,
      emails: emailSplit.standard as ContactWritableFields["emails"],
      phones: phoneSplit.standard as ContactWritableFields["phones"],
      addresses: addressSplit.standard,
      websites: websiteSplit.standard as ContactWritableFields["websites"],
      organizations,
      birthday,
      notes,
      customFields: [
        ...emailSplit.custom,
        ...phoneSplit.custom,
        ...websiteSplit.custom,
        ...addressSplit.custom,
        ...bundledCustomFields,
      ],
    },
    categories,
    photo,
    uid,
  };
}

export interface SerializeVcardArgs {
  /** The last raw vCard this Contact held, or `null` for a Contact that has never had one (a Local Contact's very first push upstream) — every unmodelled line here survives into the result untouched. */
  previousRawVcard: string | null;
  fields: ContactWritableFields;
  categories: string[];
  /** Present only when a User's own upload set/changed this Contact's photo since the last confirmed write — `undefined` leaves whatever `PHOTO` line `previousRawVcard` already carried alone, `null` removes it. */
  photo?: { mimeType: string; base64: string } | null;
  /** The vCard's own `UID` — reused from `previousRawVcard` when present; required for a brand-new one. */
  uid: string;
}

/**
 * Re-serialises only the modelled properties this module understands,
 * leaving every other line of `previousRawVcard` exactly where it was
 * (`parseVcard`'s own doc comment states the whole rule this implements).
 * A brand-new vCard (`previousRawVcard: null`) gets `VERSION:3.0` — the
 * widest-supported, RFC 2426/vCard 3 shape every surveyed server accepts —
 * and an existing one keeps whatever `VERSION` it already declared.
 */
export function serializeVcard(args: SerializeVcardArgs): string {
  const previousLines = args.previousRawVcard ? unfoldVcardLines(args.previousRawVcard) : [];
  const version = args.previousRawVcard ? extractVersion(args.previousRawVcard) : "3.0";
  const preserved = previousLines.filter((line) => {
    const parsed = parsePropertyLine(line);
    return !parsed || !MODELLED_PROPERTY_NAMES.has(parsed.name);
  });

  const generated = buildModelledLines(args);

  const uidLine = previousLines.some((line) => parsePropertyLine(line)?.name === "uid")
    ? []
    : [`UID:${args.uid}`];

  return ["BEGIN:VCARD", `VERSION:${version}`, ...uidLine, ...preserved, ...generated, "END:VCARD"]
    .map(foldVcardLine)
    .join("\r\n");
}

function buildModelledLines(args: SerializeVcardArgs): string[] {
  const { fields, categories } = args;
  const lines: string[] = [];

  lines.push(`FN:${escapeVcardText(contactDisplayName(fields))}`);
  lines.push(
    `N:${[
      fields.name.family,
      fields.name.given,
      fields.name.middle,
      fields.name.prefix,
      fields.name.suffix,
    ]
      .map((part) => escapeVcardText(part ?? ""))
      .join(";")}`,
  );

  const bundledCustomFields: CustomField[] = [];
  for (const field of fields.customFields) {
    if (field.type === "phone" || field.type === "website") {
      lines.push(buildTypedXTypeLine(field));
    } else {
      bundledCustomFields.push(field);
    }
  }

  for (const email of fields.emails) lines.push(buildTypedLine("EMAIL", email));
  for (const phone of fields.phones) lines.push(buildTypedLine("TEL", phone));
  for (const website of fields.websites) lines.push(buildTypedLine("URL", website));
  for (const address of fields.addresses) lines.push(buildAdrLine(address));
  fields.organizations.forEach((organization, index) => {
    lines.push(
      `ORG:${escapeVcardText(organization.name)}${organization.department ? `;${escapeVcardText(organization.department)}` : ""}`,
    );
    if (index === 0 && organization.title)
      lines.push(`TITLE:${escapeVcardText(organization.title)}`);
  });

  if (fields.birthday) lines.push(`BDAY:${formatVcardDate(fields.birthday)}`);
  if (fields.notes) lines.push(`NOTE:${escapeVcardText(fields.notes)}`);
  if (categories.length > 0) {
    lines.push(`CATEGORIES:${categories.map(escapeVcardText).join(",")}`);
  }
  if (bundledCustomFields.length > 0) {
    lines.push(`X-WICKET-CUSTOMFIELDS:${escapeVcardText(JSON.stringify(bundledCustomFields))}`);
  }

  if (args.photo === null) {
    // Explicitly cleared — no PHOTO line at all (`previousRawVcard`'s own,
    // if any, was already dropped by the `preserved` filter above).
  } else if (args.photo) {
    lines.push(
      `PHOTO;ENCODING=b;TYPE=${mimeTypeToVcardType(args.photo.mimeType)}:${args.photo.base64}`,
    );
  }
  // `args.photo === undefined`: leave the photo alone — but this function
  // only ever regenerates lines, it never re-emits an *unchanged* `PHOTO`
  // line from `previousRawVcard`, since that line was already stripped by
  // the `preserved` filter. The caller (`write-back-loop.ts`) is expected to
  // pass the Contact's current photo (from the Blob Store) on every write
  // whenever one is set, not only when it just changed.

  return lines;
}

/** `ContactEmail`/`ContactPhone`/`ContactWebsite` share this shape — the standard-family entries `ContactWritableFields` actually stores, distinct from the `ContactTypedFieldInput` (`.label`) the *parse* side produces before `splitTypedContactFields` sorts it (`typedFieldInput`'s own doc comment). */
function buildTypedLine(
  property: string,
  entry: { type: string; value: string; primary: boolean },
): string {
  const typeParam = entry.primary ? `${entry.type},pref` : entry.type;
  return `${property};TYPE=${escapeVcardParam(typeParam)}:${escapeVcardText(entry.value)}`;
}

/** A Custom Field of type `phone`/`website` rides its native property with an `x-`-prefixed `TYPE` (#226's own acceptance line) rather than the bundled `X-WICKET-CUSTOMFIELDS` property — a real vCard `TYPE=x-…` extension value (RFC 6350 §5.6's own `x-name` production), not a Wicket invention. */
function buildTypedXTypeLine(field: CustomField): string {
  const property = field.type === "phone" ? "TEL" : "URL";
  return `${property};TYPE=x-${escapeVcardParam(field.label)}:${escapeVcardText(field.value)}`;
}

function buildAdrLine(address: ContactAddress): string {
  const typeParam = address.primary ? `${address.type},pref` : address.type;
  const components = [
    "",
    "",
    address.street ?? "",
    address.city ?? "",
    address.region ?? "",
    address.postalCode ?? "",
    address.country ?? "",
  ]
    .map(escapeVcardText)
    .join(";");
  return `ADR;TYPE=${escapeVcardParam(typeParam)}:${components}`;
}

// --- line-level parsing ----------------------------------------------------

/** Unfolds RFC 6350 §3.2 continuation lines (a line starting with a single space or tab is a continuation of the previous one) and drops `BEGIN`/`END`/`VERSION` — those three are structural, handled by `serializeVcard` itself rather than filtered out of an ordinary property list. */
function unfoldVcardLines(raw: string): string[] {
  const rawLines = raw.split(/\r\n|\r|\n/);
  const unfolded: string[] = [];
  for (const line of rawLines) {
    if (line.length === 0) continue;
    if ((line.startsWith(" ") || line.startsWith("\t")) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += line.slice(1);
    } else {
      unfolded.push(line);
    }
  }
  return unfolded.filter((line) => {
    const upper = line.toUpperCase();
    return (
      !upper.startsWith("BEGIN:") && !upper.startsWith("END:") && !upper.startsWith("VERSION:")
    );
  });
}

function extractVersion(raw: string): string {
  const match = /^VERSION:(.+)$/im.exec(raw);
  return match?.[1]?.trim() ?? "3.0";
}

/** RFC 6350 §3.2's own fold: a line over 75 octets breaks after 75, continuing with a single leading space. Octet-counted via UTF-8 byte length, not JS string length, so a multi-byte character never folds mid-codepoint. */
function foldVcardLine(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const chunks: string[] = [];
  let offset = 0;
  let first = true;
  while (offset < bytes.length) {
    const limit = first ? 75 : 74; // continuation lines lose one octet to their own leading space
    let end = Math.min(offset + limit, bytes.length);
    // Never split a multi-byte UTF-8 codepoint: back off while the next
    // octet is a continuation byte (`10xxxxxx`).
    while (end < bytes.length && (bytes.readUInt8(end) & 0xc0) === 0x80) end -= 1;
    chunks.push(bytes.subarray(offset, end).toString("utf8"));
    offset = end;
    first = false;
  }
  return chunks.join("\r\n ");
}

interface ParsedProperty {
  /** Lowercased property name, e.g. `"email"`, `"x-wicket-customfields"`. */
  name: string;
  params: Record<string, string[]>;
  value: string;
}

/** Splits one unfolded property line into its name, parameters and raw (still-escaped) value — tolerant of a group prefix (`item1.EMAIL:...`, RFC 6350 §3.3) by dropping everything before the last `.` in the name segment. */
function parsePropertyLine(line: string): ParsedProperty | null {
  const colonIndex = findUnquotedColon(line);
  if (colonIndex === -1) return null;
  const head = line.slice(0, colonIndex);
  const value = line.slice(colonIndex + 1);
  const segments = head.split(";");
  const rawName = segments[0];
  if (!rawName) return null;
  const name = (
    rawName.includes(".") ? rawName.slice(rawName.lastIndexOf(".") + 1) : rawName
  ).toLowerCase();

  const params: Record<string, string[]> = {};
  for (const segment of segments.slice(1)) {
    const eq = segment.indexOf("=");
    if (eq === -1) continue;
    const key = segment.slice(0, eq).toLowerCase();
    const raw = segment.slice(eq + 1).replace(/^"|"$/g, "");
    params[key] = raw.split(",").map((v) => v.trim().toLowerCase());
  }
  return { name, params, value };
}

/** The first `:` outside of a `"…"` quoted parameter value — a plain `indexOf` would cut a value like `ADR;LABEL="Home, Anytown:99":…` in the wrong place. */
function findUnquotedColon(line: string): number {
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') inQuotes = !inQuotes;
    else if (char === ":" && !inQuotes) return i;
  }
  return -1;
}

/** `;`-separated structured-value components (`N`, `ADR`, `ORG`) — a bare `split(";")` since a comma-separated sub-component (RFC 6350 §4.2's multi-value components, e.g. two street lines) is joined back with a space rather than modelled as its own list, matching this app's own single-string `ContactAddress` fields. */
function splitComponents(value: string): string[] {
  return value.split(";").map((part) => part.replace(/,/g, " ").trim());
}

/** `CATEGORIES`' own list delimiter (RFC 6350 §6.6.1: a comma-separated `text-list`) — splits on an unescaped `,` only, so a category name containing an escaped `\,` survives as one entry rather than breaking in two. */
function splitEscapedList(value: string): string[] {
  const items: string[] = [];
  let current = "";
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i] as string;
    if (char === "\\" && i + 1 < value.length) {
      current += char + value[i + 1];
      i += 1;
    } else if (char === ",") {
      items.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  items.push(current);
  return items;
}

function vcardTypeLabel(params: Record<string, string[]>): string {
  const types = (params.type ?? []).filter((t) => t !== "pref");
  return types[0] ?? "other";
}

function hasPrefParam(params: Record<string, string[]>): boolean {
  return (params.type ?? []).includes("pref");
}

function typedFieldInput(params: Record<string, string[]>, value: string): ContactTypedFieldInput {
  const rawLabel = vcardTypeLabel(params);
  // `TYPE=x-boat` (this module's own write side, `buildTypedXTypeLine`) round-trips
  // back to the bare label `splitTypedContactFields` checks against — an
  // `x-` prefix is this module's own extension-value marker, not part of the
  // label a User typed, and stripping it here is what makes a Custom Field
  // survive a full down-then-up round trip with the same label it started
  // with (`splitTypedContactFields` demotes it right back to one, since
  // "boat" is still outside `CONTACT_FIELD_TYPES` either way).
  const label = rawLabel.startsWith("x-") ? rawLabel.slice(2) : rawLabel;
  return {
    id: generateFieldId(),
    label,
    value: unescapeVcardText(value),
    primary: hasPrefParam(params),
  };
}

function parseVcardDate(value: string): ContactBirthday | null {
  // vCard 4 (RFC 6350 §4.3.1) year-less form: `--MM-DD` or `--MMDD`.
  const yearless = /^--(\d{2})-?(\d{2})$/.exec(value.trim());
  if (yearless) {
    return { month: Number(yearless[1]), day: Number(yearless[2]), year: null };
  }
  const full = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(value.trim());
  if (full) {
    return { year: Number(full[1]), month: Number(full[2]), day: Number(full[3]) };
  }
  return null;
}

function formatVcardDate(birthday: ContactBirthday): string {
  const month = String(birthday.month).padStart(2, "0");
  const day = String(birthday.day).padStart(2, "0");
  if (birthday.year === null) return `--${month}-${day}`;
  return `${birthday.year}-${month}-${day}`;
}

function parseVcardPhoto(
  params: Record<string, string[]>,
  value: string,
): { mimeType: string; bytes: Buffer } | null {
  const encoding = params.encoding?.[0];
  if (encoding !== "b" && encoding !== "base64") return null; // a `VALUE=uri:` reference — never fetched, `ParsedVcard.photo`'s own doc comment
  const typeParam = params.type?.[0];
  const mimeType = typeParam ? vcardTypeToMimeType(typeParam) : "image/jpeg";
  try {
    return { mimeType, bytes: Buffer.from(value, "base64") };
  } catch {
    return null;
  }
}

function vcardTypeToMimeType(type: string): string {
  const normalized = type.toLowerCase();
  if (normalized === "png") return "image/png";
  if (normalized === "webp") return "image/webp";
  return "image/jpeg";
}

function mimeTypeToVcardType(mimeType: string): string {
  if (mimeType === "image/png") return "PNG";
  if (mimeType === "image/webp") return "WEBP";
  return "JPEG";
}

function parseBundledCustomFields(value: string): CustomField[] {
  try {
    const parsed: unknown = JSON.parse(unescapeVcardText(value));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is CustomField =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as CustomField).id === "string" &&
        typeof (entry as CustomField).label === "string" &&
        typeof (entry as CustomField).value === "string",
    );
  } catch {
    return [];
  }
}

/** A stable id for a family entry parsed off the wire — this app's own `ContactTypedFieldInput.id` is never carried by vCard itself, so a fresh one is minted every parse the same way `mapping.ts#googlePersonToContactFields` already does for Google's own field families. */
function generateFieldId(): string {
  return randomUUID();
}

// --- vCard TEXT escaping (RFC 6350 §3.4) -----------------------------------

function escapeVcardText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function unescapeVcardText(value: string): string {
  return value.replace(/\\([\\,;nN])/g, (_match, char: string) =>
    char === "n" || char === "N" ? "\n" : char,
  );
}

/** Parameter values can't carry the TEXT escapes above — a value containing `,`/`;`/`:`/`"` is simply not representable unescaped as a bare `TYPE=` token, so this only ever strips characters a real label should never contain rather than attempting the (nonexistent) vCard parameter escape. */
function escapeVcardParam(value: string): string {
  return value.replace(/[,;:"]/g, "");
}
