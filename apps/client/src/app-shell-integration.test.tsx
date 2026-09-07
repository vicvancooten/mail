import type { MailAccount } from "@mail/shared";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App.js";
import { resetActiveMailHost } from "./mail/actions/active-mail-host.js";
import { resetSurfaceHandles } from "./mail/actions/surface-handles.js";
import { writeAccountScope, writeViewMode } from "./mail/device-preferences.js";
import { resetScrollOffsetsForTest } from "./mail/scroll-restore.js";
import { publishNotificationTarget } from "./pwa/notification-router.js";
import { localCache, openLocalCache } from "./store/local-cache.js";
import { applyMailAccountDelta, applyThreadDelta } from "./store/server-writes.js";
import { resetSyncStatus } from "./sync/sync-loop.js";
import {
  delta,
  makeMailAccount,
  makeThread,
  minutesAfterEpoch,
} from "./test-support/mail-fixtures.js";
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
 * `router/shell.css`'s `.app-shell`/`.app-viewport` describe is the one
 * thing actually mounted under the router, at any viewport width — the
 * structural half of the phone-layout regression the CSS fix (#71) can't be
 * asserted on directly under jsdom, which never computes real layout.
 */

let counter = 0;
const names: string[] = [];

function authResponses(role: "owner" | "member" = "owner"): Record<string, () => Response> {
  return {
    "/auth/status": () => jsonResponse({ claimed: true }),
    "/auth/session": () =>
      jsonResponse({
        user: { id: "u1", username: "vic", role, createdAt: "2026-01-01T00:00:00.000Z" },
      }),
    "/push/config": () => jsonResponse({ vapidPublicKey: null }),
    // Owner-only (#104) — a Member never reaches this route in practice
    // (`SettingsLayout`'s nav hides it, `settingsInstanceRoute` redirects a
    // direct URL away), so the fixture only needs a real answer for Owner.
    "/instance/health": () =>
      jsonResponse({
        version: "0.0.0",
        imageTag: "test-tag",
        webPush: {
          configured: false,
          generateCommand: "mail generate-vapid-keys",
          canGenerate: true,
        },
        systemMailer: { configured: false },
        publicUrl: { value: "http://localhost:3000", isSecureContext: true },
        // Provider Health (#115) — empty here; `InstancePage.test.tsx` and
        // `ProviderRegistrationCard.test.tsx` cover its own rendering.
        providers: [],
      }),
  };
}

function stubFetch(mailAccounts: MailAccount[] = [], role: "owner" | "member" = "owner") {
  const authResponsesForRole = authResponses(role);
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const auth = authResponsesForRole[url];
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
  // `active-mail-host.ts`/`surface-handles.ts` (#147) are module state too,
  // published by whichever Mail-family surface is mounted and cleared on its
  // own unmount — but only once that unmount's effect cleanup has actually
  // run, which the next test's mount can't guarantee. Their own "Test-only"
  // reset exports drop a stale host/handle rather than let it survive.
  resetActiveMailHost();
  resetSurfaceHandles();
  const name = `app-shell-integration-test-${counter++}`;
  names.push(name);
  await openLocalCache({ name, schemaVersion: 1 });
  localStorage.clear();
  // `scroll-restore.ts`'s map is deliberately module-level, not component
  // state (#142, its own doc comment) — it has to survive `MailSection`
  // unmounting for Stream/Settings — which also means it survives past
  // this test unless cleared: most fixtures here share the same Account +
  // folder + label, so a saved offset would otherwise leak into the next
  // test's first mount of that same list.
  resetScrollOffsetsForTest();
  // jsdom's `history`/`location` persist across tests in one file — a
  // `replaceState` alone reset the URL but not the position, so a test that
  // left the real history mid-stack (#140's own `history.back()`/`forward()`
  // cases) left stale, now-unreachable "forward" entries ahead of it for the
  // next test to inherit, throwing off that test's own push-counted
  // assertions. `pushState` always discards everything ahead of wherever the
  // previous test left the pointer, so every test starts at the true top of
  // a real (if arbitrarily long) stack — the one guarantee these tests
  // actually need, since every assertion here is relative to a length
  // snapshot taken fresh inside the test, never an absolute one.
  history.pushState(null, "", "/");
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

/** Newest first (`store/reads.ts#ThreadWindowPage`): "Newer thread" (t1) leads, "Older thread" (t2) trails. */
async function seedTwoThreads(): Promise<void> {
  await applyMailAccountDelta(delta({ created: [makeMailAccount("acct-1")] }), { replace: false });
  await applyThreadDelta(
    "acct-1",
    delta({
      created: [
        makeThread("t1", "acct-1", {
          subject: "Newer thread",
          lastMessageAt: minutesAfterEpoch(2),
        }),
        makeThread("t2", "acct-1", {
          subject: "Older thread",
          lastMessageAt: minutesAfterEpoch(1),
        }),
      ],
    }),
    { replace: false },
  );
}

/** Enough Threads, all in the same Time Group (tier 1, 54px rows), that the list's total content height clears the 600px viewport `test-support/virtualization.ts` stubs — without that headroom there is nothing to scroll, and every offset restoration assertion below would trivially pass at 0. Newest (`t0`) first, same order `seedTwoThreads` above documents. */
async function seedManyThreads(count: number): Promise<void> {
  await applyMailAccountDelta(delta({ created: [makeMailAccount("acct-1")] }), { replace: false });
  await applyThreadDelta(
    "acct-1",
    delta({
      created: Array.from({ length: count }, (_, i) =>
        makeThread(`t${i}`, "acct-1", {
          subject: `Thread ${i}`,
          lastMessageAt: minutesAfterEpoch(count - i),
        }),
      ),
    }),
    { replace: false },
  );
}

describe("scroll restoration (#142)", () => {
  it("restores the list's exact pixel offset on return from the Reader, in the List layout where the list unmounts while reading", async () => {
    await seedManyThreads(30);
    stubFetch();
    act(() => writeViewMode("list"));

    render(<App />);
    await screen.findByText("Thread 0");

    const list = document.querySelector(".thread-list") as HTMLElement;
    fireEvent.scroll(list, { target: { scrollTop: 400 } });

    fireEvent.click(screen.getByText("Thread 0"));
    // The List layout swaps the list for the Reader outright (`ListView.tsx`)
    // — nothing named ".thread-list" is even in the tree while it's open.
    await screen.findByRole("button", { name: "Back to list" });
    expect(document.querySelector(".thread-list")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Back to list" }));
    await screen.findByText("Thread 0");

    expect((document.querySelector(".thread-list") as HTMLElement).scrollTop).toBe(400);
  });

  it("restores the list's exact pixel offset on return from Stream, in the Split layout where the list never unmounts for the Reader alone", async () => {
    await seedManyThreads(30);
    stubFetch();

    render(<App />);
    await screen.findByText("Thread 0");

    const list = document.querySelector(".thread-list") as HTMLElement;
    fireEvent.scroll(list, { target: { scrollTop: 550 } });

    fireEvent.click(screen.getByRole("button", { name: "Open Stream" }));
    await waitFor(() => expect(document.querySelector(".thread-list")).toBeNull());

    fireEvent.click(await screen.findByRole("button", { name: "Close Stream" }));
    await waitFor(() => expect(location.pathname).toBe("/mail"));
    await screen.findByText("Thread 0");

    expect((document.querySelector(".thread-list") as HTMLElement).scrollTop).toBe(550);
  });

  it("restores the list's exact pixel offset on return from Settings", async () => {
    await seedManyThreads(30);
    stubFetch();
    const user = userEvent.setup();

    render(<App />);
    await screen.findByText("Thread 0");

    const list = document.querySelector(".thread-list") as HTMLElement;
    fireEvent.scroll(list, { target: { scrollTop: 300 } });

    await user.click(screen.getByRole("button", { name: /Account menu for/ }));
    await user.click(screen.getByRole("menuitem", { name: "Settings" }));
    await screen.findByRole("heading", { name: "General" });
    expect(document.querySelector(".thread-list")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Switch app" }));
    await user.click(screen.getByRole("link", { name: "Mail" }));
    await screen.findByText("Thread 0");

    expect((document.querySelector(".thread-list") as HTMLElement).scrollTop).toBe(300);
  });

  it("survives the open Thread being removed from the list (Done) while reading, restoring the same offset rather than falling back", async () => {
    await seedManyThreads(20);
    stubFetch();
    act(() => writeViewMode("list"));

    render(<App />);
    await screen.findByText("Thread 0");

    const list = document.querySelector(".thread-list") as HTMLElement;
    // Well within the shortened (19-Thread) list's own total height, so the
    // saved offset still fits after Done removes one row (#142's "no longer
    // valid" fallback is for an offset that stops fitting, not any removal).
    fireEvent.scroll(list, { target: { scrollTop: 300 } });

    fireEvent.click(screen.getByText("Thread 0"));
    await screen.findByRole("button", { name: /Done/ });
    fireEvent.click(screen.getByRole("button", { name: /Done/ }));

    await waitFor(() => expect(screen.queryByText("Thread 0")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Back to list" }));
    await screen.findByText("Thread 1");

    expect((document.querySelector(".thread-list") as HTMLElement).scrollTop).toBe(300);
  });

  it("falls back to scrolling the still-open Thread into view when no offset has been saved yet", async () => {
    await seedManyThreads(30);
    stubFetch();
    // Split (the default view mode): its own list never unmounts for the
    // Reader alone, so this is a *cold* mount of the list — a reload
    // straight onto a deep Thread — with no prior "leave" to have ever
    // saved a pixel offset for this list under `scroll-restore.ts`.
    history.replaceState(null, "", "/mail?thread=t20");

    render(<App />);
    await screen.findByText("Thread 20", { selector: ".reading-subject" });

    // No saved offset exists for this list — `initialScrollThreadId`'s
    // fallback (unchanged since #51) is what put Thread 20's own row on
    // screen, not a restored pixel offset.
    expect(await screen.findByText("Thread 20", { selector: ".subject" })).toBeDefined();
  });
});

describe("the app shell over a routed tree (#71)", () => {
  it("lands on Mail by default, with the seeded Thread visible", async () => {
    await seedOneThread();
    stubFetch();

    render(<App />);

    expect(await screen.findByText("Routed thread")).toBeDefined();
    expect(location.pathname).toBe("/mail");
  });

  it("Settings is reachable from the avatar menu and is no longer rendered below the mail pane", async () => {
    await seedOneThread();
    stubFetch();
    const user = userEvent.setup();

    render(<App />);
    await screen.findByText("Routed thread");
    // Settings' own controls aren't in the tree at all yet — not merely
    // scrolled past — until the route is entered.
    expect(screen.queryByRole("heading", { name: "General" })).toBeNull();

    await user.click(screen.getByRole("button", { name: /Account menu for/ }));
    await user.click(screen.getByRole("menuitem", { name: "Settings" }));

    // `/settings` redirects to General (#99) — its own sub-route.
    expect(await screen.findByRole("heading", { name: "General" })).toBeDefined();
    expect(screen.queryByText("Routed thread")).toBeNull();
    expect(location.pathname).toBe("/settings/general");
  });

  it("the App Switcher names all four Apps as reachable links, the reserved three marked SOON (#72, #86)", async () => {
    await seedOneThread();
    stubFetch();
    const user = userEvent.setup();

    render(<App />);
    await screen.findByText("Routed thread");

    await user.click(screen.getByRole("button", { name: "Switch app" }));

    // The switcher expands into the comp's tab row: real `Link`s, so a
    // reserved App is a destination rather than a disabled menu entry.
    expect(screen.getByRole("link", { name: "Mail" })).toBeDefined();
    for (const name of ["Contacts", "Calendar", "Tasks"]) {
      const tab = screen.getByRole("link", { name: new RegExp(name) });
      expect(tab).toBeDefined();
      expect(tab.textContent).toContain("SOON");
    }

    await user.click(screen.getByRole("link", { name: /Contacts/ }));

    expect(await screen.findByLabelText("Contacts")).toBeDefined();
    expect(screen.getByText("Not built yet")).toBeDefined();
    expect(location.pathname).toBe("/contacts");
  });

  it("at phone width, the App Switcher opens as a sheet and closes by outside pointer or Escape (#136)", async () => {
    await seedOneThread();
    stubFetch();
    const user = userEvent.setup();
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });

    try {
      render(<App />);
      await screen.findByText("Routed thread");

      // Desktop's inline expansion never renders a `dialog` — its tab row
      // is a plain positioned `div`, open or not.
      expect(screen.queryByRole("dialog")).toBeNull();

      await user.click(screen.getByRole("button", { name: "Switch app" }));
      expect(await screen.findByRole("dialog")).toBeDefined();
      // Every App is reachable from the sheet, the same as the desktop row.
      expect(screen.getByRole("link", { name: "Mail" })).toBeDefined();
      for (const name of ["Contacts", "Calendar", "Tasks"]) {
        expect(screen.getByRole("link", { name: new RegExp(name) })).toBeDefined();
      }

      await user.keyboard("{Escape}");
      expect(screen.queryByRole("dialog")).toBeNull();

      await user.click(screen.getByRole("button", { name: "Switch app" }));
      await screen.findByRole("dialog");

      // A tap outside the sheet closes it — Radix `Dialog`'s own
      // pointer-event dismissal, exercised here over the overlay it renders
      // behind the sheet's content.
      const overlay = document.querySelector('[data-slot="sheet-overlay"]');
      expect(overlay).not.toBeNull();
      await user.click(overlay as Element);
      expect(screen.queryByRole("dialog")).toBeNull();
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
    }
  });

  it("at phone width, the header sheds to search and avatar and the bottom bar carries Folders, the App Switcher and Compose (#155)", async () => {
    await seedOneThread();
    stubFetch();
    const user = userEvent.setup();
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });

    try {
      render(<App />);
      await screen.findByText("Routed thread");

      // The home mark, the header's own App Switcher instance and the
      // appearance toggle are gone from the tree entirely — a real
      // conditional (#155), not CSS-only visibility, so there's exactly
      // one "Switch app" control to find, not a duplicate.
      expect(screen.queryByLabelText("Wicket home")).toBeNull();
      expect(screen.queryByLabelText("Toggle appearance")).toBeNull();
      expect(screen.getByRole("button", { name: "Switch app" })).toBeDefined();

      // The bottom bar itself: Folders, the App Switcher (captioned with
      // the current App's name, "Mail" — its accessible name stays "Switch
      // app" either way, the same one the header's own skin carries), and
      // Compose — scoped to the bar itself, since jsdom (unlike a real
      // browser) never hides the desktop folder rail's own same-named
      // Compose pill for a width it can't apply `mail.css`'s CSS against.
      const bottomBar = screen.getByRole("navigation", {
        name: "Folders, switch app, and compose",
      });
      expect(within(bottomBar).getByRole("button", { name: "Folders" })).toBeDefined();
      expect(within(bottomBar).getByText("Mail")).toBeDefined();
      expect(within(bottomBar).getByRole("button", { name: "Compose" })).toBeDefined();

      // Folders opens the same Sheet the desktop rail's entries live in.
      await user.click(within(bottomBar).getByRole("button", { name: "Folders" }));
      expect(await screen.findByRole("dialog")).toBeDefined();
      expect(screen.getByRole("button", { name: "Screener" })).toBeDefined();
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("dialog")).toBeNull();

      // Compose opens the Composer from the bottom bar directly.
      await user.click(within(bottomBar).getByRole("button", { name: "Compose" }));
      expect(await screen.findByPlaceholderText("Subject")).toBeDefined();
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
    }
  });

  it("Appearance written from the header reaches Settings' own copy of the control (#72)", async () => {
    await seedOneThread();
    stubFetch();
    const user = userEvent.setup();

    render(<App />);
    await screen.findByText("Routed thread");

    await user.click(screen.getByRole("button", { name: /Account menu for/ }));
    await user.click(screen.getByRole("menuitemradio", { name: "Dark" }));

    await user.click(screen.getByRole("button", { name: /Account menu for/ }));
    await user.click(screen.getByRole("menuitem", { name: "Settings" }));
    // Appearance is "This device" page's own control now (#99), not General.
    await user.click(await screen.findByRole("link", { name: "This device" }));

    const appearanceSelect = (await screen.findByLabelText("Appearance")) as HTMLSelectElement;
    expect(appearanceSelect.value).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("a reload (a fresh mount at a URL already in hand) restores the view", async () => {
    await seedOneThread();
    stubFetch();

    // Simulates the User having navigated to Settings' "This device" page,
    // then reloading: a brand-new mount that only has the URL to go on, no
    // prior React state.
    history.replaceState(null, "", "/settings/this-device");
    render(<App />);

    expect(await screen.findByRole("heading", { name: "This device" })).toBeDefined();
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
      await screen.findByText("Routed thread", { selector: ".reading-subject" }),
    ).toBeDefined();
  });

  it("a cold-start Thread deep-link (#151) widens a narrowed Account Scope so the URL's own Thread is actually visible", async () => {
    await applyMailAccountDelta(
      delta({
        created: [
          makeMailAccount("acct-1", { createdAt: "2026-01-01T00:00:00.000Z" }),
          makeMailAccount("acct-2", { createdAt: "2026-01-02T00:00:00.000Z" }),
        ],
      }),
      { replace: false },
    );
    await applyThreadDelta(
      "acct-2",
      delta({ created: [makeThread("t2", "acct-2", { subject: "Notified thread" })] }),
      { replace: false },
    );
    stubFetch();
    // Scope was previously narrowed to the *other* account — the same
    // gap `sw.ts#focusOrOpenClient` opening a bare "/" would have left
    // unaddressed, since Account Scope is a Device Preference, not part
    // of the URL a real notification click carries.
    writeAccountScope(["acct-1"]);

    history.replaceState(null, "", "/mail?thread=t2&account=acct-2");
    render(<App />);

    expect(
      await screen.findByText("Notified thread", { selector: ".reading-subject" }),
    ).toBeDefined();
  });

  it("a cold-start Gatekeeper digest deep-link (#151) opens the Screener, narrowed to that Mail Account", async () => {
    await applyMailAccountDelta(
      delta({
        created: [
          makeMailAccount("acct-1", { createdAt: "2026-01-01T00:00:00.000Z" }),
          makeMailAccount("acct-2", { createdAt: "2026-01-02T00:00:00.000Z" }),
        ],
      }),
      { replace: false },
    );
    stubFetch();
    writeAccountScope(["acct-1"]);

    history.replaceState(null, "", "/mail?folder=screener&account=acct-2");
    render(<App />);

    expect(await screen.findByRole("region", { name: "Screener" })).toBeDefined();
    expect(location.pathname).toBe("/mail");
    expect(location.search).toContain("folder=screener");
  });

  it("a cold-start Needs Reauth deep-link (#151) lands on Mail Accounts settings and scrolls to that row", async () => {
    const account = makeMailAccount("acct-1", { status: "needs_reauth" });
    await applyMailAccountDelta(delta({ created: [account] }), { replace: false });
    stubFetch([account]);

    history.replaceState(null, "", "/settings/mail-accounts?account=acct-1");
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Mail Accounts", level: 2 })).toBeDefined();
    await waitFor(() => expect(document.getElementById("mail-account-acct-1")).not.toBeNull());
  });

  it("a Gatekeeper digest notification click, with a window open, opens the Screener narrowed to that Mail Account (#151)", async () => {
    await applyMailAccountDelta(
      delta({
        created: [
          makeMailAccount("acct-1", { createdAt: "2026-01-01T00:00:00.000Z" }),
          makeMailAccount("acct-2", { createdAt: "2026-01-02T00:00:00.000Z" }),
        ],
      }),
      { replace: false },
    );
    await applyThreadDelta(
      "acct-1",
      delta({ created: [makeThread("t1", "acct-1", { subject: "Account one thread" })] }),
      { replace: false },
    );
    stubFetch();

    render(<App />);
    expect(await screen.findByText("Account one thread")).toBeDefined();

    act(() => {
      publishNotificationTarget({ kind: "screener", mailAccountId: "acct-2" });
    });

    expect(await screen.findByRole("region", { name: "Screener" })).toBeDefined();
    expect(screen.queryByText("Account one thread")).toBeNull();
  });

  it("opening a Thread from the list pushes a history entry, and the phone back gesture returns to it (#81)", async () => {
    await seedOneThread();
    stubFetch();

    render(<App />);
    await screen.findByText("Routed thread");
    const historyLengthBeforeOpen = history.length;

    fireEvent.click(screen.getByText("Routed thread"));
    await screen.findByText("Routed thread", { selector: ".reading-subject" });

    // A real history entry — not the `replace` every other Mail navigation
    // uses — is what makes the router's own Back gesture the way back to
    // the list, "the way every other app on the phone behaves".
    expect(history.length).toBe(historyLengthBeforeOpen + 1);
    expect(location.search).toContain("thread=t1");

    await act(async () => {
      history.back();
    });

    await waitFor(() => expect(location.search).not.toContain("thread=t1"));
    // The reading pane actually closed to match the URL the gesture landed
    // on — not just a URL change with the pane left open over it.
    expect(screen.queryByText("Routed thread", { selector: ".reading-subject" })).toBeNull();
  });

  it("moving between Threads inside the Reader adds no history entries, and Back returns to the list from any of them (#140)", async () => {
    await seedTwoThreads();
    stubFetch();

    render(<App />);
    await screen.findByText("Newer thread");
    const historyLengthBeforeOpen = history.length;

    fireEvent.click(screen.getByText("Newer thread"));
    await screen.findByText("Newer thread", { selector: ".reading-subject" });
    expect(history.length).toBe(historyLengthBeforeOpen + 1);

    // `j` moves to the next (older) Thread from inside the Reader — a
    // replace, not a further push (CONTEXT.md: "moving to another Thread
    // from inside the Reader is not a further step").
    fireEvent.keyDown(window, { key: "j" });
    await screen.findByText("Older thread", { selector: ".reading-subject" });
    expect(history.length).toBe(historyLengthBeforeOpen + 1);
    expect(location.search).toContain("thread=t2");

    await act(async () => {
      history.back();
    });

    // One Back lands on the list, however many Threads were read in between.
    await waitFor(() => expect(location.search).not.toContain("thread="));
    expect(screen.queryByText("Older thread", { selector: ".reading-subject" })).toBeNull();
    expect(screen.getByText("Newer thread")).toBeDefined();
    expect(screen.getByText("Older thread")).toBeDefined();
  });

  it("a Back-then-Forward gesture into the Reader still lets one further Back return to the list (#140)", async () => {
    await seedOneThread();
    stubFetch();

    render(<App />);
    await screen.findByText("Routed thread");

    fireEvent.click(screen.getByText("Routed thread"));
    await screen.findByText("Routed thread", { selector: ".reading-subject" });

    await act(async () => {
      history.back();
    });
    await waitFor(() =>
      expect(screen.queryByText("Routed thread", { selector: ".reading-subject" })).toBeNull(),
    );

    await act(async () => {
      history.forward();
    });
    await screen.findByText("Routed thread", { selector: ".reading-subject" });

    // The router's own same-location dedup absorbs a same-destination
    // duplicate push, so it never surfaces as an extra `history.length` here
    // even from the pre-#140 marker — `router/MailRoute.test.tsx` is what
    // actually exercises the marker's own push/replace decision (the fix
    // this ticket made) directly. What this level still has to prove: a
    // single further Back genuinely reaches the list, not a Reader that
    // merely looks the same because a stale entry sits between here and it.
    await act(async () => {
      history.back();
    });

    await waitFor(() => expect(location.search).not.toContain("thread=t1"));
    expect(screen.queryByText("Routed thread", { selector: ".reading-subject" })).toBeNull();
  });

  it("closing the Reader with the Back pill leaves no stale history entry: Back from the list goes wherever it went before the Thread was opened (#140)", async () => {
    await seedOneThread();
    stubFetch();
    const user = userEvent.setup();

    history.replaceState(null, "", "/contacts");
    render(<App />);
    await screen.findByLabelText("Contacts");

    await user.click(screen.getByRole("button", { name: "Switch app" }));
    await user.click(screen.getByRole("link", { name: "Mail" }));
    await screen.findByText("Routed thread");
    const historyLengthAtList = history.length;

    fireEvent.click(screen.getByText("Routed thread"));
    await screen.findByText("Routed thread", { selector: ".reading-subject" });
    expect(history.length).toBe(historyLengthAtList + 1);

    await user.click(screen.getByRole("button", { name: "Back to list" }));

    await waitFor(() => expect(location.search).not.toContain("thread=t1"));
    expect(screen.queryByText("Routed thread", { selector: ".reading-subject" })).toBeNull();

    // One more Back goes to wherever the User was before the Thread was
    // opened — Contacts — not a ghost of the Mail list: the close popped
    // the entry the open had pushed rather than leaving it behind and
    // merely replacing its content (`history.length` itself can't tell the
    // two apart — back()/replace() neither one changes it — so this is the
    // one observable difference).
    await act(async () => {
      history.back();
    });
    await waitFor(() => expect(location.pathname).toBe("/contacts"));
  });

  it("leaving Stream after entering it from Mail goes back to the Mail surface that was showing, adding no net history (#141)", async () => {
    await seedOneThread();
    stubFetch();
    const user = userEvent.setup();

    render(<App />);
    await screen.findByText("Routed thread");
    const historyLengthAtMail = history.length;

    await user.click(screen.getByRole("button", { name: "Open Stream" }));
    await screen.findByRole("button", { name: "Close Stream" });
    expect(location.pathname).toBe("/mail/stream");
    expect(history.length).toBe(historyLengthAtMail + 1);

    await user.click(screen.getByRole("button", { name: "Close Stream" }));

    await waitFor(() => expect(location.pathname).toBe("/mail"));
    expect(await screen.findByText("Routed thread")).toBeDefined();
    // The pushed Stream entry was popped via `history.back()`, not
    // replaced-over and left behind for a real browser to still hold as a
    // reachable "forward" entry (`history.length` itself can't tell a pop
    // from a replace apart — neither changes it, the same fact #140's own
    // Back-pill test above notes) — so the proof is behavioural: one more
    // Back from here leaves Mail entirely rather than bouncing back into
    // Stream.
    await act(async () => {
      history.back();
    });
    await waitFor(() => expect(location.pathname).not.toBe("/mail/stream"));
  });

  it("landing on the Stream route cold and leaving it navigates to Mail (#141)", async () => {
    await seedOneThread();
    stubFetch();

    history.replaceState(null, "", "/mail/stream");
    render(<App />);
    await screen.findByRole("button", { name: "Close Stream" });
    const historyLengthAtStream = history.length;

    fireEvent.click(screen.getByRole("button", { name: "Close Stream" }));

    await waitFor(() => expect(location.pathname).toBe("/mail"));
    expect(await screen.findByText("Routed thread")).toBeDefined();
    // A cold entry has nothing pushed to go back to — the navigate to Mail
    // replaces rather than growing the stack.
    expect(history.length).toBe(historyLengthAtStream);
  });

  it("a needs-reauth notification click navigates to Settings and scrolls to that Mail Account's row (#53)", async () => {
    const account = makeMailAccount("acct-1", { status: "needs_reauth" });
    await applyMailAccountDelta(delta({ created: [account] }), { replace: false });
    stubFetch([account]);

    render(<App />);
    await screen.findByLabelText("Switch app");
    expect(screen.queryByRole("heading", { name: "Mail Accounts", level: 2 })).toBeNull();

    act(() => {
      publishNotificationTarget({ kind: "needs-reauth", mailAccountId: "acct-1" });
    });

    // Lands on `/settings/mail-accounts` directly (#99) — the one sub-route
    // `MailAccountsSection`'s row, and so `scrollToMailAccountSettings`'s
    // target, actually renders on.
    expect(await screen.findByRole("heading", { name: "Mail Accounts", level: 2 })).toBeDefined();
    expect(location.pathname).toBe("/settings/mail-accounts");
    await waitFor(() => expect(document.getElementById("mail-account-acct-1")).not.toBeNull());
  });

  it("the placeholder Apps are real, reachable routes", async () => {
    await seedOneThread();
    stubFetch();

    history.replaceState(null, "", "/contacts");
    render(<App />);

    expect(await screen.findByLabelText("Contacts")).toBeDefined();
    // Still under the one shell — the header's App Switcher is
    // unconditional chrome, not something each route re-renders.
    expect(screen.getByLabelText("Switch app")).toBeDefined();
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

  it("the Owner reaches the Instance page and sees its four facts (#104)", async () => {
    await seedOneThread();
    stubFetch([], "owner");
    const user = userEvent.setup();

    render(<App />);
    await screen.findByText("Routed thread");

    await user.click(screen.getByRole("button", { name: /Account menu for/ }));
    await user.click(screen.getByRole("menuitem", { name: "Settings" }));
    await user.click(await screen.findByRole("link", { name: "Instance" }));

    expect(await screen.findByRole("heading", { name: "Instance" })).toBeDefined();
    expect(await screen.findByText("test-tag")).toBeDefined();
    expect(screen.getByText((_, node) => node?.textContent === "Not configured")).toBeDefined();
    expect(location.pathname).toBe("/settings/instance");
  });

  it("a Member gets no Instance nav entry, and a direct URL redirects to General (#104)", async () => {
    await seedOneThread();
    stubFetch([], "member");
    const user = userEvent.setup();

    render(<App />);
    await screen.findByText("Routed thread");

    await user.click(screen.getByRole("button", { name: /Account menu for/ }));
    await user.click(screen.getByRole("menuitem", { name: "Settings" }));
    await screen.findByRole("heading", { name: "General" });
    expect(screen.queryByRole("link", { name: "Instance" })).toBeNull();
  });

  it("a Member navigating straight to /settings/instance is redirected to General (#104)", async () => {
    stubFetch([], "member");
    history.replaceState(null, "", "/settings/instance");

    render(<App />);

    expect(await screen.findByRole("heading", { name: "General" })).toBeDefined();
    expect(location.pathname).toBe("/settings/general");
  });

  describe("the Command Palette, lifted to Hub level (#147)", () => {
    it("has no Mail search field anywhere — the Hub's pill is the one visible search affordance", async () => {
      await seedOneThread();
      stubFetch();

      render(<App />);
      await screen.findByText("Routed thread");

      expect(screen.queryByLabelText("Search mail")).toBeNull();
      expect(screen.getByRole("button", { name: /Search everything/ })).toBeDefined();
    });

    it("opens from the Hub's own search pill, from `/`, and from ⌘K — all reaching the same Palette", async () => {
      await seedOneThread();
      stubFetch();

      render(<App />);
      await screen.findByText("Routed thread");

      fireEvent.click(screen.getByRole("button", { name: /Search everything/ }));
      expect(await screen.findByLabelText("Search commands and mail")).toBeDefined();
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      await waitFor(() => expect(screen.queryByLabelText("Search commands and mail")).toBeNull());

      fireEvent.keyDown(window, { key: "/" });
      expect(await screen.findByLabelText("Search commands and mail")).toBeDefined();
      fireEvent.keyDown(
        await screen.findByLabelText<HTMLInputElement>("Search commands and mail"),
        { key: "Escape" },
      );
      await waitFor(() => expect(screen.queryByLabelText("Search commands and mail")).toBeNull());

      fireEvent.keyDown(window, { key: "k", metaKey: true });
      expect(await screen.findByLabelText("Search commands and mail")).toBeDefined();
    });

    it("opens over Stream — mounted once at Hub level, not inside the Mail surface (#147)", async () => {
      await seedOneThread();
      stubFetch();

      render(<App />);
      await screen.findByText("Routed thread");

      fireEvent.click(screen.getByRole("button", { name: "Open Stream" }));
      await screen.findByText("Routed thread", { selector: ".reading-subject" });
      expect(document.querySelector(".stream-route")).not.toBeNull();

      fireEvent.keyDown(window, { key: "k", metaKey: true });

      // Both the Palette and Stream are in the tree at once — the Palette
      // renders *over* Stream rather than Stream unmounting it or hiding
      // behind it, the bug the epic named directly.
      expect(await screen.findByLabelText("Search commands and mail")).toBeDefined();
      expect(document.querySelector(".stream-route")).not.toBeNull();
      expect(screen.getByRole("option", { name: /Compose/ })).toBeDefined();
    });

    it("opens from a placeholder App too, with its own commands still listed", async () => {
      await seedOneThread();
      stubFetch();

      history.replaceState(null, "", "/contacts");
      render(<App />);
      await screen.findByLabelText("Contacts");

      fireEvent.keyDown(window, { key: "k", metaKey: true });

      expect(await screen.findByLabelText("Search commands and mail")).toBeDefined();
      expect(screen.getByRole("option", { name: /Compose/ })).toBeDefined();
    });
  });
});
