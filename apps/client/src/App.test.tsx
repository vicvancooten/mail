import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App.js";
import { createMockFetch, jsonResponse } from "./test-support/mock-fetch.js";

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
    expect(screen.getByRole("heading", { name: "Mail" })).toBeDefined();
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
      }),
    );

    render(<App />);
    await screen.findByText(/Signed in as/);

    await user.click(screen.getByRole("button", { name: "Log out" }));

    expect(await screen.findByRole("heading", { name: "Log in" })).toBeDefined();
  });
});
