import type {
  CollectionDelta,
  ComposeSaveOutcome,
  MutationOutcome,
  SyncResponse,
} from "@mail/shared";
import { syncRequestSchema, syncResponseSchema } from "@mail/shared";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import { getMailAccountForUser } from "../mail-accounts/store.js";
import { computeUnreadInboxCount } from "../notifier/badge.js";
import {
  mailAccountCollectionRegistry,
  userCollectionRegistry,
} from "../sync/collection-registry.js";
import { flushComposeSaves } from "../sync/compose-store.js";
import { flushMutations, flushUserMutations } from "../sync/mutations.js";
import { flushNoteSaves } from "../sync/note-store.js";

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
 * The User-scoped collections are answered **after every Mail Account's
 * queue has drained**, for the same reason one step out: a
 * Mail-Account-scoped intent can change a User-scoped row (`applyLabel`
 * creates a `Label`, #186; `setSignature` moves a `MailAccount`), so reading
 * them first would answer with state this very request has since changed.
 *
 * `composeSaves` are flushed **before** `mutations`, and that order is
 * load-bearing rather than incidental: a `sendComposition` intent (#46) sends
 * whatever content the Composition row holds at the moment it is applied, and
 * the Client enqueues the send in the same round as the composer's final
 * autosave. Draining the saves first is what makes "send" mean "send what I
 * was looking at" instead of "send the last thing that happened to have
 * reached the server". The two arrays otherwise touch disjoint tables, so
 * nothing else depends on which goes first.
 *
 * Which collections to answer, per scope, comes from `collection-registry.ts`
 * (#184) rather than a hand-written branch per collection: `userSyncRequest`/
 * `mailAccountSyncRequest` name a collection's requested token only when the
 * Client actually asked for it, so this route reads that token generically
 * off each registered descriptor's `name` and only ever calls `descriptor
 * .sync` for the ones present.
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
    // `noteSaves` (#192, ADR-0023) flush before `mutations`, the same
    // relative order `composeSaves` keeps ahead of a Mail Account's own
    // `mutations` below — see that comment further down for why the order is
    // load-bearing there. It is not load-bearing here (no Note intent reads
    // `document`), but keeping the two channels in the same relative
    // position is one less thing to remember.
    const noteSaves = user?.noteSaves ?? [];
    const noteSaveResults = noteSaves.length > 0 ? await flushNoteSaves(db, userId, noteSaves) : [];
    if (noteSaveResults.length > 0) userResult.noteSaves = noteSaveResults;

    // #54's User-scoped `Preference` mutations flush before its collection
    // delta is computed, same ordering reason as a Mail Account's own
    // `mutations`-before-`Thread` below: the very same round trip's delta
    // then already reflects what just changed.
    const userMutations = user?.mutations ?? [];
    const userMutationResults =
      userMutations.length > 0 ? await flushUserMutations(db, userId, userMutations) : [];
    if (userMutationResults.length > 0) userResult.mutations = userMutationResults;

    const mailAccountsResult: SyncResponse["mailAccounts"] = {};
    for (const [mailAccountId, requested] of Object.entries(requestedMailAccounts ?? {})) {
      const wantsAnyCollection = mailAccountCollectionRegistry.some(
        (descriptor) => readRequestedToken(requested, descriptor.name) !== undefined,
      );
      const queued = requested.mutations ?? [];
      const queuedComposeSaves = requested.composeSaves ?? [];
      if (!wantsAnyCollection && queued.length === 0 && queuedComposeSaves.length === 0) {
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

      const accountResult: Record<string, unknown> = {};
      for (const descriptor of mailAccountCollectionRegistry) {
        const token = readRequestedToken(requested, descriptor.name);
        if (token === undefined) continue;
        const delta = await descriptor.sync(db, { mailAccountId, account }, token);
        if (delta) setCollectionDelta(accountResult, descriptor.name, delta);
      }

      if (
        Object.keys(accountResult).length > 0 ||
        mutationResults.length > 0 ||
        composeSaveResults.length > 0
      ) {
        mailAccountsResult[mailAccountId] = {
          ...accountResult,
          ...(mutationResults.length > 0 ? { mutations: mutationResults } : {}),
          ...(composeSaveResults.length > 0 ? { composeSaves: composeSaveResults } : {}),
        };
      }
    }

    // The User-scoped collection deltas come **last**, after every Mail
    // Account's queue has drained — the same "a mutation-flush response
    // carries deltas too" ordering each account gets for its own `Thread`,
    // extended across scopes because a Mail-Account-scoped mutation can
    // change a User-scoped row: `applyLabel` (#186) creates a `Label`, and
    // `setSignature`/`setNotificationsEnabled` move a `MailAccount`. Reading
    // these before the flush would answer with the row as it was a moment
    // before the intent this very request applied.
    for (const descriptor of userCollectionRegistry) {
      const token = readRequestedToken(user ?? {}, descriptor.name);
      if (token === undefined) continue;
      const delta = await descriptor.sync(db, { userId }, token);
      if (delta) setCollectionDelta(userResult, descriptor.name, delta);
    }
    // The app-icon badge (#53, ADR-0015): unconditional, never gated on
    // "something changed" — see `userSyncResponseSchema`'s own doc comment
    // for why the visibility-change "snap the badge true" round depends on
    // that.
    userResult.unreadInboxCount = await computeUnreadInboxCount(db, userId);

    return syncResponseSchema.parse({ user: userResult, mailAccounts: mailAccountsResult });
  });
}

function requireUser(request: { user: { id: string } | null }): { id: string } {
  if (!request.user) {
    throw new Error("requireAuth did not populate request.user");
  }
  return request.user;
}

/**
 * Reads one registered collection's requested token generically off a
 * parsed `user`/`mailAccounts[id]` request object, keyed by the descriptor's
 * own `name` (#184) — the schema in `@mail/shared` already guarantees this
 * is `string | null | undefined` for every field a descriptor names, so this
 * is a plain lookup, not a cast: `undefined` (absent from `requested`, or of
 * some other shape entirely) means "not requested".
 */
function readRequestedToken(
  requested: Record<string, unknown>,
  name: string,
): string | null | undefined {
  const value = requested[name];
  return value === null || typeof value === "string" ? value : undefined;
}

/** Assigns a collection's computed delta into a response bucket by its registered `name` — the loop this replaces used to write `result.Thread = ...`/`result.Label = ...` by hand, one line per collection. */
function setCollectionDelta(
  result: Record<string, unknown>,
  name: string,
  delta: CollectionDelta<unknown>,
): void {
  result[name] = delta;
}
