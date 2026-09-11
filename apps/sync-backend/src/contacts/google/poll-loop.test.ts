import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { selectAddressBooksForConnectedAccount } from "../../address-books/store.js";
import {
  deriveCredentialKey,
  widenOAuthCredential,
} from "../../connected-accounts/credential-crypto.js";
import {
  attachFacetToConnectedAccount,
  getConnectedAccountById,
} from "../../connected-accounts/store.js";
import type { Db } from "../../db/client.js";
import { contacts } from "../../db/schema.js";
import { createTestDb, resetTestDb, TEST_MAIL_CREDENTIAL_KEY } from "../../test-support/db.js";
import { createTestMailAccount } from "../../test-support/mail-account.js";
import type { GooglePeopleClient } from "./client.js";
import { startGoogleContactsSyncLoop } from "./poll-loop.js";

/**
 * `startGoogleContactsSyncLoop` (#118-style scheduler proof, same shape as
 * `sync/grant-refresh-loop.test.ts`): proving it finds an active Contacts
 * Facet, unseals the shared `"default"`-audience access token, and mirrors
 * on its immediate first tick — `people-sync.test.ts` already owns every
 * sync-policy branch, not re-proven here.
 */

/** #216's/#224's own write-back methods — never called by `startGoogleContactsSyncLoop` (the read side alone), spread into every fake below just to satisfy `GooglePeopleClient`'s shape. */
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

async function turnOnContactsFacet(db: Db, connectedAccountId: string) {
  const key = deriveCredentialKey(TEST_MAIL_CREDENTIAL_KEY);
  const before = await getConnectedAccountById(db, connectedAccountId);
  if (!before) throw new Error("expected the Connected Account to exist");
  const widened = widenOAuthCredential(
    before.credential,
    {
      provider: "google",
      accessToken: "contacts-access-token",
      refreshToken: "fresh-refresh",
      expiresAt: "2026-02-01T00:00:00.000Z",
      scope: ["https://www.googleapis.com/auth/contacts", "openid", "email"],
    },
    "default",
    connectedAccountId,
    key,
  );
  await attachFacetToConnectedAccount(db, connectedAccountId, "contacts", widened);
}

describe("startGoogleContactsSyncLoop", () => {
  it("mirrors an active Contacts Facet's account on its immediate first tick, using the widened access token", async () => {
    const account = await createTestMailAccount(db, { oauth: { accessToken: "mail-token" } });
    await turnOnContactsFacet(db, account.connectedAccountId);

    let seenAccessToken: string | undefined;
    const client: GooglePeopleClient = {
      ...writeBackStubs,
      listConnections: vi.fn(async (accessToken) => {
        seenAccessToken = accessToken;
        return {
          connections: [{ resourceName: "people/c1", etag: "etag-1" }],
          nextSyncToken: "token-1",
        };
      }),
    };

    const handle = startGoogleContactsSyncLoop(db, {
      mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
      client,
      intervalMs: 60_000,
    });

    await vi.waitFor(async () => {
      expect(client.listConnections).toHaveBeenCalled();
    });
    await handle.stop();

    expect(seenAccessToken).toBe("contacts-access-token");
    const [addressBook] = await selectAddressBooksForConnectedAccount(
      db,
      account.connectedAccountId,
      0,
    );
    expect(addressBook?.capabilityTableId).toBe("google");
    const rows = await db
      .select()
      .from(contacts)
      .where(eq(contacts.addressBookId, addressBook?.id ?? ""));
    expect(rows).toHaveLength(1);
  });

  it("never calls the client for an account with no active Contacts Facet", async () => {
    await createTestMailAccount(db, { oauth: { accessToken: "mail-token" } });

    const client: GooglePeopleClient = { ...writeBackStubs, listConnections: vi.fn() };
    const handle = startGoogleContactsSyncLoop(db, {
      mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
      client,
      intervalMs: 60_000,
    });
    await handle.stop();

    expect(client.listConnections).not.toHaveBeenCalled();
  });

  it("isolates one account's failure from the rest of the same tick", async () => {
    const failing = await createTestMailAccount(db, { oauth: { accessToken: "mail-token" } });
    await turnOnContactsFacet(db, failing.connectedAccountId);
    const healthy = await createTestMailAccount(db, { oauth: { accessToken: "mail-token" } });
    await turnOnContactsFacet(db, healthy.connectedAccountId);

    let calls = 0;
    const client: GooglePeopleClient = {
      ...writeBackStubs,
      listConnections: vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new Error("simulated network failure");
        return { connections: [], nextSyncToken: "token" };
      }),
    };

    const handle = startGoogleContactsSyncLoop(db, {
      mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
      client,
      intervalMs: 60_000,
    });

    await vi.waitFor(async () => {
      expect(calls).toBe(2);
    });
    await handle.stop();

    // Whichever account happened to fail first, the other account's own
    // Address Book still landed — one account's thrown error never stops
    // the tick from reaching the rest.
    const bookCounts = await Promise.all(
      [failing, healthy].map(async (account) => {
        const books = await selectAddressBooksForConnectedAccount(
          db,
          account.connectedAccountId,
          0,
        );
        return books.length;
      }),
    );
    expect(bookCounts).toEqual([1, 1]);
  });
});
