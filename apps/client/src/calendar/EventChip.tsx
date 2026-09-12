import type { Calendar, Event, RegionFormatSettings } from "@mail/shared";
import type { CSSProperties, MouseEvent } from "react";
import { elementAnchorRect, openEditPanel } from "./calendar-event-panel.js";
import { eventStart } from "./calendar-occurrences.js";

/**
 * One (locale, clock format) pair's formatter, cached — `calendar-dates.ts#labelFormatter`'s
 * own reasoning: a handful of distinct Region Settings combinations ever
 * appear in one session, not one per chip per render.
 */
const TIME_LABEL_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function timeLabel(event: Event, region: RegionFormatSettings): string {
  // The Occurrence's own start, already resolved into the Home Time Zone
  // (`calendar-occurrences.ts#eventStart`) — this only ever formats the
  // resulting wall-clock digits, never converts a zone a second time (a
  // floating/all-day Event's digits are already wall clock, same as before).
  const start = eventStart(event, region.timeZone);
  const asDate = new Date(start.year, start.month - 1, start.day, start.hour, start.minute);

  const key = `${region.locale}:${region.clockFormat}`;
  let formatter = TIME_LABEL_FORMATTERS.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(region.locale || undefined, {
      hour: "numeric",
      minute: "2-digit",
      hour12: region.clockFormat === "12" ? true : region.clockFormat === "24" ? false : undefined,
    });
    TIME_LABEL_FORMATTERS.set(key, formatter);
  }
  return formatter.format(asDate);
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
  region,
}: {
  event: Event;
  calendar: Calendar | undefined;
  variant?: "timed" | "all-day" | "block";
  /** Region Settings + Home Time Zone (#303) — this chip's own time label (never shown for an all-day variant/Event) routes through it. */
  region: RegionFormatSettings;
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
        <span className="calendar-event-time">{timeLabel(event, region)}</span>
      ) : null}
      <span className="calendar-event-title">{event.title}</span>
    </button>
  );
}
