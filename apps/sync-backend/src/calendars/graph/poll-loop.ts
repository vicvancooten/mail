import { and, eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { listActiveConnectedAccountsWithFacet } from "../../connected-accounts/store.js";
import type { Db } from "../../db/client.js";
import { calendarMirrorSyncState, calendars } from "../../db/schema.js";
import { type PollLoopHandle, startPollLoop } from "../../sync/poll-loop.js";
import { calendarEventPollIntervalMs } from "../google/cadence.js";
import { syncGraphCalendarList } from "./calendar-list-sync.js";
import type { GraphCalendarClient } from "./client.js";
import { syncGraphCalendarEvents } from "./event-sync.js";

/** 15 minutes — same enumeration cadence as Google's own (`google/poll-loop.ts`), reused verbatim; this ticket never asks for a different one. */
const CALENDAR_LIST_INTERVAL_MS = 15 * 60 * 1000;
/** The tick itself runs far more often than either cadence, same reasoning as `google/poll-loop.ts`'s own constant. */
const TICK_INTERVAL_MS = 60 * 1000;

/**
 * Mints (and, once minted, reads — see `credentials.ts`'s own doc comment
 * for why never *refreshes*) a Graph access token for one Connected
 * Account. `GoogleCalendarCredentialProvider`'s own shape
 * (`getAccessToken(connectedAccountId): Promise<string | null>`), declared
 * separately rather than imported, so this module names its own seam the
 * way `google/poll-loop.ts` names its.
 */
export interface GraphCalendarCredentialProvider {
  getAccessToken(connectedAccountId: string): Promise<string | null>;
}

/** `main.ts`'s own default should a Graph credential provider ever need one before wiring — mirrors `google/poll-loop.ts#unavailableGoogleCalendarCredentials`; unused today since `credentials.ts`'s real provider is always wired. */
export const unavailableGraphCalendarCredentials: GraphCalendarCredentialProvider = {
  async getAccessToken() {
    return null;
  },
};

export interface CalendarMirrorLoopOptions {
  client: GraphCalendarClient;
  credentials: GraphCalendarCredentialProvider;
  logger?: FastifyBaseLogger;
  /** Test seam — the real loop always uses `TICK_INTERVAL_MS`. */
  tickIntervalMs?: number;
}

export function startGraphCalendarMirrorLoop(
  db: Db,
  options: CalendarMirrorLoopOptions,
): PollLoopHandle {
  const { client, credentials, logger, tickIntervalMs = TICK_INTERVAL_MS } = options;
  return startPollLoop({
    label: "graph calendar mirror loop",
    intervalMs: tickIntervalMs,
    logger,
    tick: ({ isStopped }) =>
      runGraphCalendarMirrorTick(db, { client, credentials, logger, isStopped }),
  });
}

/** Factored out of `startPollLoop`'s own callback so a test can drive it directly — `google/poll-loop.ts#runCalendarMirrorTick`'s own reasoning. */
export async function runGraphCalendarMirrorTick(
  db: Db,
  deps: {
    client: GraphCalendarClient;
    credentials: GraphCalendarCredentialProvider;
    logger?: FastifyBaseLogger;
    isStopped?: () => boolean;
  },
): Promise<void> {
  const accounts = await listGraphCalendarFacetAccounts(db);
  for (const account of accounts) {
    if (deps.isStopped?.()) return;
    await tickOneAccount(db, account, deps);
  }
}

interface CalendarFacetAccount {
  connectedAccountId: string;
  userId: string;
}

/**
 * Every Microsoft Connected Account with an `active` Calendar Facet (#282)
 * — `google/poll-loop.ts#listGoogleCalendarFacetAccounts`'s own reasoning:
 * a fresh grant with zero mirrored rows yet must still be ticked so its
 * first `syncGraphCalendarList` run can create them, which the previous
 * `calendars`-table-derived query could never do for an account that
 * hadn't already mirrored at least one row.
 */
async function listGraphCalendarFacetAccounts(db: Db): Promise<CalendarFacetAccount[]> {
  const rows = await listActiveConnectedAccountsWithFacet(db, "microsoft", "calendar");
  return rows.map((row) => ({ connectedAccountId: row.connectedAccountId, userId: row.userId }));
}

async function tickOneAccount(
  db: Db,
  account: CalendarFacetAccount,
  deps: {
    client: GraphCalendarClient;
    credentials: GraphCalendarCredentialProvider;
    logger?: FastifyBaseLogger;
  },
): Promise<void> {
  const { client, credentials, logger } = deps;
  const accessToken = await credentials.getAccessToken(account.connectedAccountId);
  if (!accessToken) return;

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
      await syncGraphCalendarList({
        db,
        userId: account.userId,
        connectedAccountId: account.connectedAccountId,
        client,
        accessToken,
      });
    }

    const eventIntervalMs = await calendarEventPollIntervalMs(db, account.userId, now);
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
      const prefix = `gcal-ms:${account.connectedAccountId}:`;
      for (const calendarRow of mirroredCalendars) {
        if (!calendarRow.id.startsWith(prefix)) continue; // a Google-mirrored row sharing this tick's account id namespace — never this loop's own.
        const graphCalendarId = calendarRow.id.slice(prefix.length);
        await syncGraphCalendarEvents({
          db,
          userId: account.userId,
          calendarId: calendarRow.id,
          graphCalendarId,
          client,
          accessToken,
          now,
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
      "graph calendar mirror loop: tick failed",
    );
  }
}
