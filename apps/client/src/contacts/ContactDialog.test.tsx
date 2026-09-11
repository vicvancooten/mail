import type { AddressBookCapabilityTableId } from "@mail/shared";
import { EMPTY_CONTACT_FIELDS } from "@mail/shared";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetUndoToastsForTest } from "../mail/undo-toast.js";
import { createContact, newContactId, readContact } from "../store/contacts.js";
import { localCache, openLocalCache } from "../store/local-cache.js";
import { setSessionUserId } from "../store/session.js";
import { makeAddressBook } from "../test-support/mail-fixtures.js";
import { ContactDialog } from "./ContactDialog.js";

/** #213's own network seam — the upload/remove round trip gets its own coverage in `api/contact-photos.test.ts`; this file only needs the picker to call through and react to what comes back. */
vi.mock("../api/contact-photos.js", () => ({
  uploadContactPhoto: vi.fn(async () => ({ blobId: "hash-1", mimeType: "image/png" })),
  removeContactPhoto: vi.fn(async () => {}),
  contactPhotoUrl: (contactId: string) => `/contacts/${contactId}/photo`,
  UnsupportedContactPhotoTypeError: class UnsupportedContactPhotoTypeError extends Error {},
  ContactPhotoTooLargeError: class ContactPhotoTooLargeError extends Error {
    maxBytes: number;
    constructor(maxBytes: number) {
      super("photo_too_large");
      this.maxBytes = maxBytes;
    }
  },
}));

/**
 * `ContactDialog` takes no router dependency of its own (`addressBook`/
 * `contactId`/`onClose` are plain props), the same split `NoteDialog.test.tsx`
 * draws — this file covers resolving/creating a Contact, Save and Delete;
 * the future card directory's own routing is #211's.
 */

const USER = "user-1";
const LOCAL_BOOK = makeAddressBook("book-1");
let counter = 0;
const names: string[] = [];

beforeEach(async () => {
  const name = `contact-dialog-test-${counter++}`;
  names.push(name);
  await openLocalCache({ name, schemaVersion: 1 });
  setSessionUserId(USER);
});

afterEach(async () => {
  cleanup();
  // Copy/Move (#225) raise a real `announceUndoableAction` bucket, whose
  // `setTimeout` would otherwise keep running past this file's own Local
  // Cache — `undo-toast.test.ts`'s own per-test reset, needed here for the
  // first tests in this file that actually reach it.
  resetUndoToastsForTest();
  localCache().close();
  setSessionUserId(null);
  for (const nm of names.splice(0)) await Dexie.delete(nm);
});

