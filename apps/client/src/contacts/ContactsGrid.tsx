import type { AddressBook } from "@mail/shared";
import { getContactCapabilityTable } from "@mail/shared";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Button } from "../components/ui/button.js";
import { announceUndoableAction } from "../mail/undo-toast.js";
import {
  deriveAddressBookScope,
  deriveMailAccountScope,
  useAccountScope,
} from "../mail/useAccountScope.js";
import { useAddressBooks } from "../store/address-books.js";
import { duplicateCandidatesInScope, useContactLinks } from "../store/contact-links.js";
import { copyContact, deleteContact, useContacts } from "../store/contacts.js";
import { useConnectedAccounts, useMailAccounts, usePreference } from "../store/index.js";
import { AddressBookFilter } from "./AddressBookFilter.js";
import { ContactBookCopyDialog } from "./ContactBookCopyDialog.js";
import { ContactCard } from "./ContactCard.js";
import { ContactImportDialog } from "./ContactImportDialog.js";
import { contactsDirectoryGroups } from "./contacts-directory.js";
import "./contacts.css";
import { PeopleYouveMailedList } from "./PeopleYouveMailedList.js";
import { contactsToVCardFile, downloadVCardFile, vCardFileName } from "./vcard-export.js";

type ContactsAppTab = "contacts" | "mailed";

/**
 * `/contacts`'s own content (#211, the winning Card directory from #174): one
 * grid across every Address Book in Account Scope — the Address Book is a
 * filter chip above the grid, never a separate screen
 * (`AddressBookFilter.tsx`'s own doc comment). The sync loop itself is the
 * Client shell's own concern now (#285, `router/RootLayout.tsx`), not this
 * component's — a User landing straight on `/contacts` still gets it, since
 * the shell runs regardless of which route is current.
 *
 * "People you've mailed" (#218) is a tab on this same list, not a second
 * screen — the tab strip below switches between the card grid and
 * `PeopleYouveMailedList`, both mounted under the one `/contacts` route and
 * its always-present `<Outlet/>` for the Person Page dialog.
 */
