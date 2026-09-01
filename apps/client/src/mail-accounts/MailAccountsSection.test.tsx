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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * `scrollToMailAccountSettings` is the client-side "navigate to that Mail
 * Account's settings" action a `needs_reauth` notification click drives
 * (#53, ADR-0015) — there's no router here, so it's a DOM scroll into this
 * always-rendered section's matching row rather than a URL change
 * (`MailSection.tsx`'s notification-target effect calls this directly).
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
