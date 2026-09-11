import type { PushPayload, SnoozeUntil } from "@mail/shared";
import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import { publishNotificationTarget } from "../pwa/notification-router.js";
import { buildNotificationContent } from "../pwa/push-decisions.js";
import { readEvent } from "../store/events.js";
import { enqueueUserMutation } from "../store/user-mutation-queue.js";
import { stagePendingReminderClick } from "./calendar-event-panel.js";

/**
 * The `calendar_reminder` half of ADR-0015's visible-window rule (#246,
 * ADR-0028): "A visible Client shows the same text as an inline toast" —
 * `NewMailToast.tsx`'s own generic relay already forwards every push kind
 * through the same `postMessage`, but its single click-to-open button has
 * no room for a Snooze menu, and its click routing doesn't know about
 * `calendar_reminder` at all (`push-decisions.ts#notificationClickTarget`'s
 * own `calendar-event` case exists, but nothing before this component ever
 * used it from a toast). Mounted globally in `RootLayout.tsx`, not inside
 * `CalendarRoute.tsx` — a Reminder can fire with Mail open just as easily.
 *
 * The toast's own Snooze row is the same "5, 10, 15 minutes and 'at
 * start'" menu the Event page offers (`EventEditorPopover.tsx`'s own
 * Snooze row) — both queue the identical `snoozeReminder` User Mutation
 * (`user-mutation-queue.ts`).
 */

const AUTO_DISMISS_MS = 10_000;

interface CalendarReminderToastMessage {
  type: "new-mail-toast";
  payload: PushPayload;
}

function isCalendarReminderMessage(data: unknown): data is CalendarReminderToastMessage & {
  payload: Extract<PushPayload, { kind: "calendar_reminder" }>;
} {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { type?: unknown }).type === "new-mail-toast" &&
    (data as { payload?: { kind?: unknown } }).payload?.kind === "calendar_reminder"
  );
}

export interface MessageContainer {
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}

export interface CalendarReminderToastProps {
  container?: MessageContainer;
  autoDismissMs?: number;
}

export function CalendarReminderToast({
  container = globalThis.navigator?.serviceWorker,
  autoDismissMs = AUTO_DISMISS_MS,
}: CalendarReminderToastProps = {}) {
  const liveIds = useRef<Set<string>>(new Set());

  const openEvent = useCallback((eventId: string, reminderDueIds: string[]) => {
    stagePendingReminderClick(eventId, reminderDueIds);
    publishNotificationTarget({ kind: "calendar-event", eventId, reminderDueIds });
  }, []);

  useEffect(() => {
    if (!container) return;

    const onMessage = (event: MessageEvent) => {
      if (!isCalendarReminderMessage(event.data)) return;
      const { payload } = event.data;
      const [first] = payload.events;
      if (!first) return;

      const reminderDueIds = payload.events.map((entry) => entry.reminderDueId);
      const content = buildNotificationContent(payload);
      const id = `calendar-reminder-toast-${first.eventId}`;
      liveIds.current.add(id);

      function snooze(snoozeUntil: SnoozeUntil) {
        toast.dismiss(id);
        void enqueueUserMutation({ type: "snoozeReminder", reminderDueIds, snoozeUntil });
      }

      // Best-effort: "at start" is dropped once the Event has begun
      // (ADR-0028) — a Local Cache miss (a push arriving before the Event
      // ever synced) just leaves it offered, since the Sync Backend itself
      // rejects a stale "at start" harmlessly either way.
      void readEvent(first.eventId).then((cachedEvent) => {
        const started = cachedEvent ? new Date(cachedEvent.start).getTime() <= Date.now() : false;

        toast.custom(
          () => (
            <div className="calendar-reminder-toast">
              <button
                type="button"
                className="calendar-reminder-toast-open"
                onClick={() => {
                  toast.dismiss(id);
                  openEvent(first.eventId, reminderDueIds);
                }}
              >
                <strong>{content.title}</strong>
                <span>{content.body}</span>
              </button>
              <div className="calendar-reminder-toast-actions">
                <button type="button" onClick={() => snooze({ kind: "minutes", minutes: 5 })}>
                  5 min
                </button>
                <button type="button" onClick={() => snooze({ kind: "minutes", minutes: 10 })}>
                  10 min
                </button>
                <button type="button" onClick={() => snooze({ kind: "minutes", minutes: 15 })}>
                  15 min
                </button>
                {started ? null : (
                  <button type="button" onClick={() => snooze({ kind: "eventStart" })}>
                    At start
                  </button>
                )}
              </div>
            </div>
          ),
          {
            id,
            duration: autoDismissMs,
            onDismiss: () => {
              liveIds.current.delete(id);
            },
          },
        );
      });
    };
    container.addEventListener("message", onMessage);
    return () => container.removeEventListener("message", onMessage);
  }, [container, autoDismissMs, openEvent]);

  return null;
}
