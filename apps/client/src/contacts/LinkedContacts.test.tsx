import type { SearchRequest, SearchResponse } from "@mail/shared";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { linkContacts, readContactLinks } from "../store/contact-links.js";
import { readContact } from "../store/contacts.js";
import { localCache, openLocalCache } from "../store/local-cache.js";
import { applyMailAccountDelta } from "../store/server-writes.js";
import { setSessionUserId } from "../store/session.js";
import {
  delta,
  makeAddressBook,
  makeContact,
  makeMailAccount,
} from "../test-support/mail-fixtures.js";
import { jsonResponse } from "../test-support/mock-fetch.js";
import { ContactDialog } from "./ContactDialog.js";

/**
 * The Person Page's Linked Contacts and possible-duplicate suggestions
 * (#222, ADR-0026) — `ContactDialog.test.tsx` covers a plain Contact's
 * Details/Edit, this file covers the same dialog once a person is more than
 * one record: the union of fields, which record each field edits, fronting,
 * Unlink, and the Link/Merge suggestions.
 */

const USER = "user-1";
const LOCAL = makeAddressBook("book-local", { isDefault: true });
const GOOGLE = makeAddressBook("book-google", {
  name: "Google Contacts",
  capabilityTableId: "google",
  isDefault: false,
  mirrored: true,
  origin: { kind: "connectedAccount", connectedAccountId: "acct-1" },
});

let counter = 0;
const names: string[] = [];

function email(id: string, value: string, type = "home") {
  return { id, type, value, primary: false };
}

function emptySearch(): SearchResponse {
  return { results: [], cursor: null, indexWatermark: { coveredSince: null, complete: true } };
}

function stubSearch(handler: (request: SearchRequest) => SearchResponse) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/search") {
        return Promise.resolve(jsonResponse(handler(JSON.parse(String(init?.body)))));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }),
  );
}

beforeEach(async () => {
  const name = `linked-contacts-test-${counter++}`;
  names.push(name);
  await openLocalCache({ name, schemaVersion: 1 });
  setSessionUserId(USER);
  await localCache().addressBooks.bulkPut([LOCAL, GOOGLE]);
  await applyMailAccountDelta(delta({ created: [makeMailAccount("acct-1")] }), { replace: false });
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  localCache().close();
  setSessionUserId(null);
  for (const nm of names.splice(0)) await Dexie.delete(nm);
});

/** The Local record and the Google record of one person, sharing an address — a possible duplicate by detection's own rule. */
async function seedPair() {
  await localCache().contacts.bulkPut([
    makeContact("c-local", LOCAL.id, {
      name: { given: "Ada", family: "Lovelace" },
      emails: [email("e1", "ada@example.com")],
      notes: "met at the museum",
    }),
    makeContact("c-google", GOOGLE.id, {
      emails: [email("e2", "ADA@example.com"), email("e3", "ada@work.example", "work")],
      phones: [{ id: "p1", type: "mobile", value: "+31612345678", primary: true }],
      birthday: { month: 12, day: 10, year: 1815 },
      updatedAt: "2026-06-01T00:00:00.000Z",
    }),
  ]);
}

function renderDialog(contactId: string, onClose = () => {}) {
  render(
    <ContactDialog
      addressBook={LOCAL}
      contactId={contactId}
      onClose={onClose}
      onOpenThread={() => {}}
    />,
  );
}

