import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localCache, openLocalCache } from "../store/local-cache.js";
import { setSessionUserId } from "../store/session.js";
import {
  makeCalendar,
  makeConnectedAccount,
  makeMailAccount,
} from "../test-support/mail-fixtures.js";
import { NotificationsPage } from "./NotificationsPage.js";

const USER = "user-1";

const enqueueMutation = vi.fn();
const enqueueUserMutation = vi.fn();
vi.mock("../store/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../store/index.js")>();
  return {
    ...actual,
    enqueueMutation: (...args: unknown[]) => enqueueMutation(...args),
    enqueueUserMutation: (...args: unknown[]) => enqueueUserMutation(...args),
  };
});

// `PushNotificationsSection` (unchanged, rendered last on this page) fetches
// its own config on mount — stubbed unconfigured so it renders nothing,
// `PushNotificationsSection.test.tsx`'s own mock shape.
vi.mock("../api/push.js", () => ({
  fetchPushConfig: vi.fn().mockResolvedValue({ vapidPublicKey: null }),
  registerPushSubscription: vi.fn().mockResolvedValue(undefined),
  unregisterPushSubscription: vi.fn().mockResolvedValue(undefined),
}));

let counter = 0;
const names: string[] = [];

beforeEach(async () => {
  const name = `notifications-page-test-${counter++}`;
  names.push(name);
  await openLocalCache({ name, schemaVersion: 1 });
  setSessionUserId(USER);
  enqueueMutation.mockReset();
  enqueueUserMutation.mockReset();
});

afterEach(() => {
  cleanup();
  localCache().close();
  setSessionUserId(null);
  return Promise.all(names.splice(0).map((nm) => Dexie.delete(nm))).then(() => undefined);
});

/**
 * `NotificationsPage.tsx` (#244, ADR-0028): "Mail Accounts first, then
 * Calendars grouped by Origin" — the acceptance line this test covers field
 * by field.
 */
describe("NotificationsPage (#244)", () => {
  it("lists Mail Accounts first, each with its own notificationsEnabled toggle", async () => {
    const user = userEvent.setup();
    await localCache().mailAccounts.put(
      makeMailAccount("acct-1", { emailAddress: "me@example.test", notificationsEnabled: true }),
    );

    render(<NotificationsPage />);

    const checkbox = await screen.findByRole<HTMLInputElement>("checkbox", {
      name: "me@example.test",
    });
    expect(checkbox.checked).toBe(true);

    await user.click(checkbox);
    expect(enqueueMutation).toHaveBeenCalledWith(
      { type: "setNotificationsEnabled", enabled: false },
      "acct-1",
    );
  });

  it("groups Calendars by Origin, Local and each Connected Account separately", async () => {
    const user = userEvent.setup();
    await localCache().connectedAccounts.put(
      makeConnectedAccount("acct-connected", { identity: "team@example.test" }),
    );
    await localCache().calendars.put(makeCalendar("cal-local", USER, { name: "Personal" }));
    await localCache().calendars.put(
      makeCalendar("cal-mirrored", USER, {
        name: "Work",
        origin: { type: "connectedAccount", connectedAccountId: "acct-connected" },
        remindersEnabled: false,
      }),
    );

    render(<NotificationsPage />);

    expect(await screen.findByText("Local")).not.toBeNull();
    expect(screen.getByText("team@example.test")).not.toBeNull();

    const workToggle = await screen.findByRole<HTMLInputElement>("checkbox", { name: "Work" });
    expect(workToggle.checked).toBe(false);

    await user.click(workToggle);
    expect(enqueueUserMutation).toHaveBeenCalledWith({
      type: "setCalendarRemindersEnabled",
      calendarId: "cal-mirrored",
      enabled: true,
    });
  });

  it("shows the Answers toggle beside Reminders (#243)", async () => {
    const user = userEvent.setup();
    await localCache().preferences.put({
      id: USER,
      autoAdvanceEnabled: true,
      autoAdvanceDirection: "older",
      undoSendDelaySeconds: 10,
      homeTimeZone: "",
      regionLocale: "",
      clockFormat: "auto",
      firstDayOfWeek: "monday",
      defaultCalendarView: "week",
      contactsSortOrder: "given",
      answerNotificationsEnabled: true,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    render(<NotificationsPage />);

    const toggle = await screen.findByRole<HTMLInputElement>("checkbox", {
      name: "Notify when an Attendee answers",
    });
    expect(toggle.checked).toBe(true);

    await user.click(toggle);
    expect(enqueueUserMutation).toHaveBeenCalledWith({
      type: "setAnswerNotificationsEnabled",
      enabled: false,
    });
  });
});
