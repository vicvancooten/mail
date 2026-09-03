import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App.js";
import { createMockFetch, jsonResponse } from "./test-support/mock-fetch.js";

// jsdom's `history`/`location` persist across tests in one file — reset the
// route so a previous test landing on `/mail` (or `/settings`) doesn't leak
// into the next one's router (#71).
beforeEach(() => {
  history.replaceState(null, "", "/");
});

// `globals: false` (vite.config.ts) means Testing Library's auto-cleanup
// never registers — without this, each render() piles onto the previous
// test's DOM instead of replacing it.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("App", () => {
  it("shows the claim form on a fresh, unclaimed instance", async () => {
    vi.stubGlobal(
      "fetch",
      createMockFetch({
        "GET /auth/status": [jsonResponse({ claimed: false })],
      }),
    );

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Claim this instance" })).toBeDefined();
    // The pre-session card carries the product's only `<h1>` (`auth/AuthCard.tsx`).
    expect(screen.getByRole("heading", { name: "Wicket", level: 1 })).toBeDefined();
  });

  it("claims the instance and lands in the authenticated shell", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      createMockFetch({
        "GET /auth/status": [jsonResponse({ claimed: false })],
        "POST /auth/claim": [
          jsonResponse(
            {
              user: {
                id: "u1",
                username: "vic",
                role: "owner",
                createdAt: "2026-01-01T00:00:00.000Z",
              },
            },
            { status: 201 },
          ),
        ],
        "GET /push/config": [jsonResponse({ vapidPublicKey: null })],
      }),
    );

    render(<App />);
    await screen.findByRole("heading", { name: "Claim this instance" });

    await user.type(screen.getByLabelText("Claim token"), "the-token");
    await user.type(screen.getByLabelText("Username"), "vic");
    await user.type(screen.getByLabelText("Password"), "a-long-enough-password");
    await user.click(screen.getByRole("button", { name: "Create Owner account" }));

    expect(await screen.findByText(/Signed in as/)).toBeDefined();
    expect(screen.getByText(/vic/)).toBeDefined();
    expect(screen.getByText(/Owner/)).toBeDefined();
  });

  it("shows the login form once claimed but not signed in", async () => {
    vi.stubGlobal(
      "fetch",
      createMockFetch({
        "GET /auth/status": [jsonResponse({ claimed: true })],
        "GET /auth/session": [jsonResponse({ error: "unauthenticated" }, { status: 401 })],
      }),
    );

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Log in" })).toBeDefined();
  });

  it("shows an error and stays on the login form after a wrong password", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      createMockFetch({
        "GET /auth/status": [jsonResponse({ claimed: true })],
        "GET /auth/session": [jsonResponse({ error: "unauthenticated" }, { status: 401 })],
        "POST /auth/login": [jsonResponse({ error: "invalid_credentials" }, { status: 401 })],
      }),
    );

    render(<App />);
    await screen.findByRole("heading", { name: "Log in" });

    await user.type(screen.getByLabelText("Username"), "vic");
    await user.type(screen.getByLabelText("Password"), "wrong");
    await user.click(screen.getByRole("button", { name: "Log in" }));

    expect(await screen.findByText("Incorrect username or password.")).toBeDefined();
  });

  it("resumes an existing session without a login prompt", async () => {
    vi.stubGlobal(
      "fetch",
      createMockFetch({
        "GET /auth/status": [jsonResponse({ claimed: true })],
        "GET /auth/session": [
          jsonResponse({
            user: {
              id: "u1",
              username: "vic",
              role: "owner",
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          }),
        ],
        "GET /push/config": [jsonResponse({ vapidPublicKey: null })],
      }),
    );

    render(<App />);

    expect(await screen.findByText(/Signed in as/)).toBeDefined();
  });

  it("logs out back to the login form", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      createMockFetch({
        "GET /auth/status": [jsonResponse({ claimed: true })],
        "GET /auth/session": [
          jsonResponse({
            user: {
              id: "u1",
              username: "vic",
              role: "owner",
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          }),
        ],
        "POST /auth/logout": [new Response(null, { status: 204 })],
        "GET /push/config": [jsonResponse({ vapidPublicKey: null })],
      }),
    );

    render(<App />);
    await screen.findByText(/Signed in as/);

    await user.click(screen.getByRole("button", { name: /Account menu for/ }));
    await user.click(screen.getByRole("menuitem", { name: "Log out" }));

    expect(await screen.findByRole("heading", { name: "Log in" })).toBeDefined();
  });
});

