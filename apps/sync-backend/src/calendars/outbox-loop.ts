import { eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { getConnectedAccountById } from "../connected-accounts/store.js";
import type { Db } from "../db/client.js";
import { calendarOutbox, calendars } from "../db/schema.js";
import { type PollLoopHandle, startPollLoop } from "../sync/poll-loop.js";
import type { CaldavCalendarClient } from "./caldav/client.js";
import type { CaldavCredentialProvider } from "./caldav/credentials.js";
import { processCaldavOutboxEntry } from "./caldav/outbox-processor.js";
import type { GoogleCalendarClient } from "./google/client.js";
import type { GoogleCalendarCredentialProvider } from "./google/poll-loop.js";
import type { GraphCalendarClient } from "./graph/client.js";
import { processGraphOutboxEntry } from "./graph/outbox-processor.js";
import type { GraphCalendarCredentialProvider } from "./graph/poll-loop.js";
import { processOutboxEntry } from "./outbox-processor.js";
import { dueOutboxCandidateIds } from "./outbox-store.js";

/**
 * The write-back outbox's own sweep (#237, ADR-0025): a short interval, a
 * first tick that runs immediately (whatever the outbox held when the
 * process died is exactly what this boot-time tick resumes), one row
 * processed at a time. `calendarOutbox`/`series`/`rollbacks` are shared
 * across every upstream (#237's own tables, provider-agnostic by
 * construction — a row names a `seriesId`, never a provider); what this loop
 * adds for #248 is picking *which* provider's push actually runs a given
 * row, by the owning Calendar's Connected Account — `google.ts`/`graph.ts`'s
 * own outbox-processor own everything past that point, same as before.
 *
 * A row this tick cannot mint an access token for (the matching provider's
 * own credential provider returns `null` — no Connected Account, no Calendar
 * Facet, a parked one, or, for Graph, simply no refresh ever having kept the
 * Graph audience warm — `graph/credentials.ts`'s own doc comment) is simply
 * left alone: not claimed, no attempt counted, no deadline moved. That is
 * the whole of "Needs Reauth holds indefinitely" — there is no separate
 * status column for it, just a row this loop skips until the Facet (or, for
 * Graph, its access token) is usable again.
 */
const DEFAULT_INTERVAL_MS = 2_000;

export interface OutboxLoopOptions {
  google: {
    client: GoogleCalendarClient;
    credentials: GoogleCalendarCredentialProvider;
  };
  graph: {
    client: GraphCalendarClient;
    credentials: GraphCalendarCredentialProvider;
  };
  caldav: {
    client: CaldavCalendarClient;
    credentials: CaldavCredentialProvider;
  };
  intervalMs?: number;
  logger?: FastifyBaseLogger;
}

export type OutboxLoopHandle = PollLoopHandle;

export function startCalendarOutboxLoop(db: Db, options: OutboxLoopOptions): OutboxLoopHandle {
  const { google, graph, caldav, intervalMs = DEFAULT_INTERVAL_MS, logger } = options;
  return startPollLoop({
    label: "calendar outbox loop",
    intervalMs,
    logger,
    tick: ({ isStopped }) =>
      runCalendarOutboxTick(db, { google, graph, caldav, logger, isStopped }),
  });
}

export interface OutboxTickDeps {
  google: OutboxLoopOptions["google"];
  graph: OutboxLoopOptions["graph"];
  caldav: OutboxLoopOptions["caldav"];
  logger?: FastifyBaseLogger;
  isStopped?: () => boolean;
}

/** One tick's worth of work, factored out the same way `google/poll-loop.ts#runCalendarMirrorTick` is, so a test can drive it directly. */
export async function runCalendarOutboxTick(db: Db, deps: OutboxTickDeps): Promise<void> {
  const ids = await dueOutboxCandidateIds(db);
  for (const id of ids) {
    if (deps.isStopped?.()) return;
    await tickOneEntry(db, id, deps);
  }
}

async function tickOneEntry(
  db: Db,
  id: string,
  deps: {
    google: OutboxLoopOptions["google"];
    graph: OutboxLoopOptions["graph"];
    caldav: OutboxLoopOptions["caldav"];
    logger?: FastifyBaseLogger;
  },
): Promise<void> {
  const [row] = await db.select().from(calendarOutbox).where(eq(calendarOutbox.id, id));
  if (!row) return; // Already handled by an earlier entry in this same tick (e.g. deleted alongside its Series).

  const [calendarRow] = await db.select().from(calendars).where(eq(calendars.id, row.calendarId));
  if (!calendarRow || calendarRow.connectedAccountId === null) return;

  const account = await getConnectedAccountById(db, calendarRow.connectedAccountId);
  if (!account) return;

  try {
    if (account.provider === "google") {
      const accessToken = await deps.google.credentials.getAccessToken(
        calendarRow.connectedAccountId,
      );
      if (!accessToken) return; // Needs Reauth (or no Connected Account at all) — hold, untouched.
      await processOutboxEntry(db, id, {
        client: deps.google.client,
        accessToken,
        logger: deps.logger,
      });
      return;
    }
    if (account.provider === "microsoft") {
      const accessToken = await deps.graph.credentials.getAccessToken(
        calendarRow.connectedAccountId,
      );
      if (!accessToken) return;
      await processGraphOutboxEntry(db, id, {
        client: deps.graph.client,
        accessToken,
        logger: deps.logger,
      });
      return;
    }
    if (account.provider === "caldav_carddav") {
      const auth = await deps.caldav.credentials.getAuth(calendarRow.connectedAccountId);
      if (!auth) return; // Needs Reauth (or no active Calendar Facet) — hold, untouched.
      await processCaldavOutboxEntry(db, id, {
        client: deps.caldav.client,
        auth,
        logger: deps.logger,
      });
      return;
    }
  } catch (err) {
    deps.logger?.error({ err, outboxId: id }, "calendar outbox loop: tick failed");
  }
}
