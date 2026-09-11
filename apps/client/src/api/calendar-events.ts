import { type EventRangeResponse, eventRangeResponseSchema } from "@mail/shared";
import { getJson } from "./auth.js";

/**
 * `GET /calendars/events` (#232): the fetch-through read `store/events.ts`
 * makes when the grid's visible range reaches outside the Event Window —
 * never `POST /sync`'s cursor, the same posture the Series body's own
 * on-demand fetch takes (`routes/calendars.ts`'s own doc comment).
 */
export function fetchEventRange(start: string, end: string): Promise<EventRangeResponse> {
  const params = new URLSearchParams({ start, end });
  return getJson(`/calendars/events?${params.toString()}`, (data) =>
    eventRangeResponseSchema.parse(data),
  );
}
