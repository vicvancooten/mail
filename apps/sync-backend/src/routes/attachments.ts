import {
  type AttachmentDisposition,
  attachmentDispositionSchema,
  attachmentMetaSchema,
} from "@mail/shared";
import type { FastifyInstance } from "fastify";
import {
  deleteBlob,
  getBlobBytes,
  getCompositionForAttachment,
  putBlob,
} from "../compose/blob-store.js";
import type { Db } from "../db/client.js";
import { getMailAccountForUser } from "../mail-accounts/store.js";

export interface AttachmentRoutesOptions {
  db: Db;
  /** ADR-0012's instance-level attachment budget, in encoded bytes (`env.ATTACHMENT_BUDGET_BYTES`). */
  attachmentBudgetBytes: number;
}

/**
 * The Blob Store's HTTP surface (#48): upload, download (the editor's own
 * inline-image preview and the row's Download link) and delete. Every route
 * is scoped through the Mail Account a Composition belongs to — the same
 * ownership check `routes/sync.ts` runs, just against a REST route instead
 * of `POST /sync`, because "bytes upload immediately on drop/select"
 * (compose-spec) can't wait for the next sync round.
 */
export async function attachmentRoutes(
  app: FastifyInstance,
  { db, attachmentBudgetBytes }: AttachmentRoutesOptions,
) {
  app.post(
    "/compositions/:compositionId/attachments",
    {
      preHandler: app.requireAuth,
      // The default 1MiB body limit is for JSON payloads; an attachment
      // upload is raw bytes up to the instance budget itself, with a little
      // slack for the multipart-free framing overhead ADR-0012 calls
      // "encoded, not raw" — the budget check inside `putBlob` is the real
      // gate, this is only what keeps an absurd upload from tying up a
      // connection at all.
      bodyLimit: attachmentBudgetBytes + 1024,
    },
    async (request, reply) => {
      const { compositionId } = request.params as { compositionId: string };
      const query = request.query as {
        mailAccountId?: string;
        filename?: string;
        mimeType?: string;
        disposition?: string;
      };
      const userId = requireUser(request).id;

      if (!query.mailAccountId || !query.filename) {
        return reply.code(400).send({ error: "invalid_request" });
      }
      const disposition = attachmentDispositionSchema.safeParse(query.disposition ?? "attachment");
      if (!disposition.success) {
        return reply.code(400).send({ error: "invalid_request" });
      }

      const account = await getMailAccountForUser(db, userId, query.mailAccountId);
      if (!account) return reply.code(404).send({ error: "not_found" });

      // A Composition that already exists must belong to this Mail Account
      // and still be a Draft — the same "autosave has nothing left to write
      // into" rule `compose/compose-store.ts#applySave` enforces for a
      // content save applies to attaching, too.
      const existing = await getCompositionForAttachment(db, compositionId);
      if (existing) {
        if (existing.mailAccountId !== account.id)
          return reply.code(404).send({ error: "not_found" });
        if (existing.status !== "draft") {
          return reply.code(409).send({ error: "not_a_draft" });
        }
      }

      const bytes = request.body as Buffer;
      const result = await putBlob(db, {
        compositionId,
        mailAccountId: account.id,
        bytes,
        filename: query.filename,
        mimeType: query.mimeType || "application/octet-stream",
        disposition: disposition.data as AttachmentDisposition,
        budgetBytes: attachmentBudgetBytes,
      });

      if (!result.ok) {
        return reply.code(413).send({
          error: "attachment_budget_exceeded",
          remainingBytes: result.remainingBytes,
          budgetBytes: result.budgetBytes,
        });
      }
      return reply.code(201).send(attachmentMetaSchema.parse(result.meta));
    },
  );

  app.get(
    "/compositions/:compositionId/attachments/:attachmentId",
    { preHandler: app.requireAuth },
    async (request, reply) => {
      const { compositionId, attachmentId } = request.params as {
        compositionId: string;
        attachmentId: string;
      };
      const userId = requireUser(request).id;

      const composition = await getCompositionForAttachment(db, compositionId);
      if (!composition) return reply.code(404).send({ error: "not_found" });
      const account = await getMailAccountForUser(db, userId, composition.mailAccountId);
      if (!account) return reply.code(404).send({ error: "not_found" });

      const meta = composition.attachments.find((entry) => entry.id === attachmentId);
      if (!meta) return reply.code(404).send({ error: "not_found" });
      const bytes = await getBlobBytes(db, attachmentId);
      if (!bytes) return reply.code(404).send({ error: "not_found" });

      reply
        .header("Content-Type", meta.mimeType)
        .header(
          "Content-Disposition",
          `${meta.disposition}; filename="${sanitizeFilename(meta.filename)}"`,
        )
        // The composer's own bytes, not fetch-through IMAP — poc-spec.md's
        // "no received-attachment caching" is about *received* mail, not a
        // Draft's own pre-submission blobs, so serving straight from
        // Postgres with a normal private cache is fine here.
        .header("Cache-Control", "private, max-age=300");
      return reply.send(bytes);
    },
  );

  app.delete(
    "/compositions/:compositionId/attachments/:attachmentId",
    { preHandler: app.requireAuth },
    async (request, reply) => {
      const { compositionId, attachmentId } = request.params as {
        compositionId: string;
        attachmentId: string;
      };
      const userId = requireUser(request).id;

      const composition = await getCompositionForAttachment(db, compositionId);
      if (!composition) return reply.code(404).send({ error: "not_found" });
      const account = await getMailAccountForUser(db, userId, composition.mailAccountId);
      if (!account) return reply.code(404).send({ error: "not_found" });

      const result = await deleteBlob(db, compositionId, attachmentId);
      if (result.status === "not_found") return reply.code(404).send({ error: "not_found" });
      return reply.code(204).send();
    },
  );
}

function sanitizeFilename(filename: string): string {
  return filename.replace(/["\r\n]/g, "");
}

function requireUser(request: { user: { id: string } | null }): { id: string } {
  if (!request.user) {
    throw new Error("requireAuth did not populate request.user");
  }
  return request.user;
}
