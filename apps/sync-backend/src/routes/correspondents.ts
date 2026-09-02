import { correspondentSearchResponseSchema } from "@mail/shared";
import { and, desc, eq, ilike, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import { correspondents } from "../db/schema.js";
import { getMailAccountForUser } from "../mail-accounts/store.js";
import { toWireCorrespondent } from "../sync/thread-projection.js";

export interface CorrespondentRoutesOptions {
  db: Db;
}

/** How many long-tail matches to hand back per query — a completion list, not a search result page. */
const SEARCH_LIMIT = 20;
/** compose-spec's floor before a query is worth a round trip at all. */
const MIN_QUERY_LENGTH = 1;

/**
 * `GET /correspondents/search` (#49, compose-spec §Recipient autocomplete):
 * the "queries the backend in parallel for the long tail" half. The Client's
 * synced top ~500 (`Correspondent` collection) answers the first keystroke
 * instantly and locally; this route is what a query that misses that local
 * set falls through to — every Correspondent this Mail Account has ever
 * had, not just its top ~500, ranked the same way.
 *
 * Deliberately a plain fetch-through read, not a synced collection: full
 * Correspondent history cannot live in the Local Cache
 * (ADR-0009), the same reasoning that keeps the search backend
 * (ADR-0016) out of the Client's own store.
 */
export async function correspondentRoutes(
  app: FastifyInstance,
  { db }: CorrespondentRoutesOptions,
) {
  app.get("/correspondents/search", { preHandler: app.requireAuth }, async (request, reply) => {
    const { mailAccountId, q } = request.query as { mailAccountId?: string; q?: string };
    if (!mailAccountId || !q || q.trim().length < MIN_QUERY_LENGTH) {
      return reply.code(400).send({ error: "invalid_request" });
    }

    const userId = requireUser(request).id;
    const account = await getMailAccountForUser(db, userId, mailAccountId);
    if (!account) {
      return reply.code(404).send({ error: "not_found" });
    }

    const needle = `%${escapeLike(q.trim())}%`;
    const rows = await db
      .select()
      .from(correspondents)
      .where(
        and(
          eq(correspondents.mailAccountId, mailAccountId),
          or(ilike(correspondents.address, needle), ilike(correspondents.name, needle)),
        ),
      )
      .orderBy(desc(correspondents.score))
      .limit(SEARCH_LIMIT);

    return correspondentSearchResponseSchema.parse({
      correspondents: rows.map(toWireCorrespondent),
    });
  });
}

/** Escapes `ILIKE`'s own wildcard characters so a literal `%`/`_` in a query never matches unrelated addresses. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function requireUser(request: { user: { id: string } | null }): { id: string } {
  if (!request.user) {
    throw new Error("requireAuth did not populate request.user");
  }
  return request.user;
}
