import { useCallback } from "react";
import { ContactDialog } from "../contacts/ContactDialog.js";
import { useAddressBook } from "../store/address-books.js";
import { useContact } from "../store/contacts.js";
import { contactsContactRoute, contactsRoute } from "./routes.js";

/**
 * `/contacts/$contactId`'s own route component (#211) — `NoteDialogRoute.tsx`'s
 * own shape, widened by one lookup: `ContactDialog` needs the Contact's own
 * Address Book (its capability table drives which fields the form shows),
 * not only its id, so this resolves both live queries before rendering
 * rather than the dialog resolving its own Address Book internally — the
 * same "the route is the one place that knows a screen lives at a route at
 * all" split `NoteDialogRoute.tsx` already draws.
 *
 * `key={contactId}` forces a fresh `ContactDialog` whenever the matched
 * `$contactId` changes without the route ever unmounting, `NoteDialogRoute.tsx`'s
 * own reasoning.
 */
export function ContactDialogRoute() {
  const { contactId } = contactsContactRoute.useParams();
  const navigate = contactsRoute.useNavigate();
  const contact = useContact(contactId);
  const addressBook = useAddressBook(contact?.addressBookId ?? null);
  const onClose = useCallback(() => {
    void navigate({ to: "/contacts", replace: true });
  }, [navigate]);
  // The Mail history tab's own row action (#217) — opens `/mail?thread=`,
  // `router/MailRoute.tsx`'s own restorable-selection search param, same
  // "the route is the one place that knows a screen lives at a route at
  // all" split every other navigation in this file already draws.
  const onOpenThread = useCallback(
    (threadId: string) => {
      void navigate({ to: "/mail", search: { thread: threadId } });
    },
    [navigate],
  );

  // A brief gap between `contactsContactRoute`'s own `beforeLoad` existence
  // check and these live queries resolving — both are already known to
  // exist by the time this renders, so this is a render or two, never a
  // real "wait forever" state.
  if (!contact || !addressBook) return null;

  return (
    <ContactDialog
      key={contactId}
      addressBook={addressBook}
      contactId={contactId}
      onClose={onClose}
      onOpenThread={onOpenThread}
    />
  );
}
