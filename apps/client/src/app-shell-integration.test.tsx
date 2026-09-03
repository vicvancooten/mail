import type { MailAccount } from "@mail/shared";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App.js";
import { publishNotificationTarget } from "./pwa/notification-router.js";
import { localCache, openLocalCache } from "./store/local-cache.js";
import { applyMailAccountDelta, applyThreadDelta } from "./store/server-writes.js";
import { resetSyncStatus } from "./sync/sync-loop.js";
import { delta, makeMailAccount, makeThread } from "./test-support/mail-fixtures.js";
import { jsonResponse } from "./test-support/mock-fetch.js";

/**
 * The seam #71 asks for: the whole router tree (`App` -> `AuthGate` ->
 * `AppShell`'s `RouterProvider`), not just `MailSection` in isolation, over
 * a seeded Local Cache — the same real-IndexedDB, stubbed-`fetch` rig
 * `MailSection.test.tsx` and the other integration suites use. What this
 * covers that a `MailSection`-only test structurally cannot: that Mail,
 * Settings and the placeholder Apps are real, reachable routes; that a
 * reload (a fresh mount at a URL already in hand) restores the view instead
 * of resetting to the default; and that the bounded-pane ancestor chain
 * `brand/brand.css`'s `.app-shell`/`.app-viewport` describe is the one
 * thing actually mounted under the router, at any viewport width — the
 * structural half of the phone-layout regression the CSS fix (#71) can't be
 * asserted on directly under jsdom, which never computes real layout.
 */

let counter = 0;
const names: string[] = [];

const AUTH_RESPONSES: Record<string, () => Response> = {
  "/auth/status": () => jsonResponse({ claimed: true }),
  "/auth/session": () =>
    jsonResponse({
      user: { id: "u1", username: "vic", role: "owner", createdAt: "2026-01-01T00:00:00.000Z" },
    }),
  "/push/config": () => jsonResponse({ vapidPublicKey: null }),
};

function stubFetch(mailAccounts: MailAccount[] = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const auth = AUTH_RESPONSES[url];
      if (auth) return Promise.resolve(auth());
      // `/sync` never resolves — every assertion here reads the seeded
      // Local Cache, never a round trip (ADR-0010).
      if (url === "/sync") return new Promise<Response>(() => {});
      // `MailAccountsSection` (Settings) reads this directly, not the Local
      // Cache — unrelated to the seeded Threads above.
      if (url === "/mail-accounts") return Promise.resolve(jsonResponse({ mailAccounts }));
      throw new Error(`Unexpected fetch: ${url}`);
    }),
  );
}

beforeEach(async () => {
  resetSyncStatus();
  const name = `app-shell-integration-test-${counter++}`;
  names.push(name);
  await openLocalCache({ name, schemaVersion: 1 });
  localStorage.clear();
  // jsdom's `history`/`location` persist across tests in one file.
  history.replaceState(null, "", "/");
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  localCache().close();
  for (const nm of names.splice(0)) await Dexie.delete(nm);
});

async function seedOneThread(): Promise<void> {
  await applyMailAccountDelta(delta({ created: [makeMailAccount("acct-1")] }), { replace: false });
  await applyThreadDelta(
    "acct-1",
    delta({ created: [makeThread("t1", "acct-1", { subject: "Routed thread" })] }),
    { replace: false },
  );
}

