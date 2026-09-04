import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as oauthApi from "../api/oauth-signin.js";
import { ProviderReauthAction } from "./ProviderReauthAction.js";

vi.mock("../api/oauth-signin.js", () => ({
  fetchProviderAvailability: vi.fn(),
  startProviderSignIn: vi.fn(),
}));

/**
 * The reauth half of the Provider sign-in door (#119): "sign in again" on an
 * OAuth account, and a password account's "switch to Google sign-in" — the
 * same component either way, always a single fixed Provider and never a
 * password field.
 */

const navigate = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(oauthApi.fetchProviderAvailability).mockResolvedValue({
    providers: [
      { provider: "google", available: true, unavailableReason: null },
      { provider: "microsoft", available: false, unavailableReason: "not_supported" },
    ],
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("starts a reauth attempt naming the Mail Account and sends the browser to the authorization URL", async () => {
  vi.mocked(oauthApi.startProviderSignIn).mockResolvedValue({
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?login_hint=vic@gmail.com",
  });
  const user = userEvent.setup();
  render(
    <ProviderReauthAction
      mailAccountId="acct-1"
      provider="google"
      label="Sign in with Google again"
      isOwner={false}
      navigate={navigate}
    />,
  );

  await user.click(await screen.findByRole("button", { name: "Sign in with Google again" }));

  await waitFor(() =>
    expect(navigate).toHaveBeenCalledWith(
      "https://accounts.google.com/o/oauth2/v2/auth?login_hint=vic@gmail.com",
    ),
  );
  expect(oauthApi.startProviderSignIn).toHaveBeenCalledWith("google", { mailAccountId: "acct-1" });
});

it("reports a plain error when the sign-in can't even be started", async () => {
  vi.mocked(oauthApi.startProviderSignIn).mockRejectedValue(new Error("nope"));
  const user = userEvent.setup();
  render(
    <ProviderReauthAction
      mailAccountId="acct-1"
      provider="google"
      label="Sign in with Google again"
      isOwner={false}
      navigate={navigate}
    />,
  );

  await user.click(await screen.findByRole("button", { name: "Sign in with Google again" }));

  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    " Couldn't start sign-in.",
  );
  expect(navigate).not.toHaveBeenCalled();
});

describe("an unregistered Provider", () => {
  it("shows the same unavailable wording ProviderSignInChoice shows when adding a Mail Account (#119)", async () => {
    vi.mocked(oauthApi.fetchProviderAvailability).mockResolvedValue({
      providers: [{ provider: "google", available: false, unavailableReason: "not_registered" }],
    });
    render(
      <ProviderReauthAction
        mailAccountId="acct-1"
        provider="google"
        label="Sign in with Google again"
        isOwner={false}
        navigate={navigate}
      />,
    );

    expect(
      await screen.findByText("Google isn't set up on this instance yet, ask the Owner."),
    ).toBeDefined();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("points the Owner at Provider Health instead", async () => {
    vi.mocked(oauthApi.fetchProviderAvailability).mockResolvedValue({
      providers: [{ provider: "google", available: false, unavailableReason: "not_registered" }],
    });
    render(
      <ProviderReauthAction
        mailAccountId="acct-1"
        provider="google"
        label="Sign in with Google again"
        isOwner
        navigate={navigate}
      />,
    );

    const link = await screen.findByRole("link", { name: "set it up on the Instance page" });
    expect(link).toHaveProperty("pathname", "/settings/instance");
  });
});

it("shows a Provider this build has no adapter for as unsupported", async () => {
  vi.mocked(oauthApi.fetchProviderAvailability).mockResolvedValue({
    providers: [{ provider: "microsoft", available: false, unavailableReason: "not_supported" }],
  });
  render(
    <ProviderReauthAction
      mailAccountId="acct-1"
      provider="microsoft"
      label="Sign in with Microsoft again"
      isOwner={false}
      navigate={navigate}
    />,
  );

  expect(await screen.findByText("Signing in with Microsoft isn't supported yet.")).toBeDefined();
});
