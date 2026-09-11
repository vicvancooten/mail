import { useCallback } from "react";
import { ContactDialog } from "../contacts/ContactDialog.js";
import { useDefaultAddressBook } from "../store/address-books.js";
import { contactsRoute } from "./routes.js";

/**
 * `/contacts/new` (#211): the grid's own "New contact" entry point —
 * `ContactDialog` in Create mode (`contactId: null`), against the User's
 * Default Address Book (`useDefaultAddressBook`, the preference this same
 * ticket lands). A real route rather than local dialog state in
 * `ContactsGrid.tsx` for the same reason `/notes/$noteId` is: a reload or a
 * shared link reopens straight into it, and closing is an ordinary
 * navigation back to `/contacts`, not a piece of grid state to restore.
 */
export function NewContactRoute() {
  const navigate = contactsRoute.useNavigate();
  const addressBook = useDefaultAddressBook();
  const onClose = useCallback(() => {
    void navigate({ to: "/contacts", replace: true });
  }, [navigate]);
  // Never actually called — a brand-new Contact has no Mail history tab to
  // click a row in (`ContactDialog.tsx`'s own "Never called" doc comment on
  // the prop) — but `ContactDialog` still takes it, `ContactDialogRoute.tsx`'s
  // own real implementation.
  const onOpenThread = useCallback(
    (threadId: string) => {
      void navigate({ to: "/mail", search: { thread: threadId } });
    },
    [navigate],
  );

  // Before the Address Book collection's first sync round lands, there is
  // nothing to create the Contact into yet — the same brief gap
  // `ContactDialogRoute.tsx` accepts for its own pair of live queries.
  if (!addressBook) return null;

  return (
    <ContactDialog
      addressBook={addressBook}
      contactId={null}
      onClose={onClose}
      onOpenThread={onOpenThread}
    />
  );
}
