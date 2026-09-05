import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AddMailAccountForm } from "./AddMailAccountForm.js";

vi.mock("../api/oauth-signin.js", () => ({
  fetchProviderAvailability: vi.fn(async () => ({
    providers: [
      { provider: "google", available: true, unavailableReason: null },
      { provider: "microsoft", available: false, unavailableReason: "not_supported" },
    ],
  })),
  startProviderSignIn: vi.fn(),
}));

const discoverMailAccount = vi.fn(async () => ({ found: false, prefill: null }));

vi.mock("../api/mail-accounts.js", () => ({
  discoverMailAccount: (...args: unknown[]) =>
    (discoverMailAccount as unknown as (...a: unknown[]) => unknown)(...args),
  createMailAccount: vi.fn(),
}));

/**
 * #116's acceptance line that nothing else covers: **Other keeps today's
 * autodiscover-then-manual flow untouched.** The form now opens on the
 * Provider choice, so this walks the one path that still leads into the
 * flow #33 built and checks it arrives unchanged.
 */

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

it("opens on the Provider choice rather than straight into the address field", async () => {
  render(<AddMailAccountForm onAdded={() => {}} />);

  expect(await screen.findByRole("button", { name: "Sign in with Google" })).toBeDefined();
  expect(screen.queryByLabelText("Email address")).toBeNull();
});

it("Other leads into the unchanged autodiscover flow, and Back returns to the choice", async () => {
  const user = userEvent.setup();
  render(<AddMailAccountForm onAdded={() => {}} />);

  await user.click(await screen.findByRole("button", { name: "Other" }));

  const emailField = screen.getByLabelText("Email address");
  await user.type(emailField, "someone@example.com");
  await user.click(screen.getByRole("button", { name: "Continue" }));

  // Autodiscover ran on the typed address, exactly as before #116.
  expect(discoverMailAccount).toHaveBeenCalledWith({ emailAddress: "someone@example.com" });
  expect(await screen.findByLabelText("Password")).toBeDefined();

  await user.click(screen.getByRole("button", { name: "Back" }));
  await user.click(await screen.findByRole("button", { name: "Back" }));
  expect(await screen.findByRole("button", { name: "Sign in with Google" })).toBeDefined();
});
