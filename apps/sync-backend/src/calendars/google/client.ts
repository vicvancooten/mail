/**
 * A thin, typed wrapper over the two Google REST resources #234 needs —
 * `CalendarList`, `Calendars` and `Events` v3 — rather than a dependency on
 * `googleapis`, whose generated client pulls in far more than three
 * `fetch()` calls call for. Gmail sync on this line never talks to a Google
 * REST endpoint at all (it's plain IMAP/SMTP with XOAUTH2,
 * `mail-accounts/google-adapter.ts`), so there is nothing to share with —
 * this is genuinely new plumbing.
 *
 * `GoogleCalendarClient` is an interface, not just this file's own function
 * exports, so `calendar-list-sync.ts`/`event-sync.ts` can be exercised in a
 * unit test against a hand-rolled fake instead of a live Google account —
 * the same "inject the network boundary" shape `ProviderAdapter`
 * (`mail-accounts/provider-adapter.ts`) already gives OAuth refresh.
 */

const API_BASE = "https://www.googleapis.com/calendar/v3";

/** One `reminders.overrides`/`defaultReminders` entry — Google's own shape, shared by a Calendar's default list and an Event's explicit one. */
export interface GoogleEventReminder {
  method: "email" | "popup";
  minutes: number;
}

export interface GoogleCalendarListEntry {
  id: string;
  summary?: string;
  backgroundColor?: string;
  accessRole: "owner" | "writer" | "reader" | "freeBusyReader";
  primary?: boolean;
  /** The User's own Google-side default Reminders for this calendar — seeds `Calendar.reminderDefault` once (#244, ADR-0028), never read again after that. */
  defaultReminders?: GoogleEventReminder[];
}

export interface GoogleCalendarMetadata {
  id: string;
  summary?: string;
  description?: string;
  timeZone: string;
}

export interface GoogleEventDateTime {
  date?: string;
  dateTime?: string;
  /** Set only for the plain timed case — a floating `dateTime` carries no offset and no zone, an all-day `date` needs neither. */
  timeZone?: string;
}

export interface GoogleEventAttendee {
  email: string;
  displayName?: string;
  responseStatus?: "needsAction" | "accepted" | "declined" | "tentative";
}

export interface GoogleEvent {
  id: string;
  status: "confirmed" | "tentative" | "cancelled";
  summary?: string;
  description?: string;
  location?: string;
  start?: GoogleEventDateTime;
  end?: GoogleEventDateTime;
  /** Present on an expanded recurring instance; absent on a singleton event or the recurring series' own (unexpanded) row. */
  recurringEventId?: string;
  originalStartTime?: GoogleEventDateTime;
  /** RFC 5545 `RRULE:`/`RDATE:`/`EXDATE:` lines — present only on a recurring master event (#237). */
  recurrence?: string[];
  attendees?: GoogleEventAttendee[];
  transparency?: "opaque" | "transparent";
  /** `useDefault: true` means "no explicit Reminder — Google's own account-level default applies", the same "ask for the default" meaning an empty `Series.reminders` carries in Wicket (#244, ADR-0028). */
  reminders?: { useDefault: boolean; overrides?: GoogleEventReminder[] };
  sequence?: number;
  /** Present on every response #237's write methods return — the conditional-write concurrency token (`If-Match`). */
  etag?: string;
}

/**
 * The subset of `GoogleEvent` #237's write methods accept as a request
 * body — never `id`/`etag`, which the two write verbs below carry (or
 * return) their own way. `status` is `optional` here (unlike `GoogleEvent`
 * itself, where every real event has one): `insertEvent` never sets it
 * (Google defaults a fresh event to `confirmed`), and `patchEvent` sets it
 * only for `trashSeries`/`restoreSeries`'s own status-flip pushes
 * (`outbox-processor.ts`) — this ticket's own acceptance line, "`restoreEvent`
 * on Google is a status flip, not a fresh create".
 */
export type GoogleEventWriteBody = Omit<
  GoogleEvent,
  "id" | "status" | "etag" | "recurringEventId" | "originalStartTime"
> & { status?: GoogleEvent["status"] };

