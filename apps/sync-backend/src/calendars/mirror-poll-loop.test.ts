import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { calendarMirrorSyncState } from "../db/schema.js";
import { createTestDb, resetTestDb } from "../test-support/db.js";
import type { MirrorAccount, MirrorLoopProvider } from "./mirror-poll-loop.js";
import { runMirrorPollTick } from "./mirror-poll-loop.js";

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

interface FakeAccount extends MirrorAccount {
  connectedAccountId: string;
  userId: string;
}

/**
 * A minimal `MirrorLoopProvider` standing in for a real one (google/graph)
 * — exercises exactly the control flow this module owns, independent of
 * any provider's own API shape. In particular: a "Facet grant" here is
 * just an account this fake `listAccounts` returns with zero mirrored
 * calendars yet, the same shape whose real-world equivalent regressed
 * independently in both `google/poll-loop.ts` and `graph/poll-loop.ts`
 * (#282) before this module existed to hold the fix once.
 */
function makeFakeProvider(overrides: {
  accounts: FakeAccount[];
  onSyncCalendarList?: () => void;
  onSyncCalendarEvents?: () => void;
  mirroredCalendars?: Array<{ id: string }>;
  credential?: string | null;
}): MirrorLoopProvider<FakeAccount, unknown, unknown, string> {
  return {
    label: "fake mirror loop",
    listAccounts: async () => overrides.accounts,
    getCredential: async () => (overrides.credential === undefined ? "token" : overrides.credential),
    syncCalendarList: async () => {
      overrides.onSyncCalendarList?.();
    },
    eventPollIntervalMs: async () => 5 * 60 * 1000,
    listMirroredCalendars: async () => overrides.mirroredCalendars ?? [],
    syncCalendarEvents: async () => {
      overrides.onSyncCalendarEvents?.();
    },
  };
}

describe("runMirrorPollTick", () => {
  it("ticks an account with zero mirrored calendars yet, so its first calendar-list sync can create them (#282)", async () => {
    const account: FakeAccount = { connectedAccountId: "acct-1", userId: "user-1" };
    let calls = 0;
    const provider = makeFakeProvider({
      accounts: [account],
      onSyncCalendarList: () => {
        calls += 1;
      },
    });

    await runMirrorPollTick(db, provider, { client: {}, credentials: {} });

    expect(calls).toBe(1);
    const [state] = await db
      .select()
      .from(calendarMirrorSyncState)
      .where(eq(calendarMirrorSyncState.connectedAccountId, "acct-1"));
    expect(state?.lastCalendarListSyncAt).not.toBeNull();
  });

  it("skips an account entirely when the provider's credential is unavailable", async () => {
    const account: FakeAccount = { connectedAccountId: "acct-1", userId: "user-1" };
    let calls = 0;
    const provider = makeFakeProvider({
      accounts: [account],
      credential: null,
      onSyncCalendarList: () => {
        calls += 1;
      },
    });

    await runMirrorPollTick(db, provider, { client: {}, credentials: {} });

    expect(calls).toBe(0);
  });

  it("syncs events for every mirrored calendar row once the event cadence is due", async () => {
    const account: FakeAccount = { connectedAccountId: "acct-1", userId: "user-1" };
    let eventCalls = 0;
    const provider = makeFakeProvider({
      accounts: [account],
      mirroredCalendars: [{ id: "cal-1" }, { id: "cal-2" }],
      onSyncCalendarEvents: () => {
        eventCalls += 1;
      },
    });

    await runMirrorPollTick(db, provider, { client: {}, credentials: {} });

    expect(eventCalls).toBe(2);
  });

  it("stops walking accounts once isStopped() reports true", async () => {
    const account: FakeAccount = { connectedAccountId: "acct-1", userId: "user-1" };
    let calls = 0;
    const provider = makeFakeProvider({
      accounts: [account],
      onSyncCalendarList: () => {
        calls += 1;
      },
    });

    await runMirrorPollTick(db, provider, { client: {}, credentials: {}, isStopped: () => true });

    expect(calls).toBe(0);
  });

  it("does not re-run the calendar-list sync before its 15-minute interval is due", async () => {
    const account: FakeAccount = { connectedAccountId: "acct-1", userId: "user-1" };
    await db.insert(calendarMirrorSyncState).values({
      connectedAccountId: "acct-1",
      lastCalendarListSyncAt: new Date(),
      lastEventSyncAt: new Date(),
    });
    let calls = 0;
    const provider = makeFakeProvider({
      accounts: [account],
      onSyncCalendarList: () => {
        calls += 1;
      },
    });

    await runMirrorPollTick(db, provider, { client: {}, credentials: {} });

    expect(calls).toBe(0);
  });

  it("treats a pending pollRequestedAt as due regardless of the ordinary cadence, and clears it", async () => {
    const account: FakeAccount = { connectedAccountId: "acct-1", userId: "user-1" };
    await db.insert(calendarMirrorSyncState).values({
      connectedAccountId: "acct-1",
      lastCalendarListSyncAt: new Date(),
      lastEventSyncAt: new Date(),
      pollRequestedAt: new Date(),
    });
    let calls = 0;
    const provider = makeFakeProvider({
      accounts: [account],
      onSyncCalendarList: () => {
        calls += 1;
      },
    });

    await runMirrorPollTick(db, provider, { client: {}, credentials: {} });

    expect(calls).toBe(1);
    const [state] = await db
      .select()
      .from(calendarMirrorSyncState)
      .where(eq(calendarMirrorSyncState.connectedAccountId, "acct-1"));
    expect(state?.pollRequestedAt).toBeNull();
  });
});
