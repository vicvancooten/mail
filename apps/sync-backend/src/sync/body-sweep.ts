import { and, desc, eq, isNull } from "drizzle-orm";
import type { ImapFlow } from "imapflow";
import type { Db } from "../db/client.js";
import { folders, mailAccounts, messages } from "../db/schema.js";
import { isGmailAccount } from "../mail-accounts/server-kind.js";
import { fetchMessageBody, storeMessageBody } from "./bodies.js";
import { readBodyParts } from "./body-structure.js";
import { GMAIL_DOWNLOAD_CAP_RESUME_MS, isGmailDownloadCapError } from "./gmail-download-cap.js";

/**
 * The run-once background body sweep (#36) and the Index Watermark it
 * advances (CONTEXT.md): backfill and the live sync loop store headers only
 * (`messages.body_fetched_at` stays null), and this is the one place a body
 * gets fetched afterwards — across every folder, account-wide, always
 * newest-pending-first over `messages_body_pending_idx`.
 *
 * Newest-pending-first is what makes one sweep loop correct for both jobs at
 * once: a message the historical backfill just stored and a message that
 * just arrived over IDLE both land in the same pending set, and whichever
 * has the newer `receivedAt` — almost always the live arrival — sorts to the
 * front of the very next batch. There is no separate "eager body fetch for
 * new mail" path to keep in sync with this one.
 *
 * "Run once and then stops": once a batch comes back empty, this account has
 * nothing left pending and `bodySweepComplete` is set. It isn't a one-shot
 * job that never runs again, though — the resident loop keeps calling this
 * on a slow idle cadence (`sync/live-session.ts`), so new mail arriving
 * after completion is swept again (`storeMessage`'s own null body flips
 * `bodySweepComplete` back to false the moment such a row is selected here).
 */

/** Heavier than a header batch — each row is a full BODYSTRUCTURE re-fetch plus a body download. */
const DEFAULT_BATCH_SIZE = 50;

export interface BodySweepBatchResult {
  processed: number;
  /** True once nothing account-wide was left pending — the sweep just went idle. */
  complete: boolean;
  /**
   * Set only while a Gmail download-cap pause (#127, ADR-0020) is in
   * effect — the batch touched no IMAP command, either because it was
   * already paused or because this call is the one that just tripped the
   * cap.
   */
  pausedUntil?: Date;
}

/**
 * One batch of the sweep: the newest `batchSize` messages account-wide still
 * missing a body, fetched and stored, then the Index Watermark advanced to
 * the oldest one this batch actually covered.
 *
 * On a `gmail`-kind account, a download-cap/throttle response
 * (`gmail-download-cap.ts`) pauses rather than throws: it stamps
 * `bodySweepPausedUntil` and returns instead of failing the sweep, which is
 * what keeps `live-session.ts`'s shared failure signal from tearing the
 * whole resident session down over an expected, resolves-itself condition
 * (ADR-0020). The same response on any other server kind still throws, same
 * as before this ticket.
 */