describe("ContactDialog (#210)", () => {
  it("creates a new Contact on Save, with the typed given/family name", async () => {
    render(
      <ContactDialog
        addressBook={LOCAL_BOOK}
        contactId={null}
        onClose={() => {}}
        onOpenThread={() => {}}
      />,
    );
    await screen.findByRole("dialog");

    fireEvent.change(screen.getByLabelText("Given name"), { target: { value: "Ada" } });
    fireEvent.change(screen.getByLabelText("Family name"), { target: { value: "Lovelace" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(async () => {
      const rows = await localCache().contacts.toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        addressBookId: LOCAL_BOOK.id,
        name: { given: "Ada", family: "Lovelace" },
      });
    });
  });

  it("adds a Custom-labelled email row and keeps it as an email on Save, never a Custom Field (#283)", async () => {
    render(
      <ContactDialog
        addressBook={LOCAL_BOOK}
        contactId={null}
        onClose={() => {}}
        onOpenThread={() => {}}
      />,
    );
    await screen.findByRole("dialog");

    fireEvent.click(screen.getByRole("button", { name: "Add email" }));
    fireEvent.change(screen.getByLabelText("Email type"), { target: { value: "Boat" } });
    fireEvent.change(screen.getByLabelText("Email value"), { target: { value: "a@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(async () => {
      const rows = await localCache().contacts.toArray();
      expect(rows[0]?.emails).toEqual([
        { id: expect.any(String), type: "Boat", value: "a@example.com", primary: true },
      ]);
      expect(rows[0]?.customFields).toEqual([]);
    });
  });

  it("opens an existing Contact into Details (view mode), not straight into the edit form", async () => {
    const id = newContactId();
    await createContact(id, LOCAL_BOOK.id, { ...EMPTY_CONTACT_FIELDS, notes: "before" });

    render(
      <ContactDialog
        addressBook={LOCAL_BOOK}
        contactId={id}
        onClose={() => {}}
        onOpenThread={() => {}}
      />,
    );
    await screen.findByRole("button", { name: "Edit" });

    expect(screen.queryByLabelText("Notes")).toBeNull();
    expect(screen.getByText("before")).toBeDefined();
  });

  it("Edit reveals the edit form, and Save persists the edit and returns to Details", async () => {
    const id = newContactId();
    await createContact(id, LOCAL_BOOK.id, { ...EMPTY_CONTACT_FIELDS, notes: "before" });

    render(
      <ContactDialog
        addressBook={LOCAL_BOOK}
        contactId={id}
        onClose={() => {}}
        onOpenThread={() => {}}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));

    await waitFor(() => {
      expect((screen.getByLabelText("Notes") as HTMLInputElement).value).toBe("before");
    });

    fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "after" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(async () => {
      expect((await readContact(id))?.notes).toBe("after");
    });
    await waitFor(() => {
      expect(screen.queryByLabelText("Notes")).toBeNull();
      expect(screen.getByText("after")).toBeDefined();
    });
  });

  it("Cancel discards an in-progress edit and returns to Details", async () => {
    const id = newContactId();
    await createContact(id, LOCAL_BOOK.id, { ...EMPTY_CONTACT_FIELDS, notes: "before" });

    render(
      <ContactDialog
        addressBook={LOCAL_BOOK}
        contactId={id}
        onClose={() => {}}
        onOpenThread={() => {}}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(await screen.findByLabelText("Notes"), { target: { value: "discarded" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(screen.queryByLabelText("Notes")).toBeNull();
      expect(screen.getByText("before")).toBeDefined();
    });
    expect((await readContact(id))?.notes).toBe("before");
  });

  it("Delete soft-deletes an existing Contact (#224) and closes", async () => {
    const id = newContactId();
    await createContact(id, LOCAL_BOOK.id, EMPTY_CONTACT_FIELDS);
    let closed = false;

    render(
      <ContactDialog
        addressBook={LOCAL_BOOK}
        contactId={id}
        onClose={() => (closed = true)}
        onOpenThread={() => {}}
      />,
    );
    await screen.findByRole("button", { name: "Delete" });

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(async () => {
      // Recently Deleted (#224): the row survives, soft-deleted, not gone —
      // `store/contacts.ts#trashContact`'s own shape, `deleteContact`'s
      // permanent-delete predecessor this replaced as the Delete control's
      // own action.
      expect((await readContact(id))?.deletedAt).not.toBeNull();
      expect(closed).toBe(true);
    });
  });

  it("offers no Delete control for a brand-new Contact", async () => {
    render(
      <ContactDialog
        addressBook={LOCAL_BOOK}
        contactId={null}
        onClose={() => {}}
        onOpenThread={() => {}}
      />,
    );
    await screen.findByRole("dialog");

    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });
});

describe("ContactDialog's Copy/Move/Export (#225)", () => {
  const TARGET_BOOK = makeAddressBook("book-2", { name: "Work", isDefault: false });

  it("offers no Copy to…/Move to… when there is only one Address Book", async () => {
    const id = newContactId();
    await createContact(id, LOCAL_BOOK.id, EMPTY_CONTACT_FIELDS);
    await localCache().addressBooks.put(LOCAL_BOOK);

    render(
      <ContactDialog
        addressBook={LOCAL_BOOK}
        contactId={id}
        onClose={() => {}}
        onOpenThread={() => {}}
      />,
    );
    await screen.findByRole("button", { name: "Delete" });

    expect(screen.queryByRole("button", { name: "Copy to…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Move to…" })).toBeNull();
  });

  it("Copy to… creates a linked copy in the chosen Address Book without removing the original", async () => {
    const id = newContactId();
    await createContact(id, LOCAL_BOOK.id, { ...EMPTY_CONTACT_FIELDS, name: { given: "Ada" } });
    await localCache().addressBooks.bulkPut([LOCAL_BOOK, TARGET_BOOK]);

    render(
      <ContactDialog
        addressBook={LOCAL_BOOK}
        contactId={id}
        onClose={() => {}}
        onOpenThread={() => {}}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Copy to…" }));
    fireEvent.change(await screen.findByLabelText("Target Address Book"), {
      target: { value: TARGET_BOOK.id },
    });
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    await waitFor(async () => {
      const rows = await localCache().contacts.toArray();
      expect(rows).toHaveLength(2);
      expect(rows.some((row) => row.addressBookId === TARGET_BOOK.id)).toBe(true);
      expect(await readContact(id)).toBeDefined();
    });
    // The Person Page re-renders into its own Linked view once the link
    // lands (`useLinkedContactGroup`'s own live query) — waiting for that
    // here, rather than only for the Local Cache rows above, lets that
    // re-render's own in-flight query settle before this test's `afterEach`
    // closes the Local Cache out from under it.
    await screen.findByText("Linked records");
  });

  it("Move to… creates the copy, removes the original and closes", async () => {
    const id = newContactId();
    await createContact(id, LOCAL_BOOK.id, { ...EMPTY_CONTACT_FIELDS, name: { given: "Ada" } });
    await localCache().addressBooks.bulkPut([LOCAL_BOOK, TARGET_BOOK]);
    let closed = false;

    render(
      <ContactDialog
        addressBook={LOCAL_BOOK}
        contactId={id}
        onClose={() => (closed = true)}
        onOpenThread={() => {}}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Move to…" }));
    fireEvent.change(await screen.findByLabelText("Target Address Book"), {
      target: { value: TARGET_BOOK.id },
    });
    fireEvent.click(screen.getByRole("button", { name: "Move" }));

    await waitFor(async () => {
      expect(await readContact(id)).toBeUndefined();
      const rows = await localCache().contacts.toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ addressBookId: TARGET_BOOK.id, name: { given: "Ada" } });
      expect(closed).toBe(true);
    });
  });
});

describe("ContactDialog's hero and banner (#212)", () => {
  it("offers no Change banner control in Details (view mode)", async () => {
    const id = newContactId();
    await createContact(id, LOCAL_BOOK.id, EMPTY_CONTACT_FIELDS);

    render(
      <ContactDialog
        addressBook={LOCAL_BOOK}
        contactId={id}
        onClose={() => {}}
        onOpenThread={() => {}}
      />,
    );
    await screen.findByRole("button", { name: "Edit" });

    expect(screen.queryByRole("button", { name: "Change banner" })).toBeNull();
  });

  it("picking a swatch in Edit mode sets the Contact's banner", async () => {
    const id = newContactId();
    await createContact(id, LOCAL_BOOK.id, EMPTY_CONTACT_FIELDS);

    render(
      <ContactDialog
        addressBook={LOCAL_BOOK}
        contactId={id}
        onClose={() => {}}
        onOpenThread={() => {}}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.click(await screen.findByRole("button", { name: "Change banner" }));
    fireEvent.click(await screen.findByRole("button", { name: "Teal" }));

    await waitFor(async () => {
      expect((await readContact(id))?.banner).toEqual({ kind: "swatch", swatch: "b" });
    });
  });
});

describe("ContactDialog's photo picker (#213)", () => {
  it("offers no Change photo control in Details (view mode)", async () => {
    const id = newContactId();
    await createContact(id, LOCAL_BOOK.id, EMPTY_CONTACT_FIELDS);

    render(
      <ContactDialog
        addressBook={LOCAL_BOOK}
        contactId={id}
        onClose={() => {}}
        onOpenThread={() => {}}
      />,
    );
    await screen.findByRole("button", { name: "Edit" });

    expect(screen.queryByRole("button", { name: "Change photo" })).toBeNull();
  });

  it("offers the Change photo control for a Google-mirrored Address Book in Edit mode too (#216: photo write-back)", async () => {
    const mirroredBook = makeAddressBook("book-google", { capabilityTableId: "google" });
    const id = newContactId();
    await createContact(id, mirroredBook.id, EMPTY_CONTACT_FIELDS);

    render(
      <ContactDialog
        addressBook={mirroredBook}
        contactId={id}
        onClose={() => {}}
        onOpenThread={() => {}}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));

    await screen.findByRole("button", { name: "Change photo" });
  });

  it("offers no Change photo control for an Address Book with no photo write-back adapter yet (e.g. microsoft)", async () => {
    const closedBook = makeAddressBook("book-microsoft", { capabilityTableId: "microsoft" });
    const id = newContactId();
    await createContact(id, closedBook.id, EMPTY_CONTACT_FIELDS);

    render(
      <ContactDialog
        addressBook={closedBook}
        contactId={id}
        onClose={() => {}}
        onOpenThread={() => {}}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));

    expect(screen.queryByRole("button", { name: "Change photo" })).toBeNull();
  });

  it("choosing a file in Edit mode uploads it and sets the Contact's photo", async () => {
    const id = newContactId();
    await createContact(id, LOCAL_BOOK.id, EMPTY_CONTACT_FIELDS);

    render(
      <ContactDialog
        addressBook={LOCAL_BOOK}
        contactId={id}
        onClose={() => {}}
        onOpenThread={() => {}}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    await screen.findByRole("button", { name: "Change photo" });

    const file = new File(["photo bytes"], "me.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("Choose photo"), { target: { files: [file] } });

    await waitFor(async () => {
      expect((await readContact(id))?.photo).toEqual({ blobId: "hash-1", mimeType: "image/png" });
    });
    await screen.findByRole("button", { name: "Remove photo" });
  });

  it("rejects an unsupported file type before ever uploading it", async () => {
    const id = newContactId();
    await createContact(id, LOCAL_BOOK.id, EMPTY_CONTACT_FIELDS);

    render(
      <ContactDialog
        addressBook={LOCAL_BOOK}
        contactId={id}
        onClose={() => {}}
        onOpenThread={() => {}}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    await screen.findByRole("button", { name: "Change photo" });

    const file = new File(["not an image"], "notes.txt", { type: "text/plain" });
    fireEvent.change(screen.getByLabelText("Choose photo"), { target: { files: [file] } });

    await screen.findByText("Use one of: image/jpeg, image/png, image/webp");
    expect((await readContact(id))?.photo).toBeNull();
  });

  it("Remove photo clears the Contact's photo", async () => {
    const id = newContactId();
    await createContact(id, LOCAL_BOOK.id, EMPTY_CONTACT_FIELDS);

    render(
      <ContactDialog
        addressBook={LOCAL_BOOK}
        contactId={id}
        onClose={() => {}}
        onOpenThread={() => {}}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const file = new File(["photo bytes"], "me.png", { type: "image/png" });
    fireEvent.change(await screen.findByLabelText("Choose photo"), { target: { files: [file] } });
    fireEvent.click(await screen.findByRole("button", { name: "Remove photo" }));

    await waitFor(async () => {
      expect((await readContact(id))?.photo).toBeNull();
    });
  });
});

describe("ContactDialog's Details view (#212)", () => {
  it("renders every populated family the Contact's Origin can hold", async () => {
    const id = newContactId();
    await createContact(id, LOCAL_BOOK.id, {
      ...EMPTY_CONTACT_FIELDS,
      name: { given: "Ada", family: "Lovelace" },
      emails: [{ id: "e1", type: "work", value: "ada@example.com", primary: true }],
      notes: "met at a conference",
    });

    render(
      <ContactDialog
        addressBook={LOCAL_BOOK}
        contactId={id}
        onClose={() => {}}
        onOpenThread={() => {}}
      />,
    );
    await screen.findByRole("button", { name: "Edit" });

    expect(screen.getByText("Ada Lovelace")).toBeDefined();
    expect(screen.getByText("ada@example.com")).toBeDefined();
    expect(screen.getByText("met at a conference")).toBeDefined();
  });

  it("omits a family the Origin's capability table doesn't hold", async () => {
    // Every real `AddressBookCapabilityTableId` now has its own declared
    // table (#210, #214, #226, #227) — a synthetic id is what exercises
    // `getContactCapabilityTable`'s own closed fallback
    // (`@mail/shared#CLOSED_CONTACT_CAPABILITY_TABLE`) for a future Origin
    // that hasn't declared one yet.
    const closedBook = makeAddressBook("book-closed", {
      capabilityTableId: "not_yet_declared" as AddressBookCapabilityTableId,
    });
    const id = newContactId();
    await createContact(id, closedBook.id, {
      ...EMPTY_CONTACT_FIELDS,
      name: { given: "Ada", family: "Lovelace" },
      emails: [{ id: "e1", type: "work", value: "ada@example.com", primary: true }],
    });

    render(
      <ContactDialog
        addressBook={closedBook}
        contactId={id}
        onClose={() => {}}
        onOpenThread={() => {}}
      />,
    );
    await screen.findByRole("button", { name: "Edit" });

    expect(screen.queryByText("ada@example.com")).toBeNull();
  });

  it("(#227) renders Graph's own categories as read-only chips", async () => {
    const id = newContactId();
    await createContact(id, LOCAL_BOOK.id, EMPTY_CONTACT_FIELDS);
    const row = await localCache().contacts.get(id);
    if (!row) throw new Error("expected the just-created Contact to exist");
    await localCache().contacts.put({ ...row, categories: ["Blue Category", "VIP"] });

    render(
      <ContactDialog
        addressBook={LOCAL_BOOK}
        contactId={id}
        onClose={() => {}}
        onOpenThread={() => {}}
      />,
    );
    await screen.findByRole("button", { name: "Edit" });

    expect(screen.getByText("Blue Category")).toBeDefined();
    expect(screen.getByText("VIP")).toBeDefined();
  });
});

describe("ContactDialog's own organization cap (#227)", () => {
  it("hides Add organization once Graph's own cap (1) is reached", async () => {
    const graphBook = makeAddressBook("book-graph", { capabilityTableId: "microsoft" });

    render(
      <ContactDialog
        addressBook={graphBook}
        contactId={null}
        onClose={() => {}}
        onOpenThread={() => {}}
      />,
    );
    await screen.findByRole("dialog");

    expect(screen.getByRole("button", { name: "Add organization" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Add organization" }));

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Add organization" })).toBeNull();
    });
  });

  it("never hides Add organization for Local's own unbounded table", async () => {
    render(
      <ContactDialog
        addressBook={LOCAL_BOOK}
        contactId={null}
        onClose={() => {}}
        onOpenThread={() => {}}
      />,
    );
    await screen.findByRole("dialog");

    fireEvent.click(screen.getByRole("button", { name: "Add organization" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Add organization" })).toBeDefined();
    });
  });
});
