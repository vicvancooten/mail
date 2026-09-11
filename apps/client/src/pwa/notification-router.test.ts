import { afterEach, describe, expect, it } from "vitest";
import {
  type MessageContainer,
  type NotificationTarget,
  startNotificationRouter,
  subscribeNotificationTarget,
} from "./notification-router.js";

/** jsdom has no `navigator.serviceWorker` — the same fake `MessageContainer` shape `NewMailToast.test.tsx` drives. */
function fakeContainer(): MessageContainer & { emit(data: unknown): void } {
  const listeners = new Set<(event: MessageEvent) => void>();
  return {
    addEventListener: (_type, listener) => {
      listeners.add(listener);
    },
    emit(data: unknown) {
      for (const listener of listeners) listener({ data } as MessageEvent);
    },
  };
}

let unsubscribe: (() => void) | undefined;

afterEach(() => {
  unsubscribe?.();
  unsubscribe = undefined;
});

describe("startNotificationRouter", () => {
  it("publishes the target carried by a notification-click message", () => {
    const container = fakeContainer();
    startNotificationRouter(container);
    const received: NotificationTarget[] = [];
    unsubscribe = subscribeNotificationTarget((target) => received.push(target));

    container.emit({
      type: "notification-click",
      target: { kind: "screener", mailAccountId: "acct-1" },
    });

    expect(received).toEqual([{ kind: "screener", mailAccountId: "acct-1" }]);
  });

  it("ignores messages of any other shape", () => {
    const container = fakeContainer();
    startNotificationRouter(container);
    const received: NotificationTarget[] = [];
    unsubscribe = subscribeNotificationTarget((target) => received.push(target));

    container.emit({ type: "new-mail-toast", payload: {} });
    container.emit({ type: "notification-click", target: null });
    container.emit({
      type: "notification-click",
      target: { kind: "thread", mailAccountId: "acct-1" },
    });
    container.emit({ type: "notification-click", target: { kind: "screener" } });
    container.emit(null);
    container.emit("not an object");

    expect(received).toEqual([]);
  });

  it("is a no-op with no container to listen on", () => {
    expect(() => startNotificationRouter(undefined)).not.toThrow();
  });

  it("does not register the same container twice", () => {
    const container = fakeContainer();
    startNotificationRouter(container);
    startNotificationRouter(container);
    const received: NotificationTarget[] = [];
    unsubscribe = subscribeNotificationTarget((target) => received.push(target));

    container.emit({
      type: "notification-click",
      target: { kind: "screener", mailAccountId: "acct-1" },
    });

    expect(received).toEqual([{ kind: "screener", mailAccountId: "acct-1" }]);
  });

  it("publishes a calendar-event target (#246)", () => {
    const container = fakeContainer();
    startNotificationRouter(container);
    const received: NotificationTarget[] = [];
    unsubscribe = subscribeNotificationTarget((target) => received.push(target));

    container.emit({
      type: "notification-click",
      target: { kind: "calendar-event", eventId: "evt-1", reminderDueIds: ["rd-1", "rd-2"] },
    });

    expect(received).toEqual([
      { kind: "calendar-event", eventId: "evt-1", reminderDueIds: ["rd-1", "rd-2"] },
    ]);
  });
});