export interface GoogleEventsPage {
  items: GoogleEvent[];
  /** Present once the page carrying it is the last one — the token to persist for the next incremental sync. */
  nextSyncToken?: string;
}

/** Thrown for a `410 Gone` — Google's own signal that a `syncToken` has expired and a full re-list is required (never a Client-visible `reset: true`, per this ticket). */
export class GoogleSyncTokenExpiredError extends Error {
  constructor() {
    super("Google syncToken expired (410 Gone)");
    this.name = "GoogleSyncTokenExpiredError";
  }
}

export interface ListEventsParams {
  syncToken?: string;
  /** Only meaningful without a `syncToken` — Google rejects `timeMin`/`timeMax` alongside one. */
  timeMin?: string;
  timeMax?: string;
  pageToken?: string;
}

/** Whether Google's own response to a write should notify attendees — `sendUpdates=all` for the User's "Send invitations" toggle on, `none` for off (`canSuppressInviteMail`, this ticket's own acceptance line). Never `externalOnly`: nothing in this product distinguishes an internal from an external attendee. */
export type SendUpdatesPolicy = "all" | "none";

export interface InsertEventParams {
  body: GoogleEventWriteBody;
  sendUpdates: SendUpdatesPolicy;
}

export interface PatchEventParams {
  body: Partial<GoogleEventWriteBody>;
  sendUpdates: SendUpdatesPolicy;
  /** The Series' own last-known `etag` — sent as `If-Match` so a stale write is rejected as a `412`, never silently overwritten (this ticket's own acceptance line: "writes are conditional on the mirrored etag"). Omitted only for a Series that has never yet been confirmed upstream at all. */
  ifMatchEtag?: string | null;
}

export interface GoogleCalendarClient {
  listCalendarList(accessToken: string): Promise<GoogleCalendarListEntry[]>;
  getCalendar(accessToken: string, calendarId: string): Promise<GoogleCalendarMetadata>;
  /** One page. `event-sync.ts` walks `nextPageToken` itself so it can bail out mid-walk on `isStopped()`. */
  listEventsPage(
    accessToken: string,
    calendarId: string,
    params: ListEventsParams,
  ): Promise<GoogleEventsPage & { nextPageToken?: string }>;
  /** `events.insert` (#237) — always a fresh create; there is no conditional form because nothing upstream exists yet to condition on. */
  insertEvent(
    accessToken: string,
    calendarId: string,
    params: InsertEventParams,
  ): Promise<GoogleEvent>;
  /**
   * `events.patch` (#237), conditional on `params.ifMatchEtag` when given.
   * `restoreEvent` (`outbox-processor.ts`) is this same call with
   * `{ status: "confirmed" }` in the body — never `insertEvent` — per this
   * ticket's own acceptance line.
   */
  patchEvent(
    accessToken: string,
    calendarId: string,
    eventId: string,
    params: PatchEventParams,
  ): Promise<GoogleEvent>;
}

async function googleGet(accessToken: string, url: string): Promise<Response> {
  return fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
}

function throwOnError(response: Response, context: string): void {
  if (response.status === 410) throw new GoogleSyncTokenExpiredError();
  if (!response.ok) {
    throw new Error(`Google Calendar API error (${context}): ${response.status}`);
  }
}

/**
 * A rejected write's shape (#237) — the outbox processor's whole conflict/
 * retry/reject/Needs-Reauth branch reads only `kind` and never the raw HTTP
 * status, so misclassifying one status is a one-line fix in
 * `classifyWriteStatus` rather than a hunt through every call site.
 */
export type GoogleWriteErrorKind = "conflict" | "permanent" | "transient" | "needsReauth";

export class GoogleCalendarWriteError extends Error {
  readonly kind: GoogleWriteErrorKind;
  readonly status: number;
  constructor(kind: GoogleWriteErrorKind, status: number, detail: string) {
    super(`Google Calendar write error (${status}): ${detail}`);
    this.name = "GoogleCalendarWriteError";
    this.kind = kind;
    this.status = status;
  }
}

