import { EMPTY_CONTACT_FIELDS } from "@mail/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeAddressBook, makeContact } from "../test-support/mail-fixtures.js";
import { ContactBookCopyDialog } from "./ContactBookCopyDialog.js";

const LOCAL_BOOK = makeAddressBook("book-1", { name: "My Contacts", capabilityTableId: "local" });
const MICROSOFT_BOOK = makeAddressBook("book-2", {
  name: "Work",
  isDefault: false,
  capabilityTableId: "microsoft",
});

afterEach(cleanup);

describe("ContactBookCopyDialog (#225)", () => {
  it("confirms with the chosen target Address Book", () => {
    const onConfirm = vi.fn();
    const contacts = [makeContact("c1", LOCAL_BOOK.id, { ...EMPTY_CONTACT_FIELDS })];

    render(
      <ContactBookCopyDialog
        sourceBook={LOCAL_BOOK}
        sourceContacts={contacts}
        addressBooks={[LOCAL_BOOK, MICROSOFT_BOOK]}
        onConfirm={onConfirm}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy 1 Contacts" }));

    expect(onConfirm).toHaveBeenCalledWith(MICROSOFT_BOOK);
  });

  it("names how many of the source Contacts lose a family the target can't hold", () => {
    const contacts = [
      makeContact("c1", LOCAL_BOOK.id, {
        organizations: [
          { id: "o1", name: "Acme" },
          { id: "o2", name: "Widgets Inc" },
        ],
      }),
      makeContact("c2", LOCAL_BOOK.id, { organizations: [{ id: "o3", name: "Acme" }] }),
    ];

    render(
      <ContactBookCopyDialog
        sourceBook={LOCAL_BOOK}
        sourceContacts={contacts}
        addressBooks={[LOCAL_BOOK, MICROSOFT_BOOK]}
        onConfirm={() => {}}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText("1 of 2 Contacts lose 1 organization")).toBeTruthy();
  });

  it("offers nothing to pick when there is no other Address Book", () => {
    render(
      <ContactBookCopyDialog
        sourceBook={LOCAL_BOOK}
        sourceContacts={[]}
        addressBooks={[LOCAL_BOOK]}
        onConfirm={() => {}}
        onClose={() => {}}
      />,
    );

    expect(screen.queryByLabelText("Target Address Book")).toBeNull();
  });
});