describe("TOTP-gated login (#32)", () => {
  async function loginToTotpPrompt(user: ReturnType<typeof userEvent.setup>) {
    await screen.findByRole("heading", { name: "Log in" });
    await user.type(screen.getByLabelText("Username"), "vic");
    await user.type(screen.getByLabelText("Password"), "a-long-enough-password");
    await user.click(screen.getByRole("button", { name: "Log in" }));
    await screen.findByRole("heading", { name: "Enter your authenticator code" });
  }

  it("asks for a code after password login, then signs in with the right one", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      createMockFetch({
        "GET /auth/status": [jsonResponse({ claimed: true })],
        "GET /auth/session": [jsonResponse({ error: "unauthenticated" }, { status: 401 })],
        "POST /auth/login": [jsonResponse({ totpRequired: true, challengeToken: "chal-1" })],
        "POST /auth/login/totp": [
          jsonResponse({
            user: {
              id: "u1",
              username: "vic",
              role: "owner",
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          }),
        ],
        "GET /push/config": [jsonResponse({ vapidPublicKey: null })],
      }),
    );

    render(<App />);
    await loginToTotpPrompt(user);

    await user.type(screen.getByLabelText("6-digit code"), "123456");
    await user.click(screen.getByRole("button", { name: "Verify" }));

    expect(await screen.findByText(/Signed in as/)).toBeDefined();
  });

  it("shows an error and stays on the code prompt after a wrong code", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      createMockFetch({
        "GET /auth/status": [jsonResponse({ claimed: true })],
        "GET /auth/session": [jsonResponse({ error: "unauthenticated" }, { status: 401 })],
        "POST /auth/login": [jsonResponse({ totpRequired: true, challengeToken: "chal-1" })],
        "POST /auth/login/totp": [jsonResponse({ error: "invalid_code" }, { status: 401 })],
      }),
    );

    render(<App />);
    await loginToTotpPrompt(user);

    await user.type(screen.getByLabelText("6-digit code"), "000000");
    await user.click(screen.getByRole("button", { name: "Verify" }));

    expect(await screen.findByText(/isn't right/)).toBeDefined();
    expect(screen.getByRole("heading", { name: "Enter your authenticator code" })).toBeDefined();
  });

  it("can back out of the code prompt to the login form", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      createMockFetch({
        "GET /auth/status": [jsonResponse({ claimed: true })],
        "GET /auth/session": [jsonResponse({ error: "unauthenticated" }, { status: 401 })],
        "POST /auth/login": [jsonResponse({ totpRequired: true, challengeToken: "chal-1" })],
      }),
    );

    render(<App />);
    await loginToTotpPrompt(user);

    await user.click(screen.getByRole("button", { name: "Back" }));

    expect(await screen.findByRole("heading", { name: "Log in" })).toBeDefined();
  });
});

