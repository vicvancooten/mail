import { MAX_REMINDER_MINUTES } from "@mail/shared";
import { Button } from "../components/ui/button.js";
import { reminderPresets } from "./reminder-presets.js";

/**
 * One minutes-before list's editor — an Event's own visible Reminders
 * (`EventEditorPopover.tsx`) and a Calendar's Reminder Default, timed or
 * all-day (`CalendarSettingsSheet.tsx`), share this exact control (#244's
 * own body: "Presets ... custom up to four weeks"). `cap` is `Infinity` for
 * a Reminder Default (Wicket's own, no upstream ceiling) and the owning
 * Calendar's `perEventReminders` count for an Event's own Reminders.
 */
export function ReminderMinutesEditor({
  minutesList,
  allDay,
  cap,
  onChange,
}: {
  minutesList: number[];
  allDay: boolean;
  cap: number;
  onChange: (next: number[]) => void;
}) {
  const presets = reminderPresets(allDay);

  return (
    <div className="calendar-reminder-editor">
      {minutesList.map((minutesBefore, index) => {
        const isPreset = presets.some((preset) => preset.minutesBefore === minutesBefore);
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: `minutesList` is a plain number[] with no id of its own and can hold duplicate values, so the value alone isn't a unique key either — rows are only ever appended or removed here, never reordered.
          <div key={index} className="calendar-event-editor-row">
            <select
              value={isPreset ? minutesBefore : "custom"}
              onChange={(event) => {
                if (event.target.value === "custom") return;
                const next = [...minutesList];
                next[index] = Number(event.target.value);
                onChange(next);
              }}
            >
              {presets.map((preset) => (
                <option key={preset.minutesBefore} value={preset.minutesBefore}>
                  {preset.label}
                </option>
              ))}
              <option value="custom">Custom…</option>
            </select>
            {!isPreset ? (
              <input
                type="number"
                min={0}
                max={MAX_REMINDER_MINUTES}
                value={minutesBefore}
                onChange={(event) => {
                  const next = [...minutesList];
                  next[index] = Math.max(
                    0,
                    Math.min(MAX_REMINDER_MINUTES, Number(event.target.value)),
                  );
                  onChange(next);
                }}
              />
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onChange(minutesList.filter((_, i) => i !== index))}
            >
              Remove
            </Button>
          </div>
        );
      })}
      {minutesList.length < cap ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onChange([...minutesList, presets[0]?.minutesBefore ?? 0])}
        >
          Add reminder
        </Button>
      ) : null}
    </div>
  );
}
