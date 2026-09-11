import { randomUUID } from "node:crypto";
import { LOCAL_CALENDAR_CAPABILITIES } from "@mail/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { calendarOutbox, calendars, connectedAccounts, series, users } from "../db/schema.js";
import { createTestDb, resetTestDb } from "../test-support/db.js";
import type { CaldavCalendarClient } from "./caldav/client.js";
import type { CaldavCredentialProvider } from "./caldav/credentials.js";
import type { GoogleCalendarClient, GoogleEvent } from "./google/client.js";
import type { GoogleCalendarCredentialProvider } from "./google/poll-loop.js";
import type { GraphCalendarClient, GraphEvent } from "./graph/client.js";
import type { GraphCalendarCredentialProvider } from "./graph/poll-loop.js";
import { runCalendarOutboxTick } from "./outbox-loop.js";
import { enqueueOutboxWrite } from "./outbox-store.js";

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

async function createUser(): Promise<string> {
  const id = randomUUID();
  await db.insert(users).values({
    id,
    username: `user-${id.slice(0, 8)}`,
    passwordHash: "not-a-real-hash",
    role: "owner",
  });
  return id;
}

async function createConnectedAccount(
  userId: string,
  id: string,
  provider: "google" | "microsoft" | "caldav_carddav",
): Promise<void> {
  await db.insert(connectedAccounts).values({
    id,
    userId,
    provider,
    identity: `${provider}-account@example.com`,
    credential: {
      kind: "password",
      secret: { keyVersion: 1, iv: "iv", ciphertext: "ct", authTag: "tag" },
    },
  });
}

async function createCalendarAndSeries(
  userId: string,
  calendarId: string,
  connectedAccountId: string,
): Promise<string> {
  await db.insert(calendars).values({
    id: calendarId,
    userId,
    name: "Mirrored",
    timeZone: "UTC",
    originType: "connectedAccount",
    connectedAccountId,
    color: "#4285F4",
    mirrored: true,
    capabilities: LOCAL_CALENDAR_CAPABILITIES,
  });
  const seriesId = randomUUID();
  await db.insert(series).values({
    id: seriesId,
    userId,
    calendarId,
    uid: `${seriesId}@test`,
    title: "Standup",
    allDay: false,
    floating: false,
    tzid: "UTC",
    dtstart: new Date("2026-01-05T09:00:00.000Z"),
    durationMs: 60 * 60 * 1000,
    transparency: "opaque",
  });
  await enqueueOutboxWrite(db, {
    userId,
    calendarId,
    seriesId,
    operation: "upsert",
    sendInvitations: true,
  });
  return seriesId;
}

function fakeGoogleClient(overrides: Partial<GoogleCalendarClient> = {}): GoogleCalendarClient {
  return {
    listCalendarList: async () => [],
    getCalendar: async () => {
      throw new Error("not used");
    },
    listEventsPage: async () => ({ items: [] }),
    insertEvent: async () => {
      throw new Error("insertEvent not stubbed");
    },
    patchEvent: async () => {
      throw new Error("patchEvent not stubbed");
    },
    ...overrides,
  };
}

function fakeGraphClient(overrides: Partial<GraphCalendarClient> = {}): GraphCalendarClient {
  return {
    listCalendars: async () => [],
    getMailboxTimeZone: async () => "UTC",
    listCalendarViewDeltaPage: async () => ({ items: [] }),
    insertEvent: async () => {
      throw new Error("insertEvent not stubbed");
    },
    getEvent: async () => {
      throw new Error("getEvent not stubbed");
    },
    patchEvent: async () => {
      throw new Error("patchEvent not stubbed");
    },
    cancelEvent: async () => {
      throw new Error("cancelEvent not stubbed");
    },
    respondToEvent: async () => {
      throw new Error("respondToEvent not stubbed");
    },
    patchCalendar: async () => {
      throw new Error("patchCalendar not stubbed");
    },
    ...overrides,
  };
}

function fakeCaldavClient(overrides: Partial<CaldavCalendarClient> = {}): CaldavCalendarClient {
  return {
    listCalendars: async () => [],
    getCtag: async () => null,
    syncCollection: async () => ({ kind: "staleToken" }),
    multiget: async () => [],
    putObject: async () => {
      throw new Error("putObject not stubbed");
    },
    ...overrides,
  };
}

async function outboxCount(): Promise<number> {
  return (await db.select().from(calendarOutbox)).length;
}

