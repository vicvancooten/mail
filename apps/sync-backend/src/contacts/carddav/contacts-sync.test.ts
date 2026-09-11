import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listCarddavAddressBooksForConnectedAccount,
  mirrorAddressBook,
  unmirrorAddressBook,
} from "../../address-books/store.js";
import {
  deriveCredentialKey,
  sealPasswordCredential,
} from "../../connected-accounts/credential-crypto.js";
import { insertCalDavAccount } from "../../connected-accounts/store.js";
import type { Db } from "../../db/client.js";
import { contacts, users } from "../../db/schema.js";
import { createTestDb, resetTestDb, TEST_MAIL_CREDENTIAL_KEY } from "../../test-support/db.js";
import type { CarddavAddressBookSummary, CarddavClient, CarddavVCard } from "./client.js";
import { CarddavSyncTokenInvalidError } from "./client.js";
import { syncCarddavContactsForAccount } from "./contacts-sync.js";

/**
 * `syncCarddavContactsForAccount` (#226) against a fake `CarddavClient` and
 * the real test database — `client.test.ts` doesn't exist because the wire
 * plumbing itself is `tsdav`'s (research doc §8.1's own verdict); every test
 * here asserts on this ticket's own sync/diff policy: discovery, a fresh vs.
 * incremental `sync-collection` round, a stale-token full re-walk, the
 * ctag-fallback per-object diff, and the embedded `PHOTO` round trip.
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

async function setUpAccount() {
  const userId = randomUUID();
  await db.insert(users).values({
    id: userId,
    username: `user-${userId.slice(0, 8)}`,
    passwordHash: "not-a-real-hash",
    role: "owner",
  });
  const connectedAccountId = randomUUID();
  const key = deriveCredentialKey(TEST_MAIL_CREDENTIAL_KEY);
  await insertCalDavAccount(db, {
    id: connectedAccountId,
    userId,
    serverAddress: "carddav.example.com",
    username: "ada",
    credential: sealPasswordCredential("app-password", connectedAccountId, key),
    facet: "contacts",
    discovery: {
      principalUrl: "https://carddav.example.com/principals/ada/",
      homeSetUrl: "https://carddav.example.com/addressbooks/ada/",
      supportsScheduling: false,
    },
  });
  return { userId, connectedAccountId };
}

function vcard(href: string, etag: string, uid: string, given: string): CarddavVCard {
  return {
    href: `${COLLECTION_URL}${href}`,
    etag,
    data: [
      "BEGIN:VCARD",
      "VERSION:3.0",
      `UID:${uid}`,
      `FN:${given}`,
      `N:;${given};;;`,
      "END:VCARD",
    ].join("\r\n"),
  };
}

function fakeClient(overrides: Partial<CarddavClient> = {}): CarddavClient {
  return {
    fetchAddressBooks: vi.fn(async () => [] as CarddavAddressBookSummary[]),
    fetchCtag: vi.fn(async () => undefined),
    syncCollection: vi.fn(async () => ({
      changed: [],
      deletedHrefs: [],
      nextSyncToken: undefined,
    })),
    listHrefs: vi.fn(async () => []),
    multiget: vi.fn(async () => []),
    createVCard: vi.fn(async () => ({ href: "unused", etag: undefined })),
    updateVCard: vi.fn(async () => ({ etag: undefined })),
    deleteVCard: vi.fn(async () => undefined),
    ...overrides,
  };
}

const COLLECTION_URL = "https://carddav.example.com/addressbooks/ada/default/";

function oneBook(overrides: Partial<CarddavAddressBookSummary> = {}): CarddavAddressBookSummary {
  return {
    url: COLLECTION_URL,
    displayName: "Default",
    ctag: "ctag-1",
    supportsSyncCollection: true,
    ...overrides,
  };
}

async function theAddressBook(connectedAccountId: string) {
  const [row] = await listCarddavAddressBooksForConnectedAccount(db, connectedAccountId);
  if (!row) throw new Error("expected a mirrored Address Book to exist");
  return row;
}

describe("sync-collection (webdav) discovery and a fresh round", () => {
  it("mints one Address Book and mirrors every reported vCard", async () => {
    const { userId, connectedAccountId } = await setUpAccount();
    const client = fakeClient({
      fetchAddressBooks: vi.fn(async () => [oneBook()]),
      syncCollection: vi.fn(async () => ({
        changed: [
          vcard("ada.vcf", "etag-1", "uid-1", "Ada Lovelace"),
          vcard("grace.vcf", "etag-2", "uid-2", "Grace Hopper"),
        ],
        deletedHrefs: [],
        nextSyncToken: "sync-token-1",
      })),
    });

    await syncCarddavContactsForAccount(db, client, {
      userId,
      connectedAccountId,
      homeSetUrl: "https://carddav.example.com/addressbooks/ada/",
      credentials: { username: "ada", password: "app-password" },
    });

    const book = await theAddressBook(connectedAccountId);
    expect(book.mirrored).toBe(true);
    expect(book.capabilityTableId).toBe("caldav_carddav");
    expect(book.carddavCollectionUrl).toBe(COLLECTION_URL);
    expect(book.carddavSyncToken).toBe("sync-token-1");

    const rows = await db.select().from(contacts).where(eq(contacts.addressBookId, book.id));
    expect(rows).toHaveLength(2);
    const ada = rows.find((row) => row.carddavHref?.endsWith("ada.vcf"));
    expect(ada?.name).toEqual({ given: "Ada Lovelace" });
    expect(ada?.carddavEtag).toBe("etag-1");
    expect(ada?.carddavRawVcard).toContain("UID:uid-1");
  });
});

describe("an incremental round", () => {
  it("applies only what the round reports: upserts and deletes", async () => {
    const { userId, connectedAccountId } = await setUpAccount();
    const client = fakeClient({ fetchAddressBooks: vi.fn(async () => [oneBook()]) });

    // Seed a prior full walk so there's a stored token and two contacts.
    client.syncCollection = vi.fn(async () => ({
      changed: [
        vcard("ada.vcf", "etag-1", "uid-1", "Ada Lovelace"),
        vcard("grace.vcf", "etag-2", "uid-2", "Grace Hopper"),
      ],
      deletedHrefs: [],
      nextSyncToken: "sync-token-1",
    }));
    await syncCarddavContactsForAccount(db, client, {
      userId,
      connectedAccountId,
      homeSetUrl: "https://carddav.example.com/addressbooks/ada/",
      credentials: { username: "ada", password: "app-password" },
    });

    // The incremental round: Ada's name changed, Grace was deleted upstream.
    client.syncCollection = vi.fn(async (args: { syncToken: string | undefined }) => {
      expect(args.syncToken).toBe("sync-token-1");
      return {
        changed: [vcard("ada.vcf", "etag-1b", "uid-1", "Ada King")],
        deletedHrefs: [`${COLLECTION_URL}grace.vcf`],
        nextSyncToken: "sync-token-2",
      };
    });
    await syncCarddavContactsForAccount(db, client, {
      userId,
      connectedAccountId,
      homeSetUrl: "https://carddav.example.com/addressbooks/ada/",
      credentials: { username: "ada", password: "app-password" },
    });

    const book = await theAddressBook(connectedAccountId);
    expect(book.carddavSyncToken).toBe("sync-token-2");
    const rows = await db.select().from(contacts).where(eq(contacts.addressBookId, book.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toEqual({ given: "Ada King" });
    expect(rows[0]?.carddavEtag).toBe("etag-1b");
  });
});

describe("a stale sync-token", () => {
  it("clears the token and falls back to a full re-walk", async () => {
    const { userId, connectedAccountId } = await setUpAccount();
    const client = fakeClient({ fetchAddressBooks: vi.fn(async () => [oneBook()]) });

    client.syncCollection = vi.fn(async () => ({
      changed: [vcard("ada.vcf", "etag-1", "uid-1", "Ada Lovelace")],
      deletedHrefs: [],
      nextSyncToken: "sync-token-1",
    }));
    await syncCarddavContactsForAccount(db, client, {
      userId,
      connectedAccountId,
      homeSetUrl: "https://carddav.example.com/addressbooks/ada/",
      credentials: { username: "ada", password: "app-password" },
    });

    const calls: (string | undefined)[] = [];
    client.syncCollection = vi.fn(async (args: { syncToken: string | undefined }) => {
      calls.push(args.syncToken);
      if (args.syncToken === "sync-token-1") {
        throw new CarddavSyncTokenInvalidError("403 Forbidden");
      }
      return {
        changed: [vcard("grace.vcf", "etag-9", "uid-9", "Grace Hopper")],
        deletedHrefs: [],
        nextSyncToken: "sync-token-fresh",
      };
    });

    await syncCarddavContactsForAccount(db, client, {
      userId,
      connectedAccountId,
      homeSetUrl: "https://carddav.example.com/addressbooks/ada/",
      credentials: { username: "ada", password: "app-password" },
    });

    expect(calls).toEqual(["sync-token-1", undefined]);
    const book = await theAddressBook(connectedAccountId);
    expect(book.carddavSyncToken).toBe("sync-token-fresh");
    // The full re-walk is the definitive membership list: Ada (not reported
    // this round) is gone, Grace (this round's only entry) is the survivor.
    const rows = await db.select().from(contacts).where(eq(contacts.addressBookId, book.id));
    expect(rows.map((row) => row.name)).toEqual([{ given: "Grace Hopper" }]);
  });
});

describe("the ctag fallback", () => {
  it("skips every further round trip when the ctag hasn't moved", async () => {
    const { userId, connectedAccountId } = await setUpAccount();
    const client = fakeClient({
      fetchAddressBooks: vi.fn(async () => [
        oneBook({ supportsSyncCollection: false, ctag: "ctag-1" }),
      ]),
    });
    await syncCarddavContactsForAccount(db, client, {
      userId,
      connectedAccountId,
      homeSetUrl: "https://carddav.example.com/addressbooks/ada/",
      credentials: { username: "ada", password: "app-password" },
    });
    vi.clearAllMocks();

    await syncCarddavContactsForAccount(db, client, {
      userId,
      connectedAccountId,
      homeSetUrl: "https://carddav.example.com/addressbooks/ada/",
      credentials: { username: "ada", password: "app-password" },
    });
    expect(client.listHrefs).not.toHaveBeenCalled();
    expect(client.multiget).not.toHaveBeenCalled();
  });

  it("on a changed ctag, multigets only the hrefs whose etag actually moved", async () => {
    const { userId, connectedAccountId } = await setUpAccount();
    const client = fakeClient({
      fetchAddressBooks: vi.fn(async () => [
        oneBook({ supportsSyncCollection: false, ctag: "ctag-1" }),
      ]),
      listHrefs: vi.fn(async () => [
        { href: `${COLLECTION_URL}ada.vcf`, etag: "etag-1" },
        { href: `${COLLECTION_URL}katherine.vcf`, etag: "etag-3" },
      ]),
      multiget: vi.fn(async () => [
        vcard("ada.vcf", "etag-1", "uid-1", "Ada Lovelace"),
        vcard("katherine.vcf", "etag-3", "uid-3", "Katherine Johnson"),
      ]),
    });
    // Round 1: Ada and Katherine both mirrored fresh (no stored ctag yet, so
    // both come back "changed" — nothing to diff against).
    await syncCarddavContactsForAccount(db, client, {
      userId,
      connectedAccountId,
      homeSetUrl: "https://carddav.example.com/addressbooks/ada/",
      credentials: { username: "ada", password: "app-password" },
    });
    const book = await theAddressBook(connectedAccountId);
    expect(book.carddavCtag).toBe("ctag-1");

    // Round 2: the ctag moved. The server now reports Ada unchanged
    // (etag-1, same as before) and a brand-new Grace — Katherine is gone
    // from the listing entirely.
    client.fetchAddressBooks = vi.fn(async () => [
      oneBook({ supportsSyncCollection: false, ctag: "ctag-2" }),
    ]);
    client.listHrefs = vi.fn(async () => [
      { href: `${COLLECTION_URL}ada.vcf`, etag: "etag-1" },
      { href: `${COLLECTION_URL}grace.vcf`, etag: "etag-2" },
    ]);
    client.multiget = vi.fn(async () => [vcard("grace.vcf", "etag-2", "uid-2", "Grace Hopper")]);

    await syncCarddavContactsForAccount(db, client, {
      userId,
      connectedAccountId,
      homeSetUrl: "https://carddav.example.com/addressbooks/ada/",
      credentials: { username: "ada", password: "app-password" },
    });

    // Ada's own unchanged etag never triggers a `multiget` for her href.
    expect(client.multiget).toHaveBeenCalledWith(
      expect.objectContaining({ hrefs: [`${COLLECTION_URL}grace.vcf`] }),
    );
    const rows = await db.select().from(contacts).where(eq(contacts.addressBookId, book.id));
    expect(rows.map((row) => row.name)).toEqual(
      expect.arrayContaining([{ given: "Ada Lovelace" }, { given: "Grace Hopper" }]),
    );
    expect(rows.some((row) => row.name.given === "Katherine")).toBe(false);

    const updated = await theAddressBook(connectedAccountId);
    expect(updated.carddavCtag).toBe("ctag-2");
  });
});

describe("PHOTO round trip", () => {
  it("decodes an embedded PHOTO into the Blob Store", async () => {
    const { userId, connectedAccountId } = await setUpAccount();
    const withPhoto: CarddavVCard = {
      href: `${COLLECTION_URL}ada.vcf`,
      etag: "etag-1",
      data: [
        "BEGIN:VCARD",
        "VERSION:3.0",
        "UID:uid-1",
        "FN:Ada Lovelace",
        "N:Ada Lovelace;;;;",
        "PHOTO;ENCODING=b;TYPE=JPEG:aGVsbG8=",
        "END:VCARD",
      ].join("\r\n"),
    };
    const client = fakeClient({
      fetchAddressBooks: vi.fn(async () => [oneBook()]),
      syncCollection: vi.fn(async () => ({
        changed: [withPhoto],
        deletedHrefs: [],
        nextSyncToken: "sync-token-1",
      })),
    });

    await syncCarddavContactsForAccount(db, client, {
      userId,
      connectedAccountId,
      homeSetUrl: "https://carddav.example.com/addressbooks/ada/",
      credentials: { username: "ada", password: "app-password" },
    });

    const book = await theAddressBook(connectedAccountId);
    const [row] = await db.select().from(contacts).where(eq(contacts.addressBookId, book.id));
    expect(row?.photo).not.toBeNull();
  });
});

describe("an unmirrored Address Book (#208)", () => {
  it("is skipped by the sync tick: no sync-collection round", async () => {
    const { userId, connectedAccountId } = await setUpAccount();
    const client = fakeClient({
      fetchAddressBooks: vi.fn(async () => [oneBook()]),
      syncCollection: vi.fn(async () => ({
        changed: [vcard("ada.vcf", "etag-1", "uid-1", "Ada Lovelace")],
        deletedHrefs: [],
        nextSyncToken: "sync-token-1",
      })),
    });
    const args = {
      userId,
      connectedAccountId,
      homeSetUrl: "https://carddav.example.com/addressbooks/ada/",
      credentials: { username: "ada", password: "app-password" },
    };
    await syncCarddavContactsForAccount(db, client, args);
    const book = await theAddressBook(connectedAccountId);
    await unmirrorAddressBook(db, userId, book.id);

    client.syncCollection = vi.fn();
    await syncCarddavContactsForAccount(db, client, args);

    expect(client.syncCollection).not.toHaveBeenCalled();
    const rows = await db.select().from(contacts).where(eq(contacts.addressBookId, book.id));
    expect(rows).toHaveLength(0);
  });

  it("resumes normal syncing on the next tick once re-mirrored", async () => {
    const { userId, connectedAccountId } = await setUpAccount();
    const client = fakeClient({
      fetchAddressBooks: vi.fn(async () => [oneBook()]),
      syncCollection: vi.fn(async () => ({
        changed: [vcard("ada.vcf", "etag-1", "uid-1", "Ada Lovelace")],
        deletedHrefs: [],
        nextSyncToken: "sync-token-1",
      })),
    });
    const args = {
      userId,
      connectedAccountId,
      homeSetUrl: "https://carddav.example.com/addressbooks/ada/",
      credentials: { username: "ada", password: "app-password" },
    };
    await syncCarddavContactsForAccount(db, client, args);
    const book = await theAddressBook(connectedAccountId);
    await unmirrorAddressBook(db, userId, book.id);
    await mirrorAddressBook(db, userId, book.id);

    client.syncCollection = vi.fn(async () => ({
      changed: [
        vcard("ada.vcf", "etag-1", "uid-1", "Ada Lovelace"),
        vcard("grace.vcf", "etag-2", "uid-2", "Grace Hopper"),
      ],
      deletedHrefs: [],
      nextSyncToken: "sync-token-2",
    }));
    await syncCarddavContactsForAccount(db, client, args);

    expect(client.syncCollection).toHaveBeenCalledTimes(1);
    const rows = await db.select().from(contacts).where(eq(contacts.addressBookId, book.id));
    expect(rows).toHaveLength(2);
  });
});
