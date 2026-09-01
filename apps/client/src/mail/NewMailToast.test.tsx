import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { subscribeNotificationTarget } from "../pwa/notification-router.js";
import { type MessageContainer, NewMailToast } from "./NewMailToast.js";

/**
 * `NewMailToast` never sees a real `push` event — only the service worker's
 * relay for a visible-window suppression (ADR-0015). jsdom has no
 * `navigator.serviceWorker` at all, so this drives a fake `MessageContainer`
 * directly rather than a real one.
 */

function fakeContainer(): MessageContainer & { emit(data: unknown): void } {
  const listeners = new Set<(event: MessageEvent) => void>();
  return {
    addEventListener: (_type, listener) => {
      listeners.add(listener);
    },
    removeEventListener: (_type, listener) => {
      listeners.delete(listener);
    },
    emit(data: unknown) {
      // The real container dispatches outside of React's own event system —
      // `act()` is what flushes the resulting `setState` synchronously here,
      // the same as a real browser event would across a render.
      act(() => {
        for (const listener of listeners) listener({ data } as MessageEvent);
      });
    },
  };
}

const newMailPayload = (overrides: Partial<Record<string, unknown>> = {}) => ({
  kind: "new_mail" as const,
  mailAccountId: "acct-1",
  threadId: "thread-1",
  senderName: "Alice",
  senderAddress: "alice@example.com",
  subject: "Hi",
  snippet: null,
  badgeCount: 1,
  ...overrides,
});

afterEach(() => {
  cleanup();
});

describe("NewMailToast", () => {
  it("renders nothing until a relayed push arrives", () => {
    render(<NewMailToast container={fakeContainer()} />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows sender + subject on a relayed new_mail message, then auto-dismisses", async () => {
    const container = fakeContainer();
    render(<NewMailToast container={container} autoDismissMs={20} />);

    container.emit({ type: "new-mail-toast", payload: newMailPayload() });

    expect(screen.getByRole("button", { name: /Alice/ }).textContent).toContain("Hi");
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });

  it("ignores a message that isn't the new-mail-toast relay", () => {
    const container = fakeContainer();
    render(<NewMailToast container={container} />);
    container.emit({ type: "something-else" });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("stacks up to 3 toasts, then collapses a fourth into one 'N new messages' toast", () => {
    const container = fakeContainer();
    render(<NewMailToast container={container} autoDismissMs={10_000} />);

    for (let i = 0; i < 3; i++) {
      container.emit({
        type: "new-mail-toast",
        payload: newMailPayload({ threadId: `thread-${i}`, subject: `Message ${i}` }),
      });
    }
    expect(screen.getAllByRole("button")).toHaveLength(3);

    container.emit({
      type: "new-mail-toast",
      payload: newMailPayload({ threadId: "thread-4", subject: "Message 4" }),
    });
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByRole("status").textContent).toBe("4 new messages");
  });

  it("publishes the clicked Thread to notification-router and dismisses", async () => {
    const container = fakeContainer();
    const received: unknown[] = [];
    const unsubscribe = subscribeNotificationTarget((target) => received.push(target));
    render(<NewMailToast container={container} />);

    container.emit({ type: "new-mail-toast", payload: newMailPayload() });
    fireEvent.click(screen.getByRole("button", { name: /Alice/ }));

    expect(received).toEqual([{ mailAccountId: "acct-1", threadId: "thread-1" }]);
    expect(screen.queryByRole("status")).toBeNull();
    unsubscribe();
  });

  it("has nothing to publish for a new_mail_burst payload's own click target — dismisses without routing", () => {
    const container = fakeContainer();
    const listener = vi.fn();
    const unsubscribe = subscribeNotificationTarget(listener);
    render(<NewMailToast container={container} autoDismissMs={10_000} />);

    container.emit({
      type: "new-mail-toast",
      payload: { kind: "new_mail_burst", mailAccountId: "acct-1", count: 6, badgeCount: 6 },
    });
    fireEvent.click(screen.getByRole("button", { name: /6 new messages/ }));

    expect(listener).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();
    unsubscribe();
  });
});
