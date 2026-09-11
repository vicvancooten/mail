import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Dexie from "dexie";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App.js";
import { resetUndoToastsForTest } from "../mail/undo-toast.js";
import { localCache, openLocalCache } from "../store/local-cache.js";
import {
  applyCalendarDelta,
  applyEventDelta,
  applyTaskDelta,
  applyTaskListDelta,
} from "../store/server-writes.js";
import { readTask } from "../store/tasks.js";
import { resetSyncStatus } from "../sync/sync-loop.js";
import {
  delta,
  eventDelta,
  makeCalendar,
  makeEvent,
  makeTask,
  makeTaskList,
} from "../test-support/mail-fixtures.js";
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
  resetUndoToastsForTest();
  // Sonner's own toast store lives outside React (`mail/MailSection.test.tsx`'s
  // own doc comment) — a toast this file raised but never dismissed would
  // otherwise bleed into the next test's own render.
  toast.dismiss();
  for (const nm of names.splice(0)) await Dexie.delete(nm);
});

/**
 * A fake `DataTransfer` (#261) — jsdom implements neither `DataTransfer` nor
 * native drag-and-drop, so every drag test here hand-rolls the one sliver
 * `TaskChip.tsx`'s/`CalendarDayCell.tsx`'s own native HTML5 drag actually
 * reads/writes — `tasks/TaskListView.test.tsx`'s own exact helper.
 */
function makeDataTransfer() {
  const store = new Map<string, string>();
  return {
    effectAllowed: "",
    dropEffect: "",
    setData: (type: string, value: string) => {
      store.set(type, value);
    },
    getData: (type: string) => store.get(type) ?? "",
    get types() {
      return [...store.keys()];
    },
  };
}

async function seedOneDueTask(overrides: Parameters<typeof makeTask>[3] = {}): Promise<void> {
  await applyTaskListDelta(
    delta({ created: [makeTaskList("list-1", USER, { name: "Errands" })] }),
    {
      replace: false,
    },
  );
  await applyTaskDelta(
    delta({
      created: [
        makeTask("t1", USER, "list-1", {
          title: "Renew passport",
          dueDate: "2026-09-08T00:00:00.000Z",
          ...overrides,
        }),
      ],
    }),
    { replace: false },
  );
}

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

