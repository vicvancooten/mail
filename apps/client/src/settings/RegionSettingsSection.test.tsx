import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localCache, openLocalCache } from "../store/local-cache.js";
import { setSessionUserId } from "../store/session.js";
import { RegionSettingsSection } from "./RegionSettingsSection.js";

const USER = "user-1";

const enqueueUserMutation = vi.fn();
vi.mock("../store/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../store/index.js")>();
  return {
    ...actual,
    enqueueUserMutation: (...args: unknown[]) => enqueueUserMutation(...args),
  };
});

let counter = 0;
const names: string[] = [];

beforeEach(async () => {
  const name = `region-settings-test-${counter++}`;
  names.push(name);
  await openLocalCache({ name, schemaVersion: 1 });
  setSessionUserId(USER);
  enqueueUserMutation.mockReset();
  await localCache().preferences.put({
    id: USER,
    autoAdvanceEnabled: true,
    autoAdvanceDirection: "older",
    undoSendDelaySeconds: 10,
    homeTimeZone: "Europe/Amsterdam",
    regionLocale: "en-US",
    clockFormat: "auto",
    firstDayOfWeek: "monday",
    defaultCalendarView: "week",
    contactsSortOrder: "given",
    answerNotificationsEnabled: true,
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
});

afterEach(() => {
  cleanup();
  localCache().close();
  setSessionUserId(null);
  return Promise.all(names.splice(0).map((nm) => Dexie.delete(nm))).then(() => undefined);
});

/**
 * `RegionSettingsSection.tsx` (#303): each control writes its own absolute
 * `Preference` set — the same field-by-field coverage `GeneralSection`'s own
 * (unwritten) test would give its controls.
 */
describe("RegionSettingsSection (#303)", () => {
  it("changes the clock format", async () => {
    const user = userEvent.setup();
    render(<RegionSettingsSection />);

    await user.click(await screen.findByRole("combobox", { name: "Clock" }));
    await user.click(await screen.findByRole("option", { name: "24-hour" }));

    expect(enqueueUserMutation).toHaveBeenCalledWith({ type: "setClockFormat", clockFormat: "24" });
  });

  it("changes first day of the week", async () => {
    const user = userEvent.setup();
    render(<RegionSettingsSection />);

    await user.click(await screen.findByRole("combobox", { name: "First day of the week" }));
    await user.click(await screen.findByRole("option", { name: "Sunday" }));

    expect(enqueueUserMutation).toHaveBeenCalledWith({
      type: "setFirstDayOfWeek",
      firstDayOfWeek: "sunday",
    });
  });

  it("changes the Calendar's default view", async () => {
    const user = userEvent.setup();
    render(<RegionSettingsSection />);

    await user.click(await screen.findByRole("combobox", { name: "Calendar's default view" }));
    await user.click(await screen.findByRole("option", { name: "Month" }));

    expect(enqueueUserMutation).toHaveBeenCalledWith({
      type: "setDefaultCalendarView",
      defaultCalendarView: "month",
    });
  });

  it("still offers Home Time Zone, moved here from General (#303)", async () => {
    const user = userEvent.setup();
    render(<RegionSettingsSection />);

    const select = await screen.findByRole("combobox", { name: "Home Time Zone" });
    expect(select.textContent).toContain("Europe/Amsterdam");

    await user.click(select);
    await user.click(await screen.findByRole("option", { name: "America/New_York" }));

    expect(enqueueUserMutation).toHaveBeenCalledWith({
      type: "setHomeTimeZone",
      homeTimeZone: "America/New_York",
    });
  });
});
