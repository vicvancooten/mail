import { and, eq, isNotNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { mailAccounts, threads } from "../db/schema.js";
import { clearAllVerdicts, seedApprovedFromSentHistory } from "./verdicts.js";

/**
 * Gatekeeper's three account-level switches (#55, poc-spec.md §Gatekeeper
 * v1). Plain functions behind `routes/gatekeeper.ts` rather than
 * `MutationIntent`s on ADR-0010's queue, unlike the Screener's own
 * decisions: enabling sweeps the whole Sent history and stamps a Cutoff the
 * server's clock owns, which is neither predictable by a Client's optimistic
 * overlay nor something to replay from an offline queue an hour later.
 */

/**
 * The Cutoff is stored floored to its second, and compared with `>=`
 * (`gatekeeper/screening.ts`), because the arrival instant it is compared
 * against is IMAP's INTERNALDATE — which has **one-second granularity**
 * (RFC 3501 §2.3.3). Storing a millisecond-precise Cutoff and asking for
 * strictly-later arrivals would silently grandfather every message that
 * landed in the same second Gatekeeper was switched on, which is exactly the
 * second a User who just enabled it is watching.
 *
 * The cost is at most one second of over-screening — a message that arrived
 * fractionally *before* the click, in the same second, is screened. That is
 * the right way to be wrong: a stranger held for one extra decision, rather
 * than a stranger let through unnoticed.
 */
function flooredToSecond(now: Date): Date {
  return new Date(Math.floor(now.getTime() / 1000) * 1000);
}

/** How many held Threads a call released, so a route can say so. */
export interface GatekeeperSwitchResult {
  seeded: number;
  released: number;
}

/**
 * Enable: **Cutoff to now, seed Approved from Sent history** (poc-spec.md).
 * Those two together are the whole of "day one shows an empty Screener":
 * the Cutoff grandfathers everything already in the mailbox, and the seed
 * means the people the User actually corresponds with are through the gate
 * before the first stranger ever arrives.
 *
 * Idempotent: enabling an already-enabled account re-stamps the Cutoff
 * forward and re-runs the seed (which writes nothing it has written before).
 * Re-enabling after a disable moves the Cutoff to now rather than keeping
 * the old one — the mail that arrived while Gatekeeper was off was already
 * shown to the User in the Inbox, and pulling it back into the Screener now
 * would be screening mail they have already read.
 */
export async function enableGatekeeper(
  db: Db,
  mailAccountId: string,
  now: Date = new Date(),
): Promise<GatekeeperSwitchResult> {
  const seeded = await seedApprovedFromSentHistory(db, mailAccountId);
  await db
    .update(mailAccounts)
    .set({ gatekeeperEnabled: true, gatekeeperCutoff: flooredToSecond(now), updatedAt: now })
    .where(eq(mailAccounts.id, mailAccountId));
  return { seeded, released: 0 };
}

/**
 * Disable: **releases every held Thread but keeps verdicts** (poc-spec.md).
 * Keeping them is what makes switching Gatekeeper off and on again a pause
 * rather than a reset — that is what Reset is for. The Cutoff is kept too,
 * as a record of when screening first started; `enableGatekeeper` re-stamps
 * it on the way back in.
 */
export async function disableGatekeeper(
  db: Db,
  mailAccountId: string,
): Promise<GatekeeperSwitchResult> {
  const released = await releaseAllHolds(db, mailAccountId);
  await db
    .update(mailAccounts)
    .set({ gatekeeperEnabled: false, updatedAt: new Date() })
    .where(eq(mailAccounts.id, mailAccountId));
  return { seeded: 0, released };
}

/**
 * Reset Gatekeeper: **clears all verdicts and re-seeds** (poc-spec.md). The
 * escape hatch for a screening history that has gone wrong — a Block on the
 * wrong address, an approval the User can no longer account for — without
 * making them audit thousands of seeded rows to find it.
 *
 * Every current hold is released and the Cutoff is re-stamped, which follows
 * from grandfathering rather than being an extra decision: after a Reset the
 * mailbox's whole past is "before the Cutoff", and held mail is part of that
 * past. Releasing it puts it in the Inbox with its original dates, where the
 * User can see it; leaving it held would strand it behind decisions that no
 * longer exist.
 *
 * Blocked senders are cleared too, and that is deliberate: ADR-0008 already
 * says unblocking is future-only, so a Reset is the same promise at scale —
 * it stops the bleeding, it recovers nothing from Trash.
 */
export async function resetGatekeeper(
  db: Db,
  mailAccountId: string,
  now: Date = new Date(),
): Promise<GatekeeperSwitchResult> {
  const released = await releaseAllHolds(db, mailAccountId);
  await clearAllVerdicts(db, mailAccountId);
  const seeded = await seedApprovedFromSentHistory(db, mailAccountId);
  await db
    .update(mailAccounts)
    .set({ gatekeeperEnabled: true, gatekeeperCutoff: flooredToSecond(now), updatedAt: now })
    .where(eq(mailAccounts.id, mailAccountId));
  return { seeded, released };
}

/**
 * Clears every Screening Hold on the account, releasing the Threads into the
 * Inbox exactly where their own dates put them. Nothing about a release
 * touches IMAP or a date column — the mail never moved (ADR-0008: the hold
 * is an App Feature), so "with original received dates" is not a restore
 * step, it is what happens when the only thing that ever changed was one
 * nullable column.
 */
async function releaseAllHolds(db: Db, mailAccountId: string): Promise<number> {
  const released = await db
    .update(threads)
    .set({ heldSender: null, heldAt: null })
    .where(and(eq(threads.mailAccountId, mailAccountId), isNotNull(threads.heldSender)))
    .returning({ id: threads.id });
  return released.length;
}
