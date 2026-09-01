import { and, eq, isNull, sql } from "drizzle-orm";
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
 * **Gatekeeper-held mail never counts** (ADR-0015, #55): a Thread with a
 * Screening Hold is deliberately still `inInbox` — it is Inbox mail the User
 * has not been shown yet, not mail that was archived — so the exclusion has
 * to be explicit here rather than falling out of the `inInbox` clause. This
 * is what makes "a new stranger's mail is held, and the badge does not move"
 * true; releasing them (`gatekeeper/decisions.ts`) makes the badge jump on
 * the next `/sync`, which is exactly when the User can act on it.
 *
 * Blocked mail needs no clause of its own: ADR-0008 takes it out of the
 * Inbox on arrival, so `inInbox` already excludes it.
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
        isNull(threads.heldSender),
        sql`${threads.unreadCount} > 0`,
      ),
    );
  return row?.total ?? 0;
}
