import type { Note, SearchResponse } from "@mail/shared";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../App.js";
import { localCache, openLocalCache } from "../../store/local-cache.js";
import {
  applyMailAccountDelta,
  applyNoteDelta,
  applyThreadDelta,
} from "../../store/server-writes.js";
import { resetSyncStatus } from "../../sync/sync-loop.js";
import { delta, makeMailAccount, makeNote, makeThread } from "../../test-support/mail-fixtures.js";
import { jsonResponse } from "../../test-support/mock-fetch.js";
import { resetActiveMailHost } from "../actions/active-mail-host.js";
import { resetSurfaceHandles } from "../actions/surface-handles.js";
import { addRecentSearch } from "../device-preferences.js";

/**
 * #79's own end-to-end coverage, driven over the full routed tree (#147:
 * the Palette moved to Hub level, `router/RootLayout.tsx`, so a bare
 * `MailSection` no longer mounts one at all) the way
 * `app-shell-integration.test.tsx` already renders `<App/>`: `⌘K`/`Ctrl-K`
 * opening the Command Palette, running a Command from it, typing a mail
 * query and reaching the full results pane through "See all results", and
 * `?` opening the Shortcut Sheet — a real IndexedDB-backed Local Cache and
 * a stubbed `fetch`, never a mocked `useSearchState`.
 */

/** The composer's own network calls — irrelevant here, mocked quiet like `MailSection.test.tsx` does. */
vi.mock("../../api/attachments.js", () => ({
  fetchComposeConfig: vi.fn(async () => ({ attachmentBudgetEncodedBytes: 25 * 1024 * 1024 })),
  uploadAttachment: vi.fn(() => new Promise(() => {})),
  deleteAttachment: vi.fn(async () => {}),
  attachmentUrl: (compositionId: string, attachmentId: string) =>
    `/compositions/${compositionId}/attachments/${attachmentId}`,
  AttachmentBudgetExceededError: class AttachmentBudgetExceededError extends Error {},
}));

let counter = 0;
const names: string[] = [];

const AUTH_RESPONSES: Record<string, () => Response> = {
  "/auth/status": () => jsonResponse({ claimed: true }),
  "/auth/session": () =>
    jsonResponse({
      user: { id: "u1", username: "vic", role: "owner", createdAt: "2026-01-01T00:00:00.000Z" },
    }),
};

const never = () => new Promise<Response>(() => {});

function stubFetch(search: () => Promise<Response> = never) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const auth = AUTH_RESPONSES[url];
      if (auth) return Promise.resolve(auth());
      if (url === "/sync") return never();
      if (url === "/search") return search();
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
  const name = `command-palette-test-${counter++}`;
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
  for (const name of names.splice(0)) await Dexie.delete(name);
});

async function seedOneThread(): Promise<void> {
  await applyMailAccountDelta(delta({ created: [makeMailAccount("acct-1")] }), { replace: false });
  await applyThreadDelta(
    "acct-1",
    delta({ created: [makeThread("t1", "acct-1", { subject: "Origin thread" })] }),
    { replace: false },
  );
}

/** #79/#196's own stubbed User (`/auth/session` above) — Notes is User-scoped, so every seeded Note here is owned by it. */
const NOTES_USER = "u1";

function paragraph(text: string, id = "b1") {
  return {
    id,
    type: "paragraph",
    props: {},
    content: [{ type: "text", text, styles: {} }],
    children: [],
  };
}

async function seedNotes(...notes: Partial<Note>[]): Promise<void> {
  await applyNoteDelta(
    delta({
      created: notes.map((overrides, index) =>
        makeNote(`note-${index + 1}`, NOTES_USER, overrides),
      ),
    }),
    { replace: false },
  );
}

function renderApp() {
  return render(<App />);
}