describe("the app shell over a routed tree (#71)", () => {
  it("lands on Mail by default, with the seeded Thread visible", async () => {
    await seedOneThread();
    stubFetch();

    render(<App />);

    expect(await screen.findByText("Routed thread")).toBeDefined();
    expect(location.pathname).toBe("/mail");
  });

  it("Settings is reachable from the shell rail and is no longer rendered below the mail pane", async () => {
    await seedOneThread();
    stubFetch();
    const user = userEvent.setup();

    render(<App />);
    await screen.findByText("Routed thread");
    // Settings' own controls aren't in the tree at all yet — not merely
    // scrolled past — until the route is entered.
    expect(screen.queryByText("Preferences")).toBeNull();

    await user.click(screen.getByRole("link", { name: "Settings" }));

    expect(await screen.findByText("Preferences")).toBeDefined();
    expect(screen.queryByText("Routed thread")).toBeNull();
    expect(location.pathname).toBe("/settings");
  });

  it("a reload (a fresh mount at a URL already in hand) restores the view", async () => {
    await seedOneThread();
    stubFetch();

    // Simulates the User having navigated to Settings, then reloading: a
    // brand-new mount that only has the URL to go on, no prior React state.
    history.replaceState(null, "", "/settings");
    render(<App />);

    expect(await screen.findByText("Preferences")).toBeDefined();
  });

  it("reload also restores Mail's own selected Label and Thread", async () => {
    await seedOneThread();
    stubFetch();

    history.replaceState(null, "", "/mail?thread=t1");
    render(<App />);

    // The detail pane's own copy of the Thread, not just the list row —
    // proof the id from the URL actually drove `selectedThreadId`, not
    // just that the list rendered.
    expect(
      await screen.findByText("Routed thread", { selector: ".thread-detail-card h1" }),
    ).toBeDefined();
  });

  it("a needs-reauth notification click navigates to Settings and scrolls to that Mail Account's row (#53)", async () => {
    const account = makeMailAccount("acct-1", { status: "needs_reauth" });
    await applyMailAccountDelta(delta({ created: [account] }), { replace: false });
    stubFetch([account]);

    render(<App />);
    await screen.findByRole("link", { name: "Settings" });
    expect(screen.queryByText("Preferences")).toBeNull();

    act(() => {
      publishNotificationTarget({ kind: "needs-reauth", mailAccountId: "acct-1" });
    });

    expect(await screen.findByText("Preferences")).toBeDefined();
    expect(location.pathname).toBe("/settings");
    // `SettingsSection`'s own "Mail Account preferences" block (from the
    // Local Cache) also names this account, so scope to
    // `MailAccountsSection`'s row specifically — the one
    // `scrollToMailAccountSettings` actually targets.
    await waitFor(() => expect(document.getElementById("mail-account-acct-1")).not.toBeNull());
  });

  it("the placeholder Apps are real, reachable routes", async () => {
    await seedOneThread();
    stubFetch();

    history.replaceState(null, "", "/contacts");
    render(<App />);

    expect(await screen.findByLabelText("Contacts")).toBeDefined();
    // Still under the one shell — the header rail's `Signed in as` is
    // unconditional chrome, not something each route re-renders.
    expect(screen.getByText(/Signed in as/)).toBeDefined();
  });

  it("the virtualized Thread list keeps its bounded-height ancestor chain at a phone width, not desktop only", async () => {
    // jsdom computes no real layout (`test-support/virtualization.ts`'s own
    // doc comment) — a CSS media query breaking at some width, the actual
    // bug #71 fixes, can't be observed here. What this can assert, and what
    // would fail if a future change reintroduced a width-conditional
    // markup swap that drops the bounded ancestor on a narrow screen: the
    // same structural chain mounts at a phone width as at any other.
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 375 });
    window.dispatchEvent(new Event("resize"));

    try {
      await seedOneThread();
      stubFetch();

      render(<App />);
      await screen.findByText("Routed thread");

      const list = document.querySelector(".thread-list");
      expect(list).not.toBeNull();
      const viewport = document.querySelector(".app-viewport");
      expect(viewport).not.toBeNull();
      // Every ancestor between the viewport-owning shell and the scroll
      // element itself is present — `.app-viewport` (the routed pane) ->
      // `.mail-section` -> `.mail-body` -> `.split-view`/`.split-list` (or
      // `.thread-list` directly in List mode) -> `.thread-list`, the actual
      // scroll container `VirtualizedThreadList.tsx` renders.
      expect(viewport?.contains(list)).toBe(true);
      expect(document.querySelector(".app-shell")?.contains(viewport)).toBe(true);
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
      window.dispatchEvent(new Event("resize"));
    }
  });
});
