import { contactEmailMatchKey, contactPhoneMatchKey } from "./contact-duplicates.js";
import {
  contactAddressMatchKey,
  contactCustomFieldMatchKey,
  contactHasName,
  contactOrganizationMatchKey,
  contactWebsiteMatchKey,
} from "./contact-links.js";
import type {
  Contact,
  ContactCapabilityTable,
  ContactFieldFamily,
  ContactOrganization,
  ContactWritableFields,
  CustomField,
} from "./contacts.js";
import { contactFieldFamilyIsSupported, contactFieldFamilyLimit } from "./contacts.js";

/**
 * Merge within one Address Book (#223, ADR-0026: "the older record survives
 * and takes the other's fields; the other is deleted") — the other half of
 * #222's duplicates answer. Two records in the same Address Book share the
 * same capability table, which is exactly why a real Merge loses nothing
 * here the way linking two records across Origins would
 * (`contact-links.ts`'s own `DuplicateSuggestions` doc comment).
 *
 * A pure function over the two records and the Address Book's own
 * capability table, called identically by the Client (for its optimistic
 * local write) and the Sync Backend (for the write it actually confirms) —
 * `contact-links.ts#mergeLinkLocally`'s own "mirror the server's rule rather
 * than guess at something simpler" posture, generalized to a destructive
 * merge instead of a lossless union.
 */

/** Whether two Contacts are a real Merge candidate at all — the same Address Book, and not the same record. A cross-Origin pair is never mergeable (Link is offered instead, `ContactDialog.tsx#DuplicateSuggestions`); this is the guard both the Client's own action and a defensive server-side check share. */
export function contactsAreMergeable(
  a: Pick<Contact, "id" | "addressBookId">,
  b: Pick<Contact, "id" | "addressBookId">,
): boolean {
  return a.id !== b.id && a.addressBookId === b.addressBookId;
}

export interface ContactMergePair {
  /** The record that survives — takes the other's fields, keeps its own id, Labels and links. */
  readonly survivor: Contact;
  /** The record deleted once the merge lands. */
  readonly loser: Contact;
}

/**
 * Which record survives (this ticket's own acceptance line: "the older
 * record survives") — the earlier `createdAt`, with the id as a final
 * tiebreak so this is a total order and never disagrees between the Client's
 * own optimistic pick and whatever the Sync Backend confirms
 * (`contact-links.ts#compareByRecency`'s own reasoning, just the other
 * direction: oldest wins here, most recent wins there).
 */
export function pickContactMergeSurvivor(a: Contact, b: Contact): ContactMergePair {
  const byCreated = a.createdAt.localeCompare(b.createdAt);
  if (byCreated !== 0) return byCreated < 0 ? { survivor: a, loser: b } : { survivor: b, loser: a };
  return a.id.localeCompare(b.id) <= 0 ? { survivor: a, loser: b } : { survivor: b, loser: a };
}

/**
 * The survivor's fields after taking the loser's (this ticket's own
 * acceptance line) — every repeatable family is the deduped concatenation of
 * the survivor's own entries followed by the loser's (`dedupeByKey` below),
 * on the exact match keys `unionLinkedContactFields` already uses for the
 * same "what counts as the same entry" question, then trimmed to fit the
 * capability table both records already conform to (`normalizeFamily`) —
 * unioning two already-conforming records can still overflow a capped family
 * (Graph's own `organization: 1`, `contacts.ts#MICROSOFT_CONTACT_CAPABILITY_TABLE`)
 * or leave two entries flagged `primary`, and this is the one place both get
 * resolved before the merge ever reaches `validateContactFields`.
 *
 * The **single-valued** pieces resolve rather than concatenate, the survivor
 * winning whenever it actually holds one: `name` falls back to the loser's
 * only when the survivor's own is blank (`contactHasName`), `birthday` the
 * same, and `notes` — prose a User wrote in a particular record — folds the
 * loser's in only when the survivor's own is blank or the two differ, rather
 * than ever silently dropping either.
 *
 * `labelIds`, `banner` and `photo` are deliberately untouched: none of the
 * three lives in `ContactWritableFields` at all (`contacts.ts#contactSchema`'s
 * own doc comment — each rides its own intent, never `updateContact`), which
 * is what makes "the survivor keeps its ... Labels" (this ticket's own
 * acceptance line) true without this function having to do anything about
 * it.
 */
