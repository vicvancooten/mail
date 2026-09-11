import { and, eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { listActiveConnectedAccountsWithFacet } from "../../connected-accounts/store.js";
import type { Db } from "../../db/client.js";
import { calendarMirrorSyncState, calendars } from "../../db/schema.js";
import { type PollLoopHandle, startPollLoop } from "../../sync/poll-loop.js";
import { calendarEventPollIntervalMs } from "./cadence.js";
import { syncGoogleCalendarList } from "./calendar-list-sync.js";
import type { GoogleCalendarClient } from "./client.js";
import { syncGoogleCalendarEvents } from "./event-sync.js";

/** 15 minutes (#234's own acceptance line: "The Facet's calendar list is enumerated every 15 minutes"). */
const CALENDAR_LIST_INTERVAL_MS = 15 * 60 * 1000;
/** The tick itself runs far more often than either cadence — the loop, not `setTimeout`, decides per-account whether either enumeration or Event sync is actually due (#234: "runs on the shared loop helper, not an eighth hand-rolled `setTimeout`"). */
const TICK_INTERVAL_MS = 60 * 1000;

/**
 * Mints (and, once minted, refreshes) a Google API access token for one
 * Connected Account — deliberately an injected seam rather than a concrete
 * implementation here. There is no Connected Account / Grant table on this
 * branch's ancestry yet (#200, a sibling epic, not merged here — see
 * `db/schema.ts#calendars`' own doc comment), so nothing can mint a real
 * token today. `main.ts` wires in a provider that always returns `null`
 * until #200/#202 land here; every tick simply skips an account it gets
 * `null` for, exactly as it already skips one with zero mirrored Calendars.
 */
export interface GoogleCalendarCredentialProvider {
  getAccessToken(connectedAccountId: string): Promise<string | null>;
}

/** `main.ts`'s own default until #200/#202 supply a real provider — see this file's own doc comment. */
export const unavailableGoogleCalendarCredentials: GoogleCalendarCredentialProvider = {
  async getAccessToken() {
    return null;
  },
};

export interface CalendarMirrorLoopOptions {
  client: GoogleCalendarClient;
  credentials: GoogleCalendarCredentialProvider;
  logger?: FastifyBaseLogger;
  /** Test seam — the real loop always uses `TICK_INTERVAL_MS`. */
  tickIntervalMs?: number;
}

export function startCalendarMirrorLoop(
  db: Db,
  options: CalendarMirrorLoopOptions,
): PollLoopHandle {
  const { client, credentials, logger, tickIntervalMs = TICK_INTERVAL_MS } = options;
  return startPollLoop({
    label: "calendar mirror loop",
    intervalMs: tickIntervalMs,
    logger,
    tick: ({ isStopped }) => runCalendarMirrorTick(db, { client, credentials, logger, isStopped }),
  });
}

/**
 * One tick's worth of work, factored out of `startPollLoop`'s own callback
 * so a test can drive it directly against a real `intervalMs`-free clock —
 * `poll-loop.test.ts` calls this, never `startCalendarMirrorLoop` itself,
 * for exactly that reason.
 */
export async function runCalendarMirrorTick(
  db: Db,
  deps: {
    client: GoogleCalendarClient;
    credentials: GoogleCalendarCredentialProvider;
    logger?: FastifyBaseLogger;
    isStopped?: () => boolean;
  },
): Promise<void> {
  const accounts = await listGoogleCalendarFacetAccounts(db);
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
 * Every Google Connected Account with an `active` Calendar Facet (#282) —
 * a fresh Facet grant with zero mirrored Calendar rows yet must still be
 * ticked so its first `syncGoogleCalendarList` run can actually create
 * them. The previous `calendars`-table-derived query only ever found an
 * account that already had at least one row, which meant a brand-new grant
 * was never listed and so could never mirror at all — `connectedAccounts.ts
 * #listActiveConnectedAccountsWithFacet` (already `contacts/google/poll-
 * loop.ts`'s own seam) is the Facet-driven source of truth this loop should
 * have used from the start.
 */
async function listGoogleCalendarFacetAccounts(db: Db): Promise<CalendarFacetAccount[]> {
  const rows = await listActiveConnectedAccountsWithFacet(db, "google", "calendar");
  return rows.map((row) => ({ connectedAccountId: row.connectedAccountId, userId: row.userId }));
}

async function tickOneAccount(
  db: Db,
  account: CalendarFacetAccount,
  deps: {
    client: GoogleCalendarClient;
    credentials: GoogleCalendarCredentialProvider;
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
      await syncGoogleCalendarList({
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
        .select({ id: calendars.id, connectedAccountId: calendars.connectedAccountId })
        .from(calendars)
        .where(
          and(
            eq(calendars.originType, "connectedAccount"),
            eq(calendars.connectedAccountId, account.connectedAccountId),
            eq(calendars.mirrored, true),
          ),
        );
      for (const calendarRow of mirroredCalendars) {
        // A mirrored row's Google-side id is the suffix of its own
        // deterministic id (`fold.ts#googleCalendarRowId`) — recovering it
        // this way, rather than a second stored column, keeps there being
        // exactly one place `connectedAccountId:googleCalendarId` is joined.
        const googleCalendarId = calendarRow.id.slice(`gcal:${account.connectedAccountId}:`.length);
        await syncGoogleCalendarEvents({
          db,
          userId: account.userId,
          calendarId: calendarRow.id,
          googleCalendarId,
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
      "calendar mirror loop: tick failed",
    );
  }
}
