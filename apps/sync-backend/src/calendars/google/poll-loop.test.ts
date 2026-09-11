import { randomUUID } from "node:crypto";
import { LOCAL_CALENDAR_CAPABILITIES } from "@mail/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../db/client.js";
import { calendarMirrorSyncState, calendars, users } from "../../db/schema.js";
import { createTestDb, resetTestDb } from "../../test-support/db.js";
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
  it("skips an account entirely when the credential provider has no token for it", async () => {
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

    await runCalendarMirrorTick(db, { client, credentials: unavailableGoogleCalendarCredentials });

    expect(calendarListCalled).toBe(false);
  });

  it("runs the calendar-list sync on an account's first tick and records its own sync state", async () => {
    const userId = await createTestUser();
    await createMirroredCalendar(userId, "acct-1");
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
      .where(eq(calendarMirrorSyncState.connectedAccountId, "acct-1"));
    expect(state?.lastCalendarListSyncAt).not.toBeNull();
    expect(state?.lastEventSyncAt).not.toBeNull();
  });

  it("does not re-run the calendar-list sync before its 15-minute interval is due", async () => {
    const userId = await createTestUser();
    await createMirroredCalendar(userId, "acct-1");
    await db.insert(calendarMirrorSyncState).values({
      connectedAccountId: "acct-1",
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
    const userId = await createTestUser();
    await createMirroredCalendar(userId, "acct-1");
    await db.insert(calendarMirrorSyncState).values({
      connectedAccountId: "acct-1",
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
      .where(eq(calendarMirrorSyncState.connectedAccountId, "acct-1"));
    expect(state?.pollRequestedAt).toBeNull();
  });

  it("stops walking accounts once isStopped() reports true", async () => {
    const userId = await createTestUser();
    await createMirroredCalendar(userId, "acct-1");
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
