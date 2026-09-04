import { labelId } from "@mail/shared";
import { describe, expect, it, vi } from "vitest";
import type { CachedThread } from "../../store/index.js";
import { ACTIONS, globalActions, menuActions, surfaceActions } from "./registry.js";
import { actionLabel, noopActionContext, withGroup, withThread } from "./types.js";

function makeThread(overrides: Partial<CachedThread> = {}): CachedThread {
  return {
    id: "t1",
    mailAccountId: "acct-1",
    subject: "Quarterly numbers",
    participants: [{ name: "Ada Lovelace", address: "ada@example.test" }],
    snippet: "See attached",
    lastMessageId: null,
    firstMessageAt: "2026-06-25T09:00:00.000Z",
    lastMessageAt: "2026-06-25T09:00:00.000Z",
    messageCount: 1,
    unreadCount: 0,
    starred: false,
    hasAttachments: false,
    inInbox: true,
    folderRole: "inbox",
    hasSentMessage: false,
    pinned: false,
    labelIds: [],
    heldSender: null,
    heldRecipientAlias: null,
    snoozeUntil: null,
    updatedAt: "2026-06-25T09:00:00.000Z",
    sortKey: "2026-06-25T09:00:00.000Z|t1",
    ...overrides,
  };
}

/**
 * The registry is the one list every surface reads (#94), so what's worth
 * asserting here is the shape of that list — no two entries fighting over a
 * key, availability actually gating, and the two pickers offering the same
 * choices a menu would render.
 */
describe("the Action registry", () => {
  it("binds each key/modifier combination exactly once", () => {
    const seen = new Map<string, string>();
    for (const action of ACTIONS) {
      if (!action.binding) continue;
      for (const key of action.binding.keys) {
        const combo = `${action.binding.meta ? "meta+" : ""}${key}`;
        // The Screener's own modal scheme (`a`/`d`/`b`) is contextual, so it
        // is never bound by the global listener and can't collide with
        // reply-all's `a` (`ActionsProvider`'s own `contextual` skip).
        const scope = action.contextual ? "contextual" : "global";
        const previous = seen.get(`${scope}:${combo}`);
        expect(previous, `${combo} is bound by both ${previous} and ${action.id}`).toBeUndefined();
        seen.set(`${scope}:${combo}`, action.id);
      }
    }
  });

  it("keeps contextual actions out of the Palette and the Shortcut Sheet", () => {
    const ids = globalActions().map((action) => action.id);
    expect(ids).toContain("done");
    expect(ids).not.toContain("group-done");
    expect(ids).not.toContain("screener-approve");
    expect(ids).not.toContain("draft-open");
  });

  it("reports every Thread action unavailable, with a reason, when nothing is selected", () => {
    const ctx = noopActionContext();
    for (const id of ["done", "trash", "star", "pin", "snooze", "label", "toggle-read"]) {
      const action = ACTIONS.find((candidate) => candidate.id === id);
      const availability = action?.availability(ctx);
      expect(availability?.available, id).toBe(false);
      if (availability && !availability.available) expect(availability.reason).toBeTruthy();
    }
  });

  it("never lists an unavailable action in a menu", () => {
    const ids = menuActions(noopActionContext()).map((action) => action.id);
    expect(ids).toEqual([]);
  });

  it("lists the Thread's own menu actions once a Thread is in hand", () => {
    const ctx = withThread(noopActionContext(), makeThread());
    const ids = menuActions(ctx).map((action) => action.id);
    expect(ids).toContain("done");
    expect(ids).toContain("snooze");
    expect(ids).toContain("label");
    expect(ids).toContain("trash");
    // No Message loaded for a row nobody has opened, so replying is out.
    expect(ids).not.toContain("reply");
  });

  it("flips its own label with the state it toggles", () => {
    const starred = withThread(noopActionContext(), makeThread({ starred: true }));
    const star = ACTIONS.find((action) => action.id === "star");
    expect(star && actionLabel(star, starred)).toBe("Unstar");
    const unread = withThread(noopActionContext(), makeThread({ unreadCount: 2 }));
    const read = ACTIONS.find((action) => action.id === "toggle-read");
    expect(read && actionLabel(read, unread)).toBe("Mark as read");
  });

  it("offers Snooze's presets as menu choices, each committing an ISO instant", () => {
    const snooze = vi.fn();
    const ctx = withThread(
      noopActionContext({ triage: { ...noopActionContext().triage, snooze } }),
      makeThread(),
    );
    const action = ACTIONS.find((candidate) => candidate.id === "snooze");
    const choices = action?.choices?.(ctx) ?? [];
    expect(choices.length).toBeGreaterThan(0);
    choices[0]?.run();
    expect(snooze).toHaveBeenCalledTimes(1);
    const [threadId, until] = snooze.mock.calls[0] as [string, string];
    expect(threadId).toBe("t1");
    expect(new Date(until).toISOString()).toBe(until);
  });

  it("offers Label's choices as toggles, applying an unapplied one and removing an applied one", () => {
    const applyLabel = vi.fn();
    const removeLabel = vi.fn();
    const workId = labelId("acct-1", "Work");
    const base = noopActionContext();
    const ctx = withThread(
      noopActionContext({
        triage: { ...base.triage, applyLabel, removeLabel },
        labels: [
          {
            id: workId,
            mailAccountId: "acct-1",
            name: "Work",
            updatedAt: "2026-06-25T09:00:00.000Z",
          },
        ],
      }),
      makeThread({ labelIds: [workId] }),
    );
    const action = ACTIONS.find((candidate) => candidate.id === "label");
    const choices = action?.choices?.(ctx) ?? [];
    expect(choices.map((choice) => choice.label)).toEqual(["Work"]);
    expect(choices[0]?.checked).toBe(true);
    choices[0]?.run();
    expect(removeLabel).toHaveBeenCalledWith("t1", "Work");
    expect(applyLabel).not.toHaveBeenCalled();
  });

  it("hides a Time Group's bulk entries for a group that can't be cleared in one action", () => {
    const ctx = withGroup(noopActionContext(), {
      label: "Pinned",
      collapsed: false,
      onDoneAll: () => {},
      onMarkAllRead: () => {},
      onToggleCollapsed: () => {},
      bulkAvailable: false,
    });
    const ids = menuActions(ctx).map((action) => action.id);
    expect(ids).toContain("group-collapse");
    expect(ids).not.toContain("group-done");
    expect(ids).not.toContain("group-mark-read");
  });

  it("keeps Done out of the hover cluster the row renders — it has whitespace of its own", () => {
    const ctx = withThread(noopActionContext(), makeThread());
    const hover = surfaceActions(ctx, "row-hover").map((action) => action.id);
    expect(hover).toContain("done");
    expect(hover).toContain("snooze");
    expect(hover).toContain("pin");
    expect(hover).not.toContain("trash");
  });
});
