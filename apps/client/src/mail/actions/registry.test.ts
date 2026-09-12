import { labelId } from "@mail/shared";
import { describe, expect, it, vi } from "vitest";
import type { CachedThread } from "../../store/index.js";
import {
  ACTIONS,
  globalActions,
  mailOverflowActions,
  menuActions,
  surfaceActions,
} from "./registry.js";
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
    gmailLabelIds: [],
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
    for (const id of [
      "done",
      "trash",
      "star",
      "pin",
      "snooze",
      "label",
      "toggle-read",
      "add-to-notes",
      "add-to-tasks",
    ]) {
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
    expect(ids).toContain("add-to-notes");
    expect(ids).toContain("add-to-tasks");
    // #144: Spam, Approve and Block are reachable from any Inbox Thread's
    // own row menu, not only the Screener's contextual entries.
    expect(ids).toContain("spam");
    expect(ids).toContain("block-sender");
    expect(ids).toContain("approve-sender");
    // No Message loaded for a row nobody has opened, so replying is out.
    expect(ids).not.toContain("reply");
  });

  it('"Add to Notes" (#195) forwards the Thread to ctx.onAddToNotes, nothing else', () => {
    const onAddToNotes = vi.fn();
    const thread = makeThread();
    const ctx = withThread(noopActionContext({ onAddToNotes }), thread);
    const action = ACTIONS.find((candidate) => candidate.id === "add-to-notes");

    expect(action?.availability(ctx)).toEqual({ available: true });
    action?.run(ctx);

    expect(onAddToNotes).toHaveBeenCalledTimes(1);
    expect(onAddToNotes).toHaveBeenCalledWith(thread);
  });

  it('"Add to Tasks" (#258) forwards the Thread to ctx.onAddToTasks, nothing else', () => {
    const onAddToTasks = vi.fn();
    const thread = makeThread();
    const ctx = withThread(noopActionContext({ onAddToTasks }), thread);
    const action = ACTIONS.find((candidate) => candidate.id === "add-to-tasks");

    expect(action?.availability(ctx)).toEqual({ available: true });
    action?.run(ctx);

    expect(onAddToTasks).toHaveBeenCalledTimes(1);
    expect(onAddToTasks).toHaveBeenCalledWith(thread);
  });

  it('"Open in new window" (#292) forwards the Thread to ctx.onOpenInNewWindow, nothing else, and is Reader-mail-overflow only', () => {
    const onOpenInNewWindow = vi.fn();
    const thread = makeThread();
    const ctx = withThread(noopActionContext({ onOpenInNewWindow }), thread);
    const action = ACTIONS.find((candidate) => candidate.id === "open-in-new-window");

    expect(action?.surfaces).toEqual(["reader-mail-overflow"]);
    expect(action?.availability(ctx)).toEqual({ available: true });
    action?.run(ctx);

    expect(onOpenInNewWindow).toHaveBeenCalledTimes(1);
    expect(onOpenInNewWindow).toHaveBeenCalledWith(thread);

    expect(mailOverflowActions(ctx).map((candidate) => candidate.id)).toContain(
      "open-in-new-window",
    );
    expect(action?.availability(noopActionContext())).toEqual({
      available: false,
      reason: expect.any(String),
    });
  });

  it('"Open in new window" (#292) is unavailable — and omitted from the Mail overflow — with a Thread in hand but no handler, the standalone Reader route\'s own shape (`router/ReaderRoute.tsx`)', () => {
    const thread = makeThread();
    const ctx = withThread(noopActionContext({ onOpenInNewWindow: null }), thread);
    const action = ACTIONS.find((candidate) => candidate.id === "open-in-new-window");

    expect(action?.availability(ctx)).toEqual({
      available: false,
      reason: expect.any(String),
    });
    expect(mailOverflowActions(ctx).map((candidate) => candidate.id)).not.toContain(
      "open-in-new-window",
    );
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
    const workId = labelId("user-1", "Work");
    const base = noopActionContext();
    const ctx = withThread(
      noopActionContext({
        triage: { ...base.triage, applyLabel, removeLabel },
        labels: [
          {
            id: workId,
            userId: "user-1",
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

  it("hides a Time Group's bulk entries for a group that can't be done in one action", () => {
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

describe("Spam, Approve and Block on any Inbox Thread (#144)", () => {
  it("puts Spam and Block in the Reader's Mail overflow, unavailable with nothing selected", () => {
    const withoutThread = mailOverflowActions(noopActionContext());
    expect(withoutThread.map((action) => action.id)).not.toContain("spam");

    const ctx = withThread(noopActionContext(), makeThread());
    const ids = mailOverflowActions(ctx).map((action) => action.id);
    expect(ids).toContain("spam");
    expect(ids).toContain("block-sender");
    // Approve is menu-only from an ordinary (not-held) Thread's Mail
    // overflow (#289) — see the dedicated Screening Hold test below.
    expect(ids).not.toContain("approve-sender");
  });

  it("shows Approve in the Reader's Mail overflow only once the Thread is under Screening Hold (#289)", () => {
    const notHeld = withThread(noopActionContext(), makeThread({ heldSender: null }));
    expect(mailOverflowActions(notHeld).map((action) => action.id)).not.toContain("approve-sender");

    const held = withThread(
      noopActionContext(),
      makeThread({ heldSender: "someone@example.test" }),
    );
    expect(mailOverflowActions(held).map((action) => action.id)).toContain("approve-sender");

    // The row's own right-click menu and the Palette are unchanged (#144):
    // Approve is reachable there regardless of Screening Hold.
    expect(menuActions(notHeld).map((action) => action.id)).toContain("approve-sender");
  });

  it("binds `!` to Spam alone (user story #20) — Approve and Block are menu/Palette-only", () => {
    const spam = ACTIONS.find((action) => action.id === "spam");
    expect(spam?.binding).toEqual({ keys: ["!"], display: "!" });
    const block = ACTIONS.find((action) => action.id === "block-sender");
    const approve = ACTIONS.find((action) => action.id === "approve-sender");
    expect(block?.binding).toBeNull();
    expect(approve?.binding).toBeNull();
  });

  it("runs Spam/Block/Approve against the Thread in context, in danger ink for Spam and Block only", () => {
    const spamSender = vi.fn();
    const blockSender = vi.fn();
    const approveSender = vi.fn();
    const base = noopActionContext();
    const ctx = withThread(
      noopActionContext({ triage: { ...base.triage, spamSender, blockSender, approveSender } }),
      makeThread(),
    );

    ACTIONS.find((action) => action.id === "spam")?.run(ctx);
    ACTIONS.find((action) => action.id === "block-sender")?.run(ctx);
    ACTIONS.find((action) => action.id === "approve-sender")?.run(ctx);

    expect(spamSender).toHaveBeenCalledWith("t1");
    expect(blockSender).toHaveBeenCalledWith("t1");
    expect(approveSender).toHaveBeenCalledWith("t1");

    expect(ACTIONS.find((action) => action.id === "spam")?.destructive).toBe(true);
    expect(ACTIONS.find((action) => action.id === "block-sender")?.destructive).toBe(true);
    expect(ACTIONS.find((action) => action.id === "approve-sender")?.destructive).toBeFalsy();
  });
});
