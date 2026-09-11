import type { Calendar } from "@mail/shared";
import { SettingsIcon } from "lucide-react";
import { useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../components/ui/sheet.js";
import { CalendarSettingsSheet } from "./CalendarSettingsSheet.js";

/**
 * The Calendar list slide-over (#231's own acceptance line: "No persistent
 * sidebar ... a slide-over reveals the Calendar list with its show/hide
 * toggles and closes again, so the grid keeps the full width"). A plain
 * shadcn `Sheet` from the left — `AppSwitcher.tsx`'s own phone sheet is the
 * same primitive for the same reason: it slides fully over the content and
 * closes again rather than reflowing it, which is exactly the "no
 * persistent sidebar" shape this ticket asks for on every viewport, not
 * only the phone.
 */
export function CalendarSlideOver({
  open,
  onOpenChange,
  calendars,
  hiddenCalendarIds,
  onToggle,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  calendars: readonly Calendar[];
  hiddenCalendarIds: ReadonlySet<string>;
  onToggle: (calendarId: string) => void;
}) {
  // The settings sheet (#236) is this component's own concern — a second,
  // right-hand `Sheet` opened by a row's gear button — rather than
  // something `CalendarRoute.tsx` has to thread state through for, the same
  // "self-contained" posture `CalendarMirrorChecklist.tsx` already takes
  // for its own confirm dialog.
  const [settingsCalendar, setSettingsCalendar] = useState<Calendar | null>(null);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="calendar-slide-over">
        <SheetHeader>
          <SheetTitle>Calendars</SheetTitle>
          <SheetDescription>Show or hide a Calendar on the grid.</SheetDescription>
        </SheetHeader>
        <div className="calendar-slide-over-list">
          {calendars.length === 0 ? (
            <p className="calendar-slide-over-empty">No Calendars yet.</p>
          ) : (
            calendars.map((calendar) => (
              <div key={calendar.id} className="calendar-slide-over-row">
                <label htmlFor={`cal-vis-${calendar.id}`} className="calendar-slide-over-row-main">
                  <input
                    id={`cal-vis-${calendar.id}`}
                    type="checkbox"
                    checked={!hiddenCalendarIds.has(calendar.id)}
                    onChange={() => onToggle(calendar.id)}
                  />
                  <span
                    aria-hidden="true"
                    className="calendar-slide-over-swatch"
                    style={{ backgroundColor: calendar.color }}
                  />
                  <span className="calendar-slide-over-name">{calendar.name}</span>
                </label>
                <button
                  type="button"
                  className="calendar-slide-over-settings-button"
                  aria-label={`${calendar.name} settings`}
                  onClick={() => setSettingsCalendar(calendar)}
                >
                  <SettingsIcon aria-hidden="true" size={14} />
                </button>
              </div>
            ))
          )}
        </div>
      </SheetContent>
      {/* A sibling `Sheet` (right-hand, #236), not nested inside the list's
          own `SheetContent` — each is Radix's own independent Dialog root,
          so opening one never fights the other's open/close state. */}
      <CalendarSettingsSheet
        calendar={settingsCalendar}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setSettingsCalendar(null);
        }}
      />
    </Sheet>
  );
}
