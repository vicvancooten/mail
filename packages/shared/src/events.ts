import { z } from "zod";

/**
 * `Event` (#229/#230, CONTEXT.md's Occurrence entry): "one dated instance
 * derived from a Series by the Sync Backend ... what the Client receives and
 * renders; the Client never expands a rule itself." #230's materialiser
 * (`apps/sync-backend/src/calendars/materialiser.ts`) is what actually
 * writes rows here, deriving them from a Series plus its Overrides
 * (`series.ts`).
 *
 * A minimal, additive-safe list projection (ADR-0025: "Occurrence rows are
 * list projections") — everything else (description, attendees, rules) is
 * the Series body's own on-demand fetch (`series.ts#seriesSchema`), never
 * part of this shape or this collection's delta.
 */
export const eventSchema = z.object({
  /** `<seriesId>@<originalStart>` (ADR-0025) — stable across an Override, unlike a re-derived index. */
  id: z.string(),
  calendarId: z.string(),
  seriesId: z.string(),
  /** The instance's original start before any Override moved it — how an Override is matched back to its Series occurrence (ADR-0025). */
  originalStart: z.iso.datetime(),
  start: z.iso.datetime(),
  end: z.iso.datetime(),
  allDay: z.boolean(),
  /**
   * Set only when this Occurrence is a plain timed instance (`allDay` and
   * `floating` both `false`) — the Series' own IANA zone name, carried onto
   * every row it materialises so a grid can render it honestly with no
   * Series body fetch (#230, ADR-0025: "Timed Events are `{ instant, tzid }`").
   */
  tzid: z.string().nullable(),
  /**
   * A floating Event's `start`/`end` are wall clock, not a resolved instant
   * — the viewer's own current zone at render time, never a zone baked in
   * server-side (#230, ADR-0025). Always `false` when `allDay` is `true`.
   */
  floating: z.boolean(),
  title: z.string(),
  location: z.string().nullable(),
  status: z.enum(["confirmed", "cancelled"]),
  transparency: z.enum(["opaque", "transparent"]),
  updatedAt: z.iso.datetime(),
});
export type Event = z.infer<typeof eventSchema>;

/**
 * The Event Window (CONTEXT.md, ADR-0025): "the slice of the Materialisation
 * Window a Client's Local Cache holds and syncs ... rolling daily." Computed
 * fresh from "now" on every call (`calendars/event-store.ts#computeEventWindow`)
 * — it is always a sub-range of the Materialisation Window
 * (`calendars/materialise-loop.ts#MATERIALISATION_WINDOW_YEARS_PAST/FUTURE`),
 * whose edges are the ones that actually bound which Occurrence rows exist
 * as stored rows, rolled daily by the materialise loop.
 */
export const EVENT_WINDOW_MONTHS_PAST = 3;
export const EVENT_WINDOW_MONTHS_FUTURE = 12;

/**
 * `GET /calendars/events?start=&end=` (#232): the on-demand fetch a Client
 * makes when the grid navigates to a range that reaches outside the Event
 * Window — never `POST /sync`'s cursor (`sync.ts#eventDeltaSchema`'s own
 * doc comment: the ordinary delta has no range parameter at all). The
 * portion of the request inside the Materialisation Window reads stored
 * `events` rows directly; the portion beyond it is computed by the
 * materialiser on request and never written back (this ticket's
 * acceptance lines). `windowStart`/`windowEnd` are the same Event Window
 * edges `eventDeltaSchema` carries — repeated here so a Client that fetches
 * a range before its first `Event` sync round still gets an honest edge to
 * draw.
 */
export const eventRangeResponseSchema = z.object({
  events: z.array(eventSchema),
  windowStart: z.iso.datetime(),
  windowEnd: z.iso.datetime(),
});
export type EventRangeResponse = z.infer<typeof eventRangeResponseSchema>;
