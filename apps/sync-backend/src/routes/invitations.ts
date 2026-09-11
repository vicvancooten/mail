import {
  addInvitationToCalendarResponseSchema,
  answerInvitationRequestSchema,
  answerInvitationResponseSchema,
  answerLocalInvitationRequestSchema,
  answerLocalInvitationResponseSchema,
  cancelLocalReplyRequestSchema,
  cancelLocalReplyResponseSchema,
  invitationCardsResponseSchema,
} from "@mail/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { answerInvitation } from "../calendars/series-store.js";
import type { Db } from "../db/client.js";
import { messages } from "../db/schema.js";
import { buildInvitationCards } from "../invitations/card.js";
import { answerLocalInvitation, cancelLocalReply } from "../invitations/local-answer.js";
import { addInvitationAsPrivateCopy } from "../invitations/local-fallback.js";
import { latestInvitationRevision } from "../invitations/store.js";
import { getMailAccountForUser } from "../mail-accounts/store.js";

export interface InvitationRoutesOptions {
  db: Db;
}

/**
 * The Reader's invite card (#240, ADR-0027): `GET /threads/:threadId
 * /invitations` is a plain fetch-through read, the same posture `GET
 * /threads/:threadId/messages` already takes for a Thread's Messages — an
 * Invitation is not an ADR-0011 sync collection either (`db/schema.ts
 * #invitations`'s own doc comment). `POST /calendars/series/:seriesId
 * /answer` is the Answer itself: an Event edit on a synced Calendar,
 * pushed upstream through the ordinary write-back outbox
 * (`calendars/series-store.ts#answerInvitation`) — never a `UserMutationIntent`
 * on the offline queue, the same "needs the real outcome back before the
 * Client can decide whether Undo is even offered" reasoning #235's mirror
 * routes already give a synchronous, once-only write.
 */
export async function invitationRoutes(app: FastifyInstance, { db }: InvitationRoutesOptions) {
  app.get(
    "/threads/:threadId/invitations",
    { preHandler: app.requireAuth },
    async (request, reply) => {
      const { threadId } = request.params as { threadId: string };
      const userId = requireUser(request).id;

      const [message] = await db
        .select({ mailAccountId: messages.mailAccountId })
        .from(messages)
        .where(eq(messages.threadId, threadId))
        .limit(1);
      if (!message) return reply.code(404).send({ error: "not_found" });

      const account = await getMailAccountForUser(db, userId, message.mailAccountId);
      if (!account) return reply.code(404).send({ error: "not_found" });

      const cards = await buildInvitationCards(db, userId, threadId);
      return reply.send(invitationCardsResponseSchema.parse({ cards }));
    },
  );

  app.post(
    "/calendars/series/:seriesId/answer",
    { preHandler: app.requireAuth },
    async (request, reply) => {
      const { seriesId } = request.params as { seriesId: string };
      const userId = requireUser(request).id;
      const { responseStatus } = answerInvitationRequestSchema.parse(request.body);

      const result = await answerInvitation(db, userId, seriesId, responseStatus);
      if (!result.ok) {
        const status = result.reason === "series_not_found" ? 404 : 400;
        return reply.code(status).send({ error: result.reason });
      }

      return reply.send(
        answerInvitationResponseSchema.parse({
          ok: true,
          previousResponseStatus: result.previousResponseStatus,
        }),
      );
    },
  );

  // The Local fallback's own Answer (#241, ADR-0027): queues an iMIP
  // `REPLY` through the invited Mail Account's SMTP rather than pushing an
  // Event edit an upstream turns into one — `not_local` covers a `seriesId`
  // that in fact names a synced Calendar's Series (the Client's own bug, or
  // a stale card): the caller belongs on `/answer` above instead.
  app.post(
    "/calendars/series/:seriesId/answer-local",
    { preHandler: app.requireAuth },
    async (request, reply) => {
      const { seriesId } = request.params as { seriesId: string };
      const userId = requireUser(request).id;
      const { responseStatus } = answerLocalInvitationRequestSchema.parse(request.body);

      const result = await answerLocalInvitation(db, userId, seriesId, responseStatus);
      if (!result.ok) {
        const status = result.reason === "series_not_found" ? 404 : 400;
        return reply.code(status).send({ error: result.reason });
      }

      return reply.send(
        answerLocalInvitationResponseSchema.parse({
          ok: true,
          previousResponseStatus: result.previousResponseStatus,
          replyId: result.replyId,
        }),
      );
    },
  );

  // Undo Send for a queued `REPLY` (#241, ADR-0007, ADR-0027: "Undo cancels
  // it outright") — the caller supplies the Attendee entry's own previous
  // `responseStatus` (`InviteCard.tsx`'s own Undo-toast closure), the same
  // "the Client already knows what to restore" shape #240's synced Undo
  // gives by re-answering with it.
  app.post(
    "/calendars/replies/:replyId/cancel-send",
    { preHandler: app.requireAuth },
    async (request, reply) => {
      const { replyId } = request.params as { replyId: string };
      const userId = requireUser(request).id;
      const { previousResponseStatus } = cancelLocalReplyRequestSchema.parse(request.body);

      const result = await cancelLocalReply(db, userId, replyId, previousResponseStatus);
      if (!result.ok) {
        const status = result.reason === "not_found" ? 404 : 400;
        return reply.code(status).send({ error: result.reason });
      }
      return reply.send(cancelLocalReplyResponseSchema.parse({ ok: true }));
    },
  );

  // "Add to calendar" (#241, ADR-0027): an Invitation addressed to nobody
  // the User is — offers no Answer at all, only a private copy.
  app.post(
    "/threads/:threadId/invitations/:uid/add-to-calendar",
    { preHandler: app.requireAuth },
    async (request, reply) => {
      const { threadId, uid } = request.params as { threadId: string; uid: string };
      const userId = requireUser(request).id;

      const invitationRow = await latestInvitationRevision(db, threadId, uid);
      if (!invitationRow) return reply.code(404).send({ error: "not_found" });

      const account = await getMailAccountForUser(db, userId, invitationRow.mailAccountId);
      if (!account) return reply.code(404).send({ error: "not_found" });

      const result = await addInvitationAsPrivateCopy(db, userId, invitationRow);
      if (!result.ok) return reply.code(404).send({ error: result.reason });
      return reply.send(addInvitationToCalendarResponseSchema.parse({ ok: true }));
    },
  );
}

/** Same shape as every other authenticated route's own inline helper (`routes/calendars.ts`'s sibling one). */
function requireUser(request: { user: { id: string } | null }): { id: string } {
  if (!request.user) {
    throw new Error("requireAuth did not populate request.user");
  }
  return request.user;
}