describe("the Person Page's possible-duplicate suggestions (#222)", () => {
  it("offers Link for a record in another Address Book, and links on click", async () => {
    await seedPair();
    renderDialog("c-local");

    // The Google record has no name of its own, so the suggestion names it
    // by its own primary address (`contactDisplayName`).
    fireEvent.click(await screen.findByRole("button", { name: "Link ADA@example.com" }));

    await waitFor(async () => {
      const links = await readContactLinks();
      expect([...(links[0]?.contactIds ?? [])].sort()).toEqual(["c-google", "c-local"]);
    });
  });

  it("offers Merge for a pair inside one Address Book, confirming before it acts (#223)", async () => {
    await localCache().contacts.bulkPut([
      makeContact("c-1", LOCAL.id, {
        name: { given: "Ada" },
        emails: [email("e1", "ada@example.com")],
        createdAt: "2020-01-01T00:00:00.000Z",
      }),
      makeContact("c-2", LOCAL.id, {
        name: { given: "Ada L." },
        emails: [email("e2", "ada@example.com"), email("e3", "ada@work.example", "work")],
        createdAt: "2024-01-01T00:00:00.000Z",
      }),
    ]);
    const onClose = vi.fn();
    renderDialog("c-1", onClose);

    fireEvent.click(await screen.findByRole("button", { name: "Merge Ada L." }));
    // Confirmed before it acts — no write yet.
    expect(await readContact("c-2")).toBeDefined();
    await screen.findByText(/can.t be undone/i);

    fireEvent.click(await screen.findByRole("button", { name: "Merge" }));

    // c-1 is older, so it survives and takes c-2's own extra email; c-2 is
    // gone. The dialog stays open — the record the route is open on (c-1)
    // is the one that survived.
    await waitFor(async () => {
      expect(await readContact("c-2")).toBeUndefined();
    });
    const survivor = await readContact("c-1");
    expect(survivor?.emails.map((entry) => entry.value)).toEqual([
      "ada@example.com",
      "ada@work.example",
    ]);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes the dialog when the record it was opened on is the one merged away", async () => {
    await localCache().contacts.bulkPut([
      makeContact("c-1", LOCAL.id, {
        emails: [email("e1", "ada@example.com")],
        createdAt: "2020-01-01T00:00:00.000Z",
      }),
      makeContact("c-2", LOCAL.id, {
        emails: [email("e2", "ada@example.com")],
        createdAt: "2024-01-01T00:00:00.000Z",
      }),
    ]);
    const onClose = vi.fn();
    // The route is open on the newer record — it is the one that loses.
    renderDialog("c-2", onClose);

    fireEvent.click(await screen.findByRole("button", { name: /Merge/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Merge" }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("suggests nothing once the pair is linked — the User has answered it", async () => {
    await seedPair();
    await linkContacts("link-1", "c-local", "c-google");
    renderDialog("c-local");

    await screen.findByText("Linked records");
    expect(screen.queryByText("Possible duplicate")).toBeNull();
  });

  it("never suggests a name-only match", async () => {
    await localCache().contacts.bulkPut([
      makeContact("c-1", LOCAL.id, { name: { given: "Ada", family: "Lovelace" } }),
      makeContact("c-2", GOOGLE.id, { name: { given: "Ada", family: "Lovelace" } }),
    ]);
    renderDialog("c-1");

    await screen.findByRole("button", { name: "Edit" });
    expect(screen.queryByText("Possible duplicate")).toBeNull();
  });
});

describe("a linked card's Person Page (#222)", () => {
  it("shows the union of both records' fields, each tagged with the record it came from", async () => {
    await seedPair();
    await linkContacts("link-1", "c-local", "c-google");
    renderDialog("c-local");

    await screen.findByText("Linked records");
    // The shared address appears once, from the front record.
    expect(screen.getAllByText("ada@example.com")).toHaveLength(1);
    // A field only the Google record holds still shows, and says so.
    expect(screen.getByText("ada@work.example")).toBeDefined();
    expect(screen.getByText("+31612345678")).toBeDefined();
    expect(screen.getByText("12/10/1815")).toBeDefined();
    expect(screen.getAllByText("Google Contacts").length).toBeGreaterThan(0);
    // And one the Local record holds.
    expect(screen.getByText("met at the museum")).toBeDefined();
  });

  it("fronts the Default Address Book's record, and the User's own pick over it", async () => {
    await seedPair();
    await linkContacts("link-1", "c-local", "c-google");
    renderDialog("c-local");

    // The Local record fronts the card, so the hero shows its name.
    await screen.findByRole("heading", { name: "Ada Lovelace" });

    fireEvent.click(screen.getByRole("button", { name: "Front Google Contacts" }));

    await waitFor(async () => {
      const links = await readContactLinks();
      expect(links[0]?.frontContactId).toBe("c-google");
    });
  });

  it("Unlink restores two cards by dropping the link", async () => {
    await seedPair();
    await linkContacts("link-1", "c-local", "c-google");
    renderDialog("c-local");

    fireEvent.click(await screen.findByRole("button", { name: "Unlink Google Contacts" }));

    await waitFor(async () => {
      expect(await readContactLinks()).toEqual([]);
    });
    await screen.findByRole("button", { name: "Edit" });
  });

  it("edits the record a field came from, not whichever one fronts the card", async () => {
    await seedPair();
    await linkContacts("link-1", "c-local", "c-google");
    renderDialog("c-local");

    fireEvent.click(await screen.findByRole("button", { name: "Edit Google Contacts" }));
    // The form opened against the Google record: its own address is in it,
    // the Local record's note is not.
    const notes = screen.getByLabelText("Notes") as HTMLTextAreaElement;
    expect(notes.value).toBe("");
    fireEvent.change(notes, { target: { value: "from the Google record" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(async () => {
      expect((await localCache().contacts.get("c-google"))?.notes).toBe("from the Google record");
      expect((await localCache().contacts.get("c-local"))?.notes).toBe("met at the museum");
    });
  });

  it("searches every address on every linked record in Mail history", async () => {
    await seedPair();
    await linkContacts("link-1", "c-local", "c-google");
    let participants: string[] | undefined;
    stubSearch((request) => {
      participants = request.participants;
      return emptySearch();
    });
    renderDialog("c-local");

    fireEvent.click(await screen.findByRole("tab", { name: "Mail history" }));

    await waitFor(() => {
      expect(participants).toEqual(["ada@example.com", "ada@work.example"]);
    });
  });
});
