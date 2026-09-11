/**
 * A thin, typed wrapper over the Microsoft Graph REST resources #248 needs —
 * `calendars`, `calendarView/delta`, `mailboxSettings` and `events` v1.0 —
 * the same "inject the network boundary, one `fetch()` interface, no vendor
 * SDK" shape `google/client.ts` already gives #234/#237. `GraphCalendarClient`
 * is an interface for the same reason: `calendar-list-sync.ts`/`event-sync.ts`/
 * `outbox-processor.ts` exercise it against a hand-rolled fake, never a live
 * Microsoft account.
 *
 * Every call here targets the **v1.0** surface only (this ticket's own
 * acceptance line: "the calendar list diffed on `changeKey` from
 * `GET /me/calendars` (v1.0, not beta)") — nothing in this file ever
 * addresses `https://graph.microsoft.com/beta`. See `event-sync.ts`'s own
 * doc comment for the one place that contract still needs a live account to
 * confirm: `calendarView/delta` **on a non-default calendar**.
 */

const API_BASE = "https://graph.microsoft.com/v1.0";

export interface GraphCalendarOwner {
  name?: string;
  address?: string;
}

export interface GraphCalendarListEntry {
  id: string;
  name: string;
  /** Read-only — Graph's own hex swatch, empty when the user never set one. Never written back (this ticket's own acceptance line: "`hexColor` stays read-only"). */
  hexColor?: string;
  canEdit: boolean;
  isDefaultCalendar?: boolean;
  /** Identifies this Calendar's own version — this ticket's own "diffed on `changeKey`" cursor, not a write concurrency token (that's the event resource's own `changeKey`, a different value). */
  changeKey: string;
  owner?: GraphCalendarOwner;
}

/** `Prefer: outlook.timezone` is deliberately never sent — every `start`/`end` below always carries its own explicit `timeZone`, so nothing depends on the header's mailbox-wide default. */
export interface GraphDateTimeZone {
  dateTime: string;
  /** An IANA zone name for a genuinely zoned instant; absent entirely for a floating one (`event-body.ts`'s own convention, mirroring `google/event-body.ts`'s). */
  timeZone?: string;
}

export type GraphRecurrencePatternType =
  | "daily"
  | "weekly"
  | "absoluteMonthly"
  | "relativeMonthly"
  | "absoluteYearly"
  | "relativeYearly";

export type GraphDayOfWeek =
  | "sunday"
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday";

export interface GraphRecurrencePattern {
  type: GraphRecurrencePatternType;
  interval: number;
  daysOfWeek?: GraphDayOfWeek[];
  firstDayOfWeek?: GraphDayOfWeek;
  dayOfMonth?: number;
  month?: number;
}

export interface GraphRecurrenceRange {
  type: "endDate" | "noEnd" | "numbered";
  startDate: string;
  endDate?: string;
  recurrenceTimeZone?: string;
}

export interface GraphPatternedRecurrence {
  pattern: GraphRecurrencePattern;
  range: GraphRecurrenceRange;
}

export interface GraphAttendee {
  emailAddress: { address: string; name?: string };
  type?: "required" | "optional" | "resource";
}

/**
 * The subset of Graph's `event` resource #248 reads. `type`/`seriesMasterId`
 * mirror Google's own `recurringEventId`/`originalStartTime` pair — Graph's
 * `calendarView` already expands a recurring series into `occurrence`/
 * `exception` rows the same way Google's `singleEvents=true` does, so, as
 * with #234, nothing here ever reconstructs a Series from these rows; it
 * upserts Occurrences directly (`event-sync.ts`'s own doc comment).
 * `isCancelled` is how an *attendee's* copy of an event the organizer
 * cancelled elsewhere keeps showing up in `calendarView/delta` rather than
 * vanishing outright — the organizer's own cancel instead removes the row
 * entirely (`event: cancel`'s documented "moves the event to Deleted
 * Items"), which `calendarView/delta` then reports as `@removed` (`removed`
 * below), Graph's own delta convention for every delta-tracked resource.
 */