describe("auth-methods management (#32)", () => {
  const AUTHENTICATED_USER = jsonResponse({
    user: { id: "u1", username: "vic", role: "owner", createdAt: "2026-01-01T00:00:00.000Z" },
  });

  it("shows disabled TOTP and no passkeys once expanded", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      createMockFetch({
        "GET /auth/status": [jsonResponse({ claimed: true })],
        "GET /auth/session": [AUTHENTICATED_USER],
        "GET /push/config": [jsonResponse({ vapidPublicKey: null })],
        "GET /auth/totp/status": [jsonResponse({ enabled: false })],
        "GET /auth/passkeys": [jsonResponse({ passkeys: [] })],
      }),
    );

    render(<App />);
    await screen.findByText(/Signed in as/);

    await user.click(screen.getByRole("button", { name: /Account menu for/ }));
    await user.click(screen.getByRole("menuitem", { name: "Settings" }));
    await user.click(screen.getByText("Sign-in methods"));

    expect(await screen.findByText("Enable two-factor authentication")).toBeDefined();
    expect(await screen.findByText("No passkeys registered yet.")).toBeDefined();
  });

  it("enrolls and confirms TOTP", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      createMockFetch({
        "GET /auth/status": [jsonResponse({ claimed: true })],
        "GET /auth/session": [AUTHENTICATED_USER],
        "GET /push/config": [jsonResponse({ vapidPublicKey: null })],
        "GET /auth/totp/status": [jsonResponse({ enabled: false })],
        "GET /auth/passkeys": [jsonResponse({ passkeys: [] })],
        "POST /auth/totp/enroll": [
          jsonResponse({
            secret: "ABCDEFGHIJKLMNOP",
            otpauthUrl: "otpauth://totp/Mail:vic?secret=ABCDEFGHIJKLMNOP",
          }),
        ],
        "POST /auth/totp/confirm": [jsonResponse({ enabled: true })],
      }),
    );

    render(<App />);
    await screen.findByText(/Signed in as/);
    await user.click(screen.getByRole("button", { name: /Account menu for/ }));
    await user.click(screen.getByRole("menuitem", { name: "Settings" }));
    await user.click(screen.getByText("Sign-in methods"));

    await user.click(
      await screen.findByRole("button", { name: "Enable two-factor authentication" }),
    );
    expect(await screen.findByText("ABCDEFGHIJKLMNOP")).toBeDefined();

    await user.type(screen.getByLabelText("6-digit code"), "123456");
    await user.click(screen.getByRole("button", { name: "Confirm" }));

    expect(await screen.findByText("Two-factor authentication is enabled.")).toBeDefined();
  });

  it("disables TOTP with the current code", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      createMockFetch({
        "GET /auth/status": [jsonResponse({ claimed: true })],
        "GET /auth/session": [AUTHENTICATED_USER],
        "GET /push/config": [jsonResponse({ vapidPublicKey: null })],
        "GET /auth/totp/status": [jsonResponse({ enabled: true })],
        "GET /auth/passkeys": [jsonResponse({ passkeys: [] })],
        "POST /auth/totp/disable": [new Response(null, { status: 204 })],
      }),
    );

    render(<App />);
    await screen.findByText(/Signed in as/);
    await user.click(screen.getByRole("button", { name: /Account menu for/ }));
    await user.click(screen.getByRole("menuitem", { name: "Settings" }));
    await user.click(screen.getByText("Sign-in methods"));

    await screen.findByText("Two-factor authentication is enabled.");
    await user.type(screen.getByLabelText("Current code, to disable"), "123456");
    await user.click(screen.getByRole("button", { name: "Disable" }));

    expect(await screen.findByText("Enable two-factor authentication")).toBeDefined();
  });

  it("lists a registered passkey and removes it", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      createMockFetch({
        "GET /auth/status": [jsonResponse({ claimed: true })],
        "GET /auth/session": [AUTHENTICATED_USER],
        "GET /push/config": [jsonResponse({ vapidPublicKey: null })],
        "GET /auth/totp/status": [jsonResponse({ enabled: false })],
        "GET /auth/passkeys": [
          jsonResponse({
            passkeys: [{ id: "cred-1", createdAt: "2026-01-01T00:00:00.000Z", lastUsedAt: null }],
          }),
          jsonResponse({ passkeys: [] }),
        ],
        "DELETE /auth/passkeys/cred-1": [new Response(null, { status: 204 })],
      }),
    );

    render(<App />);
    await screen.findByText(/Signed in as/);
    await user.click(screen.getByRole("button", { name: /Account menu for/ }));
    await user.click(screen.getByRole("menuitem", { name: "Settings" }));
    await user.click(screen.getByText("Sign-in methods"));

    expect(await screen.findByText(/Added/)).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Remove" }));

    expect(await screen.findByText("No passkeys registered yet.")).toBeDefined();
  });
});