describe("Command Palette (#79, lifted to Hub level by #147)", () => {
  it("`>` lists every command with its binding, unbound ones included (#148)", async () => {
    await seedOneThread();
    stubFetch();

    renderApp();
    await screen.findByText("Origin thread");

    fireEvent.keyDown(window, { key: "k", metaKey: true });

    const field = await screen.findByLabelText<HTMLInputElement>("Search commands and mail");
    expect(field).toBeDefined();
    fireEvent.change(field, { target: { value: ">" } });

    expect(screen.getByRole("option", { name: /Compose/ })).toBeDefined();
    // "Mark as read/unread" lost its `u` key to "Back to list" (#79) — still
    // listed, marked unbound rather than missing outright.
    const markReadRow = screen.getByRole("option", { name: /Mark as (read|unread)/ });
    expect(markReadRow.textContent).toContain("unbound");
  });

  it("`>` narrows to commands only, hiding Mail hits and the three-command cap (#148)", async () => {
    await seedOneThread();
    const searchResponse: SearchResponse = {
      results: [
        {
          thread: makeThread("t-great", "acct-1", { subject: "Great outcome" }),
          matchedMessageId: "t-great-msg",
          headline: null,
          folder: { id: "f1", name: "Inbox", role: "inbox" },
          gatekeeper: null,
        },
      ],
      cursor: null,
      indexWatermark: { coveredSince: null, complete: true },
    };
    stubFetch(() => Promise.resolve(jsonResponse(searchResponse)));

    renderApp();
    await screen.findByText("Origin thread");
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const field = await screen.findByLabelText<HTMLInputElement>("Search commands and mail");

    // "rea" matches four real, non-contextual commands (Mark as read/unread,
    // Next thread, Previous thread, Open Stream, via "thread"/"Stream") and
    // the seeded Mail hit ("Great outcome").
    fireEvent.change(field, { target: { value: ">rea" } });

    expect(screen.getByRole("option", { name: /Mark as (read|unread)/ })).toBeDefined();
    expect(screen.getByRole("option", { name: /Next thread/ })).toBeDefined();
    expect(screen.getByRole("option", { name: /Previous thread/ })).toBeDefined();
    expect(screen.getByRole("option", { name: /Open Stream/ })).toBeDefined();
    expect(screen.queryByText("Great outcome")).toBeNull();
    expect(screen.queryByRole("option", { name: /See all results/ })).toBeNull();
  });

  it("merges matching commands above Mail hits, capped at three once hits are present (#148)", async () => {
    await seedOneThread();
    const searchResponse: SearchResponse = {
      results: [
        {
          thread: makeThread("t-great", "acct-1", { subject: "Great outcome" }),
          matchedMessageId: "t-great-msg",
          headline: null,
          folder: { id: "f1", name: "Inbox", role: "inbox" },
          gatekeeper: null,
        },
      ],
      cursor: null,
      indexWatermark: { coveredSince: null, complete: true },
    };
    stubFetch(() => Promise.resolve(jsonResponse(searchResponse)));

    renderApp();
    await screen.findByText("Origin thread");
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const field = await screen.findByLabelText<HTMLInputElement>("Search commands and mail");

    fireEvent.change(field, { target: { value: "rea" } });

    // Wait for the Mail hit to land first — the three-command cap only
    // applies once a hit is actually on screen, and the fetch is async.
    expect(
      await screen.findByText("Great outcome", { selector: ".command-palette-hit-subject" }),
    ).toBeDefined();
    expect(screen.getByRole("option", { name: /See all results/ })).toBeDefined();

    // Registry order caps to the first three of the four matches — "Open
    // Stream" is the fourth and falls off.
    expect(screen.getByRole("option", { name: /Mark as (read|unread)/ })).toBeDefined();
    expect(screen.getByRole("option", { name: /Next thread/ })).toBeDefined();
    expect(screen.getByRole("option", { name: /Previous thread/ })).toBeDefined();
    expect(screen.queryByRole("option", { name: /Open Stream/ })).toBeNull();
  });

  it("the empty state shows the most-used commands, freshest device falling back to registry order (#148)", async () => {
    await seedOneThread();
    stubFetch();

    renderApp();
    await screen.findByText("Origin thread");

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    await screen.findByLabelText("Search commands and mail");

    // No usage recorded yet on this device — the top five in registry order.
    expect(screen.getByRole("option", { name: /^Compose/ })).toBeDefined();
    expect(screen.getByRole("option", { name: /Snooze/ })).toBeDefined();
    expect(screen.getByRole("option", { name: /Pin/ })).toBeDefined();
    // Sixth in registry order — outside the top five, so absent here (still
    // reachable via `>`, tested above).
    expect(screen.queryByRole("option", { name: /Mark as (read|unread)/ })).toBeNull();
    expect(screen.queryByText("Recent searches")).toBeNull();
  });

  it("the empty state shows recent searches, clickable to re-run (#148)", async () => {
    await seedOneThread();
    const searchResponse: SearchResponse = {
      results: [
        {
          thread: makeThread("t-invoice", "acct-1", { subject: "Invoice March" }),
          matchedMessageId: "t-invoice-msg",
          headline: null,
          folder: { id: "f1", name: "Inbox", role: "inbox" },
          gatekeeper: null,
        },
      ],
      cursor: null,
      indexWatermark: { coveredSince: null, complete: true },
    };
    stubFetch(() => Promise.resolve(jsonResponse(searchResponse)));
    addRecentSearch("invoice");

    renderApp();
    await screen.findByText("Origin thread");
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    await screen.findByLabelText("Search commands and mail");

    expect(screen.getByText("Recent searches")).toBeDefined();
    fireEvent.click(screen.getByRole("option", { name: /invoice/ }));

    await waitFor(() => expect(screen.queryByLabelText("Search commands and mail")).toBeNull());
    expect(document.querySelector(".search-chip-row")).not.toBeNull();
    expect(await screen.findByText("Invoice March")).toBeDefined();
  });

  it("running Compose from the Palette opens the composer and closes the Palette", async () => {
    await seedOneThread();
    stubFetch();

    renderApp();
    await screen.findByText("Origin thread");
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    await screen.findByLabelText("Search commands and mail");

    fireEvent.click(screen.getByRole("option", { name: /^Compose/ }));

    expect(await screen.findByRole("dialog", { name: "New message" })).toBeDefined();
    expect(screen.queryByLabelText("Search commands and mail")).toBeNull();
  });

  it("typing shows top mail hits inline; 'See all results' reveals the results pane behind it", async () => {
    await seedOneThread();
    const searchResponse: SearchResponse = {
      results: [
        {
          thread: makeThread("t-invoice", "acct-1", { subject: "Invoice March" }),
          matchedMessageId: "t-invoice-msg",
          headline: null,
          folder: { id: "f1", name: "Inbox", role: "inbox" },
          gatekeeper: null,
        },
      ],
      cursor: null,
      indexWatermark: { coveredSince: null, complete: true },
    };
    stubFetch(() => Promise.resolve(jsonResponse(searchResponse)));

    renderApp();
    await screen.findByText("Origin thread");
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const field = await screen.findByLabelText("Search commands and mail");

    fireEvent.change(field, { target: { value: "invoice" } });
    expect(
      await screen.findByText("Invoice March", { selector: ".command-palette-hit-subject" }),
    ).toBeDefined();
    const seeAll = await screen.findByRole("option", { name: /See all results/ });

    fireEvent.click(seeAll);

    // The Palette's gone; the list pane it was floating over is already the
    // real results view underneath (search-ux-spec.md §The surface).
    await waitFor(() => expect(screen.queryByLabelText("Search commands and mail")).toBeNull());
    expect(document.querySelector(".search-chip-row")).not.toBeNull();
  });

  it("typing never swaps the list pane behind the Palette (#100)", async () => {
    await seedOneThread();
    const searchResponse: SearchResponse = {
      results: [
        {
          thread: makeThread("t-invoice", "acct-1", { subject: "Invoice March" }),
          matchedMessageId: "t-invoice-msg",
          headline: null,
          folder: { id: "f1", name: "Inbox", role: "inbox" },
          gatekeeper: null,
        },
      ],
      cursor: null,
      indexWatermark: { coveredSince: null, complete: true },
    };
    stubFetch(() => Promise.resolve(jsonResponse(searchResponse)));

    renderApp();
    await screen.findByText("Origin thread");
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const field = await screen.findByLabelText("Search commands and mail");

    fireEvent.change(field, { target: { value: "invoice" } });
    await screen.findByText("Invoice March", { selector: ".command-palette-hit-subject" });

    // Still typing, hits showing inline — the results view (and its
    // search-only chip row) must never have appeared behind the Palette.
    expect(document.querySelector(".search-chip-row")).toBeNull();

    // Closing the Palette without "See all results" leaves the origin
    // exactly as it was.
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByLabelText("Search commands and mail")).toBeNull());
    expect(document.querySelector(".search-chip-row")).toBeNull();
    expect(screen.getAllByText("Origin thread").length).toBeGreaterThan(0);
  });

  it("Enter opens the top hit in the reading pane without opening the results view (#100)", async () => {
    await seedOneThread();
    const searchResponse: SearchResponse = {
      results: [
        {
          thread: makeThread("t-invoice", "acct-1", { subject: "Invoice March" }),
          matchedMessageId: "t-invoice-msg",
          headline: null,
          folder: { id: "f1", name: "Inbox", role: "inbox" },
          gatekeeper: null,
        },
      ],
      cursor: null,
      indexWatermark: { coveredSince: null, complete: true },
    };
    stubFetch(() => Promise.resolve(jsonResponse(searchResponse)));

    renderApp();
    await screen.findByText("Origin thread");
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const field = await screen.findByLabelText<HTMLInputElement>("Search commands and mail");

    fireEvent.change(field, { target: { value: "invoice" } });
    await screen.findByText("Invoice March", { selector: ".command-palette-hit-subject" });

    // Nothing in the Client's own command set matches "invoice", so the top
    // hit is already `activeIndex`'s default 0 — Enter opens it directly.
    fireEvent.keyDown(field, { key: "Enter" });

    await waitFor(() => expect(screen.queryByLabelText("Search commands and mail")).toBeNull());
    // The results view never opened…
    expect(document.querySelector(".search-chip-row")).toBeNull();
    // …but the hit is open in the reading pane, and the origin list is
    // still what it was (still showing "Origin thread").
    expect(
      await screen.findByText("Invoice March", { selector: ".reading-subject" }),
    ).toBeDefined();
    expect(screen.getByText("Origin thread")).toBeDefined();
  });

  it("Escape clears Palette text first, then leaves and closes it on the next Escape", async () => {
    await seedOneThread();
    stubFetch();

    renderApp();
    await screen.findByText("Origin thread");
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const field = await screen.findByLabelText<HTMLInputElement>("Search commands and mail");
    fireEvent.change(field, { target: { value: "inv" } });
    expect(field.value).toBe("inv");

    fireEvent.keyDown(field, { key: "Escape" });
    expect(field.value).toBe("");

    fireEvent.keyDown(field, { key: "Escape" });
    await waitFor(() => expect(screen.queryByLabelText("Search commands and mail")).toBeNull());
  });

  it("? opens the Shortcut Sheet, listing bound and unbound commands by section", async () => {
    await seedOneThread();
    stubFetch();

    renderApp();
    await screen.findByText("Origin thread");

    fireEvent.keyDown(window, { key: "?" });

    const sheet = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    expect(within(sheet).getByText("Compose", { selector: "dt" })).toBeDefined();
    expect(within(sheet).getAllByText("Command Palette only").length).toBeGreaterThan(0);
  });

  it("opens from the Hub's own search pill and from `/`, from outside `/mail` too (#147)", async () => {
    await seedOneThread();
    stubFetch();

    renderApp();
    await screen.findByText("Origin thread");

    // The Hub pill, reachable from any App.
    fireEvent.click(screen.getByRole("button", { name: /Search everything/ }));
    expect(await screen.findByLabelText("Search commands and mail")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByLabelText("Search commands and mail")).toBeNull());

    // `/` opens the Palette directly — there is no Mail field left to focus.
    fireEvent.keyDown(window, { key: "/" });
    expect(await screen.findByLabelText("Search commands and mail")).toBeDefined();
  });
});

