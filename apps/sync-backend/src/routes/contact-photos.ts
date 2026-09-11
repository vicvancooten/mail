import { contactPhotoSchema, isContactPhotoMimeType } from "@mail/shared";
import type { FastifyInstance } from "fastify";
import {
  getContactPhotoBlob,
  putContactPhoto,
  removeContactPhoto,
} from "../contacts/photo-store.js";
import type { Db } from "../db/client.js";

export interface ContactPhotoRoutesOptions {
  db: Db;
  /** #213's own instance-level bound, in raw bytes — a photo, not an attachment corpus, so this is its own budget rather than `attachmentBudgetBytes`. */
  contactPhotoMaxBytes: number;
}

/**
 * A Contact photo's own Blob Store HTTP surface (#213): upload, download and
 * remove, scoped through the Contact's own `userId` — `routes/attachments.ts`'s
 * shape, generalized from "owned via a Mail Account" to "owned via a
 * Contact directly" (`ContactRow.userId`, ADR-0023's own Sync Scope for a
 * Local Contact). The download route is deliberately named by `contactId`,
 * never by a bare blob id: the blob itself is content-addressed and
 * theoretically guessable, but this route only ever resolves bytes through
 * a Contact this session's User owns — "reachable by every Client of the
 * owning User and by no one else" (the ticket's own acceptance line) is
 * this ownership check, not blob-id secrecy.
 */
export async function contactPhotoRoutes(
  app: FastifyInstance,
  { db, contactPhotoMaxBytes }: ContactPhotoRoutesOptions,
) {
  app.post(
    "/contacts/:contactId/photo",
    {
      preHandler: app.requireAuth,
      // Same reasoning as `routes/attachments.ts`'s own bodyLimit: the real
      // gate is `putContactPhoto`'s own budget check, this only keeps an
      // absurd upload from tying up a connection at all.
      bodyLimit: contactPhotoMaxBytes + 1024,
    },
    async (request, reply) => {
      const { contactId } = request.params as { contactId: string };
      const query = request.query as { mimeType?: string };
      const userId = requireUser(request).id;

      if (!query.mimeType || !isContactPhotoMimeType(query.mimeType)) {
        return reply.code(415).send({ error: "unsupported_mime_type" });
      }

      const result = await putContactPhoto(db, {
        userId,
        contactId,
        bytes: request.body as Buffer,
        mimeType: query.mimeType,
        maxBytes: contactPhotoMaxBytes,
      });

      if (!result.ok && result.reason === "not_found") {
        return reply.code(404).send({ error: "not_found" });
      }
      if (!result.ok && result.reason === "over_budget") {
        return reply.code(413).send({ error: "photo_too_large", maxBytes: result.maxBytes });
      }
      if (!result.ok) return reply.code(500).send({ error: "unknown" });
      return reply.code(200).send(contactPhotoSchema.parse(result.photo));
    },
  );

  app.get("/contacts/:contactId/photo", { preHandler: app.requireAuth }, async (request, reply) => {
    const { contactId } = request.params as { contactId: string };
    const userId = requireUser(request).id;

    const blob = await getContactPhotoBlob(db, userId, contactId);
    if (!blob) return reply.code(404).send({ error: "not_found" });

    // Private and long-lived: unlike a composer's own pre-submission
    // attachment, a photo's bytes never change once uploaded — the same
    // bytes always live at the same content-addressed id, and a new upload
    // simply points the Contact at a different id (`contactPhotoUrl`'s own
    // doc comment on the Client) — so there is nothing here for a cache to
    // ever need revalidating.
    reply
      .header("Content-Type", blob.mimeType)
      .header("Cache-Control", "private, max-age=31536000, immutable");
    return reply.send(blob.bytes);
  });

  app.delete(
    "/contacts/:contactId/photo",
    { preHandler: app.requireAuth },
    async (request, reply) => {
      const { contactId } = request.params as { contactId: string };
      const userId = requireUser(request).id;

      const result = await removeContactPhoto(db, userId, contactId);
      if (result.status === "not_found") return reply.code(404).send({ error: "not_found" });
      return reply.code(204).send();
    },
  );
}

/** Same shape as every other authenticated route's own inline helper (`attachments.ts`'s sibling one). */
function requireUser(request: { user: { id: string } | null }): { id: string } {
  if (!request.user) {
    throw new Error("requireAuth did not populate request.user");
  }
  return request.user;
}
