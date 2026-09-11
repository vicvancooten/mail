import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mirrorAddressBook,
  selectAddressBooksForConnectedAccount,
  unmirrorAddressBook,
} from "../../address-books/store.js";
import type { Db } from "../../db/client.js";
import { contacts, syncTombstones } from "../../db/schema.js";
import { createTestDb, resetTestDb } from "../../test-support/db.js";
import { createTestMailAccount } from "../../test-support/mail-account.js";
import type { GooglePeopleClient, ListConnectionsResult } from "./client.js";
import { GoogleSyncTokenExpiredError } from "./client.js";
import { GOOGLE_FULL_RESYNC_INTERVAL_MS, syncGoogleContactsForAccount } from "./people-sync.js";

/**
 * `syncGoogleContactsForAccount` (#214) against a fake `GooglePeopleClient`
 * and the real test database — `client.test.ts` already covers the wire
 * format, so every test here only ever asserts on sync *policy*: full vs.
 * incremental, the 7-day floor, `EXPIRED_SYNC_TOKEN` recovery, and what a
 * full walk's own reconciliation tombstones.
 */

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

function person(resourceName: string, overrides: Record<string, unknown> = {}) {
  return {
    resourceName,
    etag: `${resourceName}-etag`,
    names: [{ givenName: "Ada" }],
    ...overrides,
  };
}

/** #216's/#224's own write-back methods — never called by `syncGoogleContactsForAccount` (the read side alone), spread into every fake below just to satisfy `GooglePeopleClient`'s shape. */
const writeBackStubs: Pick<
  GooglePeopleClient,
  "updateContact" | "updateContactPhoto" | "deleteContactPhoto" | "createContact" | "deleteContact"
> = {
  updateContact: vi.fn(async () => {
    throw new Error("writeBackStubs.updateContact: not exercised by this suite");
  }),
  updateContactPhoto: vi.fn(async () => {
    throw new Error("writeBackStubs.updateContactPhoto: not exercised by this suite");
  }),
  deleteContactPhoto: vi.fn(async () => {
    throw new Error("writeBackStubs.deleteContactPhoto: not exercised by this suite");
  }),
  createContact: vi.fn(async () => {
    throw new Error("writeBackStubs.createContact: not exercised by this suite");
  }),
  deleteContact: vi.fn(async () => {
    throw new Error("writeBackStubs.deleteContact: not exercised by this suite");
  }),
};

async function setUpAccount() {
  const mailAccount = await createTestMailAccount(db, { oauth: { accessToken: "mail-token" } });
  return { userId: mailAccount.userId, connectedAccountId: mailAccount.connectedAccountId };
}

async function selectAddressBook(connectedAccountId: string) {
  const [row] = await selectAddressBooksForConnectedAccount(db, connectedAccountId, 0);
  if (!row) throw new Error("expected a mirrored Address Book to exist");
  return row;
}

