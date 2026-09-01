import { searchRequestSchema, searchResponseSchema } from "@mail/shared";
import { inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import { folders, threads } from "../db/schema.js";
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
    const [threadRows, folderRows] = await Promise.all([
      db.select().from(threads).where(inArray(threads.id, threadIds)),
      db.select().from(folders).where(inArray(folders.id, folderIds)),
    ]);
    const threadById = new Map(threadRows.map((row) => [row.id, row as ThreadRow]));
    const folderById = new Map(folderRows.map((row) => [row.id, row]));

    const results = rows.flatMap((row) => {
      const thread = threadById.get(row.threadId);
      const folder = folderById.get(row.folderId);
      // Vanished (a Thread merge, a folder rebuild) between the ranking
      // query above and these lookups — dropped rather than erroring; the
      // next search reconciles it.
      if (!thread || !folder) return [];
      return [
        {
          thread: toWireThread(thread),
          matchedMessageId: row.matchedMessageId,
          headline: row.headline,
          folder: { id: folder.id, name: folder.name, role: folder.role },
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
