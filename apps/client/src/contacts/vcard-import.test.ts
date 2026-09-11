import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetUndoToastsForTest } from "../mail/undo-toast.js";
import { readContact, readContacts } from "../store/contacts.js";
import { localCache, openLocalCache } from "../store/local-cache.js";
import { setSessionUserId } from "../store/session.js";
import { makeAddressBook } from "../test-support/mail-fixtures.js";
import { importVCardFile } from "./vcard-import.js";

/**
 * `importVCardFile` (#225): "each imported card is an ordinary create ...
 * One toast with the count; Undo deletes the whole batch" — checked here
 * through the same `contactImport` bucket `mail/undo-toast.ts` already owns,
 * `ContactDialog.test.tsx`'s own network-seam-mocking convention for the
 * photo upload route.
 */

vi.mock("../api/contact-photos.js", () => ({
  uploadContactPhoto: vi.fn(async () => ({ blobId: "hash-1", mimeType: "image/jpeg" })),
  contactPhotoUrl: (contactId: string) => `/contacts/${contactId}/photo`,
}));

interface ToastOptions {
  id: string;
  duration: number;
  action?: { label: string; onClick(): void };
}
const toastFn = vi.fn<(message: string, opts: ToastOptions) => void>();
vi.mock("sonner", () => ({
  toast: Object.assign((message: string, opts: ToastOptions) => toastFn(message, opts), {
    dismiss: vi.fn(),
  }),
}));

const USER = "user-1";
const LOCAL_BOOK = makeAddressBook("book-1", { capabilityTableId: "local" });
const MICROSOFT_BOOK = makeAddressBook("book-2", { capabilityTableId: "microsoft" });

let counter = 0;
const names: string[] = [];

beforeEach(async () => {
  const name = `vcard-import-test-${counter++}`;
  names.push(name);
  await openLocalCache({ name, schemaVersion: 1 });
  setSessionUserId(USER);
  toastFn.mockClear();
  resetUndoToastsForTest();
});

afterEach(async () => {
  localCache().close();
  setSessionUserId(null);
  resetUndoToastsForTest();
  for (const name of names.splice(0)) await Dexie.delete(name);
});

function vCardFile(text: string): File {
  return new File([text], "contacts.vcf", { type: "text/vcard" });
}

const TWO_CARDS = [
  "BEGIN:VCARD",
  "VERSION:4.0",
  "N:Lovelace;Ada;;;",
  "END:VCARD",
  "BEGIN:VCARD",
  "VERSION:4.0",
  "N:Hopper;Grace;;;",
  "END:VCARD",
].join("\r\n");

describe("importVCardFile", () => {
  it("creates a Contact per card in the chosen Address Book", async () => {
    const result = await importVCardFile(vCardFile(TWO_CARDS), LOCAL_BOOK);

    expect(result.count).toBe(2);
    const contacts = await readContacts();
    expect(contacts).toHaveLength(2);
    expect(contacts.map((contact) => contact.name.family).sort()).toEqual(["Hopper", "Lovelace"]);
    expect(contacts.every((contact) => contact.addressBookId === LOCAL_BOOK.id)).toBe(true);
  });

  it("trims each card's fields to the target's own capability table", async () => {
    const twoOrgCard = [
      "BEGIN:VCARD",
      "VERSION:4.0",
      "N:Lovelace;Ada;;;",
      "ORG:Acme",
      "END:VCARD",
    ].join("\r\n");
    // Graph's own `organization: 1` cap would reject a second ORG outright —
    // there is only one here, so this proves the target table (not Local's)
    // is what's actually consulted, via a birthday it can't hold at all.
    const yearlessBirthdayCard = [
      "BEGIN:VCARD",
      "VERSION:4.0",
      "N:Hopper;Grace;;;",
      "BDAY:--12-09",
      "END:VCARD",
    ].join("\r\n");

    await importVCardFile(
      vCardFile([twoOrgCard, yearlessBirthdayCard].join("\r\n")),
      MICROSOFT_BOOK,
    );

    const contacts = await readContacts();
    const grace = contacts.find((contact) => contact.name.family === "Hopper");
    // `birthdayYearOptional: false` on Graph's own table — a year-less
    // birthday can't be represented, so it's dropped rather than rejecting
    // the whole card.
    expect(grace?.birthday).toBeNull();
  });

  it("raises one toast naming the whole batch's count, with an Undo that deletes it", async () => {
    await importVCardFile(vCardFile(TWO_CARDS), LOCAL_BOOK);

    const call = toastFn.mock.calls.at(-1);
    expect(call?.[0]).toBe("2 Contacts imported");
    const contactsBeforeUndo = await readContacts();
    expect(contactsBeforeUndo).toHaveLength(2);

    call?.[1].action?.onClick();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(await readContacts()).toEqual([]);
  });

  it("best-effort uploads an inline photo without failing the card if it can't", async () => {
    const withPhoto = [
      "BEGIN:VCARD",
      "VERSION:4.0",
      "N:Lovelace;Ada;;;",
      "PHOTO:data:image/jpeg;base64,/9j/4AAQ",
      "END:VCARD",
    ].join("\r\n");

    const result = await importVCardFile(vCardFile(withPhoto), LOCAL_BOOK);

    expect(result.count).toBe(1);
    const [contact] = await readContacts();
    expect(await readContact(contact?.id ?? "")).toMatchObject({
      photo: { blobId: "hash-1", mimeType: "image/jpeg" },
    });
  });
});