export interface GraphEvent {
  id: string;
  changeKey: string;
  subject?: string;
  body?: { contentType: "text" | "html"; content: string };
  location?: { displayName?: string };
  start?: GraphDateTimeZone;
  end?: GraphDateTimeZone;
  isAllDay?: boolean;
  isCancelled?: boolean;
  type?: "singleInstance" | "occurrence" | "exception" | "seriesMaster";
  seriesMasterId?: string;
  /** Present on an `occurrence`/`exception` row — the same "instance's own natural key" `originalStartTime` gives a Google event. Absent on a `singleInstance`/`seriesMaster` row. */
  originalStart?: string;
  recurrence?: GraphPatternedRecurrence | null;
  showAs?: "free" | "tentative" | "busy" | "oof" | "workingElsewhere" | "unknown";
  reminderMinutesBeforeStart?: number;
  isReminderOn?: boolean;
  attendees?: GraphAttendee[];
}

/**
 * One delta page's own entry — Graph's universal delta-query convention
 * (`learn.microsoft.com/graph/delta-query-overview`): a live row is a
 * normal `event` resource, a deleted one carries only `id` and `@removed`
 * (no `changeKey`, no `start`/`end` — `event-sync.ts`'s own doc comment on
 * why that matters). `Partial<GraphEvent>` reflects that: only `id` is
 * guaranteed present on every entry.
 */
export type GraphDeltaEntry = Partial<GraphEvent> &
  Pick<GraphEvent, "id"> & { "@removed"?: { reason: string } };

export interface GraphDeltaPage {
  items: GraphDeltaEntry[];
  /** Set on every page but the last — walk this before trusting `deltaLink`. */
  nextLink?: string;
  /** Set only on the final page of a round — persist this as the next round's own starting point. */
  deltaLink?: string;
}

/** Thrown for a `410 Gone` — Graph's own signal (shared across every delta-tracked resource) that a `deltaLink` has expired or is otherwise invalid and a full re-list is required. */
export class GraphDeltaExpiredError extends Error {
  constructor() {
    super("Graph calendarView delta expired or invalid (410 Gone)");
    this.name = "GraphDeltaExpiredError";
  }
}

export type GraphWriteErrorKind = "conflict" | "permanent" | "transient" | "needsReauth";

export class GraphCalendarWriteError extends Error {
  readonly kind: GraphWriteErrorKind;
  readonly status: number;
  constructor(kind: GraphWriteErrorKind, status: number, detail: string) {
    super(`Microsoft Graph calendar write error (${status}): ${detail}`);
    this.name = "GraphCalendarWriteError";
    this.kind = kind;
    this.status = status;
  }
}

/**
 * `401` reached mid-flight is Needs Reauth, the same reasoning
 * `google/client.ts#classifyWriteStatus` gives; `429`/`5xx` are transient.
 * Graph has no documented `412`/`If-Match` support on an event write (this
 * ticket's own acceptance line) — a conflict is never discovered from the
 * write response's own status here, only from the pre-write `changeKey`
 * compare `outbox-processor.ts` does before ever calling `patchEvent`. A
 * `405` (a group-calendar container's `PATCH`, `patchCalendar`'s own doc
 * comment) is permanent, not retried.
 */
function classifyWriteStatus(status: number): GraphWriteErrorKind {
  if (status === 401) return "needsReauth";
  if (status === 429 || status >= 500) return "transient";
  return "permanent";
}

async function throwOnWriteError(response: Response, context: string): Promise<void> {
  if (response.ok) return;
  const detail = await response.text().catch(() => response.statusText);
  throw new GraphCalendarWriteError(
    classifyWriteStatus(response.status),
    response.status,
    `${context}: ${detail}`,
  );
}

async function graphGet(accessToken: string, url: string): Promise<Response> {
  return fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
}

function throwOnReadError(response: Response, context: string): void {
  if (response.status === 410) throw new GraphDeltaExpiredError();
  if (!response.ok) {
    throw new Error(`Microsoft Graph calendar API error (${context}): ${response.status}`);
  }
}

export type SendUpdatesPolicy = "all" | "none";

export type GraphEventWriteBody = Omit<
  GraphEvent,
  "id" | "changeKey" | "isCancelled" | "type" | "seriesMasterId" | "originalStart"
>;

