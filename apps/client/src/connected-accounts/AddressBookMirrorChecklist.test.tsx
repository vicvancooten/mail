import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localCache, openLocalCache } from "../store/local-cache.js";
import { applyConnectedAccountAddressBookDelta } from "../store/server-writes.js";
import { setSessionUserId } from "../store/session.js";
import { delta, makeAddressBook } from "../test-support/mail-fixtures.js";
import { AddressBookMirrorChecklist } from "./AddressBookMirrorChecklist.js";

const USER = "user-1";
const CONNECTED_ACCOUNT_ID = "acct-1";

const fetchUnmirrorAddressBookImpact = vi.fn();
const unmirrorAddressBook = vi.fn();
const mirrorAddressBook = vi.fn();

vi.mock("@/api/address-books.js", () => ({
  fetchUnmirrorAddressBookImpact: (...args: unknown[]) => fetchUnmirrorAddressBookImpact(...args),
  unmirrorAddressBook: (...args: unknown[]) => unmirrorAddressBook(...args),
  mirrorAddressBook: (...args: unknown[]) => mirrorAddressBook(...args),
}));

let counter = 0;
const names: string[] = [];

beforeEach(async () => {
  const name = `address-book-mirror-checklist-test-${counter++}`;
  names.push(name);
  await openLocalCache({ name, schemaVersion: 1 });
  setSessionUserId(USER);
  fetchUnmirrorAddressBookImpact.mockReset();
  unmirrorAddressBook.mockReset();
  mirrorAddressBook.mockReset();
});

afterEach(async () => {
  cleanup();
  localCache().close();
  setSessionUserId(null);
  for (const nm of names.splice(0)) await Dexie.delete(nm);
});

function connectedAccountAddressBook(
  id: string,
  overrides: Partial<Parameters<typeof makeAddressBook>[1]> = {},
) {
  return makeAddressBook(id, {
    origin: { kind: "connectedAccount", connectedAccountId: CONNECTED_ACCOUNT_ID },
    isDefault: false,
    ...overrides,
  });
}

async function seed(addressBooks: ReturnType<typeof connectedAccountAddressBook>[]) {
  await applyConnectedAccountAddressBookDelta(
    CONNECTED_ACCOUNT_ID,
    delta({ created: addressBooks }),
    { replace: false },
  );
}

describe("AddressBookMirrorChecklist (#215)", () => {
  it("lists every discovered Address Book, mirrored and unmirrored alike", async () => {
    await seed([
      connectedAccountAddressBook("book-work", { name: "Work", mirrored: true }),
      connectedAccountAddressBook("book-newsletter", { name: "Newsletter", mirrored: false }),
    ]);

    render(<AddressBookMirrorChecklist connectedAccountId={CONNECTED_ACCOUNT_ID} />);

    const work = await screen.findByLabelText<HTMLInputElement>("Work");
    const newsletter = await screen.findByLabelText<HTMLInputElement>("Newsletter");
    expect(work.checked).toBe(true);
    expect(newsletter.checked).toBe(false);
  });

  it("never lists an Address Book from a different Connected Account", async () => {
    await applyConnectedAccountAddressBookDelta(
      CONNECTED_ACCOUNT_ID,
      delta({ created: [connectedAccountAddressBook("book-mine", { name: "Mine" })] }),
      { replace: false },
    );
    await applyConnectedAccountAddressBookDelta(
      "acct-2",
      delta({
        created: [
          makeAddressBook("book-other", {
            name: "Someone else's",
            origin: { kind: "connectedAccount", connectedAccountId: "acct-2" },
          }),
        ],
      }),
      { replace: false },
    );

    render(<AddressBookMirrorChecklist connectedAccountId={CONNECTED_ACCOUNT_ID} />);

    await screen.findByLabelText("Mine");
    expect(screen.queryByLabelText("Someone else's")).toBeNull();
  });

  it("checking a box back on calls mirrorAddressBook with no confirm dialog", async () => {
    await seed([
      connectedAccountAddressBook("book-newsletter", { name: "Newsletter", mirrored: false }),
    ]);
    mirrorAddressBook.mockResolvedValue({
      addressBook: connectedAccountAddressBook("book-newsletter", { mirrored: true }),
    });

    render(<AddressBookMirrorChecklist connectedAccountId={CONNECTED_ACCOUNT_ID} />);
    const checkbox = await screen.findByLabelText("Newsletter");
    await userEvent.click(checkbox);

    await waitFor(() => expect(mirrorAddressBook).toHaveBeenCalledWith("book-newsletter"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("unchecking a box previews the discard count and confirms before unmirroring", async () => {
    await seed([connectedAccountAddressBook("book-work", { name: "Work", mirrored: true })]);
    fetchUnmirrorAddressBookImpact.mockResolvedValue({ discarded: { contacts: 3 } });
    unmirrorAddressBook.mockResolvedValue({
      addressBook: connectedAccountAddressBook("book-work", { mirrored: false }),
      discarded: { contacts: 3 },
    });

    render(<AddressBookMirrorChecklist connectedAccountId={CONNECTED_ACCOUNT_ID} />);
    const checkbox = await screen.findByLabelText("Work");
    await userEvent.click(checkbox);

    await waitFor(() => expect(fetchUnmirrorAddressBookImpact).toHaveBeenCalledWith("book-work"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/discards 3 synced contacts/i)).not.toBeNull();
    expect(unmirrorAddressBook).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole("button", { name: /stop mirroring/i }));

    await waitFor(() => expect(unmirrorAddressBook).toHaveBeenCalledWith("book-work"));
  });

  it("cancelling the confirm dialog never calls unmirrorAddressBook", async () => {
    await seed([connectedAccountAddressBook("book-work", { name: "Work", mirrored: true })]);
    fetchUnmirrorAddressBookImpact.mockResolvedValue({ discarded: { contacts: 1 } });

    render(<AddressBookMirrorChecklist connectedAccountId={CONNECTED_ACCOUNT_ID} />);
    const checkbox = await screen.findByLabelText("Work");
    await userEvent.click(checkbox);

    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: /cancel/i }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(unmirrorAddressBook).not.toHaveBeenCalled();
  });
});
