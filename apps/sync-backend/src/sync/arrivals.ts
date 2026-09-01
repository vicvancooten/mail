import type { Db } from "../db/client.js";
import { screenArrivals } from "../gatekeeper/screening.js";
import type { MailAccountRow } from "../mail-accounts/store.js";
import { recordGatekeeperDigest, recordNewMailNotifications } from "../notifier/record.js";
import type { FolderRow } from "./folders.js";

/**
 * What both **live** arrival paths do with a batch of newly stored messages
 * (#55): screen it, then notify on whatever screening let through.
 *
 * The order is the whole point, and it is why this exists as one function
 * rather than two calls repeated in `sync/delta.ts` and
 * `sync/qresync-catchup.ts`: Gatekeeper decides *before* the Notifier is
 * consulted, so a stranger's first message is held, moved, or released
 * before anything could have interrupted the User about it. Held mail never
 * fires a `new_mail` push (poc-scope.md: "Blocked and Unscreened mail never
 * pushes otherwise") — it gets at most the coalesced digest below.
 *
 * Both call sites reach here immediately after storing messages that arrived
 * over IDLE or a live delta, and **nothing** in `sync/ingest.ts`'s backfill
 * does — the same "which functions call this" contract `notifier/record.ts`
 * documents for itself. Backfill must neither screen (everything it finds
 * predates the Cutoff) nor notify (ADR-0015: "backfill and `reset: true` can
 * never notify").
 */
export async function handleNewArrivals(
  db: Db,
  folder: Pick<FolderRow, "id" | "mailAccountId" | "role">,
  account: Pick<
    MailAccountRow,
    "id" | "userId" | "notificationsEnabled" | "gatekeeperEnabled" | "gatekeeperCutoff"
  >,
  createdMessageIds: string[],
): Promise<void> {
  if (createdMessageIds.length === 0) return;

  const screened = await screenArrivals(db, folder, account, createdMessageIds);
  await recordNewMailNotifications(db, folder, account, screened.notifiableMessageIds);
  await recordGatekeeperDigest(db, account, screened.newlyHeldSenders);
}
