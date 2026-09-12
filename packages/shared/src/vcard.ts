import {
  type ContactAddress,
  type ContactBirthday,
  type ContactOrganization,
  type ContactTypedFieldInput,
  type ContactWritableFields,
  type CustomField,
  demoteContactAddress,
  EMPTY_CONTACT_FIELDS,
  splitTypedContactFields,
} from "./contacts.js";
import { generateUlid } from "./ulid.js";

/**
 * vCard 3.0/4.0 import and export (#225, `docs/contacts-spec.md` §Import,
 * export, copy, move) — hand-rolled rather than a dependency: both formats
 * share one line-oriented grammar simple enough that the app's own existing
 * upstream adapters (`contacts/google/mapping.ts`, `contacts/microsoft/mapping.ts`)
 * are a closer precedent than pulling in a library for it.
 *
 * Every typed family (`EMAIL`/`TEL`/`URL`) is handed to
 * `splitTypedContactFields` — the exact function `contacts.ts`'s own doc
 * comment names as this ticket's intended caller — so a vCard `TYPE` outside
 * this app's fixed vocabulary (`CONTACT_FIELD_TYPES`) demotes `TEL`/`URL` to
 * a Custom Field automatically, the same rule the local edit form already
 * applies to a User typing a non-standard label by hand. `EMAIL` is the one
 * exception: `splitTypedContactFields` never demotes an email (#283), so a
 * vCard `EMAIL` survives import regardless of its `TYPE`, blank included.
 * `ADR` gets the `TEL`/`URL` treatment through `demoteContactAddress`.
 *
 * Deliberately dropped on import, with nothing to lose data quietly since
 * none of these have anywhere in `ContactWritableFields` to land: `UID`,
 * `REV`, `PRODID`, `VERSION`, `KIND`, `GENDER`, `ANNIVERSARY`, `TZ`, `GEO`,
 * `LANG`, `KEY`, `SOUND`, `LOGO`, `SOURCE`, `XML`, `CLIENTPIDMAP`,
 * `RELATED`, `CATEGORIES` (Origin-owned on `Contact.categories`,
 * `contacts.ts`'s own doc comment — never a User-writable import target),
 * and a `PHOTO` that names a remote URI rather than carrying inline data (no
 * network fetch during import, the same "never a remote-image fetch from the
 * Client" posture `contact-photo.ts` already holds for a Contact's photo).
 * `NICKNAME` and any `X-` extension property become a Custom Field of type
 * `text`, labelled by the property name, rather than dropped outright.
 */

export interface ParsedVCardPhoto {
  mimeType: string;
  /** Still base64, undecoded — the caller turns this into upload bytes only once it actually creates the Contact (`vcard-import.ts` on the Client). */
  base64: string;
}

export interface ParsedVCard {
  fields: ContactWritableFields;
  photo: ParsedVCardPhoto | null;
}

interface RawVCardProperty {
  name: string;
  params: Record<string, string[]>;
  /** Still escaped (`\,`/`\;`/`\\`/`\n`) — unescaped only once split into its final components, since an escaped delimiter must survive that split. */
  rawValue: string;
}

/** RFC 6350 §3.2: a continuation line begins with exactly one SPACE or TAB, which is dropped along with the fold itself — nothing is inserted at the join. */
function unfoldLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rawLines = normalized.split("\n");
  const lines: string[] = [];
  for (const rawLine of rawLines) {
    if ((rawLine.startsWith(" ") || rawLine.startsWith("\t")) && lines.length > 0) {
      lines[lines.length - 1] += rawLine.slice(1);
    } else {
      lines.push(rawLine);
    }
  }
  return lines;
}

/** Splits on `delimiter`, ignoring one inside a double-quoted parameter value (RFC 6350's own `param-value = ... / DQUOTE ... DQUOTE`) — a `TYPE`/`LABEL` param is the only place this app's own vCards ever need to quote a delimiter. */
function splitUnquoted(str: string, delimiter: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const ch of str) {
    if (ch === '"') inQuotes = !inQuotes;
    if (ch === delimiter && !inQuotes) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

function findUnquotedColon(str: string): number {
  let inQuotes = false;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '"') inQuotes = !inQuotes;
    else if (str[i] === ":" && !inQuotes) return i;
  }
  return -1;
}

