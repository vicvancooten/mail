import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeAddressBook } from "../test-support/mail-fixtures.js";
import { ContactImportDialog } from "./ContactImportDialog.js";
import { importVCardFile } from "./vcard-import.js";

vi.mock("./vcard-import.js", () => ({
  importVCardFile: vi.fn(async () => ({ count: 2 })),
}));

const LOCAL_BOOK = makeAddressBook("book-1", { name: "My Contacts" });
const WORK_BOOK = makeAddressBook("book-2", { name: "Work", isDefault: false });

afterEach(() => {
  cleanup();
  vi.mocked(importVCardFile).mockClear();
});

describe("ContactImportDialog (#225)", () => {
  it("preselects the Default Address Book", async () => {
    render(
      <ContactImportDialog
        addressBooks={[LOCAL_BOOK, WORK_BOOK]}
        defaultAddressBookId={LOCAL_BOOK.id}
        onClose={() => {}}
      />,
    );

    const select = screen.getByLabelText("Address Book") as HTMLSelectElement;
    expect(select.value).toBe(LOCAL_BOOK.id);
  });

  it("imports the chosen file into the chosen Address Book and closes", async () => {
    let closed = false;
    render(
      <ContactImportDialog
        addressBooks={[LOCAL_BOOK, WORK_BOOK]}
        defaultAddressBookId={LOCAL_BOOK.id}
        onClose={() => (closed = true)}
      />,
    );

    const file = new File(["BEGIN:VCARD\r\nEND:VCARD"], "contacts.vcf", { type: "text/vcard" });
    fireEvent.change(screen.getByLabelText("vCard file"), { target: { files: [file] } });
    fireEvent.change(screen.getByLabelText("Address Book"), { target: { value: WORK_BOOK.id } });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() => {
      expect(importVCardFile).toHaveBeenCalledWith(file, WORK_BOOK);
      expect(closed).toBe(true);
    });
  });

  it("names a file with no cards rather than closing silently", async () => {
    vi.mocked(importVCardFile).mockResolvedValueOnce({ count: 0 });
    render(
      <ContactImportDialog
        addressBooks={[LOCAL_BOOK]}
        defaultAddressBookId={LOCAL_BOOK.id}
        onClose={() => {}}
      />,
    );
    const file = new File(["not a vcard"], "contacts.vcf", { type: "text/vcard" });
    fireEvent.change(screen.getByLabelText("vCard file"), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));

    await screen.findByText("No cards found in that file.");
  });
});
