import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localCache, openLocalCache } from "../../store/local-cache.js";
import { applyCalendarDelta } from "../../store/server-writes.js";
import { setSessionUserId } from "../../store/session.js";
import { delta, makeCalendar } from "../../test-support/mail-fixtures.js";
import { CalendarMirrorChecklist } from "./CalendarMirrorChecklist.js";

const USER = "user-1";
const CONNECTED_ACCOUNT_ID = "acct-1";

const fetchUnmirrorImpact = vi.fn();
const unmirrorCalendar = vi.fn();
const mirrorCalendar = vi.fn();

vi.mock("../../api/calendars.js", () => ({
  fetchUnmirrorImpact: (...args: unknown[]) => fetchUnmirrorImpact(...args),
  unmirrorCalendar: (...args: unknown[]) => unmirrorCalendar(...args),
  mirrorCalendar: (...args: unknown[]) => mirrorCalendar(...args),
}));

let counter = 0;
const names: string[] = [];

beforeEach(async () => {
  const name = `calendar-mirror-checklist-test-${counter++}`;
  names.push(name);
  await openLocalCache({ name, schemaVersion: 1 });
  setSessionUserId(USER);
  fetchUnmirrorImpact.mockReset();
  unmirrorCalendar.mockReset();
  mirrorCalendar.mockReset();
});

afterEach(async () => {
  cleanup();
  localCache().close();
  setSessionUserId(null);
  for (const nm of names.splice(0)) await Dexie.delete(nm);
});

function connectedAccountCalendar(
  id: string,
  overrides: Partial<Parameters<typeof makeCalendar>[2]> = {},
) {
  return makeCalendar(id, USER, {
    origin: { type: "connectedAccount", connectedAccountId: CONNECTED_ACCOUNT_ID },
    isDefault: false,
    ...overrides,
  });
}

describe("CalendarMirrorChecklist (#235)", () => {
  it("lists every discovered Calendar, mirrored and unmirrored alike", async () => {
    await applyCalendarDelta(
      delta({
        created: [
          connectedAccountCalendar("cal-work", { name: "Work", mirrored: true }),
          connectedAccountCalendar("cal-holidays", { name: "Holidays", mirrored: false }),
        ],
      }),
      { replace: false },
    );

    render(<CalendarMirrorChecklist connectedAccountId={CONNECTED_ACCOUNT_ID} />);

    const work = await screen.findByLabelText<HTMLInputElement>("Work");
    const holidays = await screen.findByLabelText<HTMLInputElement>("Holidays");
    expect(work.checked).toBe(true);
    expect(holidays.checked).toBe(false);
  });

  it("never lists a Calendar from a different Connected Account", async () => {
    await applyCalendarDelta(
      delta({
        created: [
          connectedAccountCalendar("cal-mine", { name: "Mine" }),
          makeCalendar("cal-other", USER, {
            name: "Someone else's",
            origin: { type: "connectedAccount", connectedAccountId: "acct-2" },
          }),
        ],
      }),
      { replace: false },
    );

    render(<CalendarMirrorChecklist connectedAccountId={CONNECTED_ACCOUNT_ID} />);

    await screen.findByLabelText("Mine");
    expect(screen.queryByLabelText("Someone else's")).toBeNull();
  });

  it("checking a box back on calls mirrorCalendar with no confirm dialog", async () => {
    await applyCalendarDelta(
      delta({
        created: [connectedAccountCalendar("cal-holidays", { name: "Holidays", mirrored: false })],
      }),
      { replace: false },
    );
    mirrorCalendar.mockResolvedValue({
      calendar: connectedAccountCalendar("cal-holidays", { mirrored: true }),
    });

    render(<CalendarMirrorChecklist connectedAccountId={CONNECTED_ACCOUNT_ID} />);
    const checkbox = await screen.findByLabelText("Holidays");
    await userEvent.click(checkbox);

    await waitFor(() => expect(mirrorCalendar).toHaveBeenCalledWith("cal-holidays"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("unchecking a box previews the discard count and confirms before unmirroring", async () => {
    await applyCalendarDelta(
      delta({ created: [connectedAccountCalendar("cal-work", { name: "Work", mirrored: true })] }),
      { replace: false },
    );
    fetchUnmirrorImpact.mockResolvedValue({ discarded: { events: 3 } });
    unmirrorCalendar.mockResolvedValue({
      calendar: connectedAccountCalendar("cal-work", { mirrored: false }),
      discarded: { events: 3 },
    });

    render(<CalendarMirrorChecklist connectedAccountId={CONNECTED_ACCOUNT_ID} />);
    const checkbox = await screen.findByLabelText("Work");
    await userEvent.click(checkbox);

    await waitFor(() => expect(fetchUnmirrorImpact).toHaveBeenCalledWith("cal-work"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/discards 3 synced events/i)).not.toBeNull();
    expect(unmirrorCalendar).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole("button", { name: /stop mirroring/i }));

    await waitFor(() => expect(unmirrorCalendar).toHaveBeenCalledWith("cal-work"));
  });

  it("cancelling the confirm dialog never calls unmirrorCalendar", async () => {
    await applyCalendarDelta(
      delta({ created: [connectedAccountCalendar("cal-work", { name: "Work", mirrored: true })] }),
      { replace: false },
    );
    fetchUnmirrorImpact.mockResolvedValue({ discarded: { events: 1 } });

    render(<CalendarMirrorChecklist connectedAccountId={CONNECTED_ACCOUNT_ID} />);
    const checkbox = await screen.findByLabelText("Work");
    await userEvent.click(checkbox);

    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: /cancel/i }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(unmirrorCalendar).not.toHaveBeenCalled();
  });
});
