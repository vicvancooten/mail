import {
  type Calendar,
  canMoveBetweenOrigins,
  MAX_EVENT_REMINDERS,
  type SnoozeUntil,
  visibleReminders,
} from "@mail/shared";
import { useEffect, useState } from "react";
import { Button } from "../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog.js";
import { Input } from "../components/ui/input.js";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
} from "../components/ui/popover.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select.js";
import { announceUndoableAction } from "../mail/undo-toast.js";
import { calendarRoute } from "../router/routes.js";
import { readEvent } from "../store/events.js";
import {
  addExdate,
  createSeries,
  hydrateSeries,
  moveSeries,
  newOverrideId,
  newSeriesId,
  removeExdate,
  restoreSeries,
  type SeriesBodyFields,
  saveSeriesBody,
  trashSeries,
  useSeries,
} from "../store/series.js";
import {
  createTask,
  newTaskId,
  setTaskDueDate,
  setTaskDueTime,
  useTaskLists,
} from "../store/tasks.js";
import { enqueueUserMutation } from "../store/user-mutation-queue.js";
import { TaskDuePicker } from "../tasks/TaskDuePicker.js";
import { dateOnlyToWireDueDate } from "../tasks/task-due.js";
import "../tasks/tasks.css";
import { creatableCalendars } from "./calendar-create.js";
import { closeEventPanel, useEventPanelState } from "./calendar-event-panel.js";
import { ReminderMinutesEditor } from "./ReminderMinutesEditor.js";
import {
  RECURRENCE_TEMPLATES,
  type RecurrenceTemplate,
  recurrenceTemplateFor,
  rrulesForTemplate,
  withUntil,
} from "./recurrence.js";
import { hiddenReminders, relativePopupReminder } from "./reminder-presets.js";

/** The create popover's own Event/Task switch (#261) — never offered while editing, and never remembered across a fresh create ("the popover always opens on Event"). */
type EntityKind = "event" | "task";

const BROWSER_TZID = Intl.DateTimeFormat().resolvedOptions().timeZone;
const RECURRENCE_LABEL: Record<RecurrenceTemplate, string> = {
  none: "Does not repeat",
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
  yearly: "Yearly",
};

/** Editing an Occurrence of a recurring Series (#233's own acceptance line): which of the three writes a Save actually performs. */
type EditScope = "this" | "all" | "thisAndFollowing";

