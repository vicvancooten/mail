import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App.js";
import { localCache, openLocalCache } from "../store/local-cache.js";
import { applyCalendarDelta, applyEventDelta } from "../store/server-writes.js";
import { resetSyncStatus } from "../sync/sync-loop.js";
import { delta, eventDelta, makeCalendar, makeEvent } from "../test-support/mail-fixtures.js";
import { jsonResponse } from "../test-support/mock-fetch.js";

/**
 * The Calendar App's grid, over the real router (#231) — the same "whole
 * tree, not the component in isolation" shape `app-shell-integration.test.tsx`
 * already established for Mail/Settings/the placeholder Apps, needed here
 * because `CalendarRoute` reads `view`/`date` off `calendarRoute.useSearch()`
 * rather than component state.
 */

const USER = "u1";

let counter = 0;
const names: string[] = [];

function stubFetch(onEventRange?: (url: string) => unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/auth/status") return Promise.resolve(jsonResponse({ claimed: true }));
      if (url === "/auth/session") {
        return Promise.resolve(
          jsonResponse({
            user: {
              id: USER,
              username: "vic",
              role: "owner",
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          }),
        );
      }
      if (url === "/push/config") return Promise.resolve(jsonResponse({ vapidPublicKey: null }));
      if (url === "/sync") return new Promise<Response>(() => {});
      if (url === "/mail-accounts") return Promise.resolve(jsonResponse({ mailAccounts: [] }));
      if (url.startsWith("/calendars/events?")) {
        if (onEventRange) return Promise.resolve(jsonResponse(onEventRange(url)));
        return Promise.resolve(
          jsonResponse({
            events: [],
            windowStart: "2026-03-01T00:00:00.000Z",
            windowEnd: "2027-06-01T00:00:00.000Z",
          }),
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }),
  );
}

beforeEach(async () => {
  resetSyncStatus();
  const name = `calendar-route-test-${counter++}`;
  names.push(name);
  await openLocalCache({ name, schemaVersion: 1 });
  localStorage.clear();
  history.replaceState(null, "", "/calendar?view=week&date=2026-09-08");
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  localCache().close();
  for (const nm of names.splice(0)) await Dexie.delete(nm);
});

async function seedOneCalendarAndEvent(): Promise<void> {
  await applyCalendarDelta(
    delta({
      created: [makeCalendar("cal-personal", USER, { name: "Personal", color: "#4285F4" })],
    }),
    { replace: false },
  );
  await applyEventDelta(
    eventDelta({
      created: [
        makeEvent("e1", "cal-personal", {
          title: "Team Standup",
          start: "2026-09-08T09:00:00.000Z",
          end: "2026-09-08T09:30:00.000Z",
        }),
      ],
    }),
    { replace: false },
  );
}

describe("CalendarRoute (#231)", () => {
  it("renders a synced Occurrence on the Week view the URL names", async () => {
    await seedOneCalendarAndEvent();
    stubFetch();

    render(<App />);

    expect(await screen.findByText("Team Standup")).toBeDefined();
    expect(location.pathname).toBe("/calendar");
  });

  it("switching to Month view keeps the Occurrence visible and updates the URL", async () => {
    await seedOneCalendarAndEvent();
    stubFetch();
    const user = userEvent.setup();

    render(<App />);
    await screen.findByText("Team Standup");

    await user.click(screen.getByRole("button", { name: "Month" }));

    await waitFor(() => expect(location.search).toContain("view=month"));
    expect(await screen.findByText("Team Standup")).toBeDefined();
  });

  it("right-clicking a day cell offers a jump to Day view for that date", async () => {
    await seedOneCalendarAndEvent();
    stubFetch();

    render(<App />);
    await screen.findByText("Team Standup");

    const chip = await screen.findByText("Team Standup");
    const column = chip.closest(".calendar-time-grid-column");
    expect(column).not.toBeNull();
    fireEvent.contextMenu(column as Element);

    const jump = await screen.findByRole("menuitem", { name: /Go to/ });
    fireEvent.click(jump);

    await waitFor(() => expect(location.search).toContain("view=day"));
    await waitFor(() => expect(location.search).toContain("date=2026-09-08"));
  });

  it("hiding a Calendar from the slide-over hides its Occurrences from the grid", async () => {
    await seedOneCalendarAndEvent();
    stubFetch();
    const user = userEvent.setup();

    render(<App />);
    await screen.findByText("Team Standup");

    await user.click(screen.getByRole("button", { name: "Show Calendars" }));
    const checkbox = await screen.findByLabelText("Personal");
    expect((checkbox as HTMLInputElement).checked).toBe(true);

    await user.click(checkbox);

    await waitFor(() => expect(screen.queryByText("Team Standup")).toBeNull());
  });

  it("opens a Calendar's settings sheet from the slide-over (#236)", async () => {
    await seedOneCalendarAndEvent();
    stubFetch();
    const user = userEvent.setup();

    render(<App />);
    await screen.findByText("Team Standup");

    await user.click(screen.getByRole("button", { name: "Show Calendars" }));
    await user.click(await screen.findByRole("button", { name: "Personal settings" }));

    expect(await screen.findByText("Everything you can say about this Calendar.")).not.toBeNull();
  });
});

describe("CalendarRoute outside the Event Window (#232)", () => {
  // The "navigating back inside the window" case below clicks the Today
  // button, which resolves `today()` off the real wall clock
  // (`calendar-dates.ts`) — pinned here to the fixture's own "today"
  // (2026-09-08, the date `seedOneCalendarAndEvent`'s Occurrence and this
  // file's `beforeEach` URL both already assume) so the test stays true
  // regardless of the real calendar date it happens to run on. Fakes only
  // `Date` (not timers/`Promise` scheduling) — faking those too breaks
  // Dexie's transaction commit, which relies on real microtask ordering
  // (`PrematureCommitError`), and stalls `waitFor`/`findByText`'s polling.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-08T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fetches on demand and draws the window edge when the view navigates outside it", async () => {
    await seedOneCalendarAndEvent();
    stubFetch((url) => ({
      events: url.includes("start=2028")
        ? [
            makeEvent("e-far", "cal-personal", {
              title: "Future Off-site",
              start: "2028-09-08T09:00:00.000Z",
              end: "2028-09-08T10:00:00.000Z",
            }),
          ]
        : [],
      windowStart: "2026-03-01T00:00:00.000Z",
      windowEnd: "2027-06-01T00:00:00.000Z",
    }));
    history.replaceState(null, "", "/calendar?view=day&date=2028-09-08");

    render(<App />);

    expect(await screen.findByText("Future Off-site")).toBeDefined();
    expect(screen.getByRole("status").textContent).toContain("outside the synced range");
  });

  it("navigating back inside the window drops the banner and returns to cached rendering", async () => {
    await seedOneCalendarAndEvent();
    stubFetch();
    history.replaceState(null, "", "/calendar?view=day&date=2028-09-08");
    const user = userEvent.setup();

    render(<App />);
    await waitFor(() => expect(screen.getByRole("status")).toBeDefined());

    await user.click(screen.getByRole("button", { name: "Today" }));

    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(await screen.findByText("Team Standup")).toBeDefined();
  });
});
