import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App.js";
import { createMockFetch, jsonResponse } from "../test-support/mock-fetch.js";

/**
 * jsdom has no WebAuthn implementation at all, so `@simplewebauthn/browser`
 * is stubbed here — a genuine ceremony is exercised on the backend
 * (`routes/passkeys.test.ts`, via `nid-webauthn-emulator`); this file proves
 * the Client's wiring around it: the button only shows when supported, and
 * the API round trip drives `AuthContext` the same way password login does.
 */
vi.mock("@simplewebauthn/browser", () => ({
  browserSupportsWebAuthn: () => true,
  startRegistration: vi.fn(async () => ({
    id: "cred-1",
    rawId: "cred-1",
    response: { clientDataJSON: "", attestationObject: "" },
    clientExtensionResults: {},
    type: "public-key",
  })),
  startAuthentication: vi.fn(async () => ({
    id: "cred-1",
    rawId: "cred-1",
    response: { clientDataJSON: "", authenticatorData: "", signature: "" },
    clientExtensionResults: {},
    type: "public-key",
  })),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const AUTHENTICATED_USER = jsonResponse({
  user: { id: "u1", username: "vic", role: "owner", createdAt: "2026-01-01T00:00:00.000Z" },
});

describe("passkey login (#32)", () => {
  it("logs in with a passkey from the login form", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      createMockFetch({
        "GET /auth/status": [jsonResponse({ claimed: true })],
        "GET /auth/session": [jsonResponse({ error: "unauthenticated" }, { status: 401 })],
        "POST /auth/passkeys/login/options": [
          jsonResponse({ challenge: "chal-1", rpId: "localhost", timeout: 60000 }),
        ],
        "POST /auth/passkeys/login/verify": [AUTHENTICATED_USER],
        "GET /push/config": [jsonResponse({ vapidPublicKey: null })],
      }),
    );

    render(<App />);
    await screen.findByRole("heading", { name: "Log in" });

    await user.click(screen.getByRole("button", { name: "Log in with a passkey" }));

    expect(await screen.findByText(/Signed in as/)).toBeDefined();
  });

  it("still asks for a TOTP code when the owner has 2FA enrolled", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      createMockFetch({
        "GET /auth/status": [jsonResponse({ claimed: true })],
        "GET /auth/session": [jsonResponse({ error: "unauthenticated" }, { status: 401 })],
        "POST /auth/passkeys/login/options": [jsonResponse({ challenge: "chal-1" })],
        "POST /auth/passkeys/login/verify": [
          jsonResponse({ totpRequired: true, challengeToken: "chal-2" }),
        ],
      }),
    );

    render(<App />);
    await screen.findByRole("heading", { name: "Log in" });
    await user.click(screen.getByRole("button", { name: "Log in with a passkey" }));

    expect(
      await screen.findByRole("heading", { name: "Enter your authenticator code" }),
    ).toBeDefined();
  });

  it("surfaces an error when the passkey isn't recognized", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      createMockFetch({
        "GET /auth/status": [jsonResponse({ claimed: true })],
        "GET /auth/session": [jsonResponse({ error: "unauthenticated" }, { status: 401 })],
        "POST /auth/passkeys/login/options": [jsonResponse({ challenge: "chal-1" })],
        "POST /auth/passkeys/login/verify": [
          jsonResponse({ error: "invalid_credentials" }, { status: 401 }),
        ],
      }),
    );

    render(<App />);
    await screen.findByRole("heading", { name: "Log in" });
    await user.click(screen.getByRole("button", { name: "Log in with a passkey" }));

    expect(await screen.findByText("That passkey isn't registered here.")).toBeDefined();
  });
});

describe("passkey registration (#32)", () => {
  it("registers a passkey from the sign-in methods section", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      createMockFetch({
        "GET /auth/status": [jsonResponse({ claimed: true })],
        "GET /auth/session": [AUTHENTICATED_USER],
        "GET /auth/totp/status": [jsonResponse({ enabled: false })],
        "GET /auth/passkeys": [
          jsonResponse({ passkeys: [] }),
          jsonResponse({
            passkeys: [{ id: "cred-1", createdAt: "2026-01-01T00:00:00.000Z", lastUsedAt: null }],
          }),
        ],
        "POST /auth/passkeys/register/options": [jsonResponse({ challenge: "chal-1" })],
        "POST /auth/passkeys/register/verify": [new Response(null, { status: 201 })],
        "GET /push/config": [jsonResponse({ vapidPublicKey: null })],
      }),
    );

    render(<App />);
    await screen.findByText(/Signed in as/);
    await user.click(screen.getByText("Sign-in methods"));

    await user.click(await screen.findByRole("button", { name: "Add a passkey" }));

    expect(await screen.findByText(/Added/)).toBeDefined();
  });
});
