import type { ConnectedAccount, ProviderAvailability } from "@mail/shared";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as oauthSigninApi from "../api/oauth-signin.js";
import { makeConnectedAccount } from "../test-support/mail-fixtures.js";
import { AddFacetControl } from "./AddFacetControl.js";

vi.mock("../api/oauth-signin.js", () => ({
  fetchProviderAvailability: vi.fn(),
  startFacetGrant: vi.fn(),
}));

/**
 * Calendar/Contacts' real turn-on flow (#202) alongside CalDAV/CardDAV's own
 * (#203), both offered from the same Popover regardless of which row's "+"
 * opened it (`ConnectedAccountsTable.test.tsx` covers that wiring). Google
 * and Microsoft: the "+" lists the User's already-connected identities at a
 * Provider and starts a consent flow for one — never a second sign-in,
 * never a speculative permission. Mail's own flow (`AddMailAccountForm`) is
 * unchanged and covered by `ConnectedAccountsTable.test.tsx`.
 */

function available(overrides: Partial<ProviderAvailability> = {}): ProviderAvailability {
  return {
    provider: "google",
    available: true,
    unavailableReason: null,
    calendarApiEnabled: true,
    contactsApiEnabled: true,
    ...overrides,
  } as ProviderAvailability;
}

function mockAvailability(...entries: ProviderAvailability[]) {
  vi.mocked(oauthSigninApi.fetchProviderAvailability).mockResolvedValue({ providers: entries });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function openPopover(triggerText = "+") {
  const user = userEvent.setup();
  await user.click(screen.getByText(triggerText));
  return user;
}

describe("a Provider that isn't set up on this instance", () => {
  it("shows the same ask-the-Owner wording a Member sees for Mail", async () => {
    mockAvailability(
      { provider: "google", available: false, unavailableReason: "not_registered" },
      available({ provider: "microsoft" }),
    );
    render(<AddFacetControl facet="calendar" isOwner={false} />);
    await openPopover();

    expect(
      await screen.findByText(/isn't set up on this instance yet, ask the Owner/),
    ).toBeDefined();
  });
});

describe("a Provider registered but not enabled for this Facet", () => {
  it("shows a Facet-specific ask-the-Owner message, distinct from an unregistered Provider", async () => {
    mockAvailability(
      available({ provider: "google", calendarApiEnabled: false }),
      available({ provider: "microsoft" }),
    );
    render(<AddFacetControl facet="calendar" isOwner={false} />);
    await openPopover();

    expect(
      await screen.findByText(/Calendar isn't enabled on this instance's Google Registration yet/),
    ).toBeDefined();
  });

  it("gives the Owner a link to the Instance page instead", async () => {
    mockAvailability(
      available({ provider: "google", contactsApiEnabled: false }),
      available({ provider: "microsoft" }),
    );
    render(<AddFacetControl facet="contacts" isOwner />);
    await openPopover();

    const link = await screen.findByRole("link", { name: "set it up on the Instance page" });
    expect(link.getAttribute("href")).toBe("/settings/instance");
  });
});

describe("a Facet whose API is enabled", () => {
  it("says to connect the Provider for Mail first when the User has no identity there yet", async () => {
    mockAvailability(available({ provider: "google" }), available({ provider: "microsoft" }));
    render(<AddFacetControl facet="calendar" isOwner={false} connectedAccounts={[]} />);
    await openPopover();

    expect(await screen.findByText("Connect Google for Mail first.")).toBeDefined();
  });

  it("says every account already has the Facet when none qualify", async () => {
    mockAvailability(available({ provider: "google" }), available({ provider: "microsoft" }));
    const account: ConnectedAccount = {
      ...makeConnectedAccount("acct-1"),
      facets: [
        { kind: "mail", status: "active" },
        { kind: "calendar", status: "active" },
      ],
    };
    render(<AddFacetControl facet="calendar" isOwner={false} connectedAccounts={[account]} />);
    await openPopover();

    expect(await screen.findByText("Every Google account already has calendar.")).toBeDefined();
  });

  it("lists an identity that doesn't yet carry the Facet, and starts its consent flow on click", async () => {
    mockAvailability(available({ provider: "google" }), available({ provider: "microsoft" }));
    vi.mocked(oauthSigninApi.startFacetGrant).mockResolvedValue({
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?scope=calendar",
    });
    const navigate = vi.fn();
    const account = makeConnectedAccount("acct-1", { identity: "vic@gmail.com" });
    render(
      <AddFacetControl
        facet="calendar"
        isOwner={false}
        connectedAccounts={[account]}
        navigate={navigate}
      />,
    );
    const user = await openPopover();

    const identityButton = await screen.findByRole("button", { name: "vic@gmail.com" });
    await user.click(identityButton);

    expect(oauthSigninApi.startFacetGrant).toHaveBeenCalledWith("google", "acct-1", "calendar");
    expect(navigate).toHaveBeenCalledWith(
      "https://accounts.google.com/o/oauth2/v2/auth?scope=calendar",
    );
  });
});

/**
 * #299's two headline acceptance criteria for Mail's own per-row doors:
 * Google/Microsoft's "+" opens a Popover holding just that one Provider's
 * sign-in step (no chooser, no Dialog); Other IMAP's "+" opens the
 * multi-step form straight into a Dialog (no chooser first either).
 */
describe("a Mail row's own door, scoped to one Provider", () => {
  it("shows only Google's sign-in step in a Popover — not Microsoft's, not a Dialog", async () => {
    mockAvailability(available({ provider: "google" }), available({ provider: "microsoft" }));
    render(<AddFacetControl facet="mail" isOwner={false} provider="google" />);
    await openPopover();

    expect(await screen.findByRole("button", { name: "Sign in with Google" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Sign in with Microsoft" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Other" })).toBeNull();
    // Radix's Popover.Content, like Dialog.Content, renders `role="dialog"`
    // itself — the `data-slot` is what actually tells the two apart here.
    expect(document.querySelector('[data-slot="popover-content"]')).not.toBeNull();
    expect(document.querySelector('[data-slot="dialog-content"]')).toBeNull();
  });

  it("shows only Microsoft's sign-in step in a Popover — not Google's, not a Dialog", async () => {
    mockAvailability(available({ provider: "google" }), available({ provider: "microsoft" }));
    render(<AddFacetControl facet="mail" isOwner={false} provider="microsoft" />);
    await openPopover();

    expect(await screen.findByRole("button", { name: "Sign in with Microsoft" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Sign in with Google" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Other" })).toBeNull();
    expect(document.querySelector('[data-slot="popover-content"]')).not.toBeNull();
    expect(document.querySelector('[data-slot="dialog-content"]')).toBeNull();
  });

  it("opens the IMAP form in a Dialog, no chooser first", async () => {
    render(<AddFacetControl facet="mail" isOwner={false} provider="other_imap" />);
    await openPopover();

    expect(await screen.findByLabelText("Email address")).toBeDefined();
    expect(document.querySelector('[data-slot="dialog-content"]')).not.toBeNull();
    expect(document.querySelector('[data-slot="popover-content"]')).toBeNull();
    expect(screen.queryByRole("button", { name: /Sign in with/ })).toBeNull();
  });
});

describe("every door in one Popover, regardless of which row's + opened it", () => {
  it("shows a section per OAuth Provider plus CalDAV/CardDAV's own working flow", async () => {
    mockAvailability(available({ provider: "google" }), {
      provider: "microsoft",
      available: false,
      unavailableReason: "not_registered",
    });
    render(
      <AddFacetControl
        facet="calendar"
        isOwner={false}
        variant="button"
        label="Add a calendar"
        connectedAccounts={[]}
      />,
    );
    await openPopover("Add a calendar");

    expect(await screen.findByText("Connect Google for Mail first.")).toBeDefined();
    expect(screen.getByText(/Microsoft isn't set up on this instance/)).toBeDefined();
    expect(screen.getByRole("button", { name: "CalDAV/CardDAV" })).toBeDefined();
  });
});
