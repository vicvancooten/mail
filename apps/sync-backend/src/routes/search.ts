import { searchRequestSchema, searchResponseSchema } from "@mail/shared";
import { inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import { folders, messages, threads } from "../db/schema.js";
import { resolveVerdicts, verdictFor } from "../gatekeeper/verdicts.js";
import { getMailAccountsForUser, type MailAccountRow } from "../mail-accounts/store.js";
import { runSearch } from "../sync/search-query.js";
import { toWireThread } from "../sync/thread-projection.js";
import type { ThreadRow } from "../sync/threading.js";

export interface SearchRoutesOptions {
  db: Db;
}

/**
 * `POST /search` (#50, #68, ADR-0016, `docs/search-ux-spec.md`): ranks the
 * Account Scope's merged Candidate Windows and hands back thread-deduped
 * results. Deliberately outside ADR-0011's `POST /sync` — a stateless
 * query, not a synced collection — so this is its own plain route rather
 * than another entry in the delta envelope.
 */
export async function searchRoutes(app: FastifyInstance, { db }: SearchRoutesOptions) {
  app.post("/search", { preHandler: app.requireAuth }, async (request, reply) => {
    const parsed = searchRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const filters = parsed.data;

    const userId = requireUser(request).id;
    // The Account Scope (#68): `mailAccountId` plus every
    // `additionalMailAccountIds` entry, deduped — every one of them must
    // belong to this User or the whole request is rejected, same posture
    // single-account search already had for its one id.
    const scopeAccountIds = [
      ...new Set([filters.mailAccountId, ...(filters.additionalMailAccountIds ?? [])]),
    ];
    const accounts = await getMailAccountsForUser(db, userId, scopeAccountIds);
    if (accounts.length !== scopeAccountIds.length) {
      return reply.code(404).send({ error: "not_found" });
    }

    const { rows, cursor } = await runSearch(db, {
      mailAccountIds: scopeAccountIds,
      text: filters.text,
      from: filters.from,
      to: filters.to,
      hasAttachment: filters.hasAttachment,
      folder: filters.folder,
      label: filters.label,
      after: filters.after,
      before: filters.before,
      cursor: filters.cursor,
    });
    const indexWatermark = mergeIndexWatermark(accounts);

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
      // page, alongside the two projections above. `mailAccountId` travels
      // too: Gatekeeper Verdicts never cross Mail Accounts (CONTEXT.md), so
      // an Account-Scope search must resolve them per account, never merged.
      db
        .select({
          id: messages.id,
          fromAddress: messages.fromAddress,
          mailAccountId: messages.mailAccountId,
        })
        .from(messages)
        .where(inArray(messages.id, matchedIds)),
    ]);
    const threadById = new Map(threadRows.map((row) => [row.id, row as ThreadRow]));
    const folderById = new Map(folderRows.map((row) => [row.id, row]));
    const matchedById = new Map(matchedRows.map((row) => [row.id, row]));
    const verdictsByAccount = await resolveVerdictsPerAccount(db, matchedRows);

    const results = rows.flatMap((row) => {
      const thread = threadById.get(row.threadId);
      const folder = folderById.get(row.folderId);
      // Vanished (a Thread merge, a folder rebuild) between the ranking
      // query above and these lookups — dropped rather than erroring; the
      // next search reconciles it.
      if (!thread || !folder) return [];
      const matched = matchedById.get(row.matchedMessageId);
      const verdicts = matched ? verdictsByAccount.get(matched.mailAccountId) : undefined;
      // Held wins over Blocked when both somehow apply: a Thread sitting in
      // the Screener is the state the User can still act on, and it is the
      // one the badge should send them to.
      const gatekeeper = thread.heldSender
        ? ("held" as const)
        : verdictFor(verdicts ?? new Map(), matched?.fromAddress ?? null).verdict === "blocked"
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

/**
 * One `resolveVerdicts` call per Mail Account actually represented among the
 * matched messages — never one merged call across the Account Scope, which
 * would let a sender Blocked on one account badge a message on another
 * (CONTEXT.md: "Verdicts are scoped to a single Mail Account").
 */
async function resolveVerdictsPerAccount(
  db: Db,
  matchedRows: { id: string; fromAddress: string | null; mailAccountId: string }[],
) {
  const addressesByAccount = new Map<string, string[]>();
  for (const row of matchedRows) {
    const list = addressesByAccount.get(row.mailAccountId) ?? [];
    list.push(row.fromAddress ?? "");
    addressesByAccount.set(row.mailAccountId, list);
  }
  const entries = await Promise.all(
    [...addressesByAccount.entries()].map(
      async ([mailAccountId, addresses]) =>
        [mailAccountId, await resolveVerdicts(db, mailAccountId, addresses)] as const,
    ),
  );
  return new Map(entries);
}

/**
 * The Account Scope's Index Watermark (#68, ADR-0016 amendment): the
 * weakest across every in-scope account. `complete` is true only once every
 * account's own sweep is; `coveredSince` is the most recent (least history
 * covered) date among them, or `null` if any account's is — an account with
 * no known coverage yet never gets silently overstated by a comfortably old
 * date from another. Reduces to today's single-account read exactly when
 * `accounts.length === 1`.
 */
function mergeIndexWatermark(accounts: MailAccountRow[]): {
  coveredSince: string | null;
  complete: boolean;
} {
  const complete = accounts.every((account) => account.bodySweepComplete);
  let coveredSince: Date | null = null;
  let sawNull = false;
  for (const account of accounts) {
    if (account.bodyWatermark === null) {
      sawNull = true;
      continue;
    }
    if (coveredSince === null || account.bodyWatermark > coveredSince) {
      coveredSince = account.bodyWatermark;
    }
  }
  return { coveredSince: sawNull ? null : (coveredSince?.toISOString() ?? null), complete };
}

function requireUser(request: { user: { id: string } | null }): { id: string } {
  if (!request.user) {
    throw new Error("requireAuth did not populate request.user");
  }
  return request.user;
}
