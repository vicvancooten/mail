import { eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db/client.js";
import { calendarMirrorSyncState } from "../db/schema.js";
import { type PollLoopHandle, startPollLoop } from "../sync/poll-loop.js";

/** 15 minutes (#234's own acceptance line: "The Facet's calendar list is enumerated every 15 minutes"). Shared by every calendar mirror provider (google/graph/caldav) — none of them has ever needed a different one. */
export const CALENDAR_LIST_INTERVAL_MS = 15 * 60 * 1000;
/** The tick itself runs far more often than either cadence — the loop, not `setTimeout`, decides per-account whether either enumeration or Event sync is actually due (#234: "runs on the shared loop helper, not an eighth hand-rolled `setTimeout`"). */
export const TICK_INTERVAL_MS = 60 * 1000;

export interface MirrorAccount {
  connectedAccountId: string;
  userId: string;
}

/**
 * Everything a specific provider (google/poll-loop.ts, graph/poll-loop.ts,
 * …) contributes to an otherwise-identical mirror poll loop: how to find
 * its own accounts, mint/read its own credential, and run its own
 * list/event syncs. Extracted after the "fresh Facet grant with zero
 * mirrored rows never ticking" bug (#282) was independently fixed twice —
 * once in google's `listGoogleCalendarFacetAccounts`, once in graph's
 * `listGraphCalendarFacetAccounts` — because the tick loop itself, not just
 * that one query, was duplicated. `runMirrorPollTick` below is the one
 * place that behaviour now lives; `mirror-poll-loop.test.ts` guards it
 * directly with a fake provider so a future regression can't land in only
 * one provider again.
 */
export interface MirrorLoopProvider<TAccount extends MirrorAccount, TClient, TCredentials, TCredential> {
  /** What this loop's own ticks and errors are logged against, e.g. "calendar mirror loop". */
  label: string;
  listAccounts(db: Db): Promise<TAccount[]>;
  /** `null` means skip this account entirely this tick — the same seam `google/poll-loop.ts#GoogleCalendarCredentialProvider` and `graph/poll-loop.ts#GraphCalendarCredentialProvider` already exposed before this extraction. */
  getCredential(credentials: TCredentials, connectedAccountId: string): Promise<TCredential | null>;
  syncCalendarList(args: {
    db: Db;
    account: TAccount;
    client: TClient;
    credential: TCredential;
  }): Promise<void>;
  eventPollIntervalMs(db: Db, userId: string, now: Date): Promise<number>;
  /** Every mirrored `calendars` row this provider owns for this account — `[]` if there's nothing to sync yet. */
  listMirroredCalendars(db: Db, account: TAccount): Promise<Array<{ id: string }>>;
  syncCalendarEvents(args: {
    db: Db;
    account: TAccount;
    calendarRow: { id: string };
    client: TClient;
    credential: TCredential;
    now: Date;
  }): Promise<void>;
}

export interface MirrorPollLoopOptions<TClient, TCredentials> {
  client: TClient;
  credentials: TCredentials;
  logger?: FastifyBaseLogger;
  /** Test seam — the real loop always uses `TICK_INTERVAL_MS`. */
  tickIntervalMs?: number;
}

export function startMirrorPollLoop<
  TAccount extends MirrorAccount,
  TClient,
  TCredentials,
  TCredential,
>(
  db: Db,
  provider: MirrorLoopProvider<TAccount, TClient, TCredentials, TCredential>,
  options: MirrorPollLoopOptions<TClient, TCredentials>,
): PollLoopHandle {
  const { client, credentials, logger, tickIntervalMs = TICK_INTERVAL_MS } = options;
  return startPollLoop({
    label: provider.label,
    intervalMs: tickIntervalMs,
    logger,
    tick: ({ isStopped }) =>
      runMirrorPollTick(db, provider, { client, credentials, logger, isStopped }),
  });
}

/**
 * One tick's worth of work, factored out of `startPollLoop`'s own callback
 * so a test can drive it directly against a real `intervalMs`-free clock —
 * every provider's own `poll-loop.test.ts` calls its thin wrapper of this,
 * never `startMirrorPollLoop` itself, for exactly that reason.
 */
export async function runMirrorPollTick<
  TAccount extends MirrorAccount,
  TClient,
  TCredentials,
  TCredential,
>(
  db: Db,
  provider: MirrorLoopProvider<TAccount, TClient, TCredentials, TCredential>,
  deps: {
    client: TClient;
    credentials: TCredentials;
    logger?: FastifyBaseLogger;
    isStopped?: () => boolean;
  },
): Promise<void> {
  const accounts = await provider.listAccounts(db);
  for (const account of accounts) {
    if (deps.isStopped?.()) return;
    await tickOneMirrorAccount(db, provider, account, deps);
  }
}

async function tickOneMirrorAccount<
  TAccount extends MirrorAccount,
  TClient,
  TCredentials,
  TCredential,
>(
  db: Db,
  provider: MirrorLoopProvider<TAccount, TClient, TCredentials, TCredential>,
  account: TAccount,
  deps: {
    client: TClient;
    credentials: TCredentials;
    logger?: FastifyBaseLogger;
  },
): Promise<void> {
  const { client, credentials, logger } = deps;
  const credential = await provider.getCredential(credentials, account.connectedAccountId);
  if (!credential) return;

  const now = new Date();
  const [state] = await db
    .select()
    .from(calendarMirrorSyncState)
    .where(eq(calendarMirrorSyncState.connectedAccountId, account.connectedAccountId))
    .limit(1);

  const pollRequested = state?.pollRequestedAt != null;
  const listDue =
    pollRequested ||
    !state?.lastCalendarListSyncAt ||
    now.getTime() - state.lastCalendarListSyncAt.getTime() >= CALENDAR_LIST_INTERVAL_MS;

  try {
    if (listDue) {
      await provider.syncCalendarList({ db, account, client, credential });
    }

    const eventIntervalMs = await provider.eventPollIntervalMs(db, account.userId, now);
    const eventsDue =
      pollRequested ||
      !state?.lastEventSyncAt ||
      now.getTime() - state.lastEventSyncAt.getTime() >= eventIntervalMs;

    if (eventsDue) {
      const mirroredCalendars = await provider.listMirroredCalendars(db, account);
      for (const calendarRow of mirroredCalendars) {
        await provider.syncCalendarEvents({ db, account, calendarRow, client, credential, now });
      }
    }

    await db
      .insert(calendarMirrorSyncState)
      .values({
        connectedAccountId: account.connectedAccountId,
        lastCalendarListSyncAt: listDue ? now : state?.lastCalendarListSyncAt,
        lastEventSyncAt: eventsDue ? now : state?.lastEventSyncAt,
        pollRequestedAt: null,
      })
      .onConflictDoUpdate({
        target: calendarMirrorSyncState.connectedAccountId,
        set: {
          lastCalendarListSyncAt: listDue ? now : state?.lastCalendarListSyncAt,
          lastEventSyncAt: eventsDue ? now : state?.lastEventSyncAt,
          pollRequestedAt: null,
        },
      });
  } catch (err) {
    logger?.error(
      { err, connectedAccountId: account.connectedAccountId },
      `${provider.label}: tick failed`,
    );
  }
}
