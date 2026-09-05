import type { ProviderAvailabilityListResponse } from "@mail/shared";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as oauthApi from "../api/oauth-signin.js";
import { ProviderSignInChoice } from "./ProviderSignInChoice.js";

vi.mock("../api/oauth-signin.js", () => ({
  fetchProviderAvailability: vi.fn(),
  startProviderSignIn: vi.fn(),
}));

/**
 * The three-way choice (#116, ADR-0021). Two things it must never get wrong:
 * an unavailable Provider is *shown*, and which of the two unavailable
 * wordings a User sees depends on whether they can do anything about it.
 */

function availability(
  overrides: Partial<
    Record<"google" | "microsoft", ProviderAvailabilityListResponse["providers"][number]>
  > = {},
): ProviderAvailabilityListResponse {
  return {
    providers: [
      overrides.google ?? { provider: "google", available: true, unavailableReason: null },
      overrides.microsoft ?? {
        provider: "microsoft",
        available: false,
        unavailableReason: "not_supported",
      },
    ],
  };
}

/** The one step that leaves the app — injected, since jsdom's own `location.assign` can be neither called nor redefined. */
const navigate = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(oauthApi.fetchProviderAvailability).mockResolvedValue(availability());
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("offers Google, Microsoft and Other", async () => {
  render(<ProviderSignInChoice isOwner={false} onChooseOther={() => {}} navigate={navigate} />);

  expect(await screen.findByRole("button", { name: "Sign in with Google" })).toBeDefined();
  expect(screen.getByRole("button", { name: "Sign in with Microsoft" })).toBeDefined();
  expect(screen.getByRole("button", { name: "Other" })).toBeDefined();
});

it("sends the browser to the Provider's authorization URL", async () => {
  vi.mocked(oauthApi.startProviderSignIn).mockResolvedValue({
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=x",
  });
  const user = userEvent.setup();
  render(<ProviderSignInChoice isOwner={false} onChooseOther={() => {}} navigate={navigate} />);

  await user.click(await screen.findByRole("button", { name: "Sign in with Google" }));

  await waitFor(() =>
    expect(navigate).toHaveBeenCalledWith(
      "https://accounts.google.com/o/oauth2/v2/auth?client_id=x",
    ),
  );
  expect(oauthApi.startProviderSignIn).toHaveBeenCalledWith("google");
});

it("says so plainly when the sign-in can't even be started", async () => {
  vi.mocked(oauthApi.startProviderSignIn).mockRejectedValue(new Error("nope"));
  const user = userEvent.setup();
  render(<ProviderSignInChoice isOwner={false} onChooseOther={() => {}} navigate={navigate} />);

  await user.click(await screen.findByRole("button", { name: "Sign in with Google" }));

  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Couldn't start sign-in with Google.",
  );
  expect(navigate).not.toHaveBeenCalled();
});

it("hands Other back to the caller's own autodiscover flow", async () => {
  const onChooseOther = vi.fn();
  const user = userEvent.setup();
  render(
    <ProviderSignInChoice isOwner={false} onChooseOther={onChooseOther} navigate={navigate} />,
  );

  await user.click(await screen.findByRole("button", { name: "Other" }));

  expect(onChooseOther).toHaveBeenCalledTimes(1);
});

describe("an unregistered Provider", () => {
  const unregistered = availability({
    google: { provider: "google", available: false, unavailableReason: "not_registered" },
  });

  it("is shown and disabled, never hidden — and a Member is told to ask the Owner", async () => {
    vi.mocked(oauthApi.fetchProviderAvailability).mockResolvedValue(unregistered);
    render(<ProviderSignInChoice isOwner={false} onChooseOther={() => {}} navigate={navigate} />);

    const button = await screen.findByRole("button", { name: "Sign in with Google" });
    expect(button).toHaveProperty("disabled", true);
    expect(
      screen.getByText("Google isn't set up on this instance yet, ask the Owner."),
    ).toBeDefined();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("points the Owner at Provider Health instead of telling them to ask themselves", async () => {
    vi.mocked(oauthApi.fetchProviderAvailability).mockResolvedValue(unregistered);
    render(<ProviderSignInChoice isOwner onChooseOther={() => {}} navigate={navigate} />);

    const link = await screen.findByRole("link", { name: "set it up on the Instance page" });
    expect(link).toHaveProperty("pathname", "/settings/instance");
    expect(screen.queryByText(/ask the Owner/)).toBeNull();
  });
});

it("shows a Provider this build has no adapter for as unsupported, not unregistered", async () => {
  render(<ProviderSignInChoice isOwner onChooseOther={() => {}} navigate={navigate} />);

  expect(await screen.findByText("Signing in with Microsoft isn't supported yet.")).toBeDefined();
  expect(screen.getByRole("button", { name: "Sign in with Microsoft" })).toHaveProperty(
    "disabled",
    true,
  );
});

it("reports a failure to check availability rather than rendering an empty choice", async () => {
  vi.mocked(oauthApi.fetchProviderAvailability).mockRejectedValue(new Error("offline"));
  render(<ProviderSignInChoice isOwner={false} onChooseOther={() => {}} navigate={navigate} />);

  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Couldn't check which providers are available.",
  );
  // Other still works — it needs no Provider at all.
  expect(screen.getByRole("button", { name: "Other" })).toBeDefined();
});