function toLocalInputValue(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromLocalInputValue(value: string): Date {
  return new Date(value);
}

function parseAttendees(
  text: string,
): { email: string; name: null; responseStatus: "needsAction" }[] {
  return text
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((email) => ({ email, name: null, responseStatus: "needsAction" as const }));
}

/** Whether a Calendar organises its own Events by mail (#242, ADR-0027) — the attendee field's own gate, and the Send / Don't send prompt's. */
function isSelfScheduled(calendar: Calendar | undefined): boolean {
  return calendar?.capabilities.invitesSentByUpstream === false;
}

function sortedEmails(list: { email: string }[]): string[] {
  return list.map((entry) => entry.email.trim().toLowerCase()).sort();
}

/**
 * The whole authoring path's one screen (#233): a Radix `Popover` anchored
 * to `calendar-event-panel.ts`'s shared state — a click point for a fresh
 * create, an `EventChip`'s own rect for an edit, `null` (a centered
 * fallback) for a `/calendar/<seriesId>@<originalStart>` deep link. Exactly
 * one instance is ever mounted (`CalendarRoute.tsx`), which is what "one
 * popover open at a time" (this ticket's own acceptance line) actually
 * means in code — there is nowhere else a second one could come from.
 */
export function EventEditorPopover({ calendars }: { calendars: Calendar[] }) {
  const panel = useEventPanelState();
  const navigate = calendarRoute.useNavigate();
  const currentSearch = calendarRoute.useSearch();

  // Closing always lands back on the bare `/calendar` URL (`replace`, no new
  // history entry, the current `view`/`date` search kept exactly as it was)
  // — a no-op when the panel was opened from a grid click (already there),
  // and what actually leaves `/calendar/$eventKey` behind when it was
  // opened from that deep link (`CalendarEventRoute.tsx`).
  function closePanel() {
    closeEventPanel();
    void navigate({ to: "/calendar", search: currentSearch, replace: true });
  }
  const [eventSeriesId, setEventSeriesId] = useState<string | null>(null);
  const [eventOriginalStart, setEventOriginalStart] = useState<string | null>(null);

  const editingSeriesId = panel?.mode === "edit" ? eventSeriesId : null;
  const cachedSeries = useSeries(editingSeriesId);

  const taskLists = useTaskLists() ?? [];
  const [entityKind, setEntityKind] = useState<EntityKind>("event");
  const [taskListId, setTaskListId] = useState("");
  const [taskDueDate, setTaskDueDateInput] = useState<string | null>(null);
  const [taskDueTime, setTaskDueTimeInput] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [calendarId, setCalendarId] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [allDay, setAllDay] = useState(false);
  const [location, setLocation] = useState("");
  const [description, setDescription] = useState("");
  const [attendeesText, setAttendeesText] = useState("");
  const [recurrence, setRecurrence] = useState<RecurrenceTemplate>("none");
  const [customRecurrence, setCustomRecurrence] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [scope, setScope] = useState<EditScope>("this");
  /** #246: cleared to `true` once this Event's own Snooze row has been acted on, so it doesn't linger after a tap. */
  const [reminderSnoozed, setReminderSnoozed] = useState(false);
  /** The Reminders the User actually sees and edits (#244) — email/absolute alarms live only on `cachedSeries.reminders`, merged back in at save time (`hiddenReminders`). */
  const [reminderMinutes, setReminderMinutes] = useState<number[]>([]);
  /** The Send / Don't send prompt (#242, ADR-0027) — shown only when `handleSave` finds a substantive edit on a self-scheduled Calendar's Series that already has (or newly has) Attendees. */
  const [showSendPrompt, setShowSendPrompt] = useState(false);

  // Resolve the Occurrence a `mode: "edit"` panel names, and hydrate its
  // owning Series' body — the one async step opening an existing Event
  // needs, since a Series is never part of the Local Cache's ordinary sync
  // (`store/series.ts`'s own doc comment).
  useEffect(() => {
    if (panel?.mode !== "edit") {
      setEventSeriesId(null);
      setEventOriginalStart(null);
      return;
    }
    let cancelled = false;
    void readEvent(panel.eventId).then((event) => {
      if (cancelled || !event) return;
      setEventSeriesId(event.seriesId);
      setEventOriginalStart(event.originalStart);
      void hydrateSeries(event.calendarId, event.seriesId);
    });
    return () => {
      cancelled = true;
    };
  }, [panel]);

  // Seeds the form fields whenever what's being edited actually changes —
  // a fresh create, a newly resolved edit target, or the Series body
  // finishing its hydration fetch.
  useEffect(() => {
    if (!panel) return;
    if (panel.mode === "create") {
      setTitle("");
      setCalendarId(panel.calendarId);
      setStart(toLocalInputValue(panel.start));
      setEnd(toLocalInputValue(panel.end));
      setAllDay(panel.allDay);
      setLocation("");
      setDescription("");
      setAttendeesText("");
      setRecurrence("none");
      setCustomRecurrence(false);
      setShowMore(false);
      setScope("all");
      setReminderMinutes([]);
      // "The popover always opens on Event" (#261's own acceptance line) —
      // the switch is never remembered from a previous create. Due prefills
      // from this same click: the clicked day always, the clicked time only
      // when `panel.allDay` is false — a timed-grid click, never the all-day
      // row or a Month cell (`calendar-create.ts#openCreatePanelForDay`).
      setEntityKind("event");
      const clicked = toLocalInputValue(panel.start);
      setTaskDueDateInput(dateOnlyToWireDueDate(clicked.slice(0, 10)));
      setTaskDueTimeInput(panel.allDay ? null : clicked.slice(11, 16));
      // Reset to empty rather than compute the default here — `taskLists`
      // (`store/tasks.ts#useTaskLists`) is a Local Cache live query that can
      // still be resolving its first snapshot when this runs; the effect
      // below picks the default the moment a List is actually available.
      setTaskListId("");
      return;
    }
    if (!cachedSeries || !eventOriginalStart) return;
    const override = cachedSeries.overrides.find((o) => o.originalStart === eventOriginalStart);
    const occurrenceStart = override?.start ?? eventOriginalStart;
    const durationMs = cachedSeries.durationMs;
    const occurrenceEnd = new Date(new Date(occurrenceStart).getTime() + durationMs).toISOString();
    setTitle(override?.title ?? cachedSeries.title);
    setCalendarId(cachedSeries.calendarId);
    setStart(toLocalInputValue(occurrenceStart));
    setEnd(toLocalInputValue(override?.end ?? occurrenceEnd));
    setAllDay(cachedSeries.allDay);
    setLocation(override?.location ?? cachedSeries.location ?? "");
    setDescription(cachedSeries.description ?? "");
    setAttendeesText(cachedSeries.attendees.map((a) => a.email).join(", "));
    const template = recurrenceTemplateFor(cachedSeries.rrules);
    setRecurrence(template ?? "none");
    setCustomRecurrence(template === null);
    setShowMore(false);
    setScope(cachedSeries.rrules.length > 0 ? "this" : "all");
    setReminderMinutes(visibleReminders(cachedSeries.reminders).map((r) => r.minutesBefore));
  }, [panel, cachedSeries, eventOriginalStart]);

  // `taskLists` (`store/tasks.ts#useTaskLists`) resolves from the Local
  // Cache asynchronously — often after the reset above already ran with
  // none loaded yet. Defaults the picker the moment a first List shows up,
  // but only while nothing has been chosen (never overriding a User's own
  // pick mid-create).
  useEffect(() => {
    if (panel?.mode !== "create" || taskListId || taskLists.length === 0) return;
    setTaskListId((taskLists.find((list) => list.isDefault) ?? taskLists[0])?.id ?? "");
  }, [panel, taskListId, taskLists]);

  // `panel.mode === "task"` (#260) is `TaskPopover.tsx`'s own turn at the
  // shared state, not this popover's — excluded here the same way `!panel`
  // already is, so the two never both render a real (`open`) Radix Popover
  // at once over one shared anchor.
  if (!panel || panel.mode === "task") return null;

  const reminderDueIds = panel.mode === "edit" ? panel.reminderDueIds : undefined;

  function handleSnoozeReminder(snoozeUntil: SnoozeUntil) {
    if (!reminderDueIds || reminderDueIds.length === 0) return;
    setReminderSnoozed(true);
    void enqueueUserMutation({ type: "snoozeReminder", reminderDueIds, snoozeUntil });
  }

  const isRecurring = panel.mode === "edit" ? (cachedSeries?.rrules.length ?? 0) > 0 : false;
  const anchorRect = panel.anchorRect ?? { x: window.innerWidth / 2, y: 96, width: 0, height: 0 };

  // Cross-Connected-Account destinations are hidden, not disabled (#238's own
  // acceptance line) — the current Calendar is always kept in the list so the
  // picker still shows where the Event already lives. A read-only Calendar is
  // never itself an eligible *destination* (#282) — `creatableCalendars`'s own
  // gate — though the current Calendar is still kept even when it is one, for
  // the same "shows where the Event already lives" reason.
  const currentCalendar =
    panel.mode === "edit" && cachedSeries
      ? calendars.find((calendar) => calendar.id === cachedSeries.calendarId)
      : undefined;
  const moveDestinationCalendars = currentCalendar
    ? calendars.filter(
        (calendar) =>
          calendar.id === currentCalendar.id ||
          (calendar.capabilities.writable &&
            canMoveBetweenOrigins(currentCalendar.origin, calendar.origin)),
      )
    : creatableCalendars(calendars);

  // #282's own acceptance line: "offers no event creation or editing" on a
  // read-only Calendar — `currentCalendar` is only set once its Series has
  // actually hydrated (`cachedSeries`), so this stays `false` for the brief
  // moment before that resolves, the same tolerance `attendeeFieldDisabled`
  // below already has for the same window.
  const readOnlyEdit =
    panel.mode === "edit" &&
    currentCalendar !== undefined &&
    !currentCalendar.capabilities.writable;

  // The Reminder editor's own ceiling (#244): the Calendar's own
  // `perEventReminders` count, itself never above `MAX_EVENT_REMINDERS` —
  // `currentCalendar` for an edit, the picker's current choice for a create.
  const targetCalendar =
    panel.mode === "create"
      ? calendars.find((calendar) => calendar.id === calendarId)
      : currentCalendar;
  const reminderCap = Math.min(
    MAX_EVENT_REMINDERS,
    targetCalendar?.capabilities.perEventReminders ?? 0,
  );

  // "A User with no Mail Account sees the attendee field disabled" (#242,
  // ADR-0027) — only a self-scheduled Calendar ever organises by mail at
  // all; a synced Calendar's own upstream sends instead, so its attendee
  // field is never gated on a Mail Account here.
  const attendeeFieldDisabled = isSelfScheduled(targetCalendar) && !targetCalendar?.mailAccountId;

  /**
   * Whether this Save owes its Attendees a Send / Don't send prompt
   * (ADR-0027): only on a self-scheduled Calendar (`isSelfScheduled`) with a
   * Mail Account, editing the whole Series (`scope === "all"`) with Attendees
   * either before or after this edit, and only when something the prompt
   * cares about actually changed — time, recurrence, location, title,
   * description, or the Attendee list itself. A Occurrence-only edit
   * (`scope === "this"`) or a Series split (`"thisAndFollowing"`) always
   * sends without asking (this ticket's own scoping decision, see its
   * closing report) — Overrides carry no organiser mail of their own yet.
   */
  function needsSendPrompt(
    attendees: { email: string }[],
    rrules: string[],
    startDate: Date,
    endDate: Date,
  ): boolean {
    if (panel?.mode !== "edit" || scope !== "all" || !cachedSeries) return false;
    if (!isSelfScheduled(currentCalendar) || !currentCalendar?.mailAccountId) return false;
    if (cachedSeries.attendees.length === 0 && attendees.length === 0) return false;

    const nextDtstart = new Date(cachedSeries.dtstart);
    nextDtstart.setHours(startDate.getHours(), startDate.getMinutes(), startDate.getSeconds(), 0);
    const durationMs = Math.max(endDate.getTime() - startDate.getTime(), 0);

    return (
      title !== cachedSeries.title ||
      (description || null) !== cachedSeries.description ||
      (location || null) !== cachedSeries.location ||
      allDay !== cachedSeries.allDay ||
      nextDtstart.getTime() !== new Date(cachedSeries.dtstart).getTime() ||
      durationMs !== cachedSeries.durationMs ||
      JSON.stringify(rrules) !== JSON.stringify(cachedSeries.rrules) ||
      JSON.stringify(sortedEmails(attendees)) !==
        JSON.stringify(sortedEmails(cachedSeries.attendees))
    );
  }

  /**
   * Creating a Task from the switched popover (#261): the ordinary Tasks
   * App create intent (`store/tasks.ts#createTask`), no body, and Due
   * committed right after through its own absolute-set intents
   * (`setTaskDueDate`/`setTaskDueTime`) — `createTaskFromThreadLink`'s own
   * "patch its fields per field" posture, not threaded through `createTask`'s
   * payload. No Undo toast: `createTask` never raises one anywhere else
   * either (`mail/undo-toast.ts`'s own doc comment lists only structural
   * deletes and completions as undoable).
   */
  async function performCreateTask() {
    if (!taskListId) return;
    const id = newTaskId();
    await createTask(id, taskListId, null, title);
    if (taskDueDate) await setTaskDueDate(id, taskDueDate);
    if (taskDueDate && taskDueTime) await setTaskDueTime(id, taskDueTime);
    closePanel();
  }

  function handleSave() {
    if (!panel) return;
    if (panel.mode === "create" && entityKind === "task") {
      void performCreateTask();
      return;
    }
    const startDate = fromLocalInputValue(start);
    const endDate = fromLocalInputValue(end);
    const attendees = parseAttendees(attendeesText);
    const rrules = customRecurrence ? (cachedSeries?.rrules ?? []) : rrulesForTemplate(recurrence);

    if (needsSendPrompt(attendees, rrules, startDate, endDate)) {
      setShowSendPrompt(true);
      return;
    }
    void performSave(true);
  }

  async function performSave(sendUpdate: boolean) {
    if (!panel) return;
    setShowSendPrompt(false);
    const startDate = fromLocalInputValue(start);
    const endDate = fromLocalInputValue(end);
    const durationMs = Math.max(endDate.getTime() - startDate.getTime(), 0);
    const attendees = parseAttendees(attendeesText);
    const rrules = customRecurrence ? (cachedSeries?.rrules ?? []) : rrulesForTemplate(recurrence);
    const reminders = reminderMinutes.map(relativePopupReminder);

    if (panel.mode === "create") {
      const id = newSeriesId();
      await createSeries(id, calendarId);
      const fields: SeriesBodyFields = {
        title: title || "(No title)",
        description: description || null,
        location: location || null,
        allDay,
        floating: false,
        tzid: allDay ? null : BROWSER_TZID,
        dtstart: startDate.toISOString(),
        durationMs,
        rrules,
        rdates: [],
        exdates: [],
        transparency: "opaque",
        attendees,
        reminders,
        overrides: [],
      };
      await saveSeriesBody(id, calendarId, fields);
      closePanel();
      return;
    }

    if (!cachedSeries || !eventOriginalStart) return;

    if (scope === "this") {
      const others = cachedSeries.overrides.filter((o) => o.originalStart !== eventOriginalStart);
      const overrideId =
        cachedSeries.overrides.find((o) => o.originalStart === eventOriginalStart)?.id ??
        newOverrideId();
      const fields: SeriesBodyFields = {
        title: cachedSeries.title,
        description: cachedSeries.description,
        location: cachedSeries.location,
        allDay: cachedSeries.allDay,
        floating: cachedSeries.floating,
        tzid: cachedSeries.tzid,
        dtstart: cachedSeries.dtstart,
        durationMs: cachedSeries.durationMs,
        rrules: cachedSeries.rrules,
        rdates: cachedSeries.rdates,
        exdates: cachedSeries.exdates,
        transparency: cachedSeries.transparency,
        attendees: cachedSeries.attendees,
        // Reminders are Series content, not an Override field (#244's own
        // body) — "this Occurrence only" never touches them, the same
        // "unchanged" posture `attendees` above already has.
        reminders: cachedSeries.reminders,
        overrides: [
          ...others,
          {
            id: overrideId,
            originalStart: eventOriginalStart,
            start: startDate.toISOString(),
            end: endDate.toISOString(),
            title: title || null,
            location: location || null,
          },
        ],
      };
      await saveSeriesBody(cachedSeries.id, cachedSeries.calendarId, fields);
    } else if (scope === "all") {
      const nextDtstart = new Date(cachedSeries.dtstart);
      nextDtstart.setHours(startDate.getHours(), startDate.getMinutes(), startDate.getSeconds(), 0);
      const fields: SeriesBodyFields = {
        title: title || "(No title)",
        description: description || null,
        location: location || null,
        allDay,
        floating: cachedSeries.floating,
        tzid: allDay ? null : (cachedSeries.tzid ?? BROWSER_TZID),
        dtstart: nextDtstart.toISOString(),
        durationMs,
        rrules,
        rdates: cachedSeries.rdates,
        exdates: cachedSeries.exdates,
        transparency: cachedSeries.transparency,
        attendees,
        reminders: [...hiddenReminders(cachedSeries.reminders), ...reminders],
        overrides: cachedSeries.overrides,
      };
      // The Calendar picker is a Move (below), a separate Optimistic Action
      // from this body Save (#238's own acceptance line: "one Optimistic
      // Action with one Undo") — Save always targets the Series' *current*
      // Calendar, never whatever the picker happens to show.
      await saveSeriesBody(cachedSeries.id, cachedSeries.calendarId, fields, sendUpdate);
    } else {
      // "This and following" (#233): cap the old Series just before this
      // Occurrence, then create its continuation as a brand-new Series with
      // a new UID (`recurrence.ts#withUntil`'s own doc comment).
      const cutover = new Date(eventOriginalStart);
      cutover.setSeconds(cutover.getSeconds() - 1);
      const cappedRrules = withUntil(cachedSeries.rrules, cutover, cachedSeries.allDay);
      await saveSeriesBody(cachedSeries.id, cachedSeries.calendarId, {
        title: cachedSeries.title,
        description: cachedSeries.description,
        location: cachedSeries.location,
        allDay: cachedSeries.allDay,
        floating: cachedSeries.floating,
        tzid: cachedSeries.tzid,
        dtstart: cachedSeries.dtstart,
        durationMs: cachedSeries.durationMs,
        rrules: cappedRrules,
        rdates: cachedSeries.rdates,
        exdates: cachedSeries.exdates,
        transparency: cachedSeries.transparency,
        attendees: cachedSeries.attendees,
        reminders: cachedSeries.reminders,
        overrides: cachedSeries.overrides,
      });

      const newId = newSeriesId();
      await createSeries(newId, calendarId);
      await saveSeriesBody(newId, calendarId, {
        title: title || "(No title)",
        description: description || null,
        location: location || null,
        allDay,
        floating: cachedSeries.floating,
        tzid: allDay ? null : (cachedSeries.tzid ?? BROWSER_TZID),
        dtstart: startDate.toISOString(),
        durationMs,
        rrules,
        rdates: [],
        exdates: [],
        transparency: cachedSeries.transparency,
        attendees,
        reminders: [...hiddenReminders(cachedSeries.reminders), ...reminders],
        overrides: [],
      });
    }
    closePanel();
  }

  function handleDeleteOccurrence() {
    if (!cachedSeries || !eventOriginalStart) return;
    const seriesId = cachedSeries.id;
    const exdate = eventOriginalStart;
    void addExdate(seriesId, exdate);
    announceUndoableAction("eventDelete", () => void removeExdate(seriesId, exdate));
    closePanel();
  }

  function handleDeleteSeries() {
    if (!cachedSeries) return;
    const seriesId = cachedSeries.id;
    void trashSeries(seriesId);
    announceUndoableAction("seriesDelete", () => void restoreSeries(seriesId));
    closePanel();
  }

  /**
   * Moving an Event between Calendars (#238): a genuinely separate
   * Optimistic Action from `handleSave`'s body edit, fired the instant the
   * picker changes rather than folded into Save — "one Optimistic Action
   * with one Undo" per Move, the same shape `handleDeleteSeries` above
   * already has. Undo is `restoreSeries`/`trashSeries` on the two Series ids
   * involved (`store/series.ts#moveSeries`'s own doc comment), not a
   * dedicated inverse intent.
   */
  function handleMoveTo(targetCalendarId: string) {
    if (!cachedSeries || targetCalendarId === cachedSeries.calendarId) return;
    const seriesId = cachedSeries.id;
    const movedSeriesId = newSeriesId();
    void moveSeries(seriesId, movedSeriesId, targetCalendarId);
    announceUndoableAction("eventMove", () => {
      void restoreSeries(seriesId);
      void trashSeries(movedSeriesId);
    });
    closePanel();
  }

  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open) closePanel();
      }}
    >
      <PopoverAnchor asChild>
        <div
          style={{
            position: "fixed",
            left: anchorRect.x,
            top: anchorRect.y,
            width: Math.max(anchorRect.width, 1),
            height: Math.max(anchorRect.height, 1),
            pointerEvents: "none",
          }}
        />
      </PopoverAnchor>
      <PopoverContent className="calendar-event-editor" onOpenAutoFocus={(e) => e.preventDefault()}>
        <PopoverHeader>
          <PopoverTitle>
            {panel.mode === "edit"
              ? "Edit event"
              : entityKind === "task"
                ? "New Task"
                : "New event"}
          </PopoverTitle>
        </PopoverHeader>

        {/* #282's own acceptance line: a read-only Calendar's Event "offers
            no ... editing" — this note is the only thing this popover adds
            beyond disabling every field below, since nothing here is ever
            hidden outright (a User should still be able to read what a
            read-only Event says, just never change it). */}
        {readOnlyEdit ? (
          <p className="calendar-event-editor-readonly-note">
            Read-only — this Calendar doesn't allow changes.
          </p>
        ) : null}

        {panel.mode === "create" ? (
          // biome-ignore lint/a11y/useSemanticElements: a `<fieldset>` brings its own default border/padding chrome that fights `.calendar-event-editor-row`'s own flex-row look; `role="group"` gives the same "these two toggle buttons are one control" semantics with none of it.
          <div className="calendar-event-editor-row" role="group" aria-label="Event or Task">
            <Button
              type="button"
              variant={entityKind === "event" ? "default" : "ghost"}
              size="sm"
              aria-pressed={entityKind === "event"}
              onClick={() => setEntityKind("event")}
            >
              Event
            </Button>
            <Button
              type="button"
              variant={entityKind === "task" ? "default" : "ghost"}
              size="sm"
              aria-pressed={entityKind === "task"}
              onClick={() => setEntityKind("task")}
            >
              Task
            </Button>
          </div>
        ) : null}

        {reminderDueIds && reminderDueIds.length > 0 ? (
          <div className="calendar-event-editor-row calendar-reminder-snooze-row">
            {reminderSnoozed ? (
              <span>Snoozed.</span>
            ) : (
              <>
                <span>Reminder — Snooze:</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => handleSnoozeReminder({ kind: "minutes", minutes: 5 })}
                >
                  5 min
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => handleSnoozeReminder({ kind: "minutes", minutes: 10 })}
                >
                  10 min
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => handleSnoozeReminder({ kind: "minutes", minutes: 15 })}
                >
                  15 min
                </Button>
                {/* "The last dropped once the Event has begun" (ADR-0028) — `start` is already this Occurrence's own local datetime-input value, seeded above. */}
                {start && fromLocalInputValue(start).getTime() > Date.now() ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => handleSnoozeReminder({ kind: "eventStart" })}
                  >
                    At start
                  </Button>
                ) : null}
              </>
            )}
          </div>
        ) : null}

        <Input
          autoFocus
          placeholder="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          disabled={readOnlyEdit}
        />

        {panel.mode === "create" && entityKind === "task" ? (
          <>
            <TaskDuePicker
              dueDate={taskDueDate}
              dueTime={taskDueTime}
              onSetDate={(dueDate) => {
                setTaskDueDateInput(dueDate);
                if (dueDate === null) setTaskDueTimeInput(null);
              }}
              onSetTime={setTaskDueTimeInput}
            />
            <Select value={taskListId} onValueChange={setTaskListId}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Task List" />
              </SelectTrigger>
              <SelectContent>
                {taskLists.map((list) => (
                  <SelectItem key={list.id} value={list.id}>
                    {list.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        ) : (
          <>
            <div className="calendar-event-editor-row">
              <label>
                <input
                  type="checkbox"
                  checked={allDay}
                  onChange={(e) => setAllDay(e.target.checked)}
                  disabled={readOnlyEdit}
                />{" "}
                All day
              </label>
            </div>
            <div className="calendar-event-editor-row">
              <input
                type={allDay ? "date" : "datetime-local"}
                value={allDay ? start.slice(0, 10) : start}
                onChange={(e) => setStart(e.target.value)}
                disabled={readOnlyEdit}
              />
              <span>–</span>
              <input
                type={allDay ? "date" : "datetime-local"}
                value={allDay ? end.slice(0, 10) : end}
                onChange={(e) => setEnd(e.target.value)}
                disabled={readOnlyEdit}
              />
            </div>

            <Select
              value={calendarId}
              onValueChange={panel.mode === "edit" ? handleMoveTo : setCalendarId}
              // A Move only ever carries a whole Series — its Overrides and
              // `exdates` (#238's own acceptance line) — so the picker is
              // read-only while editing just one Occurrence or splitting off a
              // continuation; only "All events" can move Calendars. A
              // read-only Calendar's own Event (#282) never offers a Move
              // either — there is nothing here a Save could ever commit.
              disabled={(panel.mode === "edit" && scope !== "all") || readOnlyEdit}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Calendar" />
              </SelectTrigger>
              <SelectContent>
                {moveDestinationCalendars.map((calendar) => (
                  <SelectItem key={calendar.id} value={calendar.id}>
                    {calendar.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {panel.mode === "edit" && isRecurring ? (
              <div className="calendar-event-editor-scope">
                <label>
                  <input
                    type="radio"
                    checked={scope === "this"}
                    onChange={() => setScope("this")}
                  />{" "}
                  This event
                </label>
                <label>
                  <input type="radio" checked={scope === "all"} onChange={() => setScope("all")} />{" "}
                  All events
                </label>
                <label>
                  <input
                    type="radio"
                    checked={scope === "thisAndFollowing"}
                    onChange={() => setScope("thisAndFollowing")}
                  />{" "}
                  This and following
                </label>
              </div>
            ) : null}

            <Button type="button" variant="ghost" size="sm" onClick={() => setShowMore((v) => !v)}>
              {showMore ? "Fewer details" : "More details"}
            </Button>

            {showMore && scope !== "this" ? (
              <div className="calendar-event-editor-more">
                {customRecurrence ? (
                  <p className="calendar-event-editor-custom-recurrence">
                    Custom recurrence (read-only)
                  </p>
                ) : (
                  <Select
                    value={recurrence}
                    onValueChange={(value) => setRecurrence(value as RecurrenceTemplate)}
                    disabled={readOnlyEdit}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {RECURRENCE_TEMPLATES.map((template) => (
                        <SelectItem key={template} value={template}>
                          {RECURRENCE_LABEL[template]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                <textarea
                  placeholder="Attendees (comma-separated emails)"
                  value={attendeesText}
                  onChange={(e) => setAttendeesText(e.target.value)}
                  disabled={attendeeFieldDisabled || readOnlyEdit}
                  title={
                    attendeeFieldDisabled ? "Connect a mail account to invite people" : undefined
                  }
                  rows={2}
                />
                {attendeeFieldDisabled ? (
                  <p className="calendar-event-editor-attendee-hint">
                    Connect a mail account to invite people
                  </p>
                ) : null}
                <textarea
                  placeholder="Description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  disabled={readOnlyEdit}
                  rows={3}
                />
                {reminderCap > 0 && !readOnlyEdit ? (
                  <ReminderMinutesEditor
                    minutesList={reminderMinutes}
                    allDay={allDay}
                    cap={reminderCap}
                    onChange={setReminderMinutes}
                  />
                ) : null}
              </div>
            ) : null}

            {showMore || scope === "this" ? (
              <Input
                placeholder="Location"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                disabled={readOnlyEdit}
              />
            ) : null}
          </>
        )}

        <div className="calendar-event-editor-actions">
          {panel.mode === "edit" && !readOnlyEdit ? (
            <>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={isRecurring ? handleDeleteOccurrence : handleDeleteSeries}
              >
                Delete
              </Button>
              {isRecurring ? (
                <Button type="button" variant="ghost" size="sm" onClick={handleDeleteSeries}>
                  Delete series
                </Button>
              ) : null}
            </>
          ) : null}
          {/* #282: nothing on a read-only Calendar's own Event ever has
              anything left to Save — every field above is already disabled,
              so the button would only ever roll back. */}
          {!readOnlyEdit ? (
            <Button type="button" size="sm" onClick={() => void handleSave()}>
              Save
            </Button>
          ) : null}
        </div>
      </PopoverContent>

      <Dialog open={showSendPrompt} onOpenChange={setShowSendPrompt}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send update to guests?</DialogTitle>
            <DialogDescription>
              This event has guests. Do you want to send them an update?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void performSave(false)}
            >
              Don't send
            </Button>
            <Button type="button" size="sm" onClick={() => void performSave(true)}>
              Send
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Popover>
  );
}
