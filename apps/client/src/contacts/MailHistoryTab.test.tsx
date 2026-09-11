import type { SearchRequest, SearchResponse } from "@mail/shared";
import { EMPTY_CONTACT_FIELDS } from "@mail/shared";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createContact, newContactId, updateContact } from "../store/contacts.js";
import { localCache, openLocalCache } from "../store/local-cache.js";
import { applyMailAccountDelta } from "../store/server-writes.js";
import { setSessionUserId } from "../store/session.js";
import {
  delta,
  makeAddressBook,
  makeMailAccount,
  makeThread,
} from "../test-support/mail-fixtures.js";
import { jsonResponse } from "../test-support/mock-fetch.js";
import { ContactDialog } from "./ContactDialog.js";

/**
 * The Person Page's Mail history tab (#217): `ContactDialog.test.tsx` covers
 * Details/Edit — this file is its own "Mail history" tab, stubbing `fetch`
 * for `POST /search` the way `search-integration.test.tsx` does (a real
 * Local Cache, a real `runServerSearch` round trip, never a mocked hook).
 */

const USER = "user-1";
const LOCAL_BOOK = makeAddressBook("book-1");
let counter = 0;
const names: string[] = [];

function stubSearch(handler: (request: SearchRequest) => SearchResponse) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/search") {
        const request = JSON.parse(String(init?.body)) as SearchRequest;
        return Promise.resolve(jsonResponse(handler(request)));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }),
  );
}

function emptyResponse(): SearchResponse {
  return { results: [], cursor: null, indexWatermark: { coveredSince: null, complete: true } };
}

beforeEach(async () => {
  const name = `mail-history-tab-test-${counter++}`;
  names.push(name);
  await openLocalCache({ name, schemaVersion: 1 });
  setSessionUserId(USER);
  await applyMailAccountDelta(delta({ created: [makeMailAccount("acct-1")] }), {
    replace: false,
  });
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  localCache().close();
  setSessionUserId(null);
  for (const nm of names.splice(0)) await Dexie.delete(nm);
});

describe("MailHistoryTab (#217)", () => {
  it("says so rather than searching when the Contact has no addresses", async () => {
    stubSearch(() => emptyResponse());
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
    fireEvent.click(await screen.findByRole("tab", { name: "Mail history" }));

    await screen.findByText("Add an email address to see this Contact's mail.");
  });

  it("sends every address on the Contact as `participants`, and renders a hit as a thread row", async () => {
    const id = newContactId();
    await createContact(id, LOCAL_BOOK.id, EMPTY_CONTACT_FIELDS);
    await updateContact(id, {
      ...EMPTY_CONTACT_FIELDS,
      emails: [{ id: "e1", type: "work", value: "Ann@Example.com", primary: true }],
    });

    let sentParticipants: string[] | undefined;
    stubSearch((request) => {
      sentParticipants = request.participants;
      return {
        results: [
          {
            thread: makeThread("t1", "acct-1", { subject: "Quarterly budget" }),
            matchedMessageId: "t1-msg",
            headline: null,
            folder: { id: "f1", name: "Inbox", role: "inbox" },
            gatekeeper: null,
          },
        ],
        cursor: null,
        indexWatermark: { coveredSince: null, complete: true },
      };
    });

    render(
      <ContactDialog
        addressBook={LOCAL_BOOK}
        contactId={id}
        onClose={() => {}}
        onOpenThread={() => {}}
      />,
    );
    fireEvent.click(await screen.findByRole("tab", { name: "Mail history" }));

    await screen.findByText("Quarterly budget");
    expect(sentParticipants).toEqual(["ann@example.com"]);
  });

  it("opens the row's own Thread via onOpenThread", async () => {
    const id = newContactId();
    await createContact(id, LOCAL_BOOK.id, EMPTY_CONTACT_FIELDS);
    await updateContact(id, {
      ...EMPTY_CONTACT_FIELDS,
      emails: [{ id: "e1", type: "work", value: "ann@example.com", primary: true }],
    });
    stubSearch(() => ({
      results: [
        {
          thread: makeThread("t1", "acct-1", { subject: "Quarterly budget" }),
          matchedMessageId: "t1-msg",
          headline: null,
          folder: { id: "f1", name: "Inbox", role: "inbox" },
          gatekeeper: null,
        },
      ],
      cursor: null,
      indexWatermark: { coveredSince: null, complete: true },
    }));

    const opened: string[] = [];
    render(
      <ContactDialog
        addressBook={LOCAL_BOOK}
        contactId={id}
        onClose={() => {}}
        onOpenThread={(threadId) => opened.push(threadId)}
      />,
    );
    fireEvent.click(await screen.findByRole("tab", { name: "Mail history" }));
    fireEvent.click(await screen.findByText("Quarterly budget"));

    await waitFor(() => expect(opened).toEqual(["t1"]));
  });
});
