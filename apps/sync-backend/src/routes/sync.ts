import type { ComposeSaveOutcome, MutationOutcome, SyncResponse } from "@mail/shared";
import { syncRequestSchema, syncResponseSchema } from "@mail/shared";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import { getMailAccountForUser } from "../mail-accounts/store.js";
import {
  syncCompositionCollection,
  syncLabelCollection,
  syncMailAccountCollection,
  syncThreadCollection,
} from "../sync/collection-sync.js";
import { flushComposeSaves } from "../sync/compose-store.js";
import { flushMutations } from "../sync/mutations.js";

export interface SyncRoutesOptions {
  db: Db;
}

/**
 * The one delta endpoint (ADR-0011, #37): `POST /sync`, session-gated,
 * carrying a map of `{collection → stateToken}` scoped per Mail Account plus
 * a set of User-scoped collections. See `packages/shared/src/sync.ts` for
 * the wire contract this thinly wraps — everything below is request
 * plumbing and per-collection dispatch, no sync logic of its own.
 *
 * A Mail Account's `mutations` (#39) are flushed *before* its Thread delta
 * is computed — ADR-0011's third divergence, "a mutation-flush response
 * carries deltas too": applying the queue first means the very same round
 * trip's Thread delta already reflects what those mutations just changed,
 * with no second poll needed to see it confirmed.
 *
 * `composeSaves` are flushed **before** `mutations`, and that order is
 * load-bearing rather than incidental: a `sendComposition` intent (#46) sends
 * whatever content the Composition row holds at the moment it is applied, and
 * the Client enqueues the send in the same round as the composer's final
 * autosave. Draining the saves first is what makes "send" mean "send what I
 * was looking at" instead of "send the last thing that happened to have
 * reached the server". The two arrays otherwise touch disjoint tables, so
 * nothing else depends on which goes first.
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
      const wantsThread = requested.Thread !== undefined;
      const wantsLabel = requested.Label !== undefined;
      const wantsComposition = requested.Composition !== undefined;
      const queued = requested.mutations ?? [];
      const queuedComposeSaves = requested.composeSaves ?? [];
      if (
        !wantsThread &&
        !wantsLabel &&
        !wantsComposition &&
        queued.length === 0 &&
        queuedComposeSaves.length === 0
      ) {
        continue;
      }

      // Silently skipped rather than a 404/403: a Mail Account the Client
      // still has cached but no longer owns (or that never existed) is not
      // this Client's mistake to report on — the MailAccount collection is
      // what tells it the account is gone. A queued mutation against it is
      // rejected outright instead: nothing here will ever apply it, and
      // holding it forever would starve the retry it deserves. Same for a
      // queued Composition autosave.
      const account = await getMailAccountForUser(db, userId, mailAccountId);
      if (!account) {
        if (queued.length > 0 || queuedComposeSaves.length > 0) {
          mailAccountsResult[mailAccountId] = {
            ...(queued.length > 0
              ? {
                  mutations: queued.map(
                    (mutation): MutationOutcome => ({
                      id: mutation.id,
                      status: "rejected",
                      reason: "mail_account_not_found",
                    }),
                  ),
                }
              : {}),
            ...(queuedComposeSaves.length > 0
              ? {
                  composeSaves: queuedComposeSaves.map(
                    (save): ComposeSaveOutcome => ({
                      id: save.id,
                      saveId: save.saveId,
                      status: "rejected",
                      version: save.version,
                      reason: "mail_account_not_found",
                    }),
                  ),
                }
              : {}),
          };
        }
        continue;
      }

      const composeSaveResults =
        queuedComposeSaves.length > 0
          ? await flushComposeSaves(db, mailAccountId, queuedComposeSaves)
          : [];
      const mutationResults =
        queued.length > 0 ? await flushMutations(db, mailAccountId, queued) : [];

      const threadDelta = wantsThread
        ? await syncThreadCollection(
            db,
            mailAccountId,
            account.threadsEpoch,
            requested.Thread ?? null,
          )
        : null;

      const labelDelta = wantsLabel
        ? await syncLabelCollection(db, mailAccountId, requested.Label ?? null)
        : null;

      const compositionDelta = wantsComposition
        ? await syncCompositionCollection(db, mailAccountId, requested.Composition ?? null)
        : null;

      if (
        threadDelta ||
        labelDelta ||
        compositionDelta ||
        mutationResults.length > 0 ||
        composeSaveResults.length > 0
      ) {
        mailAccountsResult[mailAccountId] = {
          ...(threadDelta ? { Thread: threadDelta } : {}),
          ...(labelDelta ? { Label: labelDelta } : {}),
          ...(compositionDelta ? { Composition: compositionDelta } : {}),
          ...(mutationResults.length > 0 ? { mutations: mutationResults } : {}),
          ...(composeSaveResults.length > 0 ? { composeSaves: composeSaveResults } : {}),
        };
      }
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
