import type { AddressBook, LinkedContactGroup } from "@mail/shared";
import {
  contactDisplayName,
  contactOrganizationLine,
  unionLinkedContactFields,
} from "@mail/shared";
import { Link } from "@tanstack/react-router";
import { addressBookOriginLabel } from "./address-book-origin.js";
import { contactBannerStyle } from "./contact-banner.js";
import { contactPhotoSrc } from "./contact-photo.js";

/**
 * One card in the directory (#211, the winning Variant B prototype from
 * #174): a full-bleed banner strip behind an overlapping avatar, the name
 * and organisation line, and the Origin badge sitting on the banner itself.
 * Read-only — the whole card is a `Link` to `/contacts/:contactId`, opening
 * the Contact in a dialog (`ContactDialog.tsx`) is entirely the router's job
 * the same way `NoteCard.tsx`'s own doc comment describes for Notes.
 *
 * One card per **person**, not per record (#222, ADR-0026: "One card and one
 * Person Page"): a linked group renders once, showing the union of its
 * records' fields and one Origin badge per record, and links to whichever
 * record currently fronts it. Unlinking restores two cards by simply leaving
 * two groups where there was one (`@mail/shared#resolveLinkedContactGroups`)
 * — nothing here knows the difference.
 *
 * `style` carries the stagger delay (`ContactsGrid.tsx`'s own
 * `--contact-card-index`) — set here rather than in the grid's CSS so each
 * card only ever needs the one custom property, not a `nth-child` rule per
 * possible grid size.
 */
export function ContactCard({
  group,
  addressBooks,
  duplicate,
  index,
}: {
  /** One person: a single Contact, or every record linked into one (#222). */
  group: LinkedContactGroup;
  /** Every Address Book in Scope by id — a linked card badges one Origin per member, so it needs more than the front record's own book. */
  addressBooks: ReadonlyMap<string, AddressBook>;
  /** Whether this person is a possible duplicate of some other Contact in Scope (#222) — the chip's own condition; computed once for the whole grid (`store/contact-links.ts#duplicateCandidatesInScope`) rather than per card. */
  duplicate: boolean;
  /** This card's position in the currently-filtered grid — the stagger-in delay's own input (#211's "cards stagger in on mount and on filter change"). */
  index: number;
}) {
  const fields = unionLinkedContactFields(group);
  const name = contactDisplayName({
    name: fields.name,
    organizations: fields.organizations.map((entry) => entry.entry),
    emails: fields.emails.map((entry) => entry.entry),
  });
  const organizationLine = contactOrganizationLine({
    organizations: fields.organizations.map((entry) => entry.entry),
  });
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  const photoSrc = fields.photo
    ? contactPhotoSrc({ id: fields.photo.sourceContactId, photo: fields.photo.entry })
    : null;
  // The fallback gradient keys off the front record's id (#211) — a linked
  // card's own identity is its link, but the gradient is a *person's* colour
  // and re-fronting shouldn't repaint half the grid, so this stays keyed on
  // the record whose name and photo the card is already showing.
  const banner = contactBannerStyle({
    id: group.front.id,
    banner: fields.banner?.entry ?? null,
  });

  const origins = [
    ...new Set(
      group.members
        .map((member) => addressBooks.get(member.addressBookId)?.capabilityTableId)
        .filter((id): id is NonNullable<typeof id> => id !== undefined)
        .map(addressBookOriginLabel),
    ),
  ];

  return (
    <Link
      to="/contacts/$contactId"
      params={{ contactId: group.front.id }}
      className="contact-card animate-in fade-in slide-in-from-bottom-2 duration-300 fill-mode-both"
      style={{ animationDelay: `${Math.min(index, 24) * 30}ms` }}
      aria-label={name}
    >
      <div className="contact-card-banner" style={{ background: banner }}>
        {origins.map((origin) => (
          <span key={origin} className="contact-card-origin-badge">
            {origin}
          </span>
        ))}
      </div>
      <div className="contact-card-avatar" aria-hidden="true">
        {photoSrc ? <img className="contact-card-avatar-image" src={photoSrc} alt="" /> : initial}
      </div>
      <div className="contact-card-body">
        <h3 className="contact-card-name">{name}</h3>
        {organizationLine ? <p className="contact-card-organization">{organizationLine}</p> : null}
        <div className="contact-card-chips">
          {group.link ? (
            <span className="contact-card-chip linked">{`Linked · ${group.members.length}`}</span>
          ) : null}
          {/* Detection suggests, never acts (ADR-0026) — a chip on the card
              and a filter on the grid, never a modal and never automatic. */}
          {duplicate ? (
            <span className="contact-card-chip duplicate">Possible duplicate</span>
          ) : null}
        </div>
      </div>
    </Link>
  );
}
