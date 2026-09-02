import type { GatekeeperStatusResponse } from "@mail/shared";
import { gatekeeperMutationResponseSchema, gatekeeperStatusResponseSchema } from "@mail/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../db/client.js";
import { disableGatekeeper, enableGatekeeper, resetGatekeeper } from "../gatekeeper/settings.js";
import { countApprovedSenders, listBlockedSenders } from "../gatekeeper/verdicts.js";
import { getMailAccountById, getMailAccountForUser } from "../mail-accounts/store.js";

export interface GatekeeperRoutesOptions {
  db: Db;
}

/**
 * Gatekeeper's account-level switches and its Settings read (#55,
 * poc-spec.md §Gatekeeper v1).
 *
 * Plain routes rather than `POST /sync` collections or mutation intents, and
 * the split is the same one `routes/send-settings.ts` already draws: the
 * *decisions* a User makes while triaging ride ADR-0010's optimistic queue
 * (`sync/mutations.ts`), while a configuration change with a server-side job
 * behind it — seeding thousands of Verdicts out of Sent history, stamping a
 * Cutoff from the server's own clock — is a request the User waits on and
 * sees the result of.
 *
 * The `MailAccount` collection still carries `gatekeeper.enabled`/`cutoff`
 * to every Client on the next `/sync`, so a switch flipped on the desktop
 * reaches the phone without either of them calling this route.
 */
export async function gatekeeperRoutes(app: FastifyInstance, { db }: GatekeeperRoutesOptions) {
  /** The Settings surface: the switch, the seed's size, and the Blocked Senders list. */
  app.get(
    "/mail-accounts/:mailAccountId/gatekeeper",
    { preHandler: app.requireAuth },
    async (request, reply) => {
      const mailAccountId = await authorizedAccountId(db, request, reply);
      if (!mailAccountId) return reply;
      return gatekeeperStatusResponseSchema.parse(await readStatus(db, mailAccountId));
    },
  );

  app.post(
    "/mail-accounts/:mailAccountId/gatekeeper/enable",
    { preHandler: app.requireAuth },
    async (request, reply) => {
      const mailAccountId = await authorizedAccountId(db, request, reply);
      if (!mailAccountId) return reply;
      const { seeded } = await enableGatekeeper(db, mailAccountId);
      return gatekeeperMutationResponseSchema.parse({
        ...(await readStatus(db, mailAccountId)),
        seeded,
      });
    },
  );

  app.post(
    "/mail-accounts/:mailAccountId/gatekeeper/disable",
    { preHandler: app.requireAuth },
    async (request, reply) => {
      const mailAccountId = await authorizedAccountId(db, request, reply);
      if (!mailAccountId) return reply;
      const { seeded } = await disableGatekeeper(db, mailAccountId);
      return gatekeeperMutationResponseSchema.parse({
        ...(await readStatus(db, mailAccountId)),
        seeded,
      });
    },
  );

  app.post(
    "/mail-accounts/:mailAccountId/gatekeeper/reset",
    { preHandler: app.requireAuth },
    async (request, reply) => {
      const mailAccountId = await authorizedAccountId(db, request, reply);
      if (!mailAccountId) return reply;
      const { seeded } = await resetGatekeeper(db, mailAccountId);
      return gatekeeperMutationResponseSchema.parse({
        ...(await readStatus(db, mailAccountId)),
        seeded,
      });
    },
  );
}

/**
 * Ownership is the only authorization primitive (ADR-0004), so a Mail
 * Account belonging to someone else and one that never existed answer
 * identically. Returns `null` having already sent the 404 — the caller just
 * returns `reply`.
 */
async function authorizedAccountId(
  db: Db,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<string | null> {
  if (!request.user) {
    throw new Error("requireAuth did not populate request.user");
  }
  const { mailAccountId } = request.params as { mailAccountId: string };
  const account = await getMailAccountForUser(db, request.user.id, mailAccountId);
  if (!account) {
    reply.code(404).send({ error: "not_found" });
    return null;
  }
  return account.id;
}

/**
 * Read after write, always: a switch's response reports the row as it now
 * stands rather than what the caller asked for, so a Client never renders a
 * Cutoff it invented from its own clock.
 */
async function readStatus(db: Db, mailAccountId: string): Promise<GatekeeperStatusResponse> {
  const [account, approvedCount, blocked] = await Promise.all([
    getMailAccountById(db, mailAccountId),
    countApprovedSenders(db, mailAccountId),
    listBlockedSenders(db, mailAccountId),
  ]);
  return {
    gatekeeper: {
      enabled: account?.gatekeeperEnabled ?? false,
      cutoff: account?.gatekeeperCutoff?.toISOString() ?? null,
    },
    approvedCount,
    blocked,
  };
}
