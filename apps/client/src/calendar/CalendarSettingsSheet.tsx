import type { Calendar } from "@mail/shared";
import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
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

/** A placeholder Select value standing in for "no Mail account" — Radix disallows an empty string item value. */
const NO_MAIL_ACCOUNT = "__none__";

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
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={writable ? "cal-name" : undefined}>Name</Label>
          {writable ? (
            <Input
              id="cal-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              onBlur={() => commitDetails({ name, description, timeZone })}
            />
          ) : (
            <span className="text-sm text-muted-foreground">{calendar.name}</span>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={writable ? "cal-description" : undefined}>Description</Label>
          {writable ? (
            <Textarea
              id="cal-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              onBlur={() => commitDetails({ name, description, timeZone })}
            />
          ) : (
            <span className="text-sm text-muted-foreground">{calendar.description || "—"}</span>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={writable ? "cal-time-zone" : undefined}>Time zone</Label>
          {writable ? (
            <Select
              value={timeZone}
              onValueChange={(nextTimeZone) => {
                setTimeZone(nextTimeZone);
                commitDetails({ name, description, timeZone: nextTimeZone });
              }}
            >
              <SelectTrigger id="cal-time-zone" className="w-fit">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIME_ZONES.map((zone) => (
                  <SelectItem key={zone} value={zone}>
                    {zone}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <span className="text-sm text-muted-foreground">{calendar.timeZone}</span>
          )}
        </div>

        <Label className="flex items-center gap-2">
          <Input
            type="color"
            className="h-8 w-12 p-0.5"
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
        </Label>

        <Label className="flex items-center gap-2">
          <Input
            type="checkbox"
            className="h-4 w-4"
            checked={!hiddenCalendarIds.has(calendar.id)}
            onChange={() => toggleHidden(calendar.id)}
          />
          Shown on this device
        </Label>

        <Label className="flex items-center gap-2">
          <Input
            type="checkbox"
            className="h-4 w-4"
            checked={calendar.isDefault}
            disabled={calendar.isDefault}
            onChange={(event) => {
              if (!event.target.checked) return;
              void enqueueUserMutation({ type: "setDefaultCalendar", calendarId: calendar.id });
            }}
          />
          Default calendar for new Events
        </Label>

        <Label className="flex items-center gap-2">
          <Input
            type="checkbox"
            className="h-4 w-4"
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
        </Label>

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
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cal-mail-account">Mail account</Label>
            <Select
              value={calendar.mailAccountId ?? NO_MAIL_ACCOUNT}
              onValueChange={(value) =>
                void enqueueUserMutation({
                  type: "setCalendarMailAccount",
                  calendarId: calendar.id,
                  mailAccountId: value === NO_MAIL_ACCOUNT ? null : value,
                })
              }
            >
              <SelectTrigger id="cal-mail-account" className="w-fit">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_MAIL_ACCOUNT}>None</SelectItem>
                {(mailAccounts ?? []).map((account) => (
                  <SelectItem key={account.id} value={account.id}>
                    {account.emailAddress}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>
    </div>
  );
}