export interface GraphCalendarClient {
  /** `GET /me/calendars` — the whole enumeration in one call (Graph folds `CalendarList`+`Calendars` into one resource, unlike Google's own two). */
  listCalendars(accessToken: string): Promise<GraphCalendarListEntry[]>;
  /** `GET /me/mailboxSettings` — the mailbox-wide `timeZone` every one of this account's Calendars shares (this ticket's own acceptance line: "Graph has no calendar-level default-reminder setting at all... Time zone comes from the mailbox-wide `mailboxSettings.timeZone`"). */
  getMailboxTimeZone(accessToken: string): Promise<string>;
  /**
   * One page of `calendarView/delta` for one Calendar, bounded by
   * `[start, end]` on the very first call of a round and by `deltaLink`/
   * `nextLink` on every call after — `event-sync.ts` walks `nextLink`
   * itself so it can bail out mid-walk on `isStopped()`, the same split
   * `google/client.ts#listEventsPage` draws.
   */
  listCalendarViewDeltaPage(
    accessToken: string,
    graphCalendarId: string,
    params: { deltaLink?: string; start?: Date; end?: Date },
  ): Promise<GraphDeltaPage>;
  /** `POST /me/calendars/{id}/events` — always a fresh create; Graph's `restore` has no conditional form (`outbox-processor.ts`'s own doc comment explains why `restore` always calls this, never `patchEvent`). */
  insertEvent(
    accessToken: string,
    graphCalendarId: string,
    body: GraphEventWriteBody,
  ): Promise<GraphEvent>;
  /** `GET /me/events/{id}` — the one call `outbox-processor.ts` makes before every `patchEvent`, to compare `changeKey` in place of an `If-Match` Graph does not document. */
  getEvent(accessToken: string, eventId: string): Promise<GraphEvent>;
  /** `PATCH /me/events/{id}` — never conditional (no `If-Match` sent; see this file's own doc comment and `outbox-processor.ts`'s pre-write compare). */
  patchEvent(
    accessToken: string,
    eventId: string,
    body: Partial<GraphEventWriteBody>,
  ): Promise<GraphEvent>;
  /** `POST /me/events/{id}/cancel` — the organizer-only action that notifies attendees and removes the event from this mailbox (`event: cancel`'s own documented behaviour); `outbox-processor.ts`'s `cancel` operation, never a bare `DELETE`, since Graph has no way to suppress the notice anyway (`canSuppressInviteMail: false`). */
  cancelEvent(accessToken: string, eventId: string, comment?: string): Promise<void>;
  /**
   * `POST /me/events/{id}/accept|decline|tentativelyAccept` (#240,
   * ADR-0027) — the *only* documented way an attendee answers an Invitation
   * on Graph; there is no generic attendee-`responseStatus` field on a plain
   * event `PATCH` the way Google's `attendees[]` allows. `sendResponse:
   * true` always, regardless of the "Send invitations" toggle: that toggle
   * is organizer-side (`canSuppressInviteMail`), and an attendee's own
   * `REPLY` reaching the organizer is the whole point of answering at all.
   * No response body to return — `outbox-processor.ts`'s own `respond`
   * branch leaves `series.upstreamId`/`etag` untouched, same tolerance
   * `cancelEvent` already gets.
   */
  respondToEvent(
    accessToken: string,
    eventId: string,
    response: "accept" | "decline" | "tentativelyAccept",
  ): Promise<void>;
  /**
   * `PATCH /me/calendars/{id}` — name, colour (`hexColor` is read-only, so
   * this sends `color`'s own enum instead — see this ticket's closing
   * comment for the one open question that leaves) and
   * `isDefaultCalendar` only (this ticket's own acceptance line). A `405`
   * (a group-calendar container) surfaces as `GraphCalendarWriteError`
   * with `kind: "permanent"`, same as any other 4xx — nothing here retries
   * it. Exposed for parity with the read side; nothing in this app's
   * routes calls it yet (no calendar-rename surface exists for *any*
   * provider today — see this ticket's closing comment).
   */
  patchCalendar(
    accessToken: string,
    graphCalendarId: string,
    body: { name?: string; isDefaultCalendar?: boolean },
  ): Promise<GraphCalendarListEntry>;
}

