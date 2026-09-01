import { searchRequestSchema, searchResponseSchema } from "@mail/shared";
import { inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import { folders, messages, threads } from "../db/schema.js";
import { resolveVerdicts, verdictFor } from "../gatekeeper/verdicts.js";
import { getMailAccountForUser } from "../mail-accounts/store.js";
import { runSearch } from "../sync/search-query.js";
import { toWireThread } from "../sync/thread-projection.js";
import type { ThreadRow } from "../sync/threading.js";

export interface SearchRoutesOptions {
  db: Db;
}

/**
 * `POST /search` (#50, ADR-0016, `docs/search-ux-spec.md`): ranks the
 * Candidate Window and hands back thread-deduped results. Deliberately
 * outside ADR-0011's `POST /sync` — a stateless query, not a synced
 * collection — so this is its own plain route rather than another entry in
 * the delta envelope.
 */
export async function searchRoutes(app: FastifyInstance, { db }: SearchRoutesOptions) {
  app.post("/search", { preHandler: app.requireAuth }, async (request, reply) => {
    const parsed = searchRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const filters = parsed.data;

    const userId = requireUser(request).id;
    const account = await getMailAccountForUser(db, userId, filters.mailAccountId);
    if (!account) {
      return reply.code(404).send({ error: "not_found" });
    }

    const { rows, cursor } = await runSearch(db, filters);
    const indexWatermark = {
      coveredSince: account.bodyWatermark?.toISOString() ?? null,
      complete: account.bodySweepComplete,
    };

    if (rows.length === 0) {
      return searchResponseSchema.parse({ results: [], cursor, indexWatermark });
    }

    // One round trip apiece for the two projections every row needs — the
    // same `Thread` list-row projection ADR-0011 already defines, and the
    // folder pill `docs/search-ux-spec.md` puts on every non-Inbox row.
    // Thread-deduped means at most `PAGE_SIZE` distinct thread ids and a
    // handful of folder ids, never one lookup per row.
    const threadIds = [...new Set(rows.map((row) => row.threadId))];
    const folderIds = [...new Set(rows.map((row) => row.folderId))];
    const matchedIds = [...new Set(rows.map((row) => row.matchedMessageId))];
    const [threadRows, folderRows, matchedRows] = await Promise.all([
      db.select().from(threads).where(inArray(threads.id, threadIds)),
      db.select().from(folders).where(inArray(folders.id, folderIds)),
      // The `Blocked` badge is a fact about the matched message's *sender*,
      // not about its Thread (`@mail/shared`'s `searchResultSchema`), so the
      // `From` has to come off the message — one batched read for the whole
      // page, alongside the two projections above.
      db
        .select({ id: messages.id, fromAddress: messages.fromAddress })
        .from(messages)
        .where(inArray(messages.id, matchedIds)),
    ]);
    const threadById = new Map(threadRows.map((row) => [row.id, row as ThreadRow]));
    const folderById = new Map(folderRows.map((row) => [row.id, row]));
    const senderByMessageId = new Map(matchedRows.map((row) => [row.id, row.fromAddress]));
    const verdicts = await resolveVerdicts(
      db,
      account.id,
      matchedRows.map((row) => row.fromAddress ?? ""),
    );

    const results = rows.flatMap((row) => {
      const thread = threadById.get(row.threadId);
      const folder = folderById.get(row.folderId);
      // Vanished (a Thread merge, a folder rebuild) between the ranking
      // query above and these lookups — dropped rather than erroring; the
      // next search reconciles it.
      if (!thread || !folder) return [];
      // Held wins over Blocked when both somehow apply: a Thread sitting in
      // the Screener is the state the User can still act on, and it is the
      // one the badge should send them to.
      const gatekeeper = thread.heldSender
        ? ("held" as const)
        : verdictFor(verdicts, senderByMessageId.get(row.matchedMessageId) ?? null).verdict ===
            "blocked"
          ? ("blocked" as const)
          : null;
      return [
        {
          thread: toWireThread(thread),
          matchedMessageId: row.matchedMessageId,
          headline: row.headline,
          folder: { id: folder.id, name: folder.name, role: folder.role },
          gatekeeper,
        },
      ];
    });

    return searchResponseSchema.parse({ results, cursor, indexWatermark });
  });
}

function requireUser(request: { user: { id: string } | null }): { id: string } {
  if (!request.user) {
    throw new Error("requireAuth did not populate request.user");
  }
  return request.user;
}