describe("runCalendarOutboxTick", () => {
  it("dispatches a Google Connected Account's row to the Google processor, never touching the Graph one", async () => {
    const userId = await createUser();
    await createConnectedAccount(userId, "acct-g", "google");
    await createCalendarAndSeries(userId, "gcal:acct-g:primary", "acct-g");

    let googleInsertCalled = false;
    const google = {
      client: fakeGoogleClient({
        insertEvent: async (): Promise<GoogleEvent> => {
          googleInsertCalled = true;
          return { id: "evt-1", status: "confirmed", etag: "etag-1" };
        },
      }),
      credentials: {
        getAccessToken: async () => "google-token",
      } satisfies GoogleCalendarCredentialProvider,
    };
    const graph = {
      client: fakeGraphClient({
        insertEvent: async (): Promise<GraphEvent> => {
          throw new Error("Graph must never be called for a Google account's row");
        },
      }),
      credentials: {
        getAccessToken: async () => "graph-token",
      } satisfies GraphCalendarCredentialProvider,
    };

    const caldav = {
      client: fakeCaldavClient(),
      credentials: { getAuth: async () => null } satisfies CaldavCredentialProvider,
    };

    await runCalendarOutboxTick(db, { google, graph, caldav });

    expect(googleInsertCalled).toBe(true);
    expect(await outboxCount()).toBe(0);
  });

  it("dispatches a Microsoft Connected Account's row to the Graph processor, never touching Google's", async () => {
    const userId = await createUser();
    await createConnectedAccount(userId, "acct-m", "microsoft");
    await createCalendarAndSeries(userId, "gcal-ms:acct-m:primary", "acct-m");

    let graphInsertCalled = false;
    const google = {
      client: fakeGoogleClient({
        insertEvent: async (): Promise<GoogleEvent> => {
          throw new Error("Google must never be called for a Microsoft account's row");
        },
      }),
      credentials: {
        getAccessToken: async () => "google-token",
      } satisfies GoogleCalendarCredentialProvider,
    };
    const graph = {
      client: fakeGraphClient({
        insertEvent: async (): Promise<GraphEvent> => {
          graphInsertCalled = true;
          return { id: "evt-1", changeKey: "ck-1" };
        },
      }),
      credentials: {
        getAccessToken: async () => "graph-token",
      } satisfies GraphCalendarCredentialProvider,
    };

    const caldav = {
      client: fakeCaldavClient(),
      credentials: { getAuth: async () => null } satisfies CaldavCredentialProvider,
    };

    await runCalendarOutboxTick(db, { google, graph, caldav });

    expect(graphInsertCalled).toBe(true);
    expect(await outboxCount()).toBe(0);
  });

  it("dispatches a CalDAV Connected Account's row to the CalDAV processor, never touching Google's or Graph's", async () => {
    const userId = await createUser();
    await createConnectedAccount(userId, "acct-d", "caldav_carddav");
    await createCalendarAndSeries(
      userId,
      "caldav:acct-d:https://dav.example.com/cal/work/",
      "acct-d",
    );

    let caldavPutCalled = false;
    const google = {
      client: fakeGoogleClient({
        insertEvent: async (): Promise<GoogleEvent> => {
          throw new Error("Google must never be called for a CalDAV account's row");
        },
      }),
      credentials: {
        getAccessToken: async () => "google-token",
      } satisfies GoogleCalendarCredentialProvider,
    };
    const graph = {
      client: fakeGraphClient({
        insertEvent: async (): Promise<GraphEvent> => {
          throw new Error("Graph must never be called for a CalDAV account's row");
        },
      }),
      credentials: {
        getAccessToken: async () => "graph-token",
      } satisfies GraphCalendarCredentialProvider,
    };
    const caldav = {
      client: fakeCaldavClient({
        putObject: async () => {
          caldavPutCalled = true;
          return { etag: "etag-1", scheduleTag: null };
        },
      }),
      credentials: {
        getAuth: async () => ({ username: "u", password: "p" }),
      } satisfies CaldavCredentialProvider,
    };

    await runCalendarOutboxTick(db, { google, graph, caldav });

    expect(caldavPutCalled).toBe(true);
    expect(await outboxCount()).toBe(0);
  });

  it("holds a row untouched when its own provider's credential provider has no access token", async () => {
    const userId = await createUser();
    await createConnectedAccount(userId, "acct-m", "microsoft");
    await createCalendarAndSeries(userId, "gcal-ms:acct-m:primary", "acct-m");

    const google = {
      client: fakeGoogleClient(),
      credentials: { getAccessToken: async () => null } satisfies GoogleCalendarCredentialProvider,
    };
    const graph = {
      client: fakeGraphClient(),
      credentials: { getAccessToken: async () => null } satisfies GraphCalendarCredentialProvider,
    };

    const caldav = {
      client: fakeCaldavClient(),
      credentials: { getAuth: async () => null } satisfies CaldavCredentialProvider,
    };

    await runCalendarOutboxTick(db, { google, graph, caldav });

    expect(await outboxCount()).toBe(1);
  });
});
