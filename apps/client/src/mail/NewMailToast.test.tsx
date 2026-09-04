import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Toaster } from "../components/ui/sonner.js";
import { subscribeNotificationTarget } from "../pwa/notification-router.js";
import { type MessageContainer, NewMailToast } from "./NewMailToast.js";

/** `toast.custom()` only ever renders through a mounted `<Toaster />` (#93) — every case renders one alongside the component under test. */
function renderWithToaster(container: MessageContainer, autoDismissMs?: number) {
  return render(
    <>
      <NewMailToast container={container} autoDismissMs={autoDismissMs} />
      <Toaster />
    </>,
  );
}

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
  // Sonner's toast store is a module-level singleton, outside React — it
  // outlives `cleanup()`'s unmount, so a toast left over from one test
  // (its dismiss timer not yet due) would otherwise bleed into the next.
  toast.dismiss();
});

describe("NewMailToast", () => {
  it("renders nothing until a relayed push arrives", () => {
    renderWithToaster(fakeContainer());
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows sender + subject on a relayed new_mail message, then auto-dismisses", async () => {
    const container = fakeContainer();
    renderWithToaster(container, 20);

    container.emit({ type: "new-mail-toast", payload: newMailPayload() });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Alice/ }).textContent).toContain("Hi"),
    );
    await waitFor(() => expect(screen.queryByRole("button", { name: /Alice/ })).toBeNull());
  });

  it("ignores a message that isn't the new-mail-toast relay", () => {
    const container = fakeContainer();
    renderWithToaster(container);
    container.emit({ type: "something-else" });
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("stacks up to 3 toasts, then collapses a fourth into one 'N new messages' toast", async () => {
    const container = fakeContainer();
    renderWithToaster(container, 10_000);

    for (let i = 0; i < 3; i++) {
      container.emit({
        type: "new-mail-toast",
        payload: newMailPayload({ threadId: `thread-${i}`, subject: `Message ${i}` }),
      });
    }
    await waitFor(() => expect(screen.getAllByRole("button")).toHaveLength(3));

    container.emit({
      type: "new-mail-toast",
      payload: newMailPayload({ threadId: "thread-4", subject: "Message 4" }),
    });
    await waitFor(() => expect(screen.queryAllByRole("button")).toHaveLength(0));
    await waitFor(() => expect(screen.getByText("4 new messages")).toBeTruthy());
  });

  it("publishes the clicked Thread to notification-router and dismisses", async () => {
    const container = fakeContainer();
    const received: unknown[] = [];
    const unsubscribe = subscribeNotificationTarget((target) => received.push(target));
    renderWithToaster(container);

    container.emit({ type: "new-mail-toast", payload: newMailPayload() });
    await waitFor(() => screen.getByRole("button", { name: /Alice/ }));
    fireEvent.click(screen.getByRole("button", { name: /Alice/ }));

    expect(received).toEqual([{ kind: "thread", mailAccountId: "acct-1", threadId: "thread-1" }]);
    await waitFor(() => expect(screen.queryByRole("button", { name: /Alice/ })).toBeNull());
    unsubscribe();
  });

  it("has nothing to publish for a new_mail_burst payload's own click target — dismisses without routing", async () => {
    const container = fakeContainer();
    const listener = vi.fn();
    const unsubscribe = subscribeNotificationTarget(listener);
    renderWithToaster(container, 10_000);

    container.emit({
      type: "new-mail-toast",
      payload: { kind: "new_mail_burst", mailAccountId: "acct-1", count: 6, badgeCount: 6 },
    });
    await waitFor(() => screen.getByRole("button", { name: /6 new messages/ }));
    fireEvent.click(screen.getByRole("button", { name: /6 new messages/ }));

    expect(listener).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /6 new messages/ })).toBeNull(),
    );
    unsubscribe();
  });

  it("routes a clicked failed_send toast the same as a real notification click (#53)", async () => {
    const container = fakeContainer();
    const received: unknown[] = [];
    const unsubscribe = subscribeNotificationTarget((target) => received.push(target));
    renderWithToaster(container);

    container.emit({
      type: "new-mail-toast",
      payload: {
        kind: "failed_send",
        mailAccountId: "acct-1",
        compositionId: "comp-1",
        subject: "Re: hi",
        detail: "550 mailbox unavailable",
        badgeCount: 0,
      },
    });
    await waitFor(() => screen.getByRole("button", { name: /Send failed/ }));
    fireEvent.click(screen.getByRole("button", { name: /Send failed/ }));

    expect(received).toEqual([
      { kind: "failed-send", mailAccountId: "acct-1", compositionId: "comp-1" },
    ]);
    unsubscribe();
  });

  it("routes a clicked needs_reauth toast the same as a real notification click (#53)", async () => {
    const container = fakeContainer();
    const received: unknown[] = [];
    const unsubscribe = subscribeNotificationTarget((target) => received.push(target));
    renderWithToaster(container);

    container.emit({
      type: "new-mail-toast",
      payload: {
        kind: "needs_reauth",
        mailAccountId: "acct-1",
        emailAddress: "vic@example.com",
        badgeCount: 0,
      },
    });
    await waitFor(() => screen.getByRole("button", { name: /Reconnect your account/ }));
    fireEvent.click(screen.getByRole("button", { name: /Reconnect your account/ }));

    expect(received).toEqual([{ kind: "needs-reauth", mailAccountId: "acct-1" }]);
    unsubscribe();
  });
});
