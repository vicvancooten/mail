import { z } from "zod";
import { contactEmailMatchKey, contactPhoneMatchKey } from "./contact-duplicates.js";
import type {
  Contact,
  ContactAddress,
  ContactBirthday,
  ContactEmail,
  ContactName,
  ContactOrganization,
  ContactPhone,
  ContactWebsite,
  CustomField,
} from "./contacts.js";

/**
 * `ContactLink` (#222, ADR-0026: "Linked Contacts are a User-scoped link,
 * never a change to any record") — the one collection this ticket adds, and
 * the whole of what linking two Contacts writes anywhere. Every record stays
 * exactly where it is, in the Address Book it came from, with the fields its
 * own Origin can hold; this row only says "these are one person", which is
 * why an unlink can restore two cards with nothing to reconstruct
 * (`unlinkContact`, `sync.ts#userMutationIntentSchema`).
 *
 * A **set**, not a pair: `contactIds` holds every record linked into one
 * person, so linking a third Contact to an already-linked pair is one row
 * gaining a member rather than three pairwise rows a reader would have to
 * take the transitive closure of. The invariant every reader may rely on is
 * that a Contact appears in **at most one** link — the Sync Backend's own
 * `linkContacts` handler enforces it by unioning whatever links the two
 * sides already belong to (`contacts/link-store.ts#linkContacts`), so two
 * separately-linked pairs meeting become one group of four rather than an
 * ambiguity.
 *
 * `frontContactId` is the User's own explicit pick of which record fronts
 * the card, and `null` — the ordinary case — means "derive it", which
 * `resolveLinkedContactFront` below does: the record in the Default Address
 * Book, else the most recently edited (ADR-0026/this ticket's own acceptance
 * line). Kept nullable rather than eagerly resolved at link time so that a
 * User who never picks keeps following their Default Address Book when they
 * change it, instead of being pinned to whatever was default the day they
 * linked.
 *
 * User-scoped and whole-replicated, `Note`'s own posture: a link spans
 * Address Books of different Origins by construction, so it can belong to
 * no Connected Account's Sync Scope — it is the User's own private
 * assertion, never written upstream (the same "never written upstream" line
 * CONTEXT.md's **Label** entry already holds).
 */
