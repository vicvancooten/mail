import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../db/client.js";
import {
  calendars,
  connectedAccounts,
  mailAccounts,
  syncTombstones,
  users,
} from "../../db/schema.js";
import { createTestDb, resetTestDb } from "../../test-support/db.js";
import { syncCaldavCalendarList } from "./calendar-list-sync.js";
import type { CaldavAuth, CaldavCalendarClient, CaldavCalendarEntry } from "./client.js";
import { caldavCalendarRowId } from "./fold.js";

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

const auth: CaldavAuth = { username: "u", password: "p" };
const HOME_SET = "https://dav.example.com/calendars/user/";

function entry(overrides: Partial<CaldavCalendarEntry> = {}): CaldavCalendarEntry {
  return {
    href: `${HOME_SET}work/`,
    displayName: "Work",
    color: "#FF0000",
    timeZone: "Europe/Amsterdam",
    ctag: "ctag-1",
    writable: true,
    invitesSentByUpstream: true,
    ...overrides,
  };
}

function fakeClient(entries: CaldavCalendarEntry[]): CaldavCalendarClient {
  return {
    async listCalendars() {
      return entries;
    },
    async getCtag() {
      throw new Error("not exercised by this test");
    },
    async syncCollection() {
      throw new Error("not exercised by this test");
    },
    async multiget() {
      throw new Error("not exercised by this test");
    },
    async putObject() {
      throw new Error("not exercised by this test");
    },
  };
}

describe("syncCaldavCalendarList", () => {
  it("inserts a new mirrored Calendar row per home-set entry", async () => {
    const userId = await createTestUser();
    await syncCaldavCalendarList({
      db,
      userId,
      connectedAccountId: "acct-1",
      homeSetUrl: HOME_SET,
      client: fakeClient([entry()]),
      auth,
    });

    const rows = await db.select().from(calendars).where(eq(calendars.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(caldavCalendarRowId("acct-1", `${HOME_SET}work/`));
    expect(rows[0]?.name).toBe("Work");
    expect(rows[0]?.mirrored).toBe(true);
    expect(rows[0]?.davCtag).toBe("ctag-1");
    expect(rows[0]?.capabilities.invitesSentByUpstream).toBe(true);
    expect(rows[0]?.mailAccountId).toBeNull();
  });

  it("seeds mailAccountId from the User's oldest Mail Account for a self-scheduled Calendar", async () => {
    const userId = await createTestUser();
    const connectedAccountRowId = randomUUID();
    await db.insert(connectedAccounts).values({
      id: connectedAccountRowId,
      userId,
      provider: "other_imap",
      identity: "me@example.com",
      credential: {
        kind: "password",
        secret: { keyVersion: 1, iv: "", ciphertext: "", authTag: "" },
      },
    });
    const accountId = randomUUID();
    await db.insert(mailAccounts).values({
      id: accountId,
      userId,
      connectedAccountId: connectedAccountRowId,
      emailAddress: "me@example.com",
      imapHost: "imap.example.com",
      imapPort: 993,
      imapSecurity: "tls",
      smtpHost: "smtp.example.com",
      smtpPort: 465,
      smtpSecurity: "tls",
      username: "me@example.com",
    });

    await syncCaldavCalendarList({
      db,
      userId,
      connectedAccountId: "acct-1",
      homeSetUrl: HOME_SET,
      client: fakeClient([entry({ invitesSentByUpstream: false })]),
      auth,
    });

    const rows = await db.select().from(calendars).where(eq(calendars.userId, userId));
    expect(rows[0]?.capabilities.invitesSentByUpstream).toBe(false);
    expect(rows[0]?.mailAccountId).toBe(accountId);
  });

  it("defaults mirrored off for a read-only collection", async () => {
    const userId = await createTestUser();
    await syncCaldavCalendarList({
      db,
      userId,
      connectedAccountId: "acct-1",
      homeSetUrl: HOME_SET,
      client: fakeClient([entry({ writable: false })]),
      auth,
    });
    const rows = await db.select().from(calendars).where(eq(calendars.userId, userId));
    expect(rows[0]?.mirrored).toBe(false);
    expect(rows[0]?.capabilities.recurrenceGrammar).toBe("none");
  });

  it("tombstones a Calendar missing from two consecutive enumerations, never immediately", async () => {
    const userId = await createTestUser();
    const params = { db, userId, connectedAccountId: "acct-1", homeSetUrl: HOME_SET, auth };

    await syncCaldavCalendarList({ ...params, client: fakeClient([entry()]) });
    await syncCaldavCalendarList({ ...params, client: fakeClient([]) });
    let rows = await db.select().from(calendars).where(eq(calendars.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.missingConfirmations).toBe(1);

    await syncCaldavCalendarList({ ...params, client: fakeClient([]) });
    rows = await db.select().from(calendars).where(eq(calendars.userId, userId));
    expect(rows).toHaveLength(0);
    const tombstones = await db.select().from(syncTombstones);
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]?.collection).toBe("Calendar");
  });
});
