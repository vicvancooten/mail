import type { FastifyInstance } from "fastify";
import type { SyncHintBroker } from "../realtime/sync-hints.js";

/**
 * Proves liveness and defeats reverse-proxy idle timeouts (ADR-0015); a
 * missed one drops the Client to its polling floor until reconnect rather
 * than failing anything here.
 */
const HEARTBEAT_MS = 25_000;

export interface EventsRoutesOptions {
  hints: SyncHintBroker;
  /** Test seam — a 25s real timer has no place in a unit test. */
  heartbeatMs?: number;
}

/**
 * `GET /events` (ADR-0015): SSE, session-gated, carrying only Sync Hints —
 * never mail state, never a `Last-Event-ID` replay (state tokens already
 * make a reconnect-then-sync lossless). Auth is the ordinary httpOnly
 * session cookie, never a token in the query string.
 *
 * One connection per request, same as any other route — it's the **Client**
 * that holds this down to one per User (the Web Locks leader tab,
 * `apps/client/src/sync/sse.ts`), not this route.
 */
export async function eventsRoutes(
  app: FastifyInstance,
  { hints, heartbeatMs = HEARTBEAT_MS }: EventsRoutesOptions,
) {
  app.get("/events", { preHandler: app.requireAuth }, (request, reply) => {
    const userId = requireUser(request).id;

    // Fastify's own reply lifecycle expects a `send()`; an SSE stream never
    // calls one, so `hijack()` hands the raw response over completely.
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    // An immediate comment opens the stream promptly across proxies that
    // buffer until the first byte, before any hint has ever fired.
    reply.raw.write(":ok\n\n");

    const unsubscribe = hints.subscribe(userId, () => {
      reply.raw.write("event: hint\ndata: {}\n\n");
    });

    const heartbeat = setInterval(() => {
      reply.raw.write(":heartbeat\n\n");
    }, heartbeatMs);

    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      // A client-initiated abort has already torn the socket down by the
      // time this fires; ending an already-ended writable throws.
      if (!reply.raw.writableEnded) reply.raw.end();
    });
  });
}

function requireUser(request: { user: { id: string } | null }): { id: string } {
  if (!request.user) {
    throw new Error("requireAuth did not populate request.user");
  }
  return request.user;
}
