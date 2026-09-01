import { type SyncResponse, syncRequestSchema, syncResponseSchema } from "@mail/shared";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import { getMailAccountForUser } from "../mail-accounts/store.js";
import { syncMailAccountCollection, syncThreadCollection } from "../sync/collection-sync.js";

export interface SyncRoutesOptions {
  db: Db;
}

/**
 * The one delta endpoint (ADR-0011, #37): `POST /sync`, session-gated,
 * carrying a map of `{collection → stateToken}` scoped per Mail Account plus
 * a set of User-scoped collections. See `packages/shared/src/sync.ts` for
 * the wire contract this thinly wraps — everything below is request
 * plumbing and per-collection dispatch, no sync logic of its own.
 */
export async function syncRoutes(app: FastifyInstance, { db }: SyncRoutesOptions) {
  app.post("/sync", { preHandler: app.requireAuth }, async (request, reply) => {
    const body = syncRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request", issues: body.error.issues });
    }
    const userId = requireUser(request).id;
    const { user, mailAccounts: requestedMailAccounts } = body.data;

    const userResult: SyncResponse["user"] = {};
    if (user?.MailAccount !== undefined) {
      const delta = await syncMailAccountCollection(db, userId, user.MailAccount);
      if (delta) userResult.MailAccount = delta;
    }

    const mailAccountsResult: SyncResponse["mailAccounts"] = {};
    for (const [mailAccountId, requested] of Object.entries(requestedMailAccounts ?? {})) {
      if (requested.Thread === undefined) continue;

      // Silently skipped rather than a 404/403: a Mail Account the Client
      // still has cached but no longer owns (or that never existed) is not
      // this Client's mistake to report on — the MailAccount collection is
      // what tells it the account is gone.
      const account = await getMailAccountForUser(db, userId, mailAccountId);
      if (!account) continue;

      const delta = await syncThreadCollection(
        db,
        mailAccountId,
        account.threadsEpoch,
        requested.Thread,
      );
      if (delta) mailAccountsResult[mailAccountId] = { Thread: delta };
    }

    return syncResponseSchema.parse({ user: userResult, mailAccounts: mailAccountsResult });
  });
}

function requireUser(request: { user: { id: string } | null }): { id: string } {
  if (!request.user) {
    throw new Error("requireAuth did not populate request.user");
  }
  return request.user;
}
