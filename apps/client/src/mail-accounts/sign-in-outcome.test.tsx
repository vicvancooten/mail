import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeMailAccount } from "../test-support/mail-fixtures.js";
import { MailAccountsSection } from "./MailAccountsSection.js";
import { clearSignInOutcome, readSignInOutcome } from "./sign-in-outcome.js";

const fetchMailAccounts = vi.fn(async () => ({ mailAccounts: [makeMailAccount("acct-1")] }));

vi.mock("../api/mail-accounts.js", () => ({
  fetchMailAccounts: (...args: unknown[]) =>
    (fetchMailAccounts as unknown as (...a: unknown[]) => unknown)(...args),
}));

vi.mock("../api/oauth-signin.js", () => ({
  fetchProviderAvailability: vi.fn(async () => ({ providers: [] })),
  startProviderSignIn: vi.fn(),
}));

/**
 * The return leg of a Provider sign-in (#116): the callback redirected the
 * browser to `/settings/mail-accounts?oauth=<outcome>`, and this is what the
 * User actually sees when they land.
 */

function landOn(search: string) {
  window.history.replaceState({}, "", `/settings/mail-accounts${search}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  landOn("");
});

afterEach(() => {
  cleanup();
});

describe("readSignInOutcome", () => {
  it("reads a known outcome and its message", () => {
    expect(readSignInOutcome("?oauth=signed_in")).toMatchObject({
      outcome: "signed_in",
      succeeded: true,
    });
    expect(readSignInOutcome("?oauth=duplicate_address")).toMatchObject({
      outcome: "duplicate_address",
      succeeded: false,
    });
  });

  it("reads tenant_refused (#117) as a failure that names the organisation as the refuser", () => {
    expect(readSignInOutcome("?oauth=tenant_refused")).toMatchObject({
      outcome: "tenant_refused",
      succeeded: false,
      message: expect.stringContaining("organisation"),
    });
  });

  it("ignores a query string with no outcome, or an outcome this build doesn't know", () => {
    expect(readSignInOutcome("")).toBeNull();
    expect(readSignInOutcome("?other=1")).toBeNull();
    expect(readSignInOutcome("?oauth=made-up")).toBeNull();
  });
});

describe("clearSignInOutcome", () => {
  it("drops the outcome without adding a history entry, leaving other parameters alone", () => {
    landOn("?oauth=signed_in&keep=me");
    const before = window.history.length;

    clearSignInOutcome();

    expect(window.location.search).toBe("?keep=me");
    expect(window.history.length).toBe(before);
  });

  it("is a no-op when there is nothing to clear", () => {
    landOn("?keep=me");
    clearSignInOutcome();
    expect(window.location.search).toBe("?keep=me");
  });
});

describe("the toast on the Mail Accounts page", () => {
  it("reports a success, reloads the list, and clears the query string", async () => {
    landOn("?oauth=signed_in");

    render(<MailAccountsSection />);

    expect(await screen.findByRole("status")).toHaveProperty(
      "textContent",
      expect.stringContaining("Signed in. The new Mail Account is syncing now."),
    );
    // The account was created while the browser was away, so the list on
    // screen is stale until this reload — once for the mount, once for the
    // outcome.
    await waitFor(() => expect(fetchMailAccounts).toHaveBeenCalledTimes(2));
    expect(window.location.search).toBe("");
  });

  it("reports a failure plainly and does not reload — nothing was created", async () => {
    landOn("?oauth=duplicate_address");

    render(<MailAccountsSection />);

    expect(
      await screen.findByText("That address is already one of your Mail Accounts.", {
        exact: false,
      }),
    ).toBeDefined();
    expect(fetchMailAccounts).toHaveBeenCalledTimes(1);
  });

  it("shows nothing when the page wasn't reached from a Provider", async () => {
    render(<MailAccountsSection />);

    await screen.findByText("acct-1@example.test");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("can be dismissed", async () => {
    landOn("?oauth=cancelled");
    const user = userEvent.setup();
    render(<MailAccountsSection />);

    await user.click(await screen.findByRole("button", { name: "Dismiss" }));

    expect(screen.queryByRole("status")).toBeNull();
  });
});
