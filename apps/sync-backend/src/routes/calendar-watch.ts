import type { FastifyInstance } from "fastify";
import { handleGoogleCalendarPushNotification } from "../calendars/google/watch.js";
import type { Db } from "../db/client.js";

export interface CalendarWatchRoutesOptions {
  db: Db;
}

/**
 * Google Calendar's `watch()` push notification (#234): a plain webhook, not
 * a Client-facing route — Google calls it directly, carrying no session
 * cookie, only its own `X-Goog-Channel-ID`/`X-Goog-Resource-ID` headers
 * (https://developers.google.com/calendar/api/guides/push#receiving-notifications).
 * Never `requireAuth`-gated for that reason. Always answers `204` — Google
 * treats anything but a 2xx as "retry, and eventually give up and let the
 * channel expire", and an unrecognized or stale channel is already a
 * harmless no-op on this end (`watch.ts`'s own doc comment).
 */
export async function calendarWatchRoutes(
  app: FastifyInstance,
  { db }: CalendarWatchRoutesOptions,
) {
  app.post("/calendars/google/watch", async (request, reply) => {
    const channelId = request.headers["x-goog-channel-id"];
    const resourceId = request.headers["x-goog-resource-id"];
    if (typeof channelId === "string" && typeof resourceId === "string") {
      await handleGoogleCalendarPushNotification(db, { channelId, resourceId });
    }
    return reply.code(204).send();
  });
}
