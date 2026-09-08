import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeConnectedAccount, makeMailAccount } from "../test-support/mail-fixtures.js";
import { ConnectedAccountsTable } from "./ConnectedAccountsTable.js";

vi.mock("../api/oauth-signin.js", () => ({
  fetchProviderAvailability: vi.fn(async () => ({
    providers: [
      { provider: "google", available: true, unavailableReason: null },
      { provider: "microsoft", available: true, unavailableReason: null },
    ],
  })),
  startProviderSignIn: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * The Provider × Facet grid itself (#201, #172 Variant C, locked in):
 * `provider-table.ts`'s own matrix decides which cells are real and which
 * are an em dash, independent of any account data.
 */
describe("the table's shape", () => {
  it("renders every Provider row and every Facet column", () => {
    render(
      <ConnectedAccountsTable
        connectedAccounts={[]}
        mailAccounts={[]}
        isOwner={false}
        focusMailAccountId={null}
      />,
    );

    for (const provider of ["Google", "Microsoft", "CalDAV/CardDAV", "Other IMAP"]) {
      expect(screen.getByRole("rowheader", { name: provider })).toBeDefined();
    }
    for (const facet of ["Mail", "Calendar", "Contacts"]) {
      expect(screen.getByRole("columnheader", { name: facet })).toBeDefined();
    }
  });

  it("shows an em dash for a Provider/Facet combination that can never exist", () => {
    render(
      <ConnectedAccountsTable
        connectedAccounts={[]}
        mailAccounts={[]}
        isOwner={false}
        focusMailAccountId={null}
      />,
    );

    const otherImapRow = screen.getByRole("rowheader", { name: "Other IMAP" }).closest("tr");
    if (!otherImapRow) throw new Error("expected an Other IMAP row");
    const [mailCell, calendarCell, contactsCell] = within(otherImapRow).getAllByRole("cell");
    // Mail (real), then Calendar and Contacts — both impossible for a plain IMAP mailbox.
    expect(mailCell?.textContent).not.toBe("—");
    expect(calendarCell?.textContent).toBe("—");
    expect(contactsCell?.textContent).toBe("—");

    const caldavRow = screen.getByRole("rowheader", { name: "CalDAV/CardDAV" }).closest("tr");
    if (!caldavRow) throw new Error("expected a CalDAV/CardDAV row");
    // Mail is the one impossible column for a CalDAV/CardDAV identity.
    const [caldavMailCell] = within(caldavRow).getAllByRole("cell");
    expect(caldavMailCell?.textContent).toBe("—");
  });

  it("still offers a dashed add control on an otherwise-empty possible cell", () => {
    render(
      <ConnectedAccountsTable
        connectedAccounts={[]}
        mailAccounts={[]}
        isOwner={false}
        focusMailAccountId={null}
      />,
    );

    const googleRow = screen.getByRole("rowheader", { name: "Google" }).closest("tr");
    if (!googleRow) throw new Error("expected a Google row");
    expect(within(googleRow).getAllByText("+")).toHaveLength(3);
  });
});

/**
 * A Connected Account's own status-dot Badge (#201): outline when its Mail
 * Facet is `active`, destructive with a working Fix when it's
 * `needs_reauth` — `mail-accounts/MailAccountsSection.tsx`'s own Needs
 * Reauth branch, unchanged, just reached through a Popover now.
 */
describe("an existing account's Facet Badge", () => {
  it("shows a plain Connected Popover for an active account", async () => {
    const user = userEvent.setup();
    const mailAccount = makeMailAccount("acct-1");
    const connectedAccount = makeConnectedAccount("acct-1-connected", {
      identity: "acct-1@example.test",
    });
    render(
      <ConnectedAccountsTable
        connectedAccounts={[connectedAccount]}
        mailAccounts={[mailAccount]}
        isOwner={false}
        focusMailAccountId={null}
      />,
    );

    await user.click(screen.getByText("acct-1@example.test"));

    expect(await screen.findByText("Connected.")).toBeDefined();
  });

  it("offers the sign-in-again Fix for an OAuth account in Needs Reauth", async () => {
    const user = userEvent.setup();
    const mailAccount = makeMailAccount("acct-2", {
      status: "needs_reauth",
      authKind: { kind: "oauth", provider: "google" },
    });
    const connectedAccount = makeConnectedAccount("acct-2-connected", {
      identity: "acct-2@example.test",
      status: "needs_reauth",
      facets: [{ kind: "mail", status: "needs_reauth" }],
    });
    render(
      <ConnectedAccountsTable
        connectedAccounts={[connectedAccount]}
        mailAccounts={[mailAccount]}
        isOwner={false}
        focusMailAccountId={null}
      />,
    );

    await user.click(screen.getByText("acct-2@example.test"));

    expect(await screen.findByRole("button", { name: "Sign in with Google again" })).toBeDefined();
  });

  it("opens automatically when it matches the focused Mail Account (#53, #201 deep link)", async () => {
    const mailAccount = makeMailAccount("acct-3", { status: "needs_reauth" });
    const connectedAccount = makeConnectedAccount("acct-3-connected", {
      identity: "acct-3@example.test",
      status: "needs_reauth",
      facets: [{ kind: "mail", status: "needs_reauth" }],
    });
    render(
      <ConnectedAccountsTable
        connectedAccounts={[connectedAccount]}
        mailAccounts={[mailAccount]}
        isOwner={false}
        focusMailAccountId="acct-3"
      />,
    );

    expect(await screen.findByLabelText("Username")).toBeDefined();
  });
});

/**
 * The dashed "+" per cell (#201): Mail's already has a working add flow
 * (`AddMailAccountForm`); Calendar and Contacts don't yet — "the flows that
 * fill them are the slices after this one" (#201's own scope note) — so
 * their Popover only names which Providers will eventually serve them.
 */
describe("the add control", () => {
  it("opens the real Add a Mail Account flow in the Mail column", async () => {
    const user = userEvent.setup();
    render(
      <ConnectedAccountsTable
        connectedAccounts={[]}
        mailAccounts={[]}
        isOwner={false}
        focusMailAccountId={null}
      />,
    );

    const googleRow = screen.getByRole("rowheader", { name: "Google" }).closest("tr");
    if (!googleRow) throw new Error("expected a Google row");
    const [mailAdd] = within(googleRow).getAllByText("+");
    if (!mailAdd) throw new Error("expected an add control in the Mail cell");
    await user.click(mailAdd);

    expect(await screen.findByRole("heading", { name: "Add a Mail Account" })).toBeDefined();
  });

  it("names the future Providers for a Calendar cell instead of a working flow", async () => {
    const user = userEvent.setup();
    render(
      <ConnectedAccountsTable
        connectedAccounts={[]}
        mailAccounts={[]}
        isOwner={false}
        focusMailAccountId={null}
      />,
    );

    const googleRow = screen.getByRole("rowheader", { name: "Google" }).closest("tr");
    if (!googleRow) throw new Error("expected a Google row");
    const [, calendarAdd] = within(googleRow).getAllByText("+");
    if (!calendarAdd) throw new Error("expected an add control in the Calendar cell");
    await user.click(calendarAdd);

    expect(await screen.findByText(/Not available yet/)).toBeDefined();
  });
});