export function mergeContactFields(
  survivor: Contact,
  loser: Contact,
  table: ContactCapabilityTable,
): ContactWritableFields {
  return {
    name: contactHasName(survivor.name) ? survivor.name : loser.name,
    emails: normalizeFamily(
      dedupeByKey(
        survivor.emails,
        loser.emails,
        (entry) => contactEmailMatchKey(entry.value) ?? entry.value.trim().toLowerCase(),
      ),
      table,
      "email",
    ),
    phones: normalizeFamily(
      dedupeByKey(
        survivor.phones,
        loser.phones,
        (entry) => contactPhoneMatchKey(entry.value) ?? entry.value.trim(),
      ),
      table,
      "phone",
    ),
    addresses: normalizeFamily(
      dedupeByKey(survivor.addresses, loser.addresses, contactAddressMatchKey),
      table,
      "address",
    ),
    websites: normalizeFamily(
      dedupeByKey(survivor.websites, loser.websites, contactWebsiteMatchKey),
      table,
      "website",
    ),
    organizations: mergeOrganizations(survivor.organizations, loser.organizations, table),
    birthday: survivor.birthday ?? loser.birthday,
    notes: mergeNotes(survivor.notes, loser.notes),
    customFields: mergeCustomFields(survivor.customFields, loser.customFields, table),
  };
}

/** The survivor's own entries first, then the loser's, deduped on `keyOf` — an entry whose key is blank (never matched anything) always survives, `contact-links.ts#dedupe`'s own tolerance. */
function dedupeByKey<Value>(
  survivorEntries: readonly Value[],
  loserEntries: readonly Value[],
  keyOf: (entry: Value) => string,
): Value[] {
  const seen = new Set<string>();
  const out: Value[] = [];
  for (const entry of [...survivorEntries, ...loserEntries]) {
    const key = keyOf(entry);
    if (key.length > 0 && seen.has(key)) continue;
    if (key.length > 0) seen.add(key);
    out.push(entry);
  }
  return out;
}

/**
 * Trims a deduped typed family to what `table` actually allows: absent from
 * the table at all empties it outright (a state two same-book records can
 * never actually be in — the same table already governed both — kept only
 * because `ContactCapabilityTable.limits`'s own doc comment insists nothing
 * reads `limits[family]` without checking support first), a numeric cap
 * drops the overflow (the survivor's own entries first, so it is always the
 * loser's that give way), and at most one surviving entry keeps `primary`
 * — the survivor's own if it had one, the loser's demoted otherwise.
 */
function normalizeFamily<Value extends { primary: boolean }>(
  deduped: readonly Value[],
  table: ContactCapabilityTable,
  family: ContactFieldFamily,
): Value[] {
  if (!contactFieldFamilyIsSupported(table, family)) return [];
  const limit = contactFieldFamilyLimit(table, family);
  const capped = limit === undefined ? deduped : deduped.slice(0, limit);
  let primarySeen = false;
  return capped.map((entry) => {
    if (!entry.primary) return entry;
    if (primarySeen) return { ...entry, primary: false };
    primarySeen = true;
    return entry;
  });
}

/** `organizations` has no `primary` flag of its own (`contacts.ts#contactOrganizationSchema`'s own doc comment), so it only needs the dedupe-then-cap half of `normalizeFamily`. */
function mergeOrganizations(
  survivorEntries: readonly ContactOrganization[],
  loserEntries: readonly ContactOrganization[],
  table: ContactCapabilityTable,
): ContactOrganization[] {
  if (!contactFieldFamilyIsSupported(table, "organization")) return [];
  const deduped = dedupeByKey(survivorEntries, loserEntries, contactOrganizationMatchKey);
  const limit = contactFieldFamilyLimit(table, "organization");
  return limit === undefined ? deduped : deduped.slice(0, limit);
}

/** Custom Fields carry no per-count cap (`contacts.ts`'s own doc comment: "unbounded wherever `customFields` is true") — only the table's own all-or-nothing flag gates them. */
function mergeCustomFields(
  survivorEntries: readonly CustomField[],
  loserEntries: readonly CustomField[],
  table: ContactCapabilityTable,
): CustomField[] {
  if (!table.customFields) return [];
  return dedupeByKey(survivorEntries, loserEntries, contactCustomFieldMatchKey);
}

/** The survivor's own notes if it wrote any, folding the loser's in only when there is something to add — never a silent drop, never a pointless duplicate. */
function mergeNotes(survivorNotes: string, loserNotes: string): string {
  const survivor = survivorNotes.trim();
  const loser = loserNotes.trim();
  if (survivor.length === 0) return loserNotes;
  if (loser.length === 0 || survivor === loser) return survivorNotes;
  return `${survivorNotes}\n\n${loserNotes}`;
}