describe("a first (full) sync", () => {
  it("mints the Address Book, mirrors every connection, and stores the sync token", async () => {
    const { userId, connectedAccountId } = await setUpAccount();
    const client: GooglePeopleClient = {
      ...writeBackStubs,
      listConnections: vi.fn(async () => ({
        connections: [person("people/c1"), person("people/c2")],
        nextSyncToken: "token-1",
      })),
    };

    const now = new Date("2026-01-01T00:00:00.000Z");
    await syncGoogleContactsForAccount(
      db,
      client,
      { userId, connectedAccountId, accessToken: "at" },
      now,
    );

    const [, params] = (client.listConnections as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { requestSyncToken?: boolean; syncToken?: string },
    ];
    expect(params.requestSyncToken).toBe(true);
    expect(params.syncToken).toBeUndefined();

    const addressBook = await selectAddressBook(connectedAccountId);
    expect(addressBook.mirrored).toBe(true);
    expect(addressBook.capabilityTableId).toBe("google");
    expect(addressBook.googleSyncToken).toBe("token-1");
    expect(addressBook.googleSyncTokenMintedAt?.toISOString()).toBe(now.toISOString());

    const rows = await db.select().from(contacts).where(eq(contacts.addressBookId, addressBook.id));
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.googleResourceName).sort()).toEqual(["people/c1", "people/c2"]);
    const c1 = rows.find((row) => row.googleResourceName === "people/c1");
    expect(c1?.googleEtag).toBe("people/c1-etag");
    expect(c1?.googlePayload).toMatchObject({ resourceName: "people/c1" });
  });

  it("pages through the whole walk with a fixed personFields mask before minting the token", async () => {
    const { userId, connectedAccountId } = await setUpAccount();
    const listConnections = vi
      .fn<GooglePeopleClient["listConnections"]>()
      .mockResolvedValueOnce({ connections: [person("people/c1")], nextPageToken: "page-2" })
      .mockResolvedValueOnce({ connections: [person("people/c2")], nextSyncToken: "token-2" });
    const client: GooglePeopleClient = { ...writeBackStubs, listConnections };

    await syncGoogleContactsForAccount(db, client, {
      userId,
      connectedAccountId,
      accessToken: "at",
    });

    expect(listConnections).toHaveBeenCalledTimes(2);
    const firstMask = listConnections.mock.calls[0]?.[1].personFields;
    const secondMask = listConnections.mock.calls[1]?.[1].personFields;
    expect(secondMask).toBe(firstMask);
    expect(listConnections.mock.calls[1]?.[1].pageToken).toBe("page-2");

    const addressBook = await selectAddressBook(connectedAccountId);
    const rows = await db.select().from(contacts).where(eq(contacts.addressBookId, addressBook.id));
    expect(rows).toHaveLength(2);
  });

  it("tombstones a Contact the walk no longer sees", async () => {
    const { userId, connectedAccountId } = await setUpAccount();
    const client: GooglePeopleClient = {
      ...writeBackStubs,
      listConnections: vi
        .fn<GooglePeopleClient["listConnections"]>()
        .mockResolvedValueOnce({
          connections: [person("people/c1"), person("people/c2")],
          nextSyncToken: "token-1",
        })
        .mockResolvedValueOnce({ connections: [person("people/c1")], nextSyncToken: "token-2" }),
    };

    await syncGoogleContactsForAccount(db, client, {
      userId,
      connectedAccountId,
      accessToken: "at",
    });
    const addressBook = await selectAddressBook(connectedAccountId);
    const afterFirst = await db
      .select()
      .from(contacts)
      .where(eq(contacts.addressBookId, addressBook.id));
    expect(afterFirst).toHaveLength(2);

    // Force another full walk (age-based) that now omits people/c2.
    const future = new Date(Date.now() + GOOGLE_FULL_RESYNC_INTERVAL_MS + 1);
    await syncGoogleContactsForAccount(
      db,
      client,
      { userId, connectedAccountId, accessToken: "at" },
      future,
    );

    const afterSecond = await db
      .select()
      .from(contacts)
      .where(eq(contacts.addressBookId, addressBook.id));
    expect(afterSecond.map((row) => row.googleResourceName)).toEqual(["people/c1"]);

    const tombstones = await db
      .select()
      .from(syncTombstones)
      .where(eq(syncTombstones.collection, "Contact"));
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]?.connectedAccountId).toBe(connectedAccountId);
  });
});

