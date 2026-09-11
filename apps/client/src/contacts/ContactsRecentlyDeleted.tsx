import { Link } from "@tanstack/react-router";
import { restoreContact, useDeletedContacts } from "../store/contacts.js";
import { useLocalCacheSync } from "../sync/use-local-cache-sync.js";
import "./contacts.css";
import { RecentlyDeletedContactCard } from "./RecentlyDeletedContactCard.js";

/**
 * Recently Deleted (#224): its own screen at `/contacts/recently-deleted`
 * (`router/routes.tsx#contactsRecentlyDeletedRoute`), not an overlay over the
 * grid the way the Person Page dialog is —
 * `notes/NotesRecentlyDeleted.tsx`'s own doc comment: a deleted Contact isn't
 * edited from here, so there is nothing underneath worth keeping visible.
 * `useDeletedContacts` already hands back the right sort
 * (`store/contacts.ts#readDeletedContacts`'s own doc comment); this only
 * lays the cards out.
 */
export function ContactsRecentlyDeleted() {
  useLocalCacheSync();
  const contacts = useDeletedContacts();

  return (
    <section className="contacts-grid-section" aria-label="Recently Deleted">
      <div className="contacts-recently-deleted-header">
        <Link to="/contacts" className="contacts-recently-deleted-back">
          ← Contacts
        </Link>
        <h2 className="contacts-grid-heading">Recently Deleted</h2>
      </div>
      {contacts && contacts.length === 0 ? (
        <p className="contacts-grid-empty">Nothing here.</p>
      ) : (
        <div className="contacts-grid">
          {(contacts ?? []).map((contact) => (
            <RecentlyDeletedContactCard
              key={contact.id}
              contact={contact}
              onRestore={() => void restoreContact(contact.id)}
            />
          ))}
        </div>
      )}
    </section>
  );
}
