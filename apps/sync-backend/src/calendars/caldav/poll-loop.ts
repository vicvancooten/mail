import { and, eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../../db/client.js";
import {
  calendarMirrorSyncState,
  calendars,
  connectedAccountFacets,
  connectedAccounts,
} from "../../db/schema.js";
import { type PollLoopHandle, startPollLoop } from "../../sync/poll-loop.js";
import { caldavEventPollIntervalMs } from "./cadence.js";
import { syncCaldavCalendarList } from "./calendar-list-sync.js";
import type { CaldavAuth, CaldavCalendarClient } from "./client.js";
import type { CaldavCredentialProvider } from "./credentials.js";
import { syncCaldavCalendarEvents } from "./event-sync.js";
import { caldavHrefFromRowId } from "./fold.js";

/** #234's own two cadence numbers, reused verbatim for CalDAV (#247: "on the shared poll-loop helper"). */
const CALENDAR_LIST_INTERVAL_MS = 15 * 60 * 1000;
const TICK_INTERVAL_MS = 60 * 1000;

export interface CaldavCalendarMirrorLoopOptions {
  client: CaldavCalendarClient;
  credentials: CaldavCredentialProvider;
  logger?: FastifyBaseLogger;
  /** Test seam — the real loop always uses `TICK_INTERVAL_MS`. */
  tickIntervalMs?: number;
}

export function startCaldavCalendarMirrorLoop(
  db: Db,
  options: CaldavCalendarMirrorLoopOptions,
): PollLoopHandle {
  const { client, credentials, logger, tickIntervalMs = TICK_INTERVAL_MS } = options;
  return startPollLoop({
    label: "caldav calendar mirror loop",
    intervalMs: tickIntervalMs,
    logger,
    tick: ({ isStopped }) =>
      runCaldavCalendarMirrorTick(db, { client, credentials, logger, isStopped }),
  });
}

export async function runCaldavCalendarMirrorTick(
  db: Db,
  deps: {
    client: CaldavCalendarClient;
    credentials: CaldavCredentialProvider;
    logger?: FastifyBaseLogger;
    isStopped?: () => boolean;
  },
): Promise<void> {
  const accounts = await listCaldavCalendarAccounts(db);
  for (const account of accounts) {
    if (deps.isStopped?.()) return;
    await tickOneAccount(db, account, deps);
  }
}

interface CaldavCalendarAccount {
  connectedAccountId: string;
  userId: string;
  homeSetUrl: string;
}

/**
 * Every active Calendar Facet on a CalDAV/CardDAV Connected Account (#247)
 * — unlike Google/Graph (`google/poll-loop.ts`'s own doc comment on why it
 * derives accounts from `calendars` alone), the Connected Account and its
 * Facet already exist here (#203/#199) with the home-set URL discovery
 * already resolved, so this reads that directly rather than waiting for a
 * first mirrored Calendar row to exist.
 */
async function listCaldavCalendarAccounts(db: Db): Promise<CaldavCalendarAccount[]> {
  const rows = await db
    .select({
      connectedAccountId: connectedAccounts.id,
      userId: connectedAccounts.userId,
      homeSetUrl: connectedAccountFacets.davHomeSetUrl,
    })
    .from(connectedAccountFacets)
    .innerJoin(
      connectedAccounts,
      eq(connectedAccounts.id, connectedAccountFacets.connectedAccountId),
    )
    .where(
      and(
        eq(connectedAccounts.provider, "caldav_carddav"),
        eq(connectedAccountFacets.kind, "calendar"),
        eq(connectedAccountFacets.status, "active"),
      ),
    );
  return rows.filter(
    (row): row is CaldavCalendarAccount =>
      typeof row.homeSetUrl === "string" && row.homeSetUrl.length > 0,
  );
}

async function tickOneAccount(
  db: Db,
  account: CaldavCalendarAccount,
  deps: {
    client: CaldavCalendarClient;
    credentials: CaldavCredentialProvider;
    logger?: FastifyBaseLogger;
  },
): Promise<void> {
  const { client, credentials, logger } = deps;
  const auth: CaldavAuth | null = await credentials.getAuth(account.connectedAccountId);
  if (!auth) return;

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
      await syncCaldavCalendarList({
        db,
        userId: account.userId,
        connectedAccountId: account.connectedAccountId,
        homeSetUrl: account.homeSetUrl,
        client,
        auth,
      });
    }

    const eventIntervalMs = await caldavEventPollIntervalMs(db, account.userId, now);
    const eventsDue =
      pollRequested ||
      !state?.lastEventSyncAt ||
      now.getTime() - state.lastEventSyncAt.getTime() >= eventIntervalMs;

    if (eventsDue) {
      const mirroredCalendars = await db
        .select({ id: calendars.id })
        .from(calendars)
        .where(
          and(
            eq(calendars.originType, "connectedAccount"),
            eq(calendars.connectedAccountId, account.connectedAccountId),
            eq(calendars.mirrored, true),
          ),
        );
      for (const calendarRow of mirroredCalendars) {
        const calendarHref = caldavHrefFromRowId(calendarRow.id, account.connectedAccountId);
        await syncCaldavCalendarEvents({
          db,
          userId: account.userId,
          calendarId: calendarRow.id,
          calendarHref,
          client,
          auth,
        });
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
      "caldav calendar mirror loop: tick failed",
    );
  }
}
