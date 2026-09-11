import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localCache, openLocalCache } from "../store/local-cache.js";
import { setSessionUserId } from "../store/session.js";
import { makeAddressBook, makeCorrespondent } from "../test-support/mail-fixtures.js";
import { PeopleYouveMailedList } from "./PeopleYouveMailedList.js";

/**
 * `PeopleYouveMailedList` takes its Mail Account ids as a plain prop —
 * `ContactsGrid.tsx` is the one that derives it from Account Scope — so this
 * file only ever seeds `correspondents`/`contacts`/`addressBooks` straight
 * into the Local Cache, `ContactDialog.test.tsx`'s own harness shape (#218).
 */

const USER = "user-1";
let counter = 0;
const names: string[] = [];

beforeEach(async () => {
  const name = `people-youve-mailed-test-${counter++}`;
  names.push(name);
  await openLocalCache({ name, schemaVersion: 1 });
  setSessionUserId(USER);
  await localCache().addressBooks.put(makeAddressBook("book-1"));
});

afterEach(async () => {
  cleanup();
  localCache().close();
  setSessionUserId(null);
  for (const nm of names.splice(0)) await Dexie.delete(nm);
});

describe("PeopleYouveMailedList (#218)", () => {
  it("merges Correspondents across every Mail Account in scope, ranked by score", async () => {
    await localCache().correspondents.bulkPut([
      makeCorrespondent("c1", "acct-1", { address: "ada@example.test", name: "Ada", score: 3 }),
      makeCorrespondent("c2", "acct-2", { address: "grace@example.test", name: "Grace", score: 9 }),
    ]);

    render(<PeopleYouveMailedList mailAccountIdsInScope={["acct-1", "acct-2"]} />);

    const items = await screen.findAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining("Grace"),
      expect.stringContaining("Ada"),
    ]);
  });

  it("excludes an address already on a Contact, and drops it as soon as Save creates one", async () => {
    await localCache().correspondents.bulkPut([
      makeCorrespondent("c1", "acct-1", { address: "ada@example.test", name: "Ada", score: 3 }),
    ]);

    render(<PeopleYouveMailedList mailAccountIdsInScope={["acct-1"]} />);
    await screen.findByText("Ada");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.queryByText("Ada")).toBeNull();
    });
    await waitFor(async () => {
      const contacts = await localCache().contacts.toArray();
      expect(contacts).toHaveLength(1);
      expect(contacts[0]?.emails[0]?.value).toBe("ada@example.test");
    });
  });

  it("shows the empty state once every Correspondent is already a Contact", async () => {
    render(<PeopleYouveMailedList mailAccountIdsInScope={["acct-1"]} />);
    expect(await screen.findByText("No one new to save yet.")).toBeDefined();
  });
});
