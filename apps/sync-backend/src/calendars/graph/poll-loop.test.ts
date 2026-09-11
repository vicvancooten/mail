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
import type { GraphCalendarClient } from "./client.js";
import { runGraphCalendarMirrorTick, unavailableGraphCalendarCredentials } from "./poll-loop.js";

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
    id: `gcal-ms:${connectedAccountId}:primary`,
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
 * #282's own seam, Graph's own side of `google/poll-loop.test.ts
 * #createGoogleCalendarFacetAccount`: a Microsoft Connected Account with an
 * `active` Calendar Facet, discoverable by `listGraphCalendarFacetAccounts`
 * regardless of whether it has mirrored any Calendar row yet.
 */
async function createGraphCalendarFacetAccount(
  userId?: string,
): Promise<{ userId: string; connectedAccountId: string }> {
  const account = await createTestMailAccount(db, {
    userId,
    oauth: { accessToken: "mail-token", provider: "microsoft" },
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

const noopClient: GraphCalendarClient = {
  async listCalendars() {
    return [];
  },
  async getMailboxTimeZone() {
    return "UTC";
  },
  async listCalendarViewDeltaPage() {
    throw new Error("not exercised");
  },
  async insertEvent() {
    throw new Error("not exercised");
  },
  async getEvent() {
    throw new Error("not exercised");
  },
  async patchEvent() {
    throw new Error("not exercised");
  },
  async cancelEvent() {
    throw new Error("not exercised");
  },
  async respondToEvent() {
    throw new Error("not exercised");
  },
  async patchCalendar() {
    throw new Error("not exercised");
  },
};

describe("runGraphCalendarMirrorTick", () => {
  it("ticks a Connected Account with an active Calendar Facet and zero Calendar rows yet (#282)", async () => {
    const { connectedAccountId } = await createGraphCalendarFacetAccount();
    let calls = 0;
    const client: GraphCalendarClient = {
      ...noopClient,
      async listCalendars() {
        calls += 1;
        return [];
      },
    };
    const credentials = {
      async getAccessToken() {
        return "token";
      },
    };

    await runGraphCalendarMirrorTick(db, { client, credentials });

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
    const client: GraphCalendarClient = {
      ...noopClient,
      async listCalendars() {
        calendarListCalled = true;
        return [];
      },
    };
    const credentials = {
      async getAccessToken() {
        return "token";
      },
    };

    await runGraphCalendarMirrorTick(db, { client, credentials });

    expect(calendarListCalled).toBe(false);
  });

  it("skips an account entirely when the credential provider has no token for it", async () => {
    await createGraphCalendarFacetAccount();
    let calendarListCalled = false;
    const client: GraphCalendarClient = {
      ...noopClient,
      async listCalendars() {
        calendarListCalled = true;
        return [];
      },
    };

    await runGraphCalendarMirrorTick(db, {
      client,
      credentials: unavailableGraphCalendarCredentials,
    });

    expect(calendarListCalled).toBe(false);
  });

  it("stops walking accounts once isStopped() reports true", async () => {
    await createGraphCalendarFacetAccount();
    let calls = 0;
    const client: GraphCalendarClient = {
      ...noopClient,
      async listCalendars() {
        calls += 1;
        return [];
      },
    };
    const credentials = {
      async getAccessToken() {
        return "token";
      },
    };

    await runGraphCalendarMirrorTick(db, { client, credentials, isStopped: () => true });

    expect(calls).toBe(0);
  });
});
