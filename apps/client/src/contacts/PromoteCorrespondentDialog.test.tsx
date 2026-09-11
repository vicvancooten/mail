import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localCache, openLocalCache } from "../store/local-cache.js";
import { listQueuedMutations } from "../store/mutation-queue.js";
import { setSessionUserId } from "../store/session.js";
import { makeAddressBook } from "../test-support/mail-fixtures.js";
import { PromoteCorrespondentDialog } from "./PromoteCorrespondentDialog.js";

const USER = "user-1";
let counter = 0;
const names: string[] = [];

beforeEach(async () => {
  const name = `promote-correspondent-test-${counter++}`;
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

describe("PromoteCorrespondentDialog (#218)", () => {
  it("pre-fills the Correspondent's display name and address, and lands in the Default Address Book on Save", async () => {
    await localCache().addressBooks.put(makeAddressBook("book-local", { isDefault: true }));

    render(
      <PromoteCorrespondentDialog
        person={{ address: "ada@example.test", name: "Ada" }}
        onClose={() => {}}
      />,
    );
    await screen.findByRole("dialog");

    expect((screen.getByLabelText("Given name") as HTMLInputElement).value).toBe("Ada");
    expect((screen.getByLabelText("Email value") as HTMLInputElement).value).toBe(
      "ada@example.test",
    );
    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(async () => {
      const rows = await localCache().contacts.toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        addressBookId: "book-local",
        name: { given: "Ada" },
        emails: [{ type: "home", value: "ada@example.test", primary: true }],
      });
    });
  });

  it("offers a one-time Address Book override when more than one Address Book exists", async () => {
    await localCache().addressBooks.bulkPut([
      makeAddressBook("book-local", { name: "My Contacts", isDefault: true }),
      makeAddressBook("book-google", {
        name: "Google Contacts",
        isDefault: false,
        origin: { kind: "connectedAccount", connectedAccountId: "acct-1-connected" },
        capabilityTableId: "google",
      }),
    ]);

    render(
      <PromoteCorrespondentDialog
        person={{ address: "ada@example.test", name: "Ada" }}
        onClose={() => {}}
      />,
    );
    await screen.findByRole("dialog");

    fireEvent.change(screen.getByLabelText("Address Book"), { target: { value: "book-google" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(async () => {
      const rows = await localCache().contacts.toArray();
      expect(rows[0]?.addressBookId).toBe("book-google");
    });
  });

  it("offers no Address Book override when only one Address Book exists", async () => {
    await localCache().addressBooks.put(makeAddressBook("book-local", { isDefault: true }));

    render(
      <PromoteCorrespondentDialog
        person={{ address: "ada@example.test", name: "Ada" }}
        onClose={() => {}}
      />,
    );
    await screen.findByRole("dialog");

    expect(screen.queryByLabelText("Address Book")).toBeNull();
  });
});

describe("PromoteCorrespondentDialog's gatekeeper prop (#219)", () => {
  it("writes no Verdict when opened with no gatekeeper prop, and shows no Approve control", async () => {
    await localCache().addressBooks.put(makeAddressBook("book-local", { isDefault: true }));

    render(
      <PromoteCorrespondentDialog
        person={{ address: "ada@example.test", name: "Ada" }}
        onClose={() => {}}
      />,
    );
    await screen.findByRole("dialog");
    expect(screen.queryByLabelText("Approve as well")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(async () => expect(await localCache().contacts.toArray()).toHaveLength(1));

    expect(await listQueuedMutations("acct-1")).toHaveLength(0);
  });

  it("ticks Approve as well by default from the Screener, and writes a Verdict scoped to the Mail Account on Save", async () => {
    await localCache().addressBooks.put(makeAddressBook("book-local", { isDefault: true }));

    render(
      <PromoteCorrespondentDialog
        person={{ address: "ada@example.test", name: "Ada" }}
        gatekeeper={{ mailAccountId: "acct-1", approveByDefault: true }}
        onClose={() => {}}
      />,
    );
    await screen.findByRole("dialog");
    const checkbox = screen.getByLabelText("Approve as well") as HTMLInputElement;
    expect(checkbox.checked).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(async () => {
      const mutations = await listQueuedMutations("acct-1");
      expect(mutations).toHaveLength(1);
      expect(mutations[0]?.intent).toMatchObject({
        type: "approveSender",
        sender: { scope: "address", value: "ada@example.test" },
      });
    });
  });

  it("unticks Approve as well by default from the Reader, and writes no Verdict when left unticked", async () => {
    await localCache().addressBooks.put(makeAddressBook("book-local", { isDefault: true }));

    render(
      <PromoteCorrespondentDialog
        person={{ address: "ada@example.test", name: "Ada" }}
        gatekeeper={{ mailAccountId: "acct-1", approveByDefault: false }}
        onClose={() => {}}
      />,
    );
    await screen.findByRole("dialog");
    const checkbox = screen.getByLabelText("Approve as well") as HTMLInputElement;
    expect(checkbox.checked).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(async () => expect(await localCache().contacts.toArray()).toHaveLength(1));

    expect(await listQueuedMutations("acct-1")).toHaveLength(0);
  });

  it("writes a Verdict when the User ticks Approve as well themselves, unticked by default", async () => {
    await localCache().addressBooks.put(makeAddressBook("book-local", { isDefault: true }));

    render(
      <PromoteCorrespondentDialog
        person={{ address: "ada@example.test", name: "Ada" }}
        gatekeeper={{ mailAccountId: "acct-1", approveByDefault: false }}
        onClose={() => {}}
      />,
    );
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByLabelText("Approve as well"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(async () => {
      const mutations = await listQueuedMutations("acct-1");
      expect(mutations).toHaveLength(1);
      expect(mutations[0]?.intent).toMatchObject({ type: "approveSender" });
    });
  });
});