export const contactLinkSchema = z.object({
  id: z.string(),
  /** Every Contact linked into this one person. Always at least two live members — a link that falls to one is deleted outright rather than kept as a group of one (`link-store.ts#pruneContactLinkMembers`). */
  contactIds: z.array(z.string()),
  /** The User's own explicit "front this record" pick, or `null` to derive it (`resolveLinkedContactFront`). */
  frontContactId: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ContactLink = z.infer<typeof contactLinkSchema>;

/** The link one Contact belongs to, or `null` — the invariant above (at most one) is what lets this return a single row rather than a list. */
export function contactLinkFor(
  links: readonly ContactLink[],
  contactId: string,
): ContactLink | null {
  return links.find((link) => link.contactIds.includes(contactId)) ?? null;
}

/**
 * One person as the grid and the Person Page see them: either a single
 * unlinked Contact (`link: null`) or every record linked into one, front
 * first. `key` is what a React list keys on and what a "one card per person"
 * count is taken over — the link's own id for a linked group, the Contact's
 * own id otherwise, so a group's card identity survives its members'
 * fronting changing.
 */
export interface LinkedContactGroup {
  readonly key: string;
  readonly link: ContactLink | null;
  readonly front: Contact;
  /** Front first, then the rest most-recently-edited first. Always non-empty; length 1 exactly when `link` is `null`. */
  readonly members: readonly Contact[];
}

export interface ResolveLinkedContactsOptions {
  /** Which Address Book currently fronts a linked card by default (`store/address-books.ts#readDefaultAddressBook`) — `null`/absent falls straight through to "most recently edited". */
  readonly defaultAddressBookId?: string | null;
}

/**
 * Which record fronts a linked card (ADR-0026: "the record in the Default
 * Address Book fronts the card", this ticket's own acceptance line: "else
 * the most recently edited; the User can pick another"), in that order of
 * precedence:
 *
 * 1. `frontContactId`, when the User picked one **and** that record is still
 *    a live member — a pick that outlived its record falls through rather
 *    than fronting nothing.
 * 2. The member in the Default Address Book. Ties (two records in one book,
 *    which a within-book duplicate makes possible) break on rule 3.
 * 3. The most recently edited member (`updatedAt`), with the id as a final
 *    tiebreak so this is a total order and never renders differently between
 *    two devices holding the same rows.
 */
export function resolveLinkedContactFront(
  members: readonly Contact[],
  link: ContactLink | null,
  options: ResolveLinkedContactsOptions = {},
): Contact {
  const first = members[0];
  if (!first) throw new Error("resolveLinkedContactFront: no members");

  const picked = link?.frontContactId
    ? members.find((member) => member.id === link.frontContactId)
    : undefined;
  if (picked) return picked;

  const byRecency = [...members].sort(compareByRecency);
  const defaultAddressBookId = options.defaultAddressBookId ?? null;
  if (defaultAddressBookId !== null) {
    const inDefault = byRecency.find((member) => member.addressBookId === defaultAddressBookId);
    if (inDefault) return inDefault;
  }
  return byRecency[0] ?? first;
}

function compareByRecency(left: Contact, right: Contact): number {
  const byUpdated = right.updatedAt.localeCompare(left.updatedAt);
  return byUpdated !== 0 ? byUpdated : left.id.localeCompare(right.id);
}

/**
 * Collapses a flat Contact collection into one entry per person (#222's own
 * acceptance line: "One card and one Person Page"; "Unlink restores two
 * cards" is simply this same function seeing one link fewer). The grid calls
 * it over the Contacts in Account Scope and renders one card per group
 * (`ContactsGrid.tsx`).
 *
 * A link whose members aren't all present — one of them outside the current
 * Address Book filter or Account Scope, or a mirrored record whose book has
 * since been unmirrored — contributes only the members that *are* present,
 * and falls back to plain unlinked cards when fewer than two survive.
 * A linked card is a claim about records the User can actually see; it never
 * silently hides a Contact because its partner is out of view.
 */
export function resolveLinkedContactGroups(
  contacts: readonly Contact[],
  links: readonly ContactLink[],
  options: ResolveLinkedContactsOptions = {},
): LinkedContactGroup[] {
  const byId = new Map(contacts.map((contact) => [contact.id, contact]));
  const grouped = new Set<string>();
  const groups: LinkedContactGroup[] = [];

  for (const link of links) {
    const members = link.contactIds
      .map((id) => byId.get(id))
      .filter((contact): contact is Contact => contact !== undefined);
    if (members.length < 2) continue;
    for (const member of members) grouped.add(member.id);
    groups.push(buildGroup(members, link, options));
  }

  for (const contact of contacts) {
    if (grouped.has(contact.id)) continue;
    groups.push({ key: contact.id, link: null, front: contact, members: [contact] });
  }

  return groups;
}

/** One person by any of their record ids — the Person Page's own read (`store/contact-links.ts#useLinkedContactGroup`), the single-Contact slice of `resolveLinkedContactGroups`. `null` when that id isn't in `contacts` at all. */
export function resolveLinkedContactGroup(
  contactId: string,
  contacts: readonly Contact[],
  links: readonly ContactLink[],
  options: ResolveLinkedContactsOptions = {},
): LinkedContactGroup | null {
  const byId = new Map(contacts.map((contact) => [contact.id, contact]));
  const self = byId.get(contactId);
  if (!self) return null;

  const link = contactLinkFor(links, contactId);
  if (!link) return { key: self.id, link: null, front: self, members: [self] };

  const members = link.contactIds
    .map((id) => byId.get(id))
    .filter((contact): contact is Contact => contact !== undefined);
  if (members.length < 2) return { key: self.id, link: null, front: self, members: [self] };
  return buildGroup(members, link, options);
}

function buildGroup(
  members: readonly Contact[],
  link: ContactLink,
  options: ResolveLinkedContactsOptions,
): LinkedContactGroup {
  const front = resolveLinkedContactFront(members, link, options);
  const rest = members.filter((member) => member.id !== front.id).sort(compareByRecency);
  return { key: link.id, link, front, members: [front, ...rest] };
}

/** One entry of a linked card's union, tagged with the record it came from — this ticket's own acceptance line: "each field edits the record it came from", which the UI can only honour if every row it draws knows its own source. */
export interface LinkedContactEntry<Value> {
  readonly sourceContactId: string;
  readonly entry: Value;
}

/**
 * A linked card's fields (#222, ADR-0026: "the union of fields shows on one
 * Person Page"). Every repeatable family is the concatenation of its
 * members' own entries, front record first, with an entry whose value
 * duplicates one already contributed dropped — the same email held by both
 * a Google record and a Local one is what made them a possible duplicate in
 * the first place, so showing it twice would make every linked card read
 * like a mistake.
 *
 * The **single-valued** pieces resolve rather than concatenate: `name` and
 * `birthday` take the front record's, falling back to the first member that
 * holds one at all (a Google record fronting a Local one it has no birthday
 * on still shows the birthday, which is the whole point of a union), while
 * `notes` stays one entry **per record** rather than a concatenated blob,
 * because a note is prose a User wrote in a particular Address Book and
 * merging two of them into one paragraph invents a document neither record
 * holds.
 *
 * `labelIds` unions outright: a Label is Wicket's own User-scoped tag
 * (CONTEXT.md), never an upstream field, so a Label on any record is a
 * Label on the person.
 */
export interface LinkedContactFields {
  readonly name: ContactName;
  /** Which record `name` came from — the one a rename edits. */
  readonly nameSourceContactId: string;
  readonly emails: readonly LinkedContactEntry<ContactEmail>[];
  readonly phones: readonly LinkedContactEntry<ContactPhone>[];
  readonly addresses: readonly LinkedContactEntry<ContactAddress>[];
  readonly websites: readonly LinkedContactEntry<ContactWebsite>[];
  readonly organizations: readonly LinkedContactEntry<ContactOrganization>[];
  readonly customFields: readonly LinkedContactEntry<CustomField>[];
  readonly birthday: LinkedContactEntry<ContactBirthday> | null;
  readonly notes: readonly LinkedContactEntry<string>[];
  readonly labelIds: readonly string[];
  /** Every upstream category across every record (#227), unioned the same way `labelIds` is — read-only chips, never written back to any Origin. */
  readonly categories: readonly string[];
  /**
   * The photo shown on the hero: the front record's, else the first member
   * that has one — a Contact's photo is a picture of a person, and the person
   * is the same person on every linked record. Kept as a tagged entry rather
   * than a bare value because a photo's bytes are addressed by *which record*
   * holds them (`api/contact-photos.ts#contactPhotoUrl`), so a caller needs
   * the source id to render it at all.
   */
  readonly photo: LinkedContactEntry<NonNullable<Contact["photo"]>> | null;
  /** The banner shown on the hero, resolved exactly like `photo`. */
  readonly banner: LinkedContactEntry<NonNullable<Contact["banner"]>> | null;
}

export function unionLinkedContactFields(group: LinkedContactGroup): LinkedContactFields {
  const members = group.members;
  const named = members.find((member) => contactHasName(member.name)) ?? group.front;

  return {
    name: named.name,
    nameSourceContactId: named.id,
    emails: dedupe(
      members,
      (member) => member.emails,
      (entry) => contactEmailMatchKey(entry.value) ?? entry.value.trim().toLowerCase(),
    ),
    phones: dedupe(
      members,
      (member) => member.phones,
      (entry) => contactPhoneMatchKey(entry.value) ?? entry.value.trim(),
    ),
    addresses: dedupe(members, (member) => member.addresses, contactAddressMatchKey),
    websites: dedupe(members, (member) => member.websites, contactWebsiteMatchKey),
    organizations: dedupe(members, (member) => member.organizations, contactOrganizationMatchKey),
    customFields: dedupe(members, (member) => member.customFields, contactCustomFieldMatchKey),
    birthday: resolveSingle(members, (member) => member.birthday),
    notes: members
      .filter((member) => member.notes.trim().length > 0)
      .map((member) => ({ sourceContactId: member.id, entry: member.notes })),
    labelIds: [...new Set(members.flatMap((member) => member.labelIds))],
    categories: [...new Set(members.flatMap((member) => member.categories))],
    photo: resolveSingle(members, (member) => member.photo),
    banner: resolveSingle(members, (member) => member.banner),
  };
}

/** Whether a structured name actually holds anything — `unionLinkedContactFields`' own "falls back to the first member that holds one at all" check, reused by `contact-merge.ts`'s own single-valued `name` resolution (the same "does the survivor already have one" question, just between two records instead of across a whole group). */
export function contactHasName(name: ContactName): boolean {
  return Object.values(name).some((part) => typeof part === "string" && part.trim().length > 0);
}

/** What two `ContactAddress` entries must share to be "the same entry" — `dedupe`'s own key for the family, exported so `contact-merge.ts` folds two records' addresses on the exact same rule this union does. */
export function contactAddressMatchKey(
  entry: Pick<ContactAddress, "street" | "city" | "region" | "postalCode" | "country">,
): string {
  return [entry.street, entry.city, entry.region, entry.postalCode, entry.country]
    .map((part) => (part ?? "").trim().toLowerCase())
    .join("|");
}

/** `contactAddressMatchKey`'s own sibling for `ContactWebsite`. */
export function contactWebsiteMatchKey(entry: Pick<ContactWebsite, "value">): string {
  return entry.value.trim().toLowerCase();
}

/** `contactAddressMatchKey`'s own sibling for `ContactOrganization` (no `type`/`primary` of its own — a business, not a typed single value). */
export function contactOrganizationMatchKey(
  entry: Pick<ContactOrganization, "name" | "title" | "department">,
): string {
  return [entry.name, entry.title ?? "", entry.department ?? ""]
    .map((part) => part.trim().toLowerCase())
    .join("|");
}

/** `contactAddressMatchKey`'s own sibling for `CustomField`. */
export function contactCustomFieldMatchKey(
  entry: Pick<CustomField, "label" | "type" | "value">,
): string {
  return [entry.label, entry.type, entry.value].map((part) => part.trim().toLowerCase()).join("|");
}

function dedupe<Value>(
  members: readonly Contact[],
  pick: (member: Contact) => readonly Value[],
  keyOf: (entry: Value) => string,
): LinkedContactEntry<Value>[] {
  const seen = new Set<string>();
  const out: LinkedContactEntry<Value>[] = [];
  for (const member of members) {
    for (const entry of pick(member)) {
      const key = keyOf(entry);
      if (key.length > 0 && seen.has(key)) continue;
      if (key.length > 0) seen.add(key);
      out.push({ sourceContactId: member.id, entry });
    }
  }
  return out;
}

function resolveSingle<Value>(
  members: readonly Contact[],
  pick: (member: Contact) => Value | null,
): LinkedContactEntry<Value> | null {
  for (const member of members) {
    const value = pick(member);
    if (value !== null && value !== undefined) return { sourceContactId: member.id, entry: value };
  }
  return null;
}

/**
 * Every email address on every record of one person (#222's own acceptance
 * line: "The Person Page mail history covers every address on every linked
 * record") — the `participants` list the Mail history tab searches on
 * (`useMailHistory.ts`, #217, which explicitly left this as this ticket's
 * own to fill in). Deduped on the same normalised key detection itself pairs
 * on, so a shared address doesn't widen the search's own OR list for
 * nothing, and ordered front record first so the list is stable across
 * renders.
 */
export function linkedContactAddresses(group: LinkedContactGroup): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const member of group.members) {
    for (const email of member.emails) {
      const key = contactEmailMatchKey(email.value);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(email.value);
    }
  }
  return out;
}
