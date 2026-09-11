import {
  type MirrorCalendarResponse,
  mirrorCalendarResponseSchema,
  type SeriesBodyResponse,
  seriesBodyResponseSchema,
  type UnmirrorCalendarResponse,
  type UnmirrorImpactResponse,
  unmirrorCalendarResponseSchema,
  unmirrorImpactResponseSchema,
} from "@mail/shared";
import { getJson, postJson } from "./auth.js";

/** The Series body's on-demand fetch (#230/#233): attendees, description, rules and Overrides for one Series — the Event editor's own hydration source, never part of the `Event` delta. */
export function fetchSeries(calendarId: string, seriesId: string): Promise<SeriesBodyResponse> {
  return getJson(`/calendars/${calendarId}/series/${seriesId}`, (data) =>
    seriesBodyResponseSchema.parse(data),
  );
}

/** The confirm dialog's counts, fetched before the User commits (#235: "confirmed with counts"). */
export function fetchUnmirrorImpact(calendarId: string): Promise<UnmirrorImpactResponse> {
  return getJson(`/calendars/${calendarId}/unmirror-impact`, (data) =>
    unmirrorImpactResponseSchema.parse(data),
  );
}

/** Immediate, no Undo (#235's own acceptance line) — never queued as an Optimistic Action. */
export function unmirrorCalendar(calendarId: string): Promise<UnmirrorCalendarResponse> {
  return postJson(`/calendars/${calendarId}/unmirror`, {}, (data) =>
    unmirrorCalendarResponseSchema.parse(data),
  );
}

export function mirrorCalendar(calendarId: string): Promise<MirrorCalendarResponse> {
  return postJson(`/calendars/${calendarId}/mirror`, {}, (data) =>
    mirrorCalendarResponseSchema.parse(data),
  );
}