export function ContactsGrid() {
  const contacts = useContacts();
  const contactLinks = useContactLinks();
  const addressBooks = useAddressBooks();
  const connectedAccounts = useConnectedAccounts();
  const mailAccounts = useMailAccounts();
  const preference = usePreference();
  const { scope: accountScope } = useAccountScope(connectedAccounts);

  const [tab, setTab] = useState<ContactsAppTab>("contacts");
  const [query, setQuery] = useState("");
  /** The Duplicates filter (#222) — a plain toggle beside the Address Book chips, never a modal and never automatic (ADR-0026: "Detection suggests, never acts"). */
  const [duplicatesOnly, setDuplicatesOnly] = useState(false);
  const [selectedAddressBookIds, setSelectedAddressBookIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  /** Import (#225) — its own sheet, never local `useState` inside `ContactCard`/a chip: it names a file and a target Address Book, neither of which belongs to any one Contact or chip. */
  const [importOpen, setImportOpen] = useState(false);
  /** "Copy all to…" (#225) — only offered while exactly one Address Book chip is selected, the same "which book" the User already named through the ordinary filter row rather than a second picker for it. */
  const [bookCopyOpen, setBookCopyOpen] = useState(false);

  const mailAccountIdsInScope = useMemo(
    () => deriveMailAccountScope(connectedAccounts, accountScope, mailAccounts ?? []),
    [connectedAccounts, accountScope, mailAccounts],
  );

  const toggleAddressBook = (addressBookId: string) => {
    setSelectedAddressBookIds((current) => {
      const next = new Set(current);
      if (next.has(addressBookId)) next.delete(addressBookId);
      else next.add(addressBookId);
      return next;
    });
  };

  const addressBooksInScope = useMemo(
    () => deriveAddressBookScope(connectedAccounts, accountScope, addressBooks ?? []),
    [connectedAccounts, accountScope, addressBooks],
  );
  const addressBooksById = useMemo(
    () => new Map(addressBooksInScope.map((book) => [book.id, book])),
    [addressBooksInScope],
  );

  const sortOrder = preference?.contactsSortOrder ?? "given";
  const defaultAddressBookId = useMemo(
    () => addressBooks?.find((book) => book.isDefault)?.id ?? null,
    [addressBooks],
  );

  // Detection runs over Account Scope as a whole (#222's own acceptance
  // line), *before* the search text and the Address Book chips narrow the
  // grid — a pair is a pair whether or not the User is currently looking at
  // both halves of it, and filtering to one book must not make the chip
  // vanish from the record that's still on screen.
  const contactsInScope = useMemo(() => {
    if (!contacts) return undefined;
    const inScopeIds = new Set(addressBooksInScope.map((book) => book.id));
    return contacts.filter((contact) => inScopeIds.has(contact.addressBookId));
  }, [contacts, addressBooksInScope]);

  const duplicates = useMemo(
    () => duplicateCandidatesInScope(contactsInScope ?? [], contactLinks ?? []),
    [contactsInScope, contactLinks],
  );

  const filtered = useMemo(() => {
    if (!contactsInScope) return undefined;
    // The three-step order (detect, filter, group) is
    // `contacts-directory.ts`'s own to state, not this component's.
    return contactsDirectoryGroups(contactsInScope, contactLinks ?? [], duplicates, {
      selectedAddressBookIds,
      query,
      duplicatesOnly,
      sortOrder,
      defaultAddressBookId,
    });
  }, [
    contactsInScope,
    contactLinks,
    defaultAddressBookId,
    duplicates,
    duplicatesOnly,
    selectedAddressBookIds,
    query,
    sortOrder,
  ]);

  // "Export"/"Copy all to…" (#225) both name **one** Address Book — the
  // chip row the User already has, rather than a second picker: only
  // offered while exactly one chip is selected.
  const selectedSingleBookId =
    selectedAddressBookIds.size === 1 ? [...selectedAddressBookIds][0] : undefined;
  const selectedSingleBook = selectedSingleBookId
    ? (addressBooksById.get(selectedSingleBookId) ?? null)
    : null;
  const contactsInSelectedBook = useMemo(
    () =>
      selectedSingleBook
        ? (contactsInScope ?? []).filter(
            (contact) => contact.addressBookId === selectedSingleBook.id,
          )
        : [],
    [contactsInScope, selectedSingleBook],
  );

  const handleExportSelectedBook = async () => {
    if (!selectedSingleBook) return;
    const vcard = await contactsToVCardFile(contactsInSelectedBook);
    downloadVCardFile(vCardFileName(selectedSingleBook.name), vcard);
  };

  const handleCopyBookConfirm = async (target: AddressBook) => {
    if (!selectedSingleBook) return;
    const table = getContactCapabilityTable(target.capabilityTableId);
    for (const contact of contactsInSelectedBook) {
      const newId = await copyContact(contact, target.id, table);
      announceUndoableAction("contactCopy", () => deleteContact(newId));
    }
    setBookCopyOpen(false);
  };

  return (
    <section className="contacts-grid-section" aria-label="Contacts">
      <div className="contacts-app-tabs" role="tablist" aria-label="Contacts App">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "contacts"}
          className={`contacts-app-tab${tab === "contacts" ? " active" : ""}`}
          onClick={() => setTab("contacts")}
        >
          Contacts
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "mailed"}
          className={`contacts-app-tab${tab === "mailed" ? " active" : ""}`}
          onClick={() => setTab("mailed")}
        >
          People you've mailed
        </button>
      </div>

      {tab === "contacts" ? (
        <>
          <div className="contacts-grid-toolbar">
            <input
              type="search"
              className="contacts-search"
              placeholder="Search Contacts"
              aria-label="Search Contacts"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <AddressBookFilter
              addressBooks={addressBooksInScope}
              selectedAddressBookIds={selectedAddressBookIds}
              onToggle={toggleAddressBook}
            />
            <button
              type="button"
              className={`contacts-duplicates-filter${duplicatesOnly ? " selected" : ""}`}
              aria-pressed={duplicatesOnly}
              onClick={() => setDuplicatesOnly((current) => !current)}
            >
              Duplicates
              {duplicates.size > 0 ? (
                <span className="contacts-duplicates-count">{duplicates.size}</span>
              ) : null}
            </button>
            {selectedSingleBook ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void handleExportSelectedBook()}
                >
                  Export
                </Button>
                {addressBooksInScope.length > 1 ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setBookCopyOpen(true)}
                  >
                    Copy all to…
                  </Button>
                ) : null}
              </>
            ) : null}
            <Button type="button" variant="outline" size="sm" onClick={() => setImportOpen(true)}>
              Import…
            </Button>
            <Link to="/contacts/new" className="contacts-new-link">
              New contact
            </Link>
            {/* Recently Deleted (#224): its own screen, not an overlay over this
                one — `routes.tsx#contactsRecentlyDeletedRoute`'s own doc comment. */}
            <Link to="/contacts/recently-deleted" className="contacts-recently-deleted-link">
              Recently Deleted
            </Link>
          </div>
          {importOpen ? (
            <ContactImportDialog
              addressBooks={addressBooksInScope}
              defaultAddressBookId={defaultAddressBookId}
              onClose={() => setImportOpen(false)}
            />
          ) : null}
          {bookCopyOpen && selectedSingleBook ? (
            <ContactBookCopyDialog
              sourceBook={selectedSingleBook}
              sourceContacts={contactsInSelectedBook}
              addressBooks={addressBooksInScope}
              onConfirm={(target) => void handleCopyBookConfirm(target)}
              onClose={() => setBookCopyOpen(false)}
            />
          ) : null}
          {filtered && filtered.length === 0 ? (
            <p className="contacts-grid-empty">
              {duplicatesOnly
                ? "No possible duplicates."
                : query.trim().length > 0 || selectedAddressBookIds.size > 0
                  ? "No Contacts match."
                  : "No Contacts yet."}
            </p>
          ) : (
            <div
              className="contacts-grid"
              key={`${query}:${duplicatesOnly}:${[...selectedAddressBookIds].join(",")}`}
            >
              {filtered?.map((group, index) => (
                <ContactCard
                  key={group.key}
                  group={group}
                  addressBooks={addressBooksById}
                  duplicate={group.members.some((member) => duplicates.has(member.id))}
                  index={index}
                />
              ))}
            </div>
          )}
        </>
      ) : (
        <PeopleYouveMailedList mailAccountIdsInScope={mailAccountIdsInScope} />
      )}
    </section>
  );
}
