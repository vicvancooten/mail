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
 * Calendar/Contacts' real turn-on flow (#202): the "+" lists the User's
 * already-connected identities at a Provider and starts a consent flow for
 * one — never a second sign-in, never a speculative permission. Mail's own
 * flow (`AddMailAccountForm`) is unchanged and covered by
 * `ConnectedAccountsTable.test.tsx`.
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
    vi.mocked(oauthSigninApi.fetchProviderAvailability).mockResolvedValue({
      providers: [{ provider: "google", available: false, unavailableReason: "not_registered" }],
    });
    render(<AddFacetControl facet="calendar" isOwner={false} provider="google" />);
    await openPopover();

    expect(
      await screen.findByText(/isn't set up on this instance yet, ask the Owner/),
    ).toBeDefined();
  });
});

describe("a Provider registered but not enabled for this Facet", () => {
  it("shows a Facet-specific ask-the-Owner message, distinct from an unregistered Provider", async () => {
    vi.mocked(oauthSigninApi.fetchProviderAvailability).mockResolvedValue({
      providers: [available({ calendarApiEnabled: false })],
    });
    render(<AddFacetControl facet="calendar" isOwner={false} provider="google" />);
    await openPopover();

    expect(
      await screen.findByText(/Calendar isn't enabled on this instance's Google Registration yet/),
    ).toBeDefined();
  });

  it("gives the Owner a link to the Instance page instead", async () => {
    vi.mocked(oauthSigninApi.fetchProviderAvailability).mockResolvedValue({
      providers: [available({ contactsApiEnabled: false })],
    });
    render(<AddFacetControl facet="contacts" isOwner provider="google" />);
    await openPopover();

    const link = await screen.findByRole("link", { name: "set it up on the Instance page" });
    expect(link.getAttribute("href")).toBe("/settings/instance");
  });
});

describe("a Facet whose API is enabled", () => {
  it("says to connect the Provider for Mail first when the User has no identity there yet", async () => {
    vi.mocked(oauthSigninApi.fetchProviderAvailability).mockResolvedValue({
      providers: [available()],
    });
    render(
      <AddFacetControl facet="calendar" isOwner={false} provider="google" connectedAccounts={[]} />,
    );
    await openPopover();

    expect(await screen.findByText("Connect Google for Mail first.")).toBeDefined();
  });

  it("says every account already has the Facet when none qualify", async () => {
    vi.mocked(oauthSigninApi.fetchProviderAvailability).mockResolvedValue({
      providers: [available()],
    });
    const account: ConnectedAccount = {
      ...makeConnectedAccount("acct-1"),
      facets: [
        { kind: "mail", status: "active" },
        { kind: "calendar", status: "active" },
      ],
    };
    render(
      <AddFacetControl
        facet="calendar"
        isOwner={false}
        provider="google"
        connectedAccounts={[account]}
      />,
    );
    await openPopover();

    expect(await screen.findByText("Every Google account already has calendar.")).toBeDefined();
  });

  it("lists an identity that doesn't yet carry the Facet, and starts its consent flow on click", async () => {
    vi.mocked(oauthSigninApi.fetchProviderAvailability).mockResolvedValue({
      providers: [available()],
    });
    vi.mocked(oauthSigninApi.startFacetGrant).mockResolvedValue({
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?scope=calendar",
    });
    const navigate = vi.fn();
    const account = makeConnectedAccount("acct-1", { identity: "vic@gmail.com" });
    const user = await (async () => {
      render(
        <AddFacetControl
          facet="calendar"
          isOwner={false}
          provider="google"
          connectedAccounts={[account]}
          navigate={navigate}
        />,
      );
      return openPopover();
    })();

    const identityButton = await screen.findByRole("button", { name: "vic@gmail.com" });
    await user.click(identityButton);

    expect(oauthSigninApi.startFacetGrant).toHaveBeenCalledWith("google", "acct-1", "calendar");
    expect(navigate).toHaveBeenCalledWith(
      "https://accounts.google.com/o/oauth2/v2/auth?scope=calendar",
    );
  });
});

describe("the below-table button variant (no fixed Provider)", () => {
  it("shows a section per Provider that can serve the Facet", async () => {
    vi.mocked(oauthSigninApi.fetchProviderAvailability).mockResolvedValue({
      providers: [available({ provider: "google" }), available({ provider: "microsoft" })],
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
    expect(await screen.findByText("Connect Microsoft for Mail first.")).toBeDefined();
  });
});

describe("a Provider that can never turn on this Facet through this door", () => {
  it("names the future Provider for CalDAV/CardDAV instead of a working flow", async () => {
    render(<AddFacetControl facet="calendar" isOwner={false} provider="caldav_carddav" />);
    await openPopover();

    expect(await screen.findByText(/Not available yet/)).toBeDefined();
  });
});
