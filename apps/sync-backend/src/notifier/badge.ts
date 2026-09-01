import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { mailAccounts, threads } from "../db/schema.js";

/**
 * The app-icon badge's one source of truth (#53, ADR-0015): "unread Inbox
 * threads across all Mail Accounts... a backend-supplied counter", never a
 * `COUNT` over the Client's Local Cache (which caps at ~500 threads per
 * view). Shared by `routes/sync.ts` (the `/sync` response's
 * `unreadInboxCount`) and the Notifier (every push payload's `badgeCount`,
 * "computed at Notifier-fire time from the same counter the `/sync`
 * response uses") — one query, two callers, so the two paths can never
 * silently drift apart.
 *
 * Gatekeeper-held mail never counts (ADR-0015) — there is no Gatekeeper
 * column to exclude yet (#12 hasn't shipped one), so this is already correct
 * by construction: a held Thread doesn't exist as a Thread in the Inbox
 * sense until Gatekeeper releases it. The clause is a plain `inInbox`/
 * `unreadCount > 0` sum today; #12 is expected to add a Verdict exclusion
 * here once it has a column to exclude on.
 */
export async function computeUnreadInboxCount(db: Db, userId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${threads.unreadCount}), 0)::int` })
    .from(threads)
    .innerJoin(mailAccounts, eq(threads.mailAccountId, mailAccounts.id))
    .where(
      and(
        eq(mailAccounts.userId, userId),
        eq(threads.inInbox, true),
        sql`${threads.unreadCount} > 0`,
      ),
    );
  return row?.total ?? 0;
}
