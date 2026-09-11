import { randomUUID } from "node:crypto";
import { LOCAL_CALENDAR_CAPABILITIES } from "@mail/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  attachFacetToConnectedAccount,
  getConnectedAccountById,
} from "../../connected-accounts/store.js";
import type { Db } from "../../db/client.js";
import { calendarMirrorSyncState, calendars, users } from "../../db/schema.js";
import { createTestDb, resetTestDb } from "../../test-support/db.js";
import { createTestMailAccount } from "../../test-support/mail-account.js";
import type { GoogleCalendarClient } from "./client.js";
import { runCalendarMirrorTick, unavailableGoogleCalendarCredentials } from "./poll-loop.js";

let db: Db;
let closeDb: () => Promise<void>;

beforeEach(async () => {
  const created = await createTestDb();
  db = created.db;
  closeDb = () => created.sql.end();
  await resetTestDb(db);
});

afterAll(async () => {
  await closeDb?.();
});

async function createTestUser(): Promise<string> {
  const id = randomUUID();
  await db.insert(users).values({
    id,
    username: `user-${id.slice(0, 8)}`,
    passwordHash: "not-a-real-hash",
    role: "owner",
  });
  return id;
}

async function createMirroredCalendar(userId: string, connectedAccountId: string): Promise<void> {
  await db.insert(calendars).values({
    id: `gcal:${connectedAccountId}:primary`,
    userId,
    name: "Work",
    timeZone: "UTC",
    originType: "connectedAccount",
    connectedAccountId,
    color: "#4285F4",
    capabilities: LOCAL_CALENDAR_CAPABILITIES,
  });
}

/**
 * #282's own seam: a Google Connected Account with an `active` Calendar
 * Facet, exactly what `listGoogleCalendarFacetAccounts` (`poll-loop.ts`)
 * should find regardless of whether it has mirrored any Calendar row yet —
 * `contacts/google/poll-loop.test.ts#turnOnContactsFacet`'s own shape,
 * generalized to the Calendar Facet kind. The credential itself is never
 * unsealed by this suite's fake `credentials` provider, so reusing whatever
 * `createTestMailAccount` already sealed is enough.
 */
async function createGoogleCalendarFacetAccount(
  userId?: string,
): Promise<{ userId: string; connectedAccountId: string }> {
  const account = await createTestMailAccount(db, {
    userId,
    oauth: { accessToken: "mail-token", provider: "google" },
  });
  const existing = await getConnectedAccountById(db, account.connectedAccountId);
  if (!existing) throw new Error("expected the Connected Account to exist");
  await attachFacetToConnectedAccount(
    db,
    account.connectedAccountId,
    "calendar",
    existing.credential,
  );
  return { userId: account.userId, connectedAccountId: account.connectedAccountId };
}

const noopClient: GoogleCalendarClient = {
  async listCalendarList() {
    return [];
  },
  async getCalendar() {
    throw new Error("not exercised");
  },
  async listEventsPage() {
    return { items: [] };
  },
  async insertEvent() {
    throw new Error("not exercised");
  },
  async patchEvent() {
    throw new Error("not exercised");
  },
};