describe("Due Tasks on the Calendar's grid (#260)", () => {
  it("renders a due Task's chip in the Week view's all-day row, due time as a prefix", async () => {
    await seedOneDueTask({ dueTime: "17:00" });
    stubFetch();

    render(<App />);

    const title = await screen.findByText("Renew passport");
    expect(title.closest(".calendar-all-day-cell")).not.toBeNull();
    expect(title.closest(".calendar-task-chip")?.textContent).toContain("5:00 PM");
  });

  it("ticking a Task chip's checkbox completes it and the chip leaves the grid", async () => {
    await seedOneDueTask();
    stubFetch();
    const user = userEvent.setup();

    render(<App />);
    await screen.findByText("Renew passport");

    await user.click(screen.getByLabelText('Mark "Renew passport" done'));

    await waitFor(() => expect(screen.queryByText("Renew passport")).toBeNull());
  });

  it("clicking a Task chip opens its popover with Due, Task List and Open in Tasks, and no body editing", async () => {
    await seedOneDueTask({ dueTime: "17:00" });
    stubFetch();
    const user = userEvent.setup();

    render(<App />);
    await user.click(await screen.findByText("Renew passport"));

    expect(await screen.findByText("Errands")).not.toBeNull();
    expect(screen.getByText("Due")).not.toBeNull();
    const popover = document.querySelector(".calendar-task-popover") as HTMLElement;
    expect(within(popover).queryByRole("textbox")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Open in Tasks" }));

    await waitFor(() => expect(location.pathname).toBe("/tasks/t1"));
  });

  it("the popover's own Due control changes the same date — drag is a shortcut, never the only path (#261)", async () => {
    await seedOneDueTask({ dueTime: "17:00" });
    stubFetch();
    const user = userEvent.setup();

    render(<App />);
    await user.click(await screen.findByText("Renew passport"));

    await user.click(await screen.findByRole("button", { name: "Due" }));
    await user.click(await screen.findByRole("menuitem", { name: "Tomorrow" }));

    await waitFor(async () =>
      expect((await readTask("t1"))?.dueDate).not.toBe("2026-09-08T00:00:00.000Z"),
    );
    // The time picked by drag/drop and the Due control's own presets is a
    // day, never a duration — `dueTime` is untouched by picking a date preset.
    expect((await readTask("t1"))?.dueTime).toBe("17:00");
  });

  it("hiding the Tasks row from the slide-over hides due Task chips from the grid", async () => {
    await seedOneDueTask();
    stubFetch();
    const user = userEvent.setup();

    render(<App />);
    await screen.findByText("Renew passport");

    await user.click(screen.getByRole("button", { name: "Show Calendars" }));
    const checkbox = await screen.findByLabelText("Tasks");
    expect((checkbox as HTMLInputElement).checked).toBe(true);

    await user.click(checkbox);

    await waitFor(() => expect(screen.queryByText("Renew passport")).toBeNull());
  });
});

describe("Due Tasks — overdue styling and Year view (#260)", () => {
  // Pinned "today" so overdue-ness (a zone-less day compare, `task-due.ts#isOverdue`)
  // doesn't depend on the real calendar date this test happens to run on.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-08T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("an overdue Task stays on its own due day, styled overdue, not rolled onto today", async () => {
    await seedOneDueTask({ dueDate: "2026-09-01T00:00:00.000Z" });
    stubFetch();
    history.replaceState(null, "", "/calendar?view=day&date=2026-09-01");

    render(<App />);

    const title = await screen.findByText("Renew passport");
    expect(title.closest(".calendar-task-chip")?.className).toContain("calendar-task-chip-overdue");
  });

  it("Year view shows no Task chips at all", async () => {
    await seedOneDueTask();
    stubFetch();
    history.replaceState(null, "", "/calendar?view=year&date=2026-09-08");

    render(<App />);

    await screen.findByText("2026");
    expect(screen.queryByText("Renew passport")).toBeNull();
  });

  it("renders a due Task's chip in the Month view's day cell", async () => {
    await seedOneDueTask();
    stubFetch();
    history.replaceState(null, "", "/calendar?view=month&date=2026-09-08");

    render(<App />);

    expect(await screen.findByText("Renew passport")).not.toBeNull();
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

describe("Rescheduling a Task from the Calendar (#261)", () => {
  it("dragging a Task chip to another day changes its due date and keeps its due time, offering an Undo", async () => {
    await seedOneDueTask({ dueTime: "17:00" });
    stubFetch();

    render(<App />);
    const chip = (await screen.findByText("Renew passport")).closest(
      ".calendar-task-chip",
    ) as HTMLElement;
    const sourceCell = chip.closest(".calendar-all-day-cell") as HTMLElement;
    const targetCell = [...document.querySelectorAll(".calendar-all-day-cell")].find(
      (cell) => cell !== sourceCell,
    ) as HTMLElement;

    const dataTransfer = makeDataTransfer();
    fireEvent.dragStart(chip, { dataTransfer });
    fireEvent.dragOver(targetCell, { dataTransfer });
    fireEvent.drop(targetCell, { dataTransfer });

    await waitFor(() => expect(within(sourceCell).queryByText("Renew passport")).toBeNull());
    expect(within(targetCell).getByText("Renew passport")).not.toBeNull();

    const rescheduled = await readTask("t1");
    expect(rescheduled?.dueDate).not.toBe("2026-09-08T00:00:00.000Z");
    expect(rescheduled?.dueTime).toBe("17:00");

    expect(await screen.findByText("Task rescheduled")).not.toBeNull();
  });

  it("Undo restores the Task's previous due date", async () => {
    await seedOneDueTask({ dueTime: "17:00" });
    stubFetch();

    render(<App />);
    const chip = (await screen.findByText("Renew passport")).closest(
      ".calendar-task-chip",
    ) as HTMLElement;
    const sourceCell = chip.closest(".calendar-all-day-cell") as HTMLElement;
    const targetCell = [...document.querySelectorAll(".calendar-all-day-cell")].find(
      (cell) => cell !== sourceCell,
    ) as HTMLElement;

    const dataTransfer = makeDataTransfer();
    fireEvent.dragStart(chip, { dataTransfer });
    fireEvent.dragOver(targetCell, { dataTransfer });
    fireEvent.drop(targetCell, { dataTransfer });

    // Let the drop's own (fire-and-forget) write settle before racing it with
    // Undo's own reverse write — clicking Undo the instant the toast appears,
    // before `rescheduleTaskTo`'s forward `setTaskDueDate` call has resolved,
    // left that call's promise chain still running once this test's own
    // `afterEach` closed the local cache, throwing an unhandled
    // `DatabaseClosedError` (harmless to the assertion below, since Dexie
    // serializes same-table transactions in call order, but a real
    // unhandled rejection vitest rightly flags).
    await waitFor(() => expect(within(sourceCell).queryByText("Renew passport")).toBeNull());

    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));

    await waitFor(async () =>
      expect((await readTask("t1"))?.dueDate).toBe("2026-09-08T00:00:00.000Z"),
    );
  });

  it("dragging a Task chip onto the timed grid is refused and changes nothing", async () => {
    await seedOneDueTask({ dueTime: "17:00" });
    stubFetch();

    render(<App />);
    const chip = (await screen.findByText("Renew passport")).closest(
      ".calendar-task-chip",
    ) as HTMLElement;
    const timedColumn = document.querySelector(".calendar-time-grid-column") as HTMLElement;

    const dataTransfer = makeDataTransfer();
    fireEvent.dragStart(chip, { dataTransfer });
    fireEvent.dragOver(timedColumn, { dataTransfer });
    fireEvent.drop(timedColumn, { dataTransfer });

    const task = await readTask("t1");
    expect(task?.dueDate).toBe("2026-09-08T00:00:00.000Z");
  });

  it("a reschedule from a second Client moves the chip without a reload (#261: round-trips to a second Client)", async () => {
    await seedOneDueTask({ dueTime: "17:00" });
    stubFetch();

    render(<App />);
    const chip = (await screen.findByText("Renew passport")).closest(
      ".calendar-task-chip",
    ) as HTMLElement;
    const sourceCell = chip.closest(".calendar-all-day-cell") as HTMLElement;

    // The reverse of what a drag/drop does locally: a second Client's own
    // reschedule arrives as an ordinary delta, the same path #252's own
    // "a Task created from a second Client appears without a reload" test
    // exercises for creation (`tasks/TaskListView.test.tsx`) — this is that
    // same mechanism's due-date-patch case, and the Calendar grid's own half
    // of "round-trips to a second Client" (#261's own acceptance line).
    await applyTaskDelta(
      delta({
        updated: [
          makeTask("t1", USER, "list-1", {
            title: "Renew passport",
            dueDate: "2026-09-09T00:00:00.000Z",
            dueTime: "17:00",
          }),
        ],
      }),
      { replace: false },
    );

    await waitFor(() => expect(within(sourceCell).queryByText("Renew passport")).toBeNull());
    expect(screen.getByText("Renew passport")).not.toBeNull();
  });

  it("the create popover offers an Event/Task switch, always opening on Event", async () => {
    await seedOneCalendarAndEvent();
    stubFetch();

    render(<App />);
    await screen.findByText("Team Standup");

    fireEvent.click(document.querySelector(".calendar-all-day-cell") as HTMLElement);

    expect(await screen.findByText("New event")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Event" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Task" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("switching to Task collapses the popover to Title, Due and Task List, prefilled with the clicked day and no time from the all-day row", async () => {
    await seedOneCalendarAndEvent();
    stubFetch();
    const user = userEvent.setup();

    render(<App />);
    await screen.findByText("Team Standup");

    fireEvent.click(document.querySelector(".calendar-all-day-cell") as HTMLElement);
    await user.click(await screen.findByRole("button", { name: "Task" }));

    expect(await screen.findByText("New Task")).not.toBeNull();
    expect(screen.queryByLabelText(/All day/)).toBeNull();
    expect(screen.queryByRole("button", { name: "More details" })).toBeNull();
    expect((screen.getByLabelText("Due date") as HTMLInputElement).value).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
    expect((screen.getByLabelText("Due time") as HTMLInputElement).value).toBe("");
  });

  it("clicking the timed grid to create a Task prefills Due with the clicked time too", async () => {
    await seedOneCalendarAndEvent();
    stubFetch();
    const user = userEvent.setup();

    render(<App />);
    await screen.findByText("Team Standup");

    const [hourButton] = screen.getAllByRole("button", { name: /^Create event at/ });
    fireEvent.click(hourButton as HTMLElement);
    await user.click(await screen.findByRole("button", { name: "Task" }));

    expect((screen.getByLabelText("Due date") as HTMLInputElement).value).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
    expect((screen.getByLabelText("Due time") as HTMLInputElement).value).toMatch(/^\d{2}:\d{2}$/);
  });

  it("creating from the popover as a Task fires the ordinary create intent, and the Task appears at once in the grid", async () => {
    await seedOneCalendarAndEvent();
    await applyTaskListDelta(
      delta({ created: [makeTaskList("list-1", USER, { name: "Errands" })] }),
      { replace: false },
    );
    stubFetch();
    const user = userEvent.setup();

    render(<App />);
    await screen.findByText("Team Standup");

    fireEvent.click(document.querySelector(".calendar-all-day-cell") as HTMLElement);
    await user.click(await screen.findByRole("button", { name: "Task" }));
    await user.type(screen.getByPlaceholderText("Title"), "Buy milk");
    await user.click(screen.getByRole("button", { name: "Save" }));

    const chipTitle = await screen.findByText("Buy milk");
    await user.click(chipTitle);
    expect(await screen.findByText("Errands")).not.toBeNull();
  });
});
