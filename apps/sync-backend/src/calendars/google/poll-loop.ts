import { and, eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { listActiveConnectedAccountsWithFacet } from "../../connected-accounts/store.js";
import type { Db } from "../../db/client.js";
import { calendars } from "../../db/schema.js";
import type { PollLoopHandle } from "../../sync/poll-loop.js";
import {
  type MirrorAccount,
  type MirrorLoopProvider,
  runMirrorPollTick,
  startMirrorPollLoop,
} from "../mirror-poll-loop.js";
import { calendarEventPollIntervalMs } from "./cadence.js";
import { syncGoogleCalendarList } from "./calendar-list-sync.js";
import type { GoogleCalendarClient } from "./client.js";
import { syncGoogleCalendarEvents } from "./event-sync.js";

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
  /** Test seam — the real loop always uses the shared module's `TICK_INTERVAL_MS`. */
  tickIntervalMs?: number;
}

export function startCalendarMirrorLoop(
  db: Db,
  options: CalendarMirrorLoopOptions,
): PollLoopHandle {
  const { client, credentials, logger, tickIntervalMs } = options;
  return startMirrorPollLoop(db, googleMirrorLoopProvider, {
    client,
    credentials,
    logger,
    tickIntervalMs,
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
  return runMirrorPollTick(db, googleMirrorLoopProvider, deps);
}

interface GoogleCalendarFacetAccount extends MirrorAccount {
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
async function listGoogleCalendarFacetAccounts(db: Db): Promise<GoogleCalendarFacetAccount[]> {
  const rows = await listActiveConnectedAccountsWithFacet(db, "google", "calendar");
  return rows.map((row) => ({ connectedAccountId: row.connectedAccountId, userId: row.userId }));
}

/**
 * The google-specific half of `mirror-poll-loop.ts#MirrorLoopProvider`; the
 * fresh-grant-zero-rows fix above and the shared tick/timing control flow
 * both now live in exactly one place. `graph/poll-loop.ts` is this
 * module's own sibling, differing only in the shape below.
 */
const googleMirrorLoopProvider: MirrorLoopProvider<
  GoogleCalendarFacetAccount,
  GoogleCalendarClient,
  GoogleCalendarCredentialProvider,
  string
> = {
  label: "calendar mirror loop",
  listAccounts: listGoogleCalendarFacetAccounts,
  getCredential: (credentials, connectedAccountId) => credentials.getAccessToken(connectedAccountId),
  syncCalendarList: ({ db, account, client, credential }) =>
    syncGoogleCalendarList({
      db,
      userId: account.userId,
      connectedAccountId: account.connectedAccountId,
      client,
      accessToken: credential,
    }),
  eventPollIntervalMs: calendarEventPollIntervalMs,
  listMirroredCalendars: (db, account) =>
    db
      .select({ id: calendars.id, connectedAccountId: calendars.connectedAccountId })
      .from(calendars)
      .where(
        and(
          eq(calendars.originType, "connectedAccount"),
          eq(calendars.connectedAccountId, account.connectedAccountId),
          eq(calendars.mirrored, true),
        ),
      ),
  syncCalendarEvents: ({ db, account, calendarRow, client, credential, now }) => {
    // A mirrored row's Google-side id is the suffix of its own
    // deterministic id (`fold.ts#googleCalendarRowId`) — recovering it
    // this way, rather than a second stored column, keeps there being
    // exactly one place `connectedAccountId:googleCalendarId` is joined.
    const googleCalendarId = calendarRow.id.slice(`gcal:${account.connectedAccountId}:`.length);
    return syncGoogleCalendarEvents({
      db,
      userId: account.userId,
      calendarId: calendarRow.id,
      googleCalendarId,
      client,
      accessToken: credential,
      now,
    });
  },
};
