import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localCache, openLocalCache } from "../store/local-cache.js";
import {
  applyMailAccountDelta,
  applyPreferenceDelta,
  applyThreadDelta,
} from "../store/server-writes.js";
import { delta, makeMailAccount, makeThread } from "../test-support/mail-fixtures.js";
import { NOOP_TRIAGE } from "./actions/types.js";
import { ThreadDetailPane } from "./ThreadDetailPane.js";

/**
 * A held Thread never appears in `MailSection`'s own row list — its
 * `!thread.heldSender` filter feeds `useThreadWindow`, which is what
 * `activeSelectedThread` reads from — so `MailSection.test.tsx`'s own render
 * seam has no route to open one in the Reader. This file mounts the Reader
 * pane directly instead (no `ActionsProvider` above it, the standalone
 * context path its own doc comment describes), the more precise render seam
 * for the Mail group overflow's own gating rule (#289).
 */

const names: string[] = [];
let counter = 0;

beforeEach(async () => {
  const name = `thread-detail-pane-test-${counter++}`;
  names.push(name);
  await openLocalCache({ name, schemaVersion: 1 });
});

afterEach(async () => {
  cleanup();
  localCache().close();
  for (const name of names.splice(0)) await Dexie.delete(name);
});

describe("Approve in the Mail group's overflow (#289)", () => {
  it("is absent for an ordinary Inbox Thread", async () => {
    await applyMailAccountDelta(delta({ created: [makeMailAccount("acct-1")] }), {
      replace: false,
    });
    const wireThread = makeThread("t1", "acct-1", {
      subject: "Ordinary thread",
      heldSender: null,
    });
    await applyThreadDelta("acct-1", delta({ created: [wireThread] }), { replace: false });
    const thread = { ...wireThread, sortKey: "t1" };

    render(
      <ThreadDetailPane
        thread={thread}
        triage={NOOP_TRIAGE}
        onReply={vi.fn()}
        onMailtoLink={vi.fn()}
        onOpenTask={vi.fn()}
      />,
    );

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /More actions for "Ordinary/ }));
    expect(screen.queryByRole("menuitem", { name: "Approve" })).toBeNull();
  });

  it("shows up once the Thread is under Screening Hold", async () => {
    await applyMailAccountDelta(delta({ created: [makeMailAccount("acct-1")] }), {
      replace: false,
    });
    const wireThread = makeThread("t1", "acct-1", {
      subject: "Held thread",
      heldSender: "stranger@example.test",
    });
    await applyThreadDelta("acct-1", delta({ created: [wireThread] }), { replace: false });
    const thread = { ...wireThread, sortKey: "t1" };

    render(
      <ThreadDetailPane
        thread={thread}
        triage={NOOP_TRIAGE}
        onReply={vi.fn()}
        onMailtoLink={vi.fn()}
        onOpenTask={vi.fn()}
      />,
    );

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /More actions for "Held/ }));
    expect(await screen.findByRole("menuitem", { name: "Approve" })).toBeDefined();
  });
});

describe("Region Settings on the Reader (#304)", () => {
  it("drops AM/PM from the reading-time line once the clock is forced to 24-hour", async () => {
    await applyMailAccountDelta(delta({ created: [makeMailAccount("acct-1")] }), {
      replace: false,
    });
    await applyPreferenceDelta(
      delta({
        created: [
          {
            id: "u1",
            autoAdvanceEnabled: true,
            autoAdvanceDirection: "older",
            undoSendDelaySeconds: 10,
            homeTimeZone: "UTC",
            regionLocale: "en-US",
            clockFormat: "24",
            firstDayOfWeek: "monday",
            defaultCalendarView: "week",
            contactsSortOrder: "given",
            answerNotificationsEnabled: true,
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
      { replace: false },
    );
    // 2:30 PM UTC reads "2:30 PM" with the default `"auto"` clock, "14:30"
    // once Region Settings forces 24-hour.
    const wireThread = makeThread("t1", "acct-1", {
      subject: "Afternoon thread",
      lastMessageAt: "2026-06-01T14:30:00.000Z",
    });
    await applyThreadDelta("acct-1", delta({ created: [wireThread] }), { replace: false });
    const thread = { ...wireThread, sortKey: "t1" };

    render(
      <ThreadDetailPane
        thread={thread}
        triage={NOOP_TRIAGE}
        onReply={vi.fn()}
        onMailtoLink={vi.fn()}
        onOpenTask={vi.fn()}
      />,
    );

    await screen.findByText("Afternoon thread");
    // `usePreference()`'s own live query resolves a tick after the first
    // render (`CalendarRoute.tsx`'s own doc comment on this) — `findByText`
    // polls until the Region Settings-driven re-render lands.
    await screen.findByText(/14:30/);
    expect(document.querySelector(".reading-time")?.textContent).not.toMatch(/AM|PM/);
  });
});