export async function runBodySweepBatch(
  db: Db,
  client: ImapFlow,
  mailAccountId: string,
  batchSize = DEFAULT_BATCH_SIZE,
): Promise<BodySweepBatchResult> {
  const [account] = await db
    .select({
      serverKind: mailAccounts.serverKind,
      bodySweepPausedUntil: mailAccounts.bodySweepPausedUntil,
    })
    .from(mailAccounts)
    .where(eq(mailAccounts.id, mailAccountId))
    .limit(1);

  if (account?.bodySweepPausedUntil && account.bodySweepPausedUntil.getTime() > Date.now()) {
    return { processed: 0, complete: false, pausedUntil: account.bodySweepPausedUntil };
  }

  const pending = await db
    .select({
      id: messages.id,
      folderId: messages.folderId,
      uid: messages.uid,
      receivedAt: messages.receivedAt,
    })
    .from(messages)
    .where(and(eq(messages.mailAccountId, mailAccountId), isNull(messages.bodyFetchedAt)))
    .orderBy(desc(messages.receivedAt))
    .limit(batchSize);

  if (pending.length === 0) {
    await db
      .update(mailAccounts)
      .set({ bodySweepComplete: true, bodySweepPausedUntil: null, updatedAt: new Date() })
      .where(eq(mailAccounts.id, mailAccountId));
    return { processed: 0, complete: true };
  }

  const byFolder = new Map<string, typeof pending>();
  for (const row of pending) {
    const bucket = byFolder.get(row.folderId);
    if (bucket) bucket.push(row);
    else byFolder.set(row.folderId, [row]);
  }

  try {
    for (const [folderId, rows] of byFolder) {
      const [folder] = await db.select().from(folders).where(eq(folders.id, folderId)).limit(1);
      if (!folder) continue; // the folder was deleted (server-side removal) since this batch was selected

      const lock = await client.getMailboxLock(folder.path, { readOnly: true });
      try {
        // BODYSTRUCTURE isn't persisted at header-ingest time (`ingest.ts`
        // keeps only the derived attachment summary), so the sweep re-asks for
        // it here — one extra small FETCH per swept message, traded for not
        // widening every message row with a structure it may never need again.
        const fetched = await client.fetchAll(
          rows.map((row) => row.uid),
          { uid: true, bodyStructure: true },
          { uid: true },
        );
        const byUid = new Map(fetched.map((message) => [message.uid, message]));

        for (const row of rows) {
          const message = byUid.get(row.uid);
          if (!message) continue; // vanished between the pending SELECT and this FETCH — the next delta/poll pass reconciles it
          const parts = readBodyParts(message.bodyStructure);
          const body = await fetchMessageBody(client, row.uid, parts);
          // Stored even when both parts are absent (a pure-attachment
          // message): `bodyFetchedAt` still gets stamped, or a body-less
          // message would show up in every future batch forever and this
          // account would never reach `complete`.
          await storeMessageBody(db, row.id, body);
        }
      } finally {
        lock.release();
      }
    }
  } catch (err) {
    if (isGmailAccount(account?.serverKind) && isGmailDownloadCapError(err)) {
      const pausedUntil = new Date(Date.now() + GMAIL_DOWNLOAD_CAP_RESUME_MS);
      await db
        .update(mailAccounts)
        .set({ bodySweepPausedUntil: pausedUntil, updatedAt: new Date() })
        .where(eq(mailAccounts.id, mailAccountId));
      // Whatever bodies this batch already stored before the cap hit stay
      // stored — the next batch after resume picks up wherever
      // `bodyFetchedAt IS NULL` still leaves off, same as any other
      // partially-completed batch.
      return { processed: 0, complete: false, pausedUntil };
    }
    throw err;
  }

  const oldest = pending[pending.length - 1];
  if (!oldest) {
    throw new Error("pending body sweep batch was non-empty but yielded no rows");
  }
  await db
    .update(mailAccounts)
    .set({
      bodyWatermark: oldest.receivedAt,
      bodySweepComplete: false,
      bodySweepPausedUntil: null,
      updatedAt: new Date(),
    })
    .where(eq(mailAccounts.id, mailAccountId));

  return { processed: pending.length, complete: false };
}

/** A tiny sleep that also resolves early on `stopSignal` — same shape as `live-session.ts`'s own. */
function sleep(ms: number, stopSignal: Promise<void>): Promise<void> {
  return Promise.race([
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    }),
    stopSignal,
  ]);
}

export interface BodySweepOptions {
  batchSize?: number;
  /** Paused between batches while there's still work — keeps IDLE/poll traffic responsive. */
  pauseMs?: number;
  /** Paused between checks once caught up — no point hammering an empty queue. */
  idlePollMs?: number;
  stopSignal: Promise<void>;
  isStopped: () => boolean;
}

const DEFAULT_PAUSE_MS = 50;
const DEFAULT_IDLE_POLL_MS = 5_000;

/**
 * Runs the sweep to exhaustion and then keeps checking on a slow cadence —
 * the resident loop's other background worker (`sync/live-session.ts`),
 * alongside the header backfill walker and IDLE/polling, all sharing the one
 * IMAP connection ADR-0005 gives the account.
 */
export async function runBodySweep(
  db: Db,
  client: ImapFlow,
  mailAccountId: string,
  options: BodySweepOptions,
): Promise<void> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const pauseMs = options.pauseMs ?? DEFAULT_PAUSE_MS;
  const idlePollMs = options.idlePollMs ?? DEFAULT_IDLE_POLL_MS;

  while (!options.isStopped()) {
    const result = await runBodySweepBatch(db, client, mailAccountId, batchSize);
    if (options.isStopped()) return;
    // A pause (Gmail's download cap) gets the same slow cadence as "caught
    // up" — there is nothing to retry sooner than the resume time, and this
    // loop re-checks `bodySweepPausedUntil` itself on the next call rather
    // than sleeping for the whole remaining pause in one go.
    await sleep(result.complete || result.pausedUntil ? idlePollMs : pauseMs, options.stopSignal);
  }
}