function toGraphEventWriteBody(body: GraphEventWriteBody): Record<string, unknown> {
  // A plain spread would still send `attendees: undefined` etc. as explicit
  // JSON `null`-free keys — harmless to Graph, but noisy in a test's own
  // request-body assertions, so this drops anything left `undefined`.
  return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
}

/** The real implementation, hitting Microsoft Graph's v1.0 REST API. `createGraphCalendarClient()` with no arguments is the production instance. */
export function createGraphCalendarClient(): GraphCalendarClient {
  return {
    async listCalendars(accessToken) {
      const entries: GraphCalendarListEntry[] = [];
      let url: string | undefined = `${API_BASE}/me/calendars?$top=250`;
      while (url) {
        const response: Response = await graphGet(accessToken, url);
        throwOnReadError(response, "calendars.list");
        const body = (await response.json()) as {
          value?: GraphCalendarListEntry[];
          "@odata.nextLink"?: string;
        };
        entries.push(...(body.value ?? []));
        url = body["@odata.nextLink"];
      }
      return entries;
    },

    async getMailboxTimeZone(accessToken) {
      const response = await graphGet(accessToken, `${API_BASE}/me/mailboxSettings`);
      throwOnReadError(response, "mailboxSettings.get");
      const body = (await response.json()) as { timeZone?: string };
      // Empty string is Graph's own "never configured" — UTC is the only
      // honest fallback with no per-User Home Time Zone to read instead
      // (that's a Local Calendar's own #189 concern, not this mailbox's).
      return body.timeZone && body.timeZone.length > 0 ? body.timeZone : "UTC";
    },

    async listCalendarViewDeltaPage(accessToken, graphCalendarId, { deltaLink, start, end }) {
      let url: string;
      if (deltaLink) {
        url = deltaLink;
      } else {
        const base = new URL(
          `${API_BASE}/me/calendars/${encodeURIComponent(graphCalendarId)}/calendarView/delta`,
        );
        if (start) base.searchParams.set("startDateTime", start.toISOString());
        if (end) base.searchParams.set("endDateTime", end.toISOString());
        url = base.toString();
      }
      const response = await graphGet(accessToken, url);
      throwOnReadError(response, "calendarView.delta");
      const body = (await response.json()) as {
        value?: GraphDeltaEntry[];
        "@odata.nextLink"?: string;
        "@odata.deltaLink"?: string;
      };
      return {
        items: body.value ?? [],
        nextLink: body["@odata.nextLink"],
        deltaLink: body["@odata.deltaLink"],
      };
    },

    async insertEvent(accessToken, graphCalendarId, body) {
      const response = await fetch(
        `${API_BASE}/me/calendars/${encodeURIComponent(graphCalendarId)}/events`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(toGraphEventWriteBody(body)),
        },
      );
      await throwOnWriteError(response, "events.insert");
      return (await response.json()) as GraphEvent;
    },

    async getEvent(accessToken, eventId) {
      const response = await graphGet(
        accessToken,
        `${API_BASE}/me/events/${encodeURIComponent(eventId)}`,
      );
      await throwOnWriteError(response, "events.get");
      return (await response.json()) as GraphEvent;
    },

    async patchEvent(accessToken, eventId, body) {
      const response = await fetch(`${API_BASE}/me/events/${encodeURIComponent(eventId)}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(toGraphEventWriteBody(body)),
      });
      await throwOnWriteError(response, "events.patch");
      return (await response.json()) as GraphEvent;
    },

    async cancelEvent(accessToken, eventId, comment) {
      const response = await fetch(`${API_BASE}/me/events/${encodeURIComponent(eventId)}/cancel`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(comment ? { comment } : {}),
      });
      await throwOnWriteError(response, "events.cancel");
    },

    async respondToEvent(accessToken, eventId, response) {
      const httpResponse = await fetch(
        `${API_BASE}/me/events/${encodeURIComponent(eventId)}/${response}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ sendResponse: true }),
        },
      );
      await throwOnWriteError(httpResponse, `events.${response}`);
    },

    async patchCalendar(accessToken, graphCalendarId, body) {
      const response = await fetch(
        `${API_BASE}/me/calendars/${encodeURIComponent(graphCalendarId)}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        },
      );
      await throwOnWriteError(response, "calendars.patch");
      return (await response.json()) as GraphCalendarListEntry;
    },
  };
}
