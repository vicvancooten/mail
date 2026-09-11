import {
  eventRangeResponseSchema,
  mirrorCalendarResponseSchema,
  seriesBodyResponseSchema,
  unmirrorCalendarResponseSchema,
  unmirrorImpactResponseSchema,
} from "@mail/shared";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import { fetchEventRange } from "../calendars/event-range.js";
import { computeEventWindow } from "../calendars/event-store.js";
import { toWireOverride, toWireSeries } from "../calendars/series-store.js";
import {
  CalendarNotFoundError,
  CalendarNotMirrorableError,
  mirrorCalendar,
  toWireCalendar,
  unmirrorCalendar,
  unmirrorImpact,
} from "../calendars/store.js";
import type { Db } from "../db/client.js";
import { calendars, overrides, series } from "../db/schema.js";

export interface CalendarRoutesOptions {
  db: Db;
}

/**
 * The Series body's on-demand fetch (#230's acceptance line: "asking for
 * one Series body returns its attendees, description and rules"), plus
 * `mirrored`'s write side (#235: `unmirror-impact`/`unmirror`/`mirror`).
 * Neither rides `POST /sync` (ADR-0011): a Series body is a fetch-through
 * read, not a delta, the same posture `routes/messages.ts` takes for a mail
 * body, since a Series is not itself a synced collection
 * (`db/schema.ts#series`'s own doc comment); the mirror routes are
 * deliberately three plain REST routes rather than a `UserMutationIntent`
 * on the ordinary sync queue — #235's own acceptance line, "Not an
 * Optimistic Action": a User needs the actual discarded counts back before
 * they can even show the confirm dialog, and unmirroring itself must run
 * synchronously, once, never replayed from an offline queue. The Calendar
 * row itself still rides the ordinary `Calendar` collection sync afterward
 * (its `syncRev` bump fires the same `notify_sync_hint` trigger any other
 * write does) — these routes only ever hand back a snapshot for the
 * request that made the change.
 *
 * `GET /calendars/events` (#232) joins them for the same reason: a range
 * outside the Event Window is a fetch-through read too, answered by
 * `calendars/event-range.ts#fetchEventRange` rather than `POST /sync`'s
 * cursor.
 */
export async function calendarRoutes(app: FastifyInstance, { db }: CalendarRoutesOptions) {
  app.get(
    "/calendars/:calendarId/series/:seriesId",
    { preHandler: app.requireAuth },
    async (request, reply) => {
      const { calendarId, seriesId } = request.params as { calendarId: string; seriesId: string };
      const userId = requireUser(request).id;

      const [calendar] = await db
        .select({ id: calendars.id })
        .from(calendars)
        .where(and(eq(calendars.id, calendarId), eq(calendars.userId, userId)));
      if (!calendar) {
        return reply.code(404).send({ error: "not_found" });
      }

      const [seriesRow] = await db
        .select()
        .from(series)
        .where(and(eq(series.id, seriesId), eq(series.calendarId, calendarId)));
      if (!seriesRow) {
        return reply.code(404).send({ error: "not_found" });
      }

      const overrideRows = await db
        .select()
        .from(overrides)
        .where(eq(overrides.seriesId, seriesId));

      return reply.send(
        seriesBodyResponseSchema.parse({
          series: toWireSeries(seriesRow),
          overrides: overrideRows.map(toWireOverride),
        }),
      );
    },
  );

  app.get("/calendars/events", { preHandler: app.requireAuth }, async (request, reply) => {
    const { start: startParam, end: endParam } = request.query as {
      start?: string;
      end?: string;
    };
    const start = startParam ? new Date(startParam) : null;
    const end = endParam ? new Date(endParam) : null;
    if (
      !start ||
      !end ||
      Number.isNaN(start.getTime()) ||
      Number.isNaN(end.getTime()) ||
      start >= end
    ) {
      return reply.code(400).send({ error: "invalid_range" });
    }

    const userId = requireUser(request).id;
    const rangeEvents = await fetchEventRange(db, userId, start, end);
    const window = computeEventWindow();
    return reply.send(
      eventRangeResponseSchema.parse({
        events: rangeEvents,
        windowStart: window.start.toISOString(),
        windowEnd: window.end.toISOString(),
      }),
    );
  });

  app.get(
    "/calendars/:id/unmirror-impact",
    { preHandler: app.requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        const discarded = await unmirrorImpact(db, requireUser(request).id, id);
        return unmirrorImpactResponseSchema.parse({ discarded });
      } catch (err) {
        return replyForCalendarError(err, reply);
      }
    },
  );

  app.post("/calendars/:id/unmirror", { preHandler: app.requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const { calendar, discarded } = await unmirrorCalendar(db, requireUser(request).id, id);
      return unmirrorCalendarResponseSchema.parse({
        calendar: toWireCalendar(calendar),
        discarded,
      });
    } catch (err) {
      return replyForCalendarError(err, reply);
    }
  });

  app.post("/calendars/:id/mirror", { preHandler: app.requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const calendar = await mirrorCalendar(db, requireUser(request).id, id);
      return mirrorCalendarResponseSchema.parse({ calendar: toWireCalendar(calendar) });
    } catch (err) {
      return replyForCalendarError(err, reply);
    }
  });
}

function replyForCalendarError(err: unknown, reply: FastifyReply) {
  if (err instanceof CalendarNotFoundError) {
    return reply.code(404).send({ error: "not_found" });
  }
  if (err instanceof CalendarNotMirrorableError) {
    return reply.code(400).send({ error: "not_mirrorable" });
  }
  throw err;
}

/** Same shape as every other authenticated route's own inline helper (`mail-accounts.ts`'s sibling one). */
function requireUser(request: { user: { id: string } | null }): { id: string } {
  if (!request.user) {
    throw new Error("requireAuth did not populate request.user");
  }
  return request.user;
}
