import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localCache, openLocalCache } from "../store/local-cache.js";
import { applyConnectedAccountAddressBookDelta } from "../store/server-writes.js";
import { setSessionUserId } from "../store/session.js";
import { delta, makeAddressBook, makeConnectedAccount } from "../test-support/mail-fixtures.js";
import { ConnectedAccountFacetBadge } from "./ConnectedAccountFacetBadge.js";

const USER = "user-1";
const CONNECTED_ACCOUNT_ID = "acct-1-connected";

let counter = 0;
const names: string[] = [];

beforeEach(async () => {
  const name = `connected-account-facet-badge-test-${counter++}`;
  names.push(name);
  await openLocalCache({ name, schemaVersion: 1 });
  setSessionUserId(USER);
});

afterEach(async () => {
  cleanup();
  localCache().close();
  setSessionUserId(null);
  for (const nm of names.splice(0)) await Dexie.delete(nm);
});

/**
 * The checklist's own home (#215's own acceptance line: "The checklist
 * renders in the Contacts Facet cell's Popover, never a modal") — mounted
 * for the Contacts Facet only, alongside every other Facet's own Fix
 * content this Popover already carries.
 */
describe("the Contacts Facet cell's Popover", () => {
  it("renders the Address Book checklist for the Contacts Facet", async () => {
    await applyConnectedAccountAddressBookDelta(
      CONNECTED_ACCOUNT_ID,
      delta({
        created: [
          makeAddressBook("book-1", {
            name: "Google Contacts",
            origin: { kind: "connectedAccount", connectedAccountId: CONNECTED_ACCOUNT_ID },
            mirrored: true,
          }),
        ],
      }),
      { replace: false },
    );

    const account = makeConnectedAccount(CONNECTED_ACCOUNT_ID, {
      facets: [{ kind: "contacts", status: "active" }],
    });
    render(
      <ConnectedAccountFacetBadge account={account} facet="contacts" mailAccount={null} isOwner />,
    );

    await userEvent.click(screen.getByText(account.identity));

    expect(await screen.findByLabelText("Google Contacts")).toBeDefined();
  });

  it("never renders the Address Book checklist for the Mail Facet", async () => {
    const account = makeConnectedAccount(CONNECTED_ACCOUNT_ID, {
      facets: [{ kind: "mail", status: "active" }],
    });
    render(
      <ConnectedAccountFacetBadge account={account} facet="mail" mailAccount={null} isOwner />,
    );

    await userEvent.click(screen.getByText(account.identity));

    expect(screen.queryByText(/No address books found/i)).toBeNull();
  });
});
