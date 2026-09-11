import {
  ALL_DAY_REMINDER_PRESET_DAYS,
  allDayPresetMinutes,
  type EventReminder,
  TIMED_REMINDER_PRESET_MINUTES,
} from "@mail/shared";

/** A timed Event's preset label, "at start" through "1 day before" (#244's own body). */
export function timedReminderLabel(minutesBefore: number): string {
  if (minutesBefore === 0) return "At start of event";
  if (minutesBefore < 60) return `${minutesBefore} minutes before`;
  if (minutesBefore < 1440) return `${minutesBefore / 60} hour before`;
  return `${minutesBefore / 1440} day before`;
}

/**
 * The Reminder editor's preset list — day-based for an all-day Event, minute-
 * based otherwise (#244's own body) — shared by an Event's own Reminders
 * (`EventEditorPopover.tsx`) and a Calendar's Reminder Default
 * (`CalendarSettingsSheet.tsx`), since both pick from the same vocabulary.
 */
export function reminderPresets(allDay: boolean): { label: string; minutesBefore: number }[] {
  if (allDay) {
    return ALL_DAY_REMINDER_PRESET_DAYS.map((days) => ({
      label: days === 1 ? "1 day before, 9:00" : `${days} days before, 9:00`,
      minutesBefore: allDayPresetMinutes(days),
    }));
  }
  return TIMED_REMINDER_PRESET_MINUTES.map((minutesBefore) => ({
    label: timedReminderLabel(minutesBefore),
    minutesBefore,
  }));
}

/** A Reminder the User actually sees ("popup", "relative" — `visibleReminders`'s own doc comment), one preset chip's own shape. */
export function relativePopupReminder(minutesBefore: number): EventReminder {
  return { kind: "relative", method: "popup", minutesBefore };
}

/** Everything a Series' `reminders` carries that the editor never shows — email/absolute alarms round-tripping unseen and unfired (#244's own acceptance line) — kept verbatim across a save. */
export function hiddenReminders(reminders: EventReminder[]): EventReminder[] {
  return reminders.filter(
    (reminder) => !(reminder.kind === "relative" && reminder.method === "popup"),
  );
}