describe("Notes in the Command Palette (#196)", () => {
  it("shows a matching Note as a local hit, ranked beneath Commands and Mail", async () => {
    await seedOneThread();
    // Named to match the same query as the seeded mail hit below — proof
    // the Notes group renders as a genuine third group under one query,
    // not merely "the only thing showing" for a query nothing else matches.
    await seedNotes({ document: [paragraph("Invoice notes")] });
    const searchResponse: SearchResponse = {
      results: [
        {
          thread: makeThread("t-invoice", "acct-1", { subject: "Invoice March" }),
          matchedMessageId: "t-invoice-msg",
          headline: null,
          folder: { id: "f1", name: "Inbox", role: "inbox" },
          gatekeeper: null,
        },
      ],
      cursor: null,
      indexWatermark: { coveredSince: null, complete: true },
    };
    stubFetch(() => Promise.resolve(jsonResponse(searchResponse)));

    renderApp();
    await screen.findByText("Origin thread");
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const field = await screen.findByLabelText("Search commands and mail");

    fireEvent.change(field, { target: { value: "invoice" } });

    const mailHit = await screen.findByText("Invoice March", {
      selector: ".command-palette-hit-subject",
    });
    const noteHit = await screen.findByText("Invoice notes", {
      selector: ".command-palette-hit-subject",
    });
    // `compareDocumentPosition`'s `DOCUMENT_POSITION_FOLLOWING` bit (4) is
    // set when the second node comes after the first — the ticket's own
    // "ranked beneath commands and mail hits", checked as DOM order rather
    // than assuming the Groups' render order never drifts from it.
    expect(
      mailHit.compareDocumentPosition(noteHit) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("shows the grid's own 'Untitled Note' fallback for a Note with no title text", async () => {
    await seedOneThread();
    // The first block carries no text (so the derived title falls back),
    // but the second still matches — proof the fallback is a *display*
    // rule, not a stand-in for "this Note has nothing to search on".
    await seedNotes({ document: [paragraph("", "b1"), paragraph("Untitled but findable", "b2")] });
    stubFetch();

    renderApp();
    await screen.findByText("Origin thread");
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const field = await screen.findByLabelText("Search commands and mail");

    fireEvent.change(field, { target: { value: "findable" } });

    expect(
      await screen.findByText("Untitled Note", { selector: ".command-palette-hit-subject" }),
    ).toBeDefined();
  });

  it("matches a Note's flattened text from any block, not only the first", async () => {
    await seedOneThread();
    await seedNotes({
      document: [paragraph("Grocery list", "b1"), paragraph("Buy oat milk", "b2")],
    });
    stubFetch();

    renderApp();
    await screen.findByText("Origin thread");
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const field = await screen.findByLabelText("Search commands and mail");

    fireEvent.change(field, { target: { value: "oat milk" } });

    // The title shown is still the derived (first-block) title — matching
    // reaches every block, but the hit's own display never does.
    expect(
      await screen.findByText("Grocery list", { selector: ".command-palette-hit-subject" }),
    ).toBeDefined();
  });

  it("selecting a Note hit navigates to it and closes the Palette", async () => {
    await seedOneThread();
    await seedNotes({ document: [paragraph("Grocery list")] });
    stubFetch();

    renderApp();
    await screen.findByText("Origin thread");
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const field = await screen.findByLabelText("Search commands and mail");
    fireEvent.change(field, { target: { value: "grocery" } });
    const noteHit = await screen.findByText("Grocery list", {
      selector: ".command-palette-hit-subject",
    });

    fireEvent.click(noteHit);

    await waitFor(() => expect(screen.queryByLabelText("Search commands and mail")).toBeNull());
    // Real navigation (`router/RootLayout.tsx`'s `onOpenLocalHit`, over the
    // full routed tree per this file's own doc comment) to `/notes/note-1`,
    // which opens the Note's dialog over the grid (#193) — the same proof
    // "Enter opens the top hit" above uses (an actually-open surface, not a
    // spied callback).
    expect(await screen.findByRole("dialog", { name: "Grocery list" })).toBeDefined();
  });
});