function parsePropertyLine(line: string): RawVCardProperty | null {
  const colonIndex = findUnquotedColon(line);
  if (colonIndex === -1) return null;
  const head = line.slice(0, colonIndex);
  const rawValue = line.slice(colonIndex + 1);
  const segments = splitUnquoted(head, ";");
  const nameSegment = segments[0];
  if (!nameSegment) return null;
  // A `group.NAME` prefix (RFC 6350 §3.3) names no group this app reads —
  // stripped so `PHOTO`/`item1.PHOTO` are the same property either way.
  const dot = nameSegment.lastIndexOf(".");
  const name = (dot === -1 ? nameSegment : nameSegment.slice(dot + 1)).toUpperCase();

  const params: Record<string, string[]> = {};
  for (const segment of segments.slice(1)) {
    const eq = segment.indexOf("=");
    if (eq === -1) continue; // a bare flag param (rare, no known use here) — nothing to key it by
    const key = segment.slice(0, eq).toUpperCase();
    let raw = segment.slice(eq + 1);
    if (raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1);
    const values = raw.split(",").map((value) => value.trim());
    params[key] = [...(params[key] ?? []), ...values];
  }
  return { name, params, rawValue };
}

/** RFC 6350 §3.4's four escapes — the only ones either format defines. */
function unescapeValue(value: string): string {
  return value.replace(/\\([\\,;nN])/g, (_match, ch: string) =>
    ch === "n" || ch === "N" ? "\n" : ch,
  );
}

/** A structured value's own components (`N`/`ADR`/`ORG`) split on an unescaped `;` — never on `,`, which stays literal punctuation inside one component (a street's own "Suite 4, Building B", say). */
function splitStructured(rawValue: string): string[] {
  const parts: string[] = [];
  let current = "";
  const chars = [...rawValue];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === "\\" && i + 1 < chars.length) {
      current += ch + chars[i + 1];
      i += 1;
      continue;
    }
    if (ch === ";") {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map(unescapeValue);
}

