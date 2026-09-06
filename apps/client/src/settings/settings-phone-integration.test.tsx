import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App.js";
import { localCache, openLocalCache } from "../store/local-cache.js";
import { resetSyncStatus } from "../sync/sync-loop.js";
import { stubMatchMedia } from "../test-support/match-media.js";
import { jsonResponse } from "../test-support/mock-fetch.js";

/**
 * #135, seam 1 of #133's Testing Decisions: the routed App over a memory
 * history (rather than jsdom's shared `window.history`, `app-shell-integration.test.tsx`'s
 * own seam), with viewport driven by a `matchMedia` stub
 * (`test-support/match-media.ts`) rather than an actual resize jsdom can't
 * produce. Asserts the rendered controls and URLs only — the squeezed
 * two-column layout this replaces is a CSS fact jsdom can't compute, so
 * that half stays on the device acceptance checklist (#133).
 */

let counter = 0;
const names: string[] = [];

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/auth/status") return Promise.resolve(jsonResponse({ claimed: true }));
      if (url === "/auth/session")
        return Promise.resolve(
          jsonResponse({
            user: {
              id: "u1",
              username: "vic",
              role: "owner",
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          }),
        );
      if (url === "/push/config") return Promise.resolve(jsonResponse({ vapidPublicKey: null }));
      if (url === "/mail-accounts") return Promise.resolve(jsonResponse({ mailAccounts: [] }));
      // `/sync` never resolves — nothing here reads a round trip.
      if (url === "/sync") return new Promise<Response>(() => {});
      throw new Error(`Unexpected fetch: ${url}`);
    }),
  );
}

beforeEach(async () => {
  resetSyncStatus();
  const name = `settings-phone-integration-test-${counter++}`;
  names.push(name);
  await openLocalCache({ name, schemaVersion: 1 });
  localStorage.clear();
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  localCache().close();
  for (const nm of names.splice(0)) await Dexie.delete(nm);
});

describe("Settings at phone width (#135)", () => {
  it("renders the section list, no rail, at /settings", async () => {
    stubMatchMedia((query) => query === "(max-width: 700px)");
    stubFetch();
    const history = createMemoryHistory({ initialEntries: ["/settings"] });

    render(<App history={history} />);

    expect(await screen.findByRole("link", { name: /General/ })).toBeDefined();
    // No section content, and no Back control — this *is* the entry point.
    expect(screen.queryByRole("heading", { name: "General" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Back to Settings" })).toBeNull();
    expect(history.location.pathname).toBe("/settings");
  });

  it("opening a section renders it full-width with a Back control back to the list", async () => {
    stubMatchMedia((query) => query === "(max-width: 700px)");
    stubFetch();
    const history = createMemoryHistory({ initialEntries: ["/settings"] });
    const user = userEvent.setup();

    render(<App history={history} />);
    await user.click(await screen.findByRole("link", { name: /General/ }));

    expect(await screen.findByRole("heading", { name: "General" })).toBeDefined();
    expect(history.location.pathname).toBe("/settings/general");
    // The list is gone — a section page, not the list, is what's on screen.
    expect(screen.queryByRole("link", { name: /This device/ })).toBeNull();

    await user.click(screen.getByRole("link", { name: "Back to Settings" }));

    expect(await screen.findByRole("link", { name: /General/ })).toBeDefined();
    expect(history.location.pathname).toBe("/settings");
  });

  it("every existing settings section is reachable this way", async () => {
    stubMatchMedia((query) => query === "(max-width: 700px)");
    stubFetch();
    const history = createMemoryHistory({ initialEntries: ["/settings"] });
    const user = userEvent.setup();

    for (const [linkName, path, headingName] of [
      ["General", "/settings/general", "General"],
      ["This device", "/settings/this-device", "This device"],
      ["Mail Accounts", "/settings/mail-accounts", "Mail Accounts"],
      ["Gatekeeper", "/settings/gatekeeper", "Gatekeeper"],
      ["Notifications", "/settings/notifications", "Notifications"],
      ["Security", "/settings/security", "Security"],
      ["Instance", "/settings/instance", "Instance"],
    ] as const) {
      render(<App history={history} />);
      await user.click(await screen.findByRole("link", { name: new RegExp(linkName) }));
      expect(await screen.findByRole("heading", { name: headingName, level: 2 })).toBeDefined();
      expect(history.location.pathname).toBe(path);
      await user.click(screen.getByRole("link", { name: "Back to Settings" }));
      await screen.findByRole("link", { name: /General/ });
      cleanup();
    }
  });

  it("at desktop width, /settings still redirects to General and keeps the rail", async () => {
    stubMatchMedia(() => false);
    stubFetch();
    const history = createMemoryHistory({ initialEntries: ["/settings"] });

    render(<App history={history} />);

    expect(await screen.findByRole("heading", { name: "General" })).toBeDefined();
    expect(history.location.pathname).toBe("/settings/general");
    // The rail's other links stay on screen beside the section — no Back control here.
    expect(screen.getByRole("link", { name: /This device/ })).toBeDefined();
    expect(screen.queryByRole("link", { name: "Back to Settings" })).toBeNull();
  });
});
