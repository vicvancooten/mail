import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeMailAccount } from "../test-support/mail-fixtures.js";
import { MailAccountsSection, scrollToMailAccountSettings } from "./MailAccountsSection.js";

vi.mock("../api/mail-accounts.js", () => ({
  fetchMailAccounts: vi.fn(async () => ({
    mailAccounts: [
      makeMailAccount("acct-1"),
      makeMailAccount("acct-2", { status: "needs_reauth" }),
    ],
  })),
}));

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
 * `scrollToMailAccountSettings` is the last step of a `needs_reauth`
 * notification click (#53, ADR-0015): `router/RootLayout.tsx`'s own
 * notification-target effect navigates to `/settings` (#71) and calls this
 * once that lands, to scroll the matching row into view within it.
 */
describe("scrollToMailAccountSettings", () => {
  it("scrolls the matching Mail Account's row into view", async () => {
    render(<MailAccountsSection />);
    await screen.findByText("acct-2@example.test");

    const row = document.getElementById("mail-account-acct-2");
    if (!row) throw new Error("expected the acct-2 row to be in the DOM");
    const scrollIntoView = vi.fn();
    row.scrollIntoView = scrollIntoView;

    scrollToMailAccountSettings("acct-2");

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when no row matches the target — the click can arrive before the list has loaded", async () => {
    render(<MailAccountsSection />);
    await waitFor(() => expect(document.getElementById("mail-account-acct-1")).not.toBeNull());

    expect(() => scrollToMailAccountSettings("acct-does-not-exist")).not.toThrow();
  });
});

/**
 * The Needs Reauth affordance branches on `authKind` (#119): never a
 * password form for an OAuth account, and a password account's settings row
 * offers to switch to a Grant regardless of its status.
 */
describe("the Needs Reauth affordance", () => {
  it("shows the password form on a password account", async () => {
    const { fetchMailAccounts } = await import("../api/mail-accounts.js");
    vi.mocked(fetchMailAccounts).mockResolvedValueOnce({
      mailAccounts: [makeMailAccount("acct-pw", { status: "needs_reauth" })],
    });
    render(<MailAccountsSection />);

    expect(await screen.findByLabelText("Username")).toBeDefined();
    expect(screen.getByLabelText("Password")).toBeDefined();
    expect(screen.queryByRole("button", { name: /Sign in with/ })).toBeNull();
  });

  it("shows the sign-in-again action and no password fields on an OAuth account", async () => {
    const { fetchMailAccounts } = await import("../api/mail-accounts.js");
    vi.mocked(fetchMailAccounts).mockResolvedValueOnce({
      mailAccounts: [
        makeMailAccount("acct-oauth", {
          status: "needs_reauth",
          authKind: { kind: "oauth", provider: "google" },
        }),
      ],
    });
    render(<MailAccountsSection />);

    expect(await screen.findByRole("button", { name: "Sign in with Google again" })).toBeDefined();
    expect(screen.queryByLabelText("Password")).toBeNull();
  });

  it("offers a password Gmail account switch-to-Google-sign-in even while active", async () => {
    const { fetchMailAccounts } = await import("../api/mail-accounts.js");
    vi.mocked(fetchMailAccounts).mockResolvedValueOnce({
      mailAccounts: [makeMailAccount("acct-pw", { status: "active" })],
    });
    render(<MailAccountsSection />);

    expect(await screen.findByRole("button", { name: "Switch to Google sign-in" })).toBeDefined();
  });
});