function parseOneCard(lines: string[]): ParsedVCard {
  const properties: RawVCardProperty[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const property = parsePropertyLine(trimmed);
    if (property) properties.push(property);
  }

  const fields: ContactWritableFields = { ...EMPTY_CONTACT_FIELDS };
  let fn: string | null = null;
  let photo: ParsedVCardPhoto | null = null;
  const customFields: CustomField[] = [];

  const emailInputs: ContactTypedFieldInput[] = [];
  const phoneInputs: ContactTypedFieldInput[] = [];
  const websiteInputs: ContactTypedFieldInput[] = [];
  const addressEntries: { id: string; type: string; primary: boolean; parts: string[] }[] = [];
  const organizations: ContactOrganization[] = [];

  for (const property of properties) {
    switch (property.name) {
      case "N": {
        const [family, given, middle, prefix, suffix] = splitStructured(property.rawValue);
        fields.name = {
          ...fields.name,
          ...(family ? { family } : {}),
          ...(given ? { given } : {}),
          ...(middle ? { middle } : {}),
          ...(prefix ? { prefix } : {}),
          ...(suffix ? { suffix } : {}),
        };
        break;
      }
      case "FN":
        fn = unescapeValue(property.rawValue);
        break;
      case "EMAIL":
        // No `"other"` fallback here (`typedInputFrom`'s own default for
        // every other typed family) — an EMAIL with no `TYPE` at all is
        // exactly the "blank label" case `splitTypedContactFields` itself
        // defaults to `"home"` (#283), not a standard label this module
        // should invent on its own.
        emailInputs.push(typedInputFrom(property, (raw) => raw, ""));
        break;
      case "TEL":
        phoneInputs.push(typedInputFrom(property, mapPhoneType));
        break;
      case "URL":
        websiteInputs.push(typedInputFrom(property));
        break;
      case "ADR": {
        const parts = splitStructured(property.rawValue);
        addressEntries.push({
          id: generateUlid(),
          type: firstType(property) ?? "other",
          primary: isPreferred(property),
          parts,
        });
        break;
      }
      case "ORG": {
        const [name, department] = splitStructured(property.rawValue);
        if (name)
          organizations.push({ id: generateUlid(), name, department: department || undefined });
        break;
      }
      case "TITLE":
        if (organizations[0]) organizations[0].title = unescapeValue(property.rawValue);
        break;
      case "BDAY": {
        const birthday = parseBirthday(unescapeValue(property.rawValue));
        if (birthday) fields.birthday = birthday;
        break;
      }
      case "NOTE":
        fields.notes = fields.notes
          ? `${fields.notes}\n\n${unescapeValue(property.rawValue)}`
          : unescapeValue(property.rawValue);
        break;
      case "PHOTO":
        photo = parsePhoto(property);
        break;
      case "NICKNAME":
        customFields.push({
          id: generateUlid(),
          label: "Nickname",
          type: "text",
          value: unescapeValue(property.rawValue),
        });
        break;
      default:
        if (property.name.startsWith("X-")) {
          customFields.push({
            id: generateUlid(),
            label: humanizeXPropertyName(property.name),
            type: "text",
            value: unescapeValue(property.rawValue),
          });
        }
      // Every other standard property (`UID`, `REV`, `PRODID`, `VERSION`,
      // `KIND`, `GENDER`, `ANNIVERSARY`, `TZ`, `GEO`, `LANG`, `KEY`, `SOUND`,
      // `LOGO`, `SOURCE`, `XML`, `CLIENTPIDMAP`, `RELATED`, `CATEGORIES`) is
      // dropped — this module's own doc comment names each and why.
    }
  }

  if (!fields.name.given && !fields.name.family && fn) {
    // No `N`, only `FN` (common in minimal vCards) — a best-effort split,
    // never attempted when a real `N` already answered the question.
    const words = fn.trim().split(/\s+/).filter(Boolean);
    if (words.length > 1) {
      fields.name = { ...fields.name, given: words.slice(0, -1).join(" "), family: words.at(-1) };
    } else if (words.length === 1) {
      fields.name = { ...fields.name, given: words[0] };
    }
  }

  const emails = splitTypedContactFields("email", resolvePrimary(emailInputs));
  const phones = splitTypedContactFields("phone", resolvePrimary(phoneInputs));
  const websites = splitTypedContactFields("website", resolvePrimary(websiteInputs));
  const addresses: ContactAddress[] = [];
  for (const entry of resolvePrimary(addressEntries)) {
    const [, , street, city, region, postalCode, country] = entry.parts;
    const { standard, custom } = demoteContactAddress({
      id: entry.id,
      type: entry.type,
      primary: entry.primary,
      street: street || undefined,
      city: city || undefined,
      region: region || undefined,
      postalCode: postalCode || undefined,
      country: country || undefined,
    });
    if (standard) addresses.push(standard);
    if (custom) customFields.push(custom);
  }

  fields.emails = emails.standard;
  fields.phones = phones.standard;
  fields.websites = websites.standard;
  fields.addresses = addresses;
  fields.organizations = organizations;
  fields.customFields = [...emails.custom, ...phones.custom, ...websites.custom, ...customFields];

  return { fields, photo };
}

/** `primary` here is only a *candidate* flag (whether this entry carried an explicit preference marker) — `resolvePrimary` below is what turns "zero or more preferred" into "exactly one primary" once every entry in the family is known. */
function typedInputFrom(
  property: RawVCardProperty,
  mapType: (raw: string) => string = (raw) => raw,
  fallbackLabel = "other",
): ContactTypedFieldInput {
  const type = firstType(property);
  return {
    id: generateUlid(),
    label: type ? mapType(type) : fallbackLabel,
    value: unescapeValue(property.rawValue),
    primary: isPreferred(property),
  };
}

/** Exactly one `primary` per family (every `ContactCapabilityTable`-gated family carries at most one, `validateContactFields`'s own `multiple_primary_${family}` check) — the first entry an explicit `PREF`/`TYPE=pref` named, falling back to the first entry outright so a family with none still reads sensibly. */
function resolvePrimary<T extends { primary: boolean }>(entries: readonly T[]): T[] {
  if (entries.length === 0) return [];
  const preferredIndex = entries.findIndex((entry) => entry.primary);
  const primaryIndex = preferredIndex === -1 ? 0 : preferredIndex;
  return entries.map((entry, index) => ({ ...entry, primary: index === primaryIndex }));
}

