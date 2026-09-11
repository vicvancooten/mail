import type { Calendar, Event } from "@mail/shared";
import type { CSSProperties, MouseEvent } from "react";
import { elementAnchorRect, openEditPanel } from "./calendar-event-panel.js";
import { eventStart } from "./calendar-occurrences.js";

const TIME_LABEL = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

function timeLabel(event: Event): string {
  const start = eventStart(event);
  const asDate = new Date(start.year, start.month - 1, start.day, start.hour, start.minute);
  return TIME_LABEL.format(asDate);
}

/**
 * One Occurrence. Tinted by its Calendar's own colour swatch, the same
 * `backgroundColor` convention `CalendarMirrorChecklist.tsx`'s row dot
 * already uses; a Calendar the Local Cache hasn't synced yet (a brand-new
 * mirror mid-first-sync) falls back to a neutral tone rather than throwing
 * on a missing lookup.
 *
 * Clicking opens the Event editor (#233) — anchored to the chip's own
 * `getBoundingClientRect()` (`elementAnchorRect`) rather than the click
 * point, since editing is about *this Occurrence*, not where the cursor
 * happened to land on it. `stopPropagation` keeps the click from also
 * reaching whatever the grid cell underneath does with a plain click (#233's
 * own create-on-empty-space handler).
 */
export function EventChip({
  event,
  calendar,
  variant = "timed",
}: {
  event: Event;
  calendar: Calendar | undefined;
  variant?: "timed" | "all-day" | "block";
}) {
  const color = calendar?.color ?? "#93969f";
  function open(target: HTMLButtonElement) {
    openEditPanel(event.id, elementAnchorRect(target));
  }
  return (
    <button
      type="button"
      className={`calendar-event-chip calendar-event-chip-${variant}`}
      style={{ "--chip-color": color } as CSSProperties}
      title={event.location ? `${event.title} — ${event.location}` : event.title}
      onClick={(clickEvent: MouseEvent<HTMLButtonElement>) => {
        clickEvent.stopPropagation();
        open(clickEvent.currentTarget);
      }}
    >
      {variant !== "all-day" && !event.allDay ? (
        <span className="calendar-event-time">{timeLabel(event)}</span>
      ) : null}
      <span className="calendar-event-title">{event.title}</span>
    </button>
  );
}
