import type { Contact, ContactLink, ContactsSortOrder, LinkedContactGroup } from "@mail/shared";
import {
  contactDisplayName,
  contactMatchesQuery,
  contactSortKey,
  resolveLinkedContactGroups,
  unionLinkedContactFields,
} from "@mail/shared";

/**
 * The card directory's own selection (#211, extended by #222) — which
 * people the grid shows, in what order, lifted out of `ContactsGrid.tsx` so
 * the rules can be read and tested without a router or a rendered card
 * (`people-youve-mailed.ts`'s own posture beside its list component).
 *
 * The order the three steps run in is the whole of what makes the Duplicates
 * filter and the Address Book chips behave sanely together, so it lives here
 * rather than being re-derived by each caller:
 *
 * 1. **Detection first, over Account Scope as a whole** — a pair is a pair
 *    whether or not the User is currently looking at both halves of it, so
 *    filtering to one Address Book must not make the chip disappear from the
 *    record still on screen.
 * 2. **Then the filters** — Address Book chips (OR), the search text, and
 *    the Duplicates toggle, each narrowing the *records*.
 * 3. **Then grouping** — one card per person, from whatever records survived
 *    (`@mail/shared#resolveLinkedContactGroups`, whose own doc comment
 *    covers what a half-hidden group does).
 */
export interface ContactsDirectoryFilters {
  /** OR semantics; empty means every Address Book in Scope (`AddressBookFilter.tsx`). */
  readonly selectedAddressBookIds: ReadonlySet<string>;
  readonly query: string;
  /** The Duplicates filter (#222) — narrows to records with at least one possible duplicate left to answer. */
  readonly duplicatesOnly: boolean;
  readonly sortOrder: ContactsSortOrder;
  /** Which Address Book fronts a linked card by default (`@mail/shared#resolveLinkedContactFront`). */
  readonly defaultAddressBookId: string | null;
}

export function contactsDirectoryGroups(
  contactsInScope: readonly Contact[],
  links: readonly ContactLink[],
  duplicates: ReadonlyMap<string, readonly string[]>,
  filters: ContactsDirectoryFilters,
): LinkedContactGroup[] {
  const visible = contactsInScope
    .filter(
      (contact) =>
        filters.selectedAddressBookIds.size === 0 ||
        filters.selectedAddressBookIds.has(contact.addressBookId),
    )
    .filter((contact) => contactMatchesQuery(contact, filters.query))
    .filter((contact) => !filters.duplicatesOnly || duplicates.has(contact.id));

  return resolveLinkedContactGroups(visible, links, {
    defaultAddressBookId: filters.defaultAddressBookId,
  }).sort((left, right) =>
    contactsGroupSortKey(left, filters.sortOrder).localeCompare(
      contactsGroupSortKey(right, filters.sortOrder),
    ),
  );
}

/**
 * A person's own sort key: `contactSortKey`'s, but over the **union**'s name
 * (#222) so a group fronted by a record with no name of its own still sorts
 * under the name its card actually shows.
 */
export function contactsGroupSortKey(group: LinkedContactGroup, order: ContactsSortOrder): string {
  const fields = unionLinkedContactFields(group);
  const organizations = fields.organizations.map((entry) => entry.entry);
  const emails = fields.emails.map((entry) => entry.entry);
  const key = contactSortKey({ name: fields.name, organizations, emails }, order);
  return key.length > 0
    ? key
    : contactDisplayName({ name: fields.name, organizations, emails }).toLowerCase();
}
