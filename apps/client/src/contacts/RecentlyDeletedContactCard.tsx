import type { Contact } from "@mail/shared";
import { contactDisplayName, contactOrganizationLine } from "@mail/shared";

/**
 * One card in Recently Deleted (#224) — `notes/RecentlyDeletedNoteCard.tsx`'s
 * own shape: greyed, read-only, one Restore control. Deliberately one card
 * per Contact **record**, never the linked union `ContactCard.tsx` shows on
 * the grid — a linked pair is always trashed (and restored) together
 * (`contacts/store.ts#trashContactAndLinkedGroup`'s own doc comment), so
 * restoring either sibling here brings the other back too, and it simply
 * stops appearing on the next sync round the same way any restored row does.
 */
export function RecentlyDeletedContactCard({
  contact,
  onRestore,
}: {
  contact: Contact;
  onRestore: () => void;
}) {
  const name = contactDisplayName(contact);
  const organizationLine = contactOrganizationLine(contact);

  return (
    <div className="contact-card contact-card-deleted">
      <div className="contact-card-body">
        <h3 className="contact-card-name">{name}</h3>
        {organizationLine ? <p className="contact-card-organization">{organizationLine}</p> : null}
      </div>
      <button type="button" className="contact-card-restore" onClick={onRestore}>
        Restore "{name}"
      </button>
    </div>
  );
}
