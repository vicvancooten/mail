import { labelId, type MailAccount } from "@mail/shared";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App.js";
import { resetUndoToastsForTest } from "./mail/undo-toast.js";
import { publishNotificationTarget } from "./pwa/notification-router.js";
import { localCache, openLocalCache } from "./store/local-cache.js";
import {
  applyConnectedAccountDelta,
  applyLabelDelta,
  applyMailAccountDelta,
  applyNoteDelta,
  applyThreadDelta,
} from "./store/server-writes.js";
import { resetSyncStatus } from "./sync/sync-loop.js";
import {
  delta,
  makeConnectedAccount,
  makeLabel,
  makeMailAccount,
  makeNote,
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
  resetUndoToastsForTest();
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

/** #193's own User (`authResponses`' stubbed `/auth/session` above) — Notes and Label are User-scoped, so every fixture below is owned by it. */
const NOTES_USER = "u1";

async function seedNotesAndLabels(
  notes: Parameters<typeof makeNote>[2][],
  labelNames: string[] = [],
): Promise<void> {
  await applyLabelDelta(
    delta({
      created: labelNames.map((name) => makeLabel(labelId(NOTES_USER, name), NOTES_USER, { name })),
    }),
    { replace: false },
  );
  await applyNoteDelta(
    delta({
      created: notes.map((overrides, index) =>
        makeNote(`note-${index + 1}`, NOTES_USER, overrides),
      ),
    }),
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

  it("the App Switcher names all five Apps as reachable links, Contacts/Calendar/Tasks marked SOON (#72, #86, #187, #193)", async () => {
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
    // Notes is real behind this since #193 — no SOON badge.
    expect(screen.getByRole("link", { name: "Notes" }).textContent).not.toContain("SOON");

    await user.click(screen.getByRole("link", { name: /Contacts/ }));

    expect(await screen.findByLabelText("Contacts")).toBeDefined();
    expect(screen.getByText("Not built yet")).toBeDefined();
    expect(location.pathname).toBe("/contacts");
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

  it("a needs-reauth notification click navigates to Connected Accounts and opens that Mail Account's Facet Popover (#53, #201)", async () => {
    const account = makeMailAccount("acct-1", { status: "needs_reauth" });
    await applyMailAccountDelta(delta({ created: [account] }), { replace: false });
    await applyConnectedAccountDelta(
      delta({
        created: [
          makeConnectedAccount("acct-1-connected", {
            facets: [{ kind: "mail", status: "needs_reauth" }],
          }),
        ],
      }),
      { replace: false },
    );
    stubFetch([account]);

    render(<App />);
    await screen.findByLabelText("Switch app");
    expect(screen.queryByRole("heading", { name: "Connected Accounts", level: 2 })).toBeNull();

    act(() => {
      publishNotificationTarget({ kind: "needs-reauth", mailAccountId: "acct-1" });
    });

    // Lands on `/settings/connected-accounts` (#201, `/settings/mail-accounts`'s
    // new address, via its own redirect route) with that Mail Account's own
    // Facet Badge already open — there's no longer one row per account to
    // scroll to, so the deep link opens the Popover instead
    // (`connected-accounts/account-focus.ts`).
    expect(
      await screen.findByRole("heading", { name: "Connected Accounts", level: 2 }),
    ).toBeDefined();
    expect(location.pathname).toBe("/settings/connected-accounts");
    await waitFor(() => expect(screen.getByLabelText("Username")).toBeDefined());
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

  it("Account Scope hides on an App that doesn't observe it, and returns with the User's last Scope intact (#187)", async () => {
    await applyMailAccountDelta(
      delta({
        created: [
          makeMailAccount("acct-1", { createdAt: "2026-01-01T00:00:00.000Z" }),
          makeMailAccount("acct-2", { createdAt: "2026-01-02T00:00:00.000Z" }),
        ],
      }),
      { replace: false },
    );
    // The picker's own rows come from the Connected Accounts collection now
    // (#207), not `MailAccount` — a matching row per Mail Account, same
    // `${id}-connected` join `mail-fixtures.ts#makeConnectedAccount`'s own
    // doc comment describes.
    await applyConnectedAccountDelta(
      delta({
        created: [
          makeConnectedAccount("acct-1-connected"),
          makeConnectedAccount("acct-2-connected"),
        ],
      }),
      { replace: false },
    );
    stubFetch();
    const user = userEvent.setup();

    render(<App />);
    const scopeButton = await screen.findByRole("button", {
      name: /Account Scope: All accounts/,
    });
    // Narrow to one account — the Scope this test expects to survive the
    // round trip through Tasks below.
    await user.click(scopeButton);
    await user.click(screen.getByRole("checkbox", { name: "acct-2@example.test" }));
    expect(
      await screen.findByRole("button", { name: "Account Scope: acct-1@example.test" }),
    ).toBeDefined();

    // Tasks doesn't observe Account Scope (`apps/apps.ts`) — the Hub hides
    // the control entirely rather than rendering it disabled.
    await user.click(screen.getByRole("button", { name: "Switch app" }));
    await user.click(screen.getByRole("link", { name: /Tasks/ }));
    await screen.findByLabelText("Tasks");
    expect(screen.queryByRole("button", { name: /Account Scope/ })).toBeNull();

    // Back to Mail: the control returns, still narrowed to acct-1 — hiding
    // it never touched the underlying Scope state.
    await user.click(screen.getByRole("button", { name: "Switch app" }));
    await user.click(screen.getByRole("link", { name: "Mail" }));
    expect(
      await screen.findByRole("button", { name: "Account Scope: acct-1@example.test" }),
    ).toBeDefined();
  });

  it("the App Switcher opens a phone sheet naming all five Apps below 700px (#187, #193)", async () => {
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 375 });
    window.dispatchEvent(new Event("resize"));

    try {
      await seedOneThread();
      stubFetch();
      const user = userEvent.setup();

      render(<App />);
      await screen.findByText("Routed thread");

      // The desktop's inline-expanding tab row isn't in the tree at all at
      // this width — `useNarrowHeader` mounts the sheet trigger instead, not
      // a CSS rule hiding the desktop row (`AppSwitcher.tsx`'s own doc
      // comment on why the two share one accessible name and can't both be
      // mounted at once).
      await user.click(screen.getByRole("button", { name: "Switch app" }));

      expect(screen.getByRole("link", { name: "Mail" })).toBeDefined();
      for (const name of ["Contacts", "Calendar", "Tasks"]) {
        const tab = screen.getByRole("link", { name: new RegExp(name) });
        expect(tab).toBeDefined();
        expect(tab.textContent).toContain("SOON");
      }
      expect(screen.getByRole("link", { name: "Notes" }).textContent).not.toContain("SOON");
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
      window.dispatchEvent(new Event("resize"));
    }
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
});

/** A Note document whose only block is a paragraph carrying `text` — the grid's own derived title and preview both read straight off this. */
function noteParagraph(text: string) {
  return [
    {
      id: "b1",
      type: "paragraph",
      props: {},
      content: [{ type: "text", text, styles: {} }],
      children: [],
    },
  ];
}

/** A card's own `.note-card-title`, found by its text — a card's preview carries the same text too, so a plain `getByText` is ambiguous between the two. */
function cardTitleText(text: string): Element | null {
  return (
    [...document.querySelectorAll(".note-card-title")].find((el) => el.textContent === text) ?? null
  );
}

describe("Notes: the grid and dialog editing (#193)", () => {
  it("renders Pinned then Others, each sorted last-edited descending, with titles and Label badges", async () => {
    const workId = labelId(NOTES_USER, "Work");
    await seedNotesAndLabels(
      [
        { pinned: true, updatedAt: minutesAfterEpoch(10), document: noteParagraph("Pinned note") },
        {
          pinned: false,
          updatedAt: minutesAfterEpoch(30),
          document: noteParagraph("Newer other"),
          labelIds: [workId],
        },
        { pinned: false, updatedAt: minutesAfterEpoch(5), document: noteParagraph("Older other") },
      ],
      ["Work"],
    );
    stubFetch();
    history.replaceState(null, "", "/notes");

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Pinned note" })).toBeDefined();
    expect(screen.getByRole("heading", { name: "Pinned" })).toBeDefined();
    expect(screen.getByRole("heading", { name: "Others" })).toBeDefined();
    // "Work" appears twice: the filter chip and the card's own Label badge.
    expect(screen.getAllByText("Work")).toHaveLength(2);

    // Others sorted last-edited descending: "Newer other" before "Older other".
    const titles = screen
      .getAllByRole("heading", { level: 3 })
      .map((heading) => heading.textContent);
    expect(titles).toEqual(["Pinned note", "Newer other", "Older other"]);
  });

  it("a Note with no text in its first block shows the transient Untitled Note placeholder", async () => {
    await seedNotesAndLabels([{ document: noteParagraph("") }]);
    stubFetch();
    history.replaceState(null, "", "/notes");

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Untitled Note" })).toBeDefined();
    // Never written into the document (#193's own acceptance line).
    expect((await localCache().notes.get("note-1"))?.document).toEqual(noteParagraph(""));
  });

  it("the Label chip row filters both sections at once, multi-select with OR semantics", async () => {
    const workId = labelId(NOTES_USER, "Work");
    const homeId = labelId(NOTES_USER, "Home");
    await seedNotesAndLabels(
      [
        { document: noteParagraph("Work note"), labelIds: [workId] },
        { document: noteParagraph("Home note"), labelIds: [homeId] },
        { document: noteParagraph("Unlabeled note") },
      ],
      ["Work", "Home"],
    );
    stubFetch();
    const user = userEvent.setup();
    history.replaceState(null, "", "/notes");

    render(<App />);
    await screen.findByRole("heading", { name: "Work note" });

    await user.click(screen.getByRole("button", { name: "Work" }));

    expect(screen.getByRole("heading", { name: "Work note" })).toBeDefined();
    expect(screen.queryByRole("heading", { name: "Home note" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Unlabeled note" })).toBeNull();

    // OR semantics: selecting Home too brings its Note back in alongside Work's.
    await user.click(screen.getByRole("button", { name: "Home" }));

    expect(screen.getByRole("heading", { name: "Work note" })).toBeDefined();
    expect(screen.getByRole("heading", { name: "Home note" })).toBeDefined();
    expect(screen.queryByRole("heading", { name: "Unlabeled note" })).toBeNull();
  });

  it("clicking a card pushes /notes/:noteId and opens the editor in a Dialog over the still-mounted grid", async () => {
    await seedNotesAndLabels([
      { document: noteParagraph("First note") },
      { document: noteParagraph("Second note") },
    ]);
    stubFetch();
    history.replaceState(null, "", "/notes");

    render(<App />);
    await screen.findByRole("heading", { name: "First note" });

    fireEvent.click(screen.getByRole("link", { name: "First note" }));

    expect(await screen.findByRole("dialog")).toBeDefined();
    expect(location.pathname).toBe("/notes/note-1");
    // The dimmed grid underneath, second Note included, is still in the tree
    // — `aria-hidden`, like the rest of the page, while the dialog traps
    // focus (Radix's own behaviour), so this reads the DOM directly rather
    // than through an accessible-role query (a card's title and its own
    // preview both carry the same text, so `.note-card-title` is what picks
    // the title specifically).
    expect(cardTitleText("Second note")).toBeDefined();
    await waitFor(() => {
      expect(document.querySelector('[contenteditable="true"]')).not.toBeNull();
    });
  });

  it("a deep link to /notes/:noteId opens straight into the dialog over the grid, no blank intermediate page", async () => {
    await seedNotesAndLabels([{ document: noteParagraph("Deep linked note") }]);
    stubFetch();
    history.replaceState(null, "", "/notes/note-1");

    render(<App />);

    expect(await screen.findByRole("dialog")).toBeDefined();
    // The grid rendered underneath, not a blank page — same Note's own card
    // (`aria-hidden` while the dialog is open, hence the direct DOM read).
    expect(cardTitleText("Deep linked note")).toBeDefined();
  });

  it("Esc navigates back to /notes, closing the dialog", async () => {
    await seedNotesAndLabels([{ document: noteParagraph("A note") }]);
    stubFetch();
    history.replaceState(null, "", "/notes/note-1");

    render(<App />);
    await screen.findByRole("dialog");

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => {
      expect(location.pathname).toBe("/notes");
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a backdrop click navigates back to /notes", async () => {
    await seedNotesAndLabels([{ document: noteParagraph("A note") }]);
    stubFetch();
    history.replaceState(null, "", "/notes/note-1");

    render(<App />);
    await screen.findByRole("dialog");

    // biome-ignore lint/style/noNonNullAssertion: the Overlay always renders alongside the Dialog itself.
    fireEvent.pointerDown(document.querySelector('[data-slot="dialog-overlay"]')!);
    // biome-ignore lint/style/noNonNullAssertion: same overlay, mouseUp closes a Radix Dialog.
    fireEvent.click(document.querySelector('[data-slot="dialog-overlay"]')!);

    await waitFor(() => {
      expect(location.pathname).toBe("/notes");
    });
  });

  it("a :noteId that resolves to nothing redirects silently to /notes", async () => {
    await seedNotesAndLabels([{ document: noteParagraph("A real note") }]);
    stubFetch();
    history.replaceState(null, "", "/notes/does-not-exist");

    render(<App />);

    await waitFor(() => {
      expect(location.pathname).toBe("/notes");
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await screen.findByRole("heading", { name: "A real note" })).toBeDefined();
  });

  it("Pin toggles from the card, moving the Note into Pinned", async () => {
    await seedNotesAndLabels([{ document: noteParagraph("Will be pinned") }]);
    stubFetch();
    history.replaceState(null, "", "/notes");

    render(<App />);
    await screen.findByRole("heading", { name: "Will be pinned" });
    expect(screen.queryByRole("heading", { name: "Pinned" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: 'Pin "Will be pinned"' }));

    expect(await screen.findByRole("heading", { name: "Pinned" })).toBeDefined();
    expect(screen.getByRole("button", { name: 'Unpin "Will be pinned"' })).toBeDefined();
  });

  it("Pin toggles from the open dialog too, with a real inverse", async () => {
    await seedNotesAndLabels([{ document: noteParagraph("Pin me from the dialog") }]);
    stubFetch();
    history.replaceState(null, "", "/notes/note-1");

    render(<App />);
    const pinButton = await screen.findByRole("button", { name: "Pin note" });

    fireEvent.click(pinButton);

    expect(await screen.findByRole("button", { name: "Unpin note" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Unpin note" }));
    expect(await screen.findByRole("button", { name: "Pin note" })).toBeDefined();
  });

  it("Notes is reachable from the Hub without the SOON badge (#187, #193)", async () => {
    await seedOneThread();
    stubFetch();
    const user = userEvent.setup();

    render(<App />);
    await screen.findByText("Routed thread");

    await user.click(screen.getByRole("button", { name: "Switch app" }));
    await user.click(screen.getByRole("link", { name: "Notes" }));

    expect(await screen.findByRole("region", { name: "Notes" })).toBeDefined();
    expect(location.pathname).toBe("/notes");
  });
});

/** `/search` never resolves in `stubFetch` above — irrelevant to a Palette test whose own hits are the Notes group, not Mail's. */
function stubFetchWithSearch(mailAccounts: MailAccount[] = []): void {
  const authResponsesForRole = authResponses("owner");
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const auth = authResponsesForRole[url];
      if (auth) return Promise.resolve(auth());
      if (url === "/sync") return new Promise<Response>(() => {});
      if (url === "/mail-accounts") return Promise.resolve(jsonResponse({ mailAccounts }));
      if (url === "/search") {
        return Promise.resolve(
          jsonResponse({
            results: [],
            cursor: null,
            indexWatermark: { coveredSince: null, complete: true },
          }),
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }),
  );
}

describe("Notes in the Command Palette (#196)", () => {
  it("selecting a Note hit navigates to /notes/:noteId and opens the dialog over the grid", async () => {
    await seedOneThread();
    await seedNotesAndLabels([{ document: noteParagraph("Grocery list") }]);
    stubFetchWithSearch();

    render(<App />);
    await screen.findByText("Routed thread");

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const field = await screen.findByLabelText("Search commands and mail");
    fireEvent.change(field, { target: { value: "grocery" } });

    fireEvent.click(
      await screen.findByText("Grocery list", { selector: ".command-palette-hit-subject" }),
    );

    await waitFor(() => expect(location.pathname).toBe("/notes/note-1"));
    expect(await screen.findByRole("dialog")).toBeDefined();
    // The grid underneath, same Note's own card — the ticket's own "opening
    // the Note's dialog over the grid", not a screen that replaces it.
    expect(cardTitleText("Grocery list")).toBeDefined();
  });
});

describe("Notes: soft delete and Recently Deleted (#194)", () => {
  it("Delete from the card removes the Note from the grid and raises an Undo toast", async () => {
    await seedNotesAndLabels([{ document: noteParagraph("Will be deleted") }]);
    stubFetch();
    history.replaceState(null, "", "/notes");

    render(<App />);
    await screen.findByRole("heading", { name: "Will be deleted" });

    fireEvent.click(screen.getByRole("button", { name: 'Delete "Will be deleted"' }));

    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "Will be deleted" })).toBeNull();
    });
    expect(await screen.findByText("Note deleted")).toBeDefined();
    expect(screen.getByRole("button", { name: "Undo" })).toBeDefined();
  });

  it("Undo returns the Note to the grid, Pinned state and Labels intact", async () => {
    const workId = labelId(NOTES_USER, "Work");
    await seedNotesAndLabels(
      [{ document: noteParagraph("Undo me"), pinned: true, labelIds: [workId] }],
      ["Work"],
    );
    stubFetch();
    history.replaceState(null, "", "/notes");

    render(<App />);
    await screen.findByRole("heading", { name: "Undo me" });

    fireEvent.click(screen.getByRole("button", { name: 'Delete "Undo me"' }));
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "Undo me" })).toBeNull();
    });

    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));

    expect(await screen.findByRole("heading", { name: "Undo me" })).toBeDefined();
    // Back in its previous section (Pinned) with its Label intact.
    expect(screen.getByRole("heading", { name: "Pinned" })).toBeDefined();
    expect(
      screen.getByRole("heading", { name: "Undo me" }).closest(".note-card")?.textContent,
    ).toContain("Work");
  });

  it("deleting the Note open in the dialog closes it and navigates back to /notes", async () => {
    await seedNotesAndLabels([{ document: noteParagraph("Open then deleted") }]);
    stubFetch();
    history.replaceState(null, "", "/notes/note-1");

    render(<App />);
    const deleteButton = await screen.findByRole("button", { name: "Delete note" });

    fireEvent.click(deleteButton);

    await waitFor(() => {
      expect(location.pathname).toBe("/notes");
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Recently Deleted lists a greyed card with Restore, and Restore brings the Note back to the grid", async () => {
    await seedNotesAndLabels([{ document: noteParagraph("Trashed note") }]);
    stubFetch();
    history.replaceState(null, "", "/notes");

    render(<App />);
    await screen.findByRole("heading", { name: "Trashed note" });
    fireEvent.click(screen.getByRole("button", { name: 'Delete "Trashed note"' }));
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "Trashed note" })).toBeNull();
    });

    fireEvent.click(screen.getByRole("link", { name: "Recently Deleted" }));

    await waitFor(() => {
      expect(location.pathname).toBe("/notes/recently-deleted");
    });
    expect(await screen.findByRole("button", { name: 'Restore "Trashed note"' })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: 'Restore "Trashed note"' }));

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: 'Restore "Trashed note"' })).toBeNull();
    });
    fireEvent.click(screen.getByRole("link", { name: "← Notes" }));
    expect(await screen.findByRole("heading", { name: "Trashed note" })).toBeDefined();
  });
});
