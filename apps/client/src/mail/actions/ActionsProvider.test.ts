import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CachedThread } from "../../store/index.js";
import { useActionKeyboard } from "./ActionsProvider.js";
import { noopActionContext, withThread } from "./types.js";

/**
 * #274: the registry's single `keydown` listener is what stands between
 * every registered binding and the browser's own default — Backspace/`#`
 * back-navigating, `/` opening Firefox's find bar, `e` typed three times
 * triggering find-as-you-type. These exercise that promise directly,
 * against `window`, the same target the hook actually listens on.
 */

function dispatch(key: string, target: EventTarget = window): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useActionKeyboard", () => {
  it("suppresses the browser default for a registered binding outside a field", () => {
    const ctx = withThread(noopActionContext(), makeThread());
    renderHook(() => useActionKeyboard(ctx, false));

    const event = dispatch("e");
    expect(event.defaultPrevented).toBe(true);
  });

  it("runs Done three times in a row with no click in between (#274)", () => {
    const archive = vi.fn(() => () => {});
    const ctx = withThread(
      noopActionContext({ triage: { ...noopActionContext().triage, archive } }),
      makeThread(),
    );
    renderHook(() => useActionKeyboard(ctx, false));

    dispatch("e");
    dispatch("e");
    dispatch("e");
    expect(archive).toHaveBeenCalledTimes(3);
  });

  it("leaves an unregistered key's default alone", () => {
    const ctx = withThread(noopActionContext(), makeThread());
    renderHook(() => useActionKeyboard(ctx, false));

    const event = dispatch("z");
    expect(event.defaultPrevented).toBe(false);
  });

  it("does not suppress the default, and does not run the action, while typing in a field", () => {
    const archive = vi.fn(() => () => {});
    const ctx = withThread(
      noopActionContext({ triage: { ...noopActionContext().triage, archive } }),
      makeThread(),
    );
    renderHook(() => useActionKeyboard(ctx, false));

    const input = document.createElement("input");
    document.body.appendChild(input);
    try {
      const event = dispatch("e", input);
      expect(event.defaultPrevented).toBe(false);
      expect(archive).not.toHaveBeenCalled();
    } finally {
      input.remove();
    }
  });

  it("suppresses `#`/Backspace so Trash never navigates back, even with nothing selected", () => {
    const ctx = noopActionContext();
    renderHook(() => useActionKeyboard(ctx, false));

    const hash = dispatch("#");
    const backspace = dispatch("Backspace");
    expect(hash.defaultPrevented).toBe(true);
    expect(backspace.defaultPrevented).toBe(true);
  });
});
