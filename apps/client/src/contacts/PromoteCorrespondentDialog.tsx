import type { GatekeeperSender } from "@mail/shared";
import { generateUlid } from "@mail/shared";
import { useState } from "react";
import { useAddressBooks, useDefaultAddressBook } from "../store/address-books.js";
import { enqueueMutation } from "../store/mutation-queue.js";
import { ContactDialog } from "./ContactDialog.js";
import type { ContactFormState } from "./contact-form.js";
import type { MailedPersonRow } from "./people-youve-mailed.js";

/**
 * Save's own dialog off "People you've mailed" (#218's acceptance line:
 * "Save opens the promotion dialog pre-filled with the Correspondent's
 * display name and address, landing in the Default Address Book, with a
 * one-time override in the sheet") — and, per #219, the same sheet Save
 * from the Reader and the Screener opens. A thin wrapper around
 * `ContactDialog` in Create mode, never a fork of it: the whole
 * Save/Cancel/field-visibility behaviour is exactly `NewContactRoute.tsx`'s,
 * plus the two things unique to promoting a Correspondent — a pre-filled
 * name/address and a one-time Address Book picker — both threaded through
 * as plain `ContactDialog` props rather than new dialog machinery.
 *
 * `gatekeeper` is #219's own addition, absent from every #218 call site
 * (People You've Mailed, the Contacts App): this still never writes a
 * Verdict on its own, and off People You've Mailed there is still no
 * Approve control at all (that call site passes no `gatekeeper`, so the
 * checkbox below never renders) — spec's own "The Gatekeeper stays
 * decoupled" line. Only a caller opening this from mail (`ThreadDetailPane`
 * via the Reader's "save-sender" action, `ScreenerActions`'s own Save) hands
 * one, and only then does "Approve as well" appear at all.
 */
export function PromoteCorrespondentDialog({
  person,
  gatekeeper,
  onClose,
}: {
  person: Pick<MailedPersonRow, "address" | "name">;
  /**
   * Present only when this sheet is opened from mail, never off People
   * You've Mailed or the Contacts App, where there is no message and no
   * Mail Account to scope a Verdict to (this ticket's acceptance line).
   * `approveByDefault` is ticked from the Screener (a held message is a
   * strong signal) and unticked from the Reader.
   */
  gatekeeper?: { mailAccountId: string; approveByDefault: boolean };
  onClose: () => void;
}) {
  const addressBooks = useAddressBooks();
  const defaultAddressBook = useDefaultAddressBook();
  const [addressBookId, setAddressBookId] = useState<string | null>(null);
  const [approve, setApprove] = useState(gatekeeper?.approveByDefault ?? false);

  const selected =
    (addressBookId ? addressBooks?.find((book) => book.id === addressBookId) : undefined) ??
    defaultAddressBook;

  // Before the Address Book collection's first sync round lands, there is
  // nowhere to create the Contact into yet — `NewContactRoute.tsx`'s own
  // brief-gap posture.
  if (!selected) return null;

  const initialFields: Partial<ContactFormState> = {
    ...(person.name ? { name: { given: person.name } } : {}),
    emails: [{ id: generateUlid(), type: "home", value: person.address, primary: true }],
  };

  // "Unticking it saves the Contact and writes no Verdict" (this ticket's
  // acceptance line): this fires only once `createContact` has actually
  // landed (`ContactDialog`'s own `onSaved`), and only when both `gatekeeper`
  // is present and the checkbox is ticked — a plain `approveSender`, the
  // same shape `Screener.tsx#decide` writes for its own Approve, scoped to
  // the Mail Account the message arrived on.
  const handleSaved = () => {
    if (!gatekeeper || !approve) return;
    const sender: GatekeeperSender = { scope: "address", value: person.address };
    void enqueueMutation({ type: "approveSender", sender }, gatekeeper.mailAccountId);
  };

  return (
    <ContactDialog
      addressBook={selected}
      contactId={null}
      initialFields={initialFields}
      addressBookOverride={
        addressBooks && addressBooks.length > 1
          ? { options: addressBooks, onChange: setAddressBookId }
          : undefined
      }
      onSaved={handleSaved}
      footerExtra={
        gatekeeper ? (
          <label className="contact-dialog-approve-toggle">
            <input
              type="checkbox"
              checked={approve}
              onChange={(event) => setApprove(event.target.checked)}
            />
            Approve as well
          </label>
        ) : null
      }
      onClose={onClose}
      // Never called — `contactId` is always `null` here (Create mode),
      // which has no Mail history tab to click a row in (`ContactDialog.tsx`'s
      // own doc comment on the prop).
      onOpenThread={() => {}}
    />
  );
}