/** The first `TYPE` token that isn't the `pref` marker itself (`isPreferred` reads that one separately) — vCard 3's own multi-valued `TYPE=home,voice` convention, first non-preference token wins. */
function firstType(property: RawVCardProperty): string | null {
  const types = (property.params.TYPE ?? []).map((value) => value.toLowerCase());
  const real = types.find((value) => value !== "pref");
  return real ?? null;
}

/** vCard 3's `TYPE=PREF` and vCard 4's `PREF=1` (lowest number wins, but this app carries only one `primary` flag, so any `PREF` at all is enough to mark it). */
function isPreferred(property: RawVCardProperty): boolean {
  const types = (property.params.TYPE ?? []).map((value) => value.toLowerCase());
  if (types.includes("pref")) return true;
  return (property.params.PREF ?? [])[0] === "1";
}

const PHONE_TYPE_ALIASES: Record<string, string> = {
  cell: "mobile",
  iphone: "mobile",
  voice: "other",
};

function mapPhoneType(raw: string): string {
  return PHONE_TYPE_ALIASES[raw] ?? raw;
}

function humanizeXPropertyName(name: string): string {
  const stripped = name.slice(2).toLowerCase().replace(/[-_]+/g, " ");
  return stripped.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** `YYYY-MM-DD`/`YYYYMMDD` (a full date) or `--MM-DD`/`--MMDD` (RFC 6350's own yearless form) — anything else (a `VALUE=text` free-form BDAY, say) is unparseable and dropped rather than guessed at. */
function parseBirthday(raw: string): ContactBirthday | null {
  const yearless = /^--(\d{2})-?(\d{2})$/.exec(raw);
  if (yearless) return { month: Number(yearless[1]), day: Number(yearless[2]), year: null };
  const full = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(raw);
  if (full) return { month: Number(full[2]), day: Number(full[3]), year: Number(full[1]) };
  return null;
}

const VCARD_PHOTO_TYPE_TO_MIME: Record<string, string> = {
  JPEG: "image/jpeg",
  JPG: "image/jpeg",
  PNG: "image/png",
  WEBP: "image/webp",
};

/** Only an inline, base64-encoded `PHOTO` is imported (vCard 3's `ENCODING=b`/`BASE64` param, vCard 4's `data:` URI value) — a `PHOTO` naming a remote URI is dropped, this module's own doc comment. */
function parsePhoto(property: RawVCardProperty): ParsedVCardPhoto | null {
  const dataUri = /^data:([^;]+);base64,([\s\S]*)$/.exec(property.rawValue.trim());
  const [, dataUriMimeType, dataUriBase64] = dataUri ?? [];
  if (dataUriMimeType !== undefined && dataUriBase64 !== undefined) {
    return { mimeType: dataUriMimeType, base64: dataUriBase64.replace(/\s+/g, "") };
  }

  const encoding = (property.params.ENCODING ?? [])[0]?.toUpperCase();
  if (encoding !== "B" && encoding !== "BASE64") return null;
  const typeParam = (property.params.TYPE ?? [])[0]?.toUpperCase() ?? "JPEG";
  const mimeType = VCARD_PHOTO_TYPE_TO_MIME[typeParam] ?? "image/jpeg";
  return { mimeType, base64: property.rawValue.replace(/\s+/g, "") };
}

/** Every `VCARD` block in `text`, in file order (spec's own "multi-card") — a block that never finds its `END:VCARD` is dropped along with whatever it held, the same tolerance a truncated file deserves over throwing partway through an otherwise-good batch. */
export function parseVCards(text: string): ParsedVCard[] {
  const lines = unfoldLines(text);
  const cards: string[][] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^BEGIN:VCARD$/i.test(trimmed)) {
      current = [];
    } else if (/^END:VCARD$/i.test(trimmed)) {
      if (current) cards.push(current);
      current = null;
    } else if (current) {
      current.push(line);
    }
  }
  return cards.map(parseOneCard);
}

/** Folds a generated line at 75 characters (RFC 6350 §3.2) — a simplified, character- rather than octet-counted fold (this module's own concession, `parseVCards`'s own unfolding tolerates either). */
function foldLine(line: string): string {
  if (line.length <= 75) return line;
  let out = line.slice(0, 75);
  let rest = line.slice(75);
  while (rest.length > 0) {
    out += `\r\n ${rest.slice(0, 74)}`;
    rest = rest.slice(74);
  }
  return out;
}

function escapeValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/[,;]/g, "\\$&").replace(/\n/g, "\\n");
}

function propertyLine(name: string, params: string, value: string): string {
  return foldLine(`${name}${params}:${escapeValue(value)}`);
}

/** `N`/`ORG`'s own shape: each component escaped on its own, then joined with a literal (never escaped) `;` — escaping the joined string the way `propertyLine` does would turn every structural separator into an escaped one, collapsing the whole value back to one component. */
function structuredLine(
  name: string,
  params: string,
  parts: readonly (string | undefined)[],
): string {
  return foldLine(`${name}${params}:${parts.map((part) => escapeValue(part ?? "")).join(";")}`);
}

/** A raw value type (`PHOTO`'s own `data:` URI): never escaped — its `;`/`,` are the URI's own syntax, not this format's structural delimiters, and `parsePhoto` matches them literally. */
function rawLine(name: string, params: string, value: string): string {
  return foldLine(`${name}${params}:${value}`);
}

function typedPropertyLines(
  name: string,
  entries: readonly { type: string; value: string; primary: boolean }[],
): string[] {
  return entries.map((entry) => {
    const params = entry.primary ? `;TYPE=${entry.type},pref` : `;TYPE=${entry.type}`;
    return propertyLine(name, params, entry.value);
  });
}

/**
 * One `VCARD` 4.0 block for `fields` (export's own acceptance line: "one
 * vCard 4.0 file"), regardless of which Origin `fields` actually came from —
 * export never asks a capability table anything, since every family here by
 * definition already fit *this* Contact's own Origin. `photo`, given, is
 * inlined as a `data:` URI (the same shape vCard 4 itself defines for an
 * embedded value) rather than a `PHOTO;ENCODING=b;TYPE=...` line — nothing
 * about round-tripping through this module's own `parsePhoto` needs the
 * older v3 form once the file declares `VERSION:4.0`.
 */
export function contactWritableFieldsToVCard(
  fields: ContactWritableFields,
  photo: ParsedVCardPhoto | null = null,
): string {
  const lines: string[] = ["BEGIN:VCARD", "VERSION:4.0"];

  const { given, family, middle, prefix, suffix } = fields.name;
  if (given || family || middle || prefix || suffix) {
    lines.push(structuredLine("N", "", [family, given, middle, prefix, suffix]));
  }
  const fn = [fields.name.given, fields.name.family].filter(Boolean).join(" ").trim();
  lines.push(propertyLine("FN", "", fn || fields.organizations[0]?.name || "Unnamed contact"));

  lines.push(...typedPropertyLines("EMAIL", fields.emails));
  lines.push(...typedPropertyLines("TEL", fields.phones));
  lines.push(...typedPropertyLines("URL", fields.websites));

  for (const address of fields.addresses) {
    const params = address.primary ? `;TYPE=${address.type},pref` : `;TYPE=${address.type}`;
    lines.push(
      structuredLine("ADR", params, [
        "",
        "",
        address.street,
        address.city,
        address.region,
        address.postalCode,
        address.country,
      ]),
    );
  }

  for (const organization of fields.organizations) {
    lines.push(structuredLine("ORG", "", [organization.name, organization.department]));
    if (organization.title) lines.push(propertyLine("TITLE", "", organization.title));
  }

  if (fields.birthday) {
    const { year, month, day } = fields.birthday;
    const mm = String(month).padStart(2, "0");
    const dd = String(day).padStart(2, "0");
    lines.push(propertyLine("BDAY", "", year === null ? `--${mm}${dd}` : `${year}-${mm}-${dd}`));
  }

  if (fields.notes.trim().length > 0) lines.push(propertyLine("NOTE", "", fields.notes));

  for (const field of fields.customFields) {
    lines.push(
      propertyLine(`X-${field.label.toUpperCase().replace(/\s+/g, "-")}`, "", field.value),
    );
  }

  if (photo) lines.push(rawLine("PHOTO", "", `data:${photo.mimeType};base64,${photo.base64}`));

  lines.push("END:VCARD");
  return lines.join("\r\n");
}