/**
 * `412` is the conditional-write rejection `ifMatchEtag` exists to produce
 * (a conflict, ADR-0025's second shape); `401` means the access token this
 * call was handed is no longer good, which — reached mid-flight rather than
 * caught by the credential provider returning `null` up front — is still
 * Needs Reauth, not a permanent rejection of the write itself; `429` and
 * `5xx` are transient (rate limiting, a flaky upstream); everything else in
 * the 4xx range (400 malformed body, 403 forbidden, 404/410 gone) is a
 * permanent rejection of this specific write.
 */
function classifyWriteStatus(status: number): GoogleWriteErrorKind {
  if (status === 412) return "conflict";
  if (status === 401) return "needsReauth";
  if (status === 429 || status >= 500) return "transient";
  return "permanent";
}

async function throwOnWriteError(response: Response, context: string): Promise<void> {
  if (response.ok) return;
  const detail = await response.text().catch(() => response.statusText);
  throw new GoogleCalendarWriteError(
    classifyWriteStatus(response.status),
    response.status,
    `${context}: ${detail}`,
  );
}

/** The real implementation, hitting Google's REST API. `createGoogleCalendarClient()` with no arguments is the production instance. */
export function createGoogleCalendarClient(): GoogleCalendarClient {
  return {
    async listCalendarList(accessToken) {
      const entries: GoogleCalendarListEntry[] = [];
      let pageToken: string | undefined;
      do {
        const url = new URL(`${API_BASE}/users/me/calendarList`);
        url.searchParams.set("maxResults", "250");
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        const response = await googleGet(accessToken, url.toString());
        throwOnError(response, "calendarList.list");
        const body = (await response.json()) as {
          items?: GoogleCalendarListEntry[];
          nextPageToken?: string;
        };
        entries.push(...(body.items ?? []));
        pageToken = body.nextPageToken;
      } while (pageToken);
      return entries;
    },

    async getCalendar(accessToken, calendarId) {
      const response = await googleGet(
        accessToken,
        `${API_BASE}/calendars/${encodeURIComponent(calendarId)}`,
      );
      throwOnError(response, "calendars.get");
      return (await response.json()) as GoogleCalendarMetadata;
    },

    async listEventsPage(accessToken, calendarId, params) {
      const url = new URL(`${API_BASE}/calendars/${encodeURIComponent(calendarId)}/events`);
      url.searchParams.set("singleEvents", "true");
      url.searchParams.set("maxResults", "250");
      if (params.syncToken) {
        url.searchParams.set("syncToken", params.syncToken);
      } else {
        if (params.timeMin) url.searchParams.set("timeMin", params.timeMin);
        if (params.timeMax) url.searchParams.set("timeMax", params.timeMax);
      }
      if (params.pageToken) url.searchParams.set("pageToken", params.pageToken);
      const response = await googleGet(accessToken, url.toString());
      throwOnError(response, "events.list");
      const body = (await response.json()) as {
        items?: GoogleEvent[];
        nextPageToken?: string;
        nextSyncToken?: string;
      };
      return {
        items: body.items ?? [],
        nextPageToken: body.nextPageToken,
        nextSyncToken: body.nextSyncToken,
      };
    },

    async insertEvent(accessToken, calendarId, { body, sendUpdates }) {
      const url = new URL(`${API_BASE}/calendars/${encodeURIComponent(calendarId)}/events`);
      url.searchParams.set("sendUpdates", sendUpdates);
      const response = await fetch(url.toString(), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      await throwOnWriteError(response, "events.insert");
      return (await response.json()) as GoogleEvent;
    },

    async patchEvent(accessToken, calendarId, eventId, { body, sendUpdates, ifMatchEtag }) {
      const url = new URL(
        `${API_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      );
      url.searchParams.set("sendUpdates", sendUpdates);
      const headers: Record<string, string> = {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      };
      if (ifMatchEtag) headers["If-Match"] = ifMatchEtag;
      const response = await fetch(url.toString(), {
        method: "PATCH",
        headers,
        body: JSON.stringify(body),
      });
      await throwOnWriteError(response, "events.patch");
      return (await response.json()) as GoogleEvent;
    },
  };
}
