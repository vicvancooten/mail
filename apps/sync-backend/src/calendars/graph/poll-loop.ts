import { and, eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { listActiveConnectedAccountsWithFacet } from "../../connected-accounts/store.js";
import type { Db } from "../../db/client.js";
import { calendars } from "../../db/schema.js";
import type { PollLoopHandle } from "../../sync/poll-loop.js";
import { calendarEventPollIntervalMs } from "../google/cadence.js";
import {
  type MirrorAccount,
  type MirrorLoopProvider,
  runMirrorPollTick,
  startMirrorPollLoop,
} from "../mirror-poll-loop.js";
import { syncGraphCalendarList } from "./calendar-list-sync.js";
import type { GraphCalendarClient } from "./client.js";
import { syncGraphCalendarEvents } from "./event-sync.js";

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
  /** Test seam — the real loop always uses the shared module's `TICK_INTERVAL_MS`. */
  tickIntervalMs?: number;
}

export function startGraphCalendarMirrorLoop(
  db: Db,
  options: CalendarMirrorLoopOptions,
): PollLoopHandle {
  const { client, credentials, logger, tickIntervalMs } = options;
  return startMirrorPollLoop(db, graphMirrorLoopProvider, {
    client,
    credentials,
    logger,
    tickIntervalMs,
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
  return runMirrorPollTick(db, graphMirrorLoopProvider, deps);
}

interface GraphCalendarFacetAccount extends MirrorAccount {
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
async function listGraphCalendarFacetAccounts(db: Db): Promise<GraphCalendarFacetAccount[]> {
  const rows = await listActiveConnectedAccountsWithFacet(db, "microsoft", "calendar");
  return rows.map((row) => ({ connectedAccountId: row.connectedAccountId, userId: row.userId }));
}

/**
 * The graph-specific half of `mirror-poll-loop.ts#MirrorLoopProvider`;
 * `google/poll-loop.ts#googleMirrorLoopProvider`'s own sibling, differing
 * only in the shape below — the shared tick/timing control flow and the
 * fresh-grant-zero-rows fix both now live in exactly one place.
 */
const graphMirrorLoopProvider: MirrorLoopProvider<
  GraphCalendarFacetAccount,
  GraphCalendarClient,
  GraphCalendarCredentialProvider,
  string
> = {
  label: "graph calendar mirror loop",
  listAccounts: listGraphCalendarFacetAccounts,
  getCredential: (credentials, connectedAccountId) =>
    credentials.getAccessToken(connectedAccountId),
  syncCalendarList: ({ db, account, client, credential }) =>
    syncGraphCalendarList({
      db,
      userId: account.userId,
      connectedAccountId: account.connectedAccountId,
      client,
      accessToken: credential,
    }),
  eventPollIntervalMs: calendarEventPollIntervalMs,
  listMirroredCalendars: async (db, account) => {
    const rows = await db
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
    // A Google-mirrored row can share this tick's account id namespace —
    // never this loop's own, so it's filtered out here rather than in the
    // shared module.
    return rows.filter((row) => row.id.startsWith(prefix));
  },
  syncCalendarEvents: ({ db, account, calendarRow, client, credential, now }) => {
    const prefix = `gcal-ms:${account.connectedAccountId}:`;
    const graphCalendarId = calendarRow.id.slice(prefix.length);
    return syncGraphCalendarEvents({
      db,
      userId: account.userId,
      calendarId: calendarRow.id,
      graphCalendarId,
      client,
      accessToken: credential,
      now,
    });
  },
};