describe("a later (incremental) sync", () => {
  it("applies an upsert and a metadata.deleted tombstone from one delta round, without touching the mint clock", async () => {
    const { userId, connectedAccountId } = await setUpAccount();
    const firstSyncClient: GooglePeopleClient = {
      ...writeBackStubs,
      listConnections: vi.fn(async () => ({
        connections: [person("people/c1"), person("people/c2")],
        nextSyncToken: "token-1",
      })),
    };
    const mintedAt = new Date("2026-02-01T00:00:00.000Z");
    await syncGoogleContactsForAccount(
      db,
      firstSyncClient,
      { userId, connectedAccountId, accessToken: "at" },
      mintedAt,
    );

    const deltaClient: GooglePeopleClient = {
      ...writeBackStubs,
      listConnections: vi.fn(async () => ({
        connections: [
          person("people/c1", { etag: "people/c1-etag-2", names: [{ givenName: "Grace" }] }),
          { resourceName: "people/c2", etag: "people/c2-etag", metadata: { deleted: true } },
        ],
        nextSyncToken: "token-2",
      })),
    };
    const laterSameDay = new Date("2026-02-01T01:00:00.000Z");
    await syncGoogleContactsForAccount(
      db,
      deltaClient,
      { userId, connectedAccountId, accessToken: "at" },
      laterSameDay,
    );

    const [, deltaParams] = (deltaClient.listConnections as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, { requestSyncToken?: boolean; syncToken?: string }];
    expect(deltaParams.syncToken).toBe("token-1");
    expect(deltaParams.requestSyncToken).toBeUndefined();

    const addressBook = await selectAddressBook(connectedAccountId);
    expect(addressBook.googleSyncToken).toBe("token-2");
    // The mint clock only ever moves on a full sync (this ticket's own
    // 7-day-floor policy) — an incremental round leaves it exactly as the
    // full sync above set it.
    expect(addressBook.googleSyncTokenMintedAt?.toISOString()).toBe(mintedAt.toISOString());

    const rows = await db.select().from(contacts).where(eq(contacts.addressBookId, addressBook.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.googleResourceName).toBe("people/c1");
    expect(rows[0]?.googleEtag).toBe("people/c1-etag-2");

    const tombstones = await db
      .select()
      .from(syncTombstones)
      .where(eq(syncTombstones.collection, "Contact"));
    expect(tombstones).toHaveLength(1);
  });

  it("falls back to a full sync in the same tick on EXPIRED_SYNC_TOKEN, never retrying the stale token", async () => {
    const { userId, connectedAccountId } = await setUpAccount();
    const firstSyncClient: GooglePeopleClient = {
      ...writeBackStubs,
      listConnections: vi.fn(async () => ({
        connections: [person("people/c1")],
        nextSyncToken: "stale-token",
      })),
    };
    await syncGoogleContactsForAccount(db, firstSyncClient, {
      userId,
      connectedAccountId,
      accessToken: "at",
    });

    let call = 0;
    const recoveringClient: GooglePeopleClient = {
      ...writeBackStubs,
      listConnections: vi.fn(async (_token, params) => {
        call += 1;
        if (call === 1) {
          expect(params.syncToken).toBe("stale-token");
          throw new GoogleSyncTokenExpiredError();
        }
        // The recovery call must be a full walk, never carrying the token
        // that was just rejected.
        expect(params.requestSyncToken).toBe(true);
        expect(params.syncToken).toBeUndefined();
        return {
          connections: [person("people/c1"), person("people/c3")],
          nextSyncToken: "fresh-token",
        };
      }),
    };

    const now = new Date("2026-03-01T00:00:00.000Z");
    await syncGoogleContactsForAccount(
      db,
      recoveringClient,
      { userId, connectedAccountId, accessToken: "at" },
      now,
    );

    expect(recoveringClient.listConnections).toHaveBeenCalledTimes(2);
    const addressBook = await selectAddressBook(connectedAccountId);
    expect(addressBook.googleSyncToken).toBe("fresh-token");
    // A recovery full sync mints a fresh token the same as any other full
    // sync — the mint clock resets to `now`.
    expect(addressBook.googleSyncTokenMintedAt?.toISOString()).toBe(now.toISOString());

    const rows = await db.select().from(contacts).where(eq(contacts.addressBookId, addressBook.id));
    expect(rows.map((row) => row.googleResourceName).sort()).toEqual(["people/c1", "people/c3"]);
  });

  it("forces a full sync once the stored token crosses the 7-day floor, even though it's still present", async () => {
    const { userId, connectedAccountId } = await setUpAccount();
    const mintedAt = new Date("2026-01-01T00:00:00.000Z");
    const firstSyncClient: GooglePeopleClient = {
      ...writeBackStubs,
      listConnections: vi.fn(async () => ({
        connections: [person("people/c1")],
        nextSyncToken: "token-1",
      })),
    };
    await syncGoogleContactsForAccount(
      db,
      firstSyncClient,
      { userId, connectedAccountId, accessToken: "at" },
      mintedAt,
    );

    const client: GooglePeopleClient = {
      ...writeBackStubs,
      listConnections: vi.fn(async (_token, params) => {
        expect(params.requestSyncToken).toBe(true);
        expect(params.syncToken).toBeUndefined();
        return {
          connections: [person("people/c1")],
          nextSyncToken: "token-2",
        } satisfies ListConnectionsResult;
      }),
    };
    const eightDaysLater = new Date(mintedAt.getTime() + GOOGLE_FULL_RESYNC_INTERVAL_MS + 60_000);
    await syncGoogleContactsForAccount(
      db,
      client,
      { userId, connectedAccountId, accessToken: "at" },
      eightDaysLater,
    );

    expect(client.listConnections).toHaveBeenCalledTimes(1);
    const addressBook = await selectAddressBook(connectedAccountId);
    expect(addressBook.googleSyncTokenMintedAt?.toISOString()).toBe(eightDaysLater.toISOString());
  });
});

describe("an unmirrored Address Book (#208)", () => {
  it("is skipped entirely by the sync tick, without calling the People API", async () => {
    const { userId, connectedAccountId } = await setUpAccount();
    const firstSyncClient: GooglePeopleClient = {
      ...writeBackStubs,
      listConnections: vi.fn(async () => ({
        connections: [person("people/c1")],
        nextSyncToken: "token-1",
      })),
    };
    await syncGoogleContactsForAccount(db, firstSyncClient, {
      userId,
      connectedAccountId,
      accessToken: "at",
    });
    const addressBook = await selectAddressBook(connectedAccountId);
    await unmirrorAddressBook(db, userId, addressBook.id);

    const listConnections = vi.fn<GooglePeopleClient["listConnections"]>();
    const client: GooglePeopleClient = { ...writeBackStubs, listConnections };
    await syncGoogleContactsForAccount(db, client, {
      userId,
      connectedAccountId,
      accessToken: "at",
    });

    expect(listConnections).not.toHaveBeenCalled();
    const rows = await db.select().from(contacts).where(eq(contacts.addressBookId, addressBook.id));
    expect(rows).toHaveLength(0);
  });

  it("resumes normal syncing on the next tick once re-mirrored", async () => {
    const { userId, connectedAccountId } = await setUpAccount();
    const firstSyncClient: GooglePeopleClient = {
      ...writeBackStubs,
      listConnections: vi.fn(async () => ({
        connections: [person("people/c1")],
        nextSyncToken: "token-1",
      })),
    };
    await syncGoogleContactsForAccount(db, firstSyncClient, {
      userId,
      connectedAccountId,
      accessToken: "at",
    });
    const addressBook = await selectAddressBook(connectedAccountId);
    await unmirrorAddressBook(db, userId, addressBook.id);
    await mirrorAddressBook(db, userId, addressBook.id);

    const client: GooglePeopleClient = {
      ...writeBackStubs,
      listConnections: vi.fn(async () => ({
        connections: [person("people/c1"), person("people/c2")],
        nextSyncToken: "token-2",
      })),
    };
    await syncGoogleContactsForAccount(db, client, {
      userId,
      connectedAccountId,
      accessToken: "at",
    });

    expect(client.listConnections).toHaveBeenCalledTimes(1);
    const rows = await db.select().from(contacts).where(eq(contacts.addressBookId, addressBook.id));
    expect(rows.map((row) => row.googleResourceName).sort()).toEqual(["people/c1", "people/c2"]);
  });
});
