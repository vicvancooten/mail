import type { Calendar } from "@mail/shared";
import { useEffect, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../components/ui/sheet.js";
import { useHiddenCalendarIds } from "../mail/device-preferences.js";
import { enqueueUserMutation } from "../store/index.js";
import { useMailAccounts } from "../store/reads.js";
import { ReminderMinutesEditor } from "./ReminderMinutesEditor.js";

/** Every IANA zone this browser knows — the same list `GeneralSection.tsx`'s Home Time Zone picker offers (#189). */
const TIME_ZONES = Intl.supportedValuesOf("timeZone");

/**
 * A Calendar's settings sheet (#236): "Everything a User can say about a
 * Calendar rather than an Event." Opened from a row in
 * `CalendarSlideOver.tsx`; `calendar` is `null` while closed so this
 * component (and its form state) unmounts along with the sheet rather than
 * carrying a stale edit across to the next Calendar opened.
 *
 * Every control commits immediately, on blur or on change — the same
 * no-Save-button posture `settings/GeneralSection.tsx` already takes for
 * every Preference control, since each field here is its own independent
 * Optimistic Action (`sync.ts#userMutationIntentSchema`'s own doc comment)
 * with nothing to batch.
 *
 * Name/description/time zone render as plain text, with no input at all,
 * when `!capabilities.writable` — "A Calendar the upstream grants only
 * reading of shows no edit affordances at all" (#236's own acceptance
 * line). Colour, shown, default-for-new-Events and the Reminder settings
 * (#244, ADR-0028: on/off plus the two Reminder Default lists) are all
 * Wicket's own and stay editable regardless; Mail account only ever applies
 * to a Local Calendar today (this ticket's closing comment — "self-scheduled"
 * mirrored Calendars are a future concept, not #234/#235's).
 */
export function CalendarSettingsSheet({
  calendar,
  onOpenChange,
}: {
  calendar: Calendar | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={calendar !== null} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="overflow-y-auto">
        {calendar && <CalendarSettingsForm calendar={calendar} />}
      </SheetContent>
    </Sheet>
  );
}

function CalendarSettingsForm({ calendar }: { calendar: Calendar }) {
  const writable = calendar.capabilities.writable;
  const [name, setName] = useState(calendar.name);
  const [description, setDescription] = useState(calendar.description ?? "");
  const [timeZone, setTimeZone] = useState(calendar.timeZone);
  const [hiddenCalendarIds, toggleHidden] = useHiddenCalendarIds();
  const mailAccounts = useMailAccounts();

  // A freshly opened Calendar's own values — never re-synced mid-edit, the
  // same "controlled input, reset only when the identity changes" shape
  // any form in this codebase takes when it wraps a synced value.
  useEffect(() => {
    setName(calendar.name);
    setDescription(calendar.description ?? "");
    setTimeZone(calendar.timeZone);
  }, [calendar.name, calendar.description, calendar.timeZone]);

  function commitDetails(next: { name: string; description: string; timeZone: string }) {
    if (!writable) return;
    if (next.name.trim().length === 0) return;
    void enqueueUserMutation({
      type: "updateCalendarDetails",
      calendarId: calendar.id,
      name: next.name,
      description: next.description.length > 0 ? next.description : null,
      timeZone: next.timeZone,
    });
  }

  return (
    <div className="flex flex-col gap-4 p-1">
      <SheetHeader>
        <SheetTitle>{calendar.name}</SheetTitle>
        <SheetDescription>Everything you can say about this Calendar.</SheetDescription>
      </SheetHeader>

      <div className="flex flex-col gap-4 px-4">
        <label className="flex flex-col gap-1 text-sm" htmlFor={writable ? "cal-name" : undefined}>
          Name
          {writable ? (
            <input
              id="cal-name"
              className="rounded-md border px-2 py-1"
              value={name}
              onChange={(event) => setName(event.target.value)}
              onBlur={() => commitDetails({ name, description, timeZone })}
            />
          ) : (
            <span className="text-muted-foreground">{calendar.name}</span>
          )}
        </label>

        <label
          className="flex flex-col gap-1 text-sm"
          htmlFor={writable ? "cal-description" : undefined}
        >
          Description
          {writable ? (
            <textarea
              id="cal-description"
              className="rounded-md border px-2 py-1"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              onBlur={() => commitDetails({ name, description, timeZone })}
            />
          ) : (
            <span className="text-muted-foreground">{calendar.description || "—"}</span>
          )}
        </label>

        <label
          className="flex flex-col gap-1 text-sm"
          htmlFor={writable ? "cal-time-zone" : undefined}
        >
          Time zone
          {writable ? (
            <select
              id="cal-time-zone"
              className="rounded-md border px-2 py-1"
              value={timeZone}
              onChange={(event) => {
                const nextTimeZone = event.target.value;
                setTimeZone(nextTimeZone);
                commitDetails({ name, description, timeZone: nextTimeZone });
              }}
            >
              {TIME_ZONES.map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </select>
          ) : (
            <span className="text-muted-foreground">{calendar.timeZone}</span>
          )}
        </label>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="color"
            value={calendar.color}
            onChange={(event) =>
              void enqueueUserMutation({
                type: "setCalendarColor",
                calendarId: calendar.id,
                color: event.target.value,
              })
            }
          />
          Colour
        </label>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={!hiddenCalendarIds.has(calendar.id)}
            onChange={() => toggleHidden(calendar.id)}
          />
          Shown on this device
        </label>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={calendar.isDefault}
            disabled={calendar.isDefault}
            onChange={(event) => {
              if (!event.target.checked) return;
              void enqueueUserMutation({ type: "setDefaultCalendar", calendarId: calendar.id });
            }}
          />
          Default calendar for new Events
        </label>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={calendar.remindersEnabled}
            onChange={(event) =>
              void enqueueUserMutation({
                type: "setCalendarRemindersEnabled",
                calendarId: calendar.id,
                enabled: event.target.checked,
              })
            }
          />
          Reminders
        </label>

        <div className="flex flex-col gap-2 text-sm">
          <span>Reminder default — timed events</span>
          <ReminderMinutesEditor
            minutesList={calendar.reminderDefault.timed}
            allDay={false}
            cap={Number.POSITIVE_INFINITY}
            onChange={(timed) =>
              void enqueueUserMutation({
                type: "setCalendarReminderDefault",
                calendarId: calendar.id,
                reminderDefault: { ...calendar.reminderDefault, timed },
              })
            }
          />
        </div>

        <div className="flex flex-col gap-2 text-sm">
          <span>Reminder default — all-day events</span>
          <ReminderMinutesEditor
            minutesList={calendar.reminderDefault.allDay}
            allDay
            cap={Number.POSITIVE_INFINITY}
            onChange={(allDay) =>
              void enqueueUserMutation({
                type: "setCalendarReminderDefault",
                calendarId: calendar.id,
                reminderDefault: { ...calendar.reminderDefault, allDay },
              })
            }
          />
        </div>

        {calendar.origin.type === "local" && (
          <label className="flex flex-col gap-1 text-sm">
            Mail account
            <select
              className="rounded-md border px-2 py-1"
              value={calendar.mailAccountId ?? ""}
              onChange={(event) =>
                void enqueueUserMutation({
                  type: "setCalendarMailAccount",
                  calendarId: calendar.id,
                  mailAccountId: event.target.value.length > 0 ? event.target.value : null,
                })
              }
            >
              <option value="">None</option>
              {(mailAccounts ?? []).map((account) => (
                <option key={account.id} value={account.id}>
                  {account.emailAddress}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
    </div>
  );
}