describe("runCalendarMirrorTick", () => {
  it("ticks a Connected Account with an active Calendar Facet and zero Calendar rows yet (#282)", async () => {
    const { connectedAccountId } = await createGoogleCalendarFacetAccount();
    let calls = 0;
    const client: GoogleCalendarClient = {
      ...noopClient,
      async listCalendarList() {
        calls += 1;
        return [];
      },
    };
    const credentials = {
      async getAccessToken() {
        return "token";
      },
    };

    await runCalendarMirrorTick(db, { client, credentials });

    expect(calls).toBe(1);
    const [state] = await db
      .select()
      .from(calendarMirrorSyncState)
      .where(eq(calendarMirrorSyncState.connectedAccountId, connectedAccountId));
    expect(state?.lastCalendarListSyncAt).not.toBeNull();
  });

  it("never ticks a Connected Account without an active Calendar Facet, even one with existing Calendar rows (#282)", async () => {
    const userId = await createTestUser();
    await createMirroredCalendar(userId, "acct-1");
    let calendarListCalled = false;
    const client: GoogleCalendarClient = {
      ...noopClient,
      async listCalendarList() {
        calendarListCalled = true;
        return [];
      },
    };
    const credentials = {
      async getAccessToken() {
        return "token";
      },
    };

    await runCalendarMirrorTick(db, { client, credentials });

    expect(calendarListCalled).toBe(false);
  });

  it("skips an account entirely when the credential provider has no token for it", async () => {
    await createGoogleCalendarFacetAccount();
    let calendarListCalled = false;
    const client: GoogleCalendarClient = {
      ...noopClient,
      async listCalendarList() {
        calendarListCalled = true;
        return [];
      },
    };

    await runCalendarMirrorTick(db, { client, credentials: unavailableGoogleCalendarCredentials });

    expect(calendarListCalled).toBe(false);
  });

  it("runs the calendar-list sync on an account's first tick and records its own sync state", async () => {
    const { connectedAccountId } = await createGoogleCalendarFacetAccount();
    let calls = 0;
    const client: GoogleCalendarClient = {
      ...noopClient,
      async listCalendarList() {
        calls += 1;
        return [];
      },
    };
    const credentials = {
      async getAccessToken() {
        return "token";
      },
    };

    await runCalendarMirrorTick(db, { client, credentials });

    expect(calls).toBe(1);
    const [state] = await db
      .select()
      .from(calendarMirrorSyncState)
      .where(eq(calendarMirrorSyncState.connectedAccountId, connectedAccountId));
    expect(state?.lastCalendarListSyncAt).not.toBeNull();
    expect(state?.lastEventSyncAt).not.toBeNull();
  });

  it("does not re-run the calendar-list sync before its 15-minute interval is due", async () => {
    const { connectedAccountId } = await createGoogleCalendarFacetAccount();
    await db.insert(calendarMirrorSyncState).values({
      connectedAccountId,
      lastCalendarListSyncAt: new Date(),
      lastEventSyncAt: new Date(),
    });
    let calls = 0;
    const client: GoogleCalendarClient = {
      ...noopClient,
      async listCalendarList() {
        calls += 1;
        return [];
      },
    };
    const credentials = {
      async getAccessToken() {
        return "token";
      },
    };

    await runCalendarMirrorTick(db, { client, credentials });

    expect(calls).toBe(0);
  });

  it("treats a pending pollRequestedAt as due regardless of the ordinary cadence, and clears it", async () => {
    const { connectedAccountId } = await createGoogleCalendarFacetAccount();
    await db.insert(calendarMirrorSyncState).values({
      connectedAccountId,
      lastCalendarListSyncAt: new Date(),
      lastEventSyncAt: new Date(),
      pollRequestedAt: new Date(),
    });
    let calls = 0;
    const client: GoogleCalendarClient = {
      ...noopClient,
      async listCalendarList() {
        calls += 1;
        return [];
      },
    };
    const credentials = {
      async getAccessToken() {
        return "token";
      },
    };

    await runCalendarMirrorTick(db, { client, credentials });

    expect(calls).toBe(1);
    const [state] = await db
      .select()
      .from(calendarMirrorSyncState)
      .where(eq(calendarMirrorSyncState.connectedAccountId, connectedAccountId));
    expect(state?.pollRequestedAt).toBeNull();
  });

  it("stops walking accounts once isStopped() reports true", async () => {
    await createGoogleCalendarFacetAccount();
    let calls = 0;
    const client: GoogleCalendarClient = {
      ...noopClient,
      async listCalendarList() {
        calls += 1;
        return [];
      },
    };
    const credentials = {
      async getAccessToken() {
        return "token";
      },
    };

    await runCalendarMirrorTick(db, { client, credentials, isStopped: () => true });

    expect(calls).toBe(0);
  });
});
