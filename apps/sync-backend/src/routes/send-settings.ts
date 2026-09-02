import { sendSettingsSchema, undoSendDelaySchema } from "@mail/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import { users } from "../db/schema.js";

export interface SendSettingsRoutesOptions {
  db: Db;
}

/**
 * The Undo Send delay, read and written per User (#46, ADR-0007).
 *
 * A plain pair of routes rather than a synced collection, deliberately:
 * #54 owns preference *storage* — the User-scoped synced collection and the
 * settings screen — and this ticket needs exactly one value, on the server,
 * before that lands. Its own ticket calls this out as one of the "existing
 * inline defaults" it migrates. Nothing here is a mechanism #54 has to
 * unpick: it is one integer column and two handlers.
 *
 * Server-held rather than sent up with each send because ADR-0007 measures
 * the delay "from server receipt, never from the Client's clock" — the
 * Client reads this to *describe* the window it is about to get, never to
 * decide it.
 */
export async function sendSettingsRoutes(app: FastifyInstance, { db }: SendSettingsRoutesOptions) {
  app.get("/send-settings", { preHandler: app.requireAuth }, async (request) => {
    const userId = requireUser(request).id;
    const [row] = await db
      .select({ delay: users.undoSendDelaySeconds })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return sendSettingsSchema.parse({
      undoSendDelaySeconds: undoSendDelaySchema.catch(10).parse(row?.delay),
    });
  });

  app.patch("/send-settings", { preHandler: app.requireAuth }, async (request, reply) => {
    const body = sendSettingsSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request", issues: body.error.issues });
    }
    const userId = requireUser(request).id;
    await db
      .update(users)
      .set({ undoSendDelaySeconds: body.data.undoSendDelaySeconds, updatedAt: new Date() })
      .where(eq(users.id, userId));
    return body.data;
  });
}

function requireUser(request: { user: { id: string } | null }): { id: string } {
  if (!request.user) {
    throw new Error("requireAuth did not populate request.user");
  }
  return request.user;
}
