import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { listMicrosoftAddressBooksForConnectedAccount } from "../../address-books/store.js";
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
import type { MicrosoftContactsClient } from "./client.js";
import { startMicrosoftContactsSyncLoop } from "./poll-loop.js";

/**
 * `startMicrosoftContactsSyncLoop` (#227) — the same scheduler-proof shape
 * `google/poll-loop.test.ts` already established: finding an active
 * Contacts Facet, unsealing Microsoft's own `"graph"`-audience access token
 * (unlike Google's shared `"default"` one), and mirroring on its immediate
 * first tick. `contacts-sync.test.ts` already owns every sync-policy
 * branch, not re-proven here.
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

async function turnOnContactsFacet(db: Db, connectedAccountId: string) {
  const key = deriveCredentialKey(TEST_MAIL_CREDENTIAL_KEY);
  const before = await getConnectedAccountById(db, connectedAccountId);
  if (!before) throw new Error("expected the Connected Account to exist");
  const widened = widenOAuthCredential(
    before.credential,
    {
      provider: "microsoft",
      accessToken: "contacts-access-token",
      refreshToken: "fresh-refresh",
      expiresAt: "2026-02-01T00:00:00.000Z",
      scope: [
        "https://graph.microsoft.com/Contacts.ReadWrite",
        "offline_access",
        "openid",
        "email",
      ],
    },
    "graph",
    connectedAccountId,
    key,
  );
  await attachFacetToConnectedAccount(db, connectedAccountId, "contacts", widened);
}

function fakeClient(): MicrosoftContactsClient {
  return {
    listContactFolders: vi.fn(async () => []),
    defaultContactFolderId: vi.fn(async () => "root-folder"),
    deltaContacts: vi.fn(async () => ({
      contacts: [{ id: "c1", changeKey: "ck1" }],
      deltaLink: "link-1",
    })),
    getContact: vi.fn(async () => null),
    createContact: vi.fn(async () => ({ id: "created", changeKey: "ck" })),
    updateContact: vi.fn(async () => ({ id: "c1", changeKey: "ck2" })),
    deleteContact: vi.fn(async () => undefined),
    getContactPhoto: vi.fn(async () => null),
  };
}

describe("startMicrosoftContactsSyncLoop", () => {
  it("mirrors an active Contacts Facet's account on its immediate first tick, using the widened graph-audience access token", async () => {
    const account = await createTestMailAccount(db, {
      oauth: { accessToken: "mail-token", provider: "microsoft" },
    });
    await turnOnContactsFacet(db, account.connectedAccountId);

    let seenAccessToken: string | undefined;
    const client = fakeClient();
    client.deltaContacts = vi.fn(async (accessToken) => {
      seenAccessToken = accessToken;
      return { contacts: [{ id: "c1", changeKey: "ck1" }], deltaLink: "link-1" };
    });

    const handle = startMicrosoftContactsSyncLoop(db, {
      mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
      client,
      intervalMs: 60_000,
    });

    await vi.waitFor(async () => {
      expect(client.deltaContacts).toHaveBeenCalled();
    });
    await handle.stop();

    expect(seenAccessToken).toBe("contacts-access-token");
    const [addressBook] = await listMicrosoftAddressBooksForConnectedAccount(
      db,
      account.connectedAccountId,
    );
    expect(addressBook?.capabilityTableId).toBe("microsoft");
    const rows = await db
      .select()
      .from(contacts)
      .where(eq(contacts.addressBookId, addressBook?.id ?? ""));
    expect(rows).toHaveLength(1);
  });

  it("never calls the client for an account with no active Contacts Facet", async () => {
    await createTestMailAccount(db, {
      oauth: { accessToken: "mail-token", provider: "microsoft" },
    });

    const client = fakeClient();
    const handle = startMicrosoftContactsSyncLoop(db, {
      mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
      client,
      intervalMs: 60_000,
    });
    await handle.stop();

    expect(client.deltaContacts).not.toHaveBeenCalled();
  });

  it("isolates one account's failure from the rest of the same tick", async () => {
    const failing = await createTestMailAccount(db, {
      oauth: { accessToken: "mail-token", provider: "microsoft" },
    });
    await turnOnContactsFacet(db, failing.connectedAccountId);
    const healthy = await createTestMailAccount(db, {
      oauth: { accessToken: "mail-token", provider: "microsoft" },
    });
    await turnOnContactsFacet(db, healthy.connectedAccountId);

    let calls = 0;
    const client = fakeClient();
    // Fails after the Address Book itself has already been minted
    // (`ensureMicrosoftAddressBook` runs ahead of the delta walk) — the same
    // "one account's own book still lands" shape `google/poll-loop.test.ts`
    // proves for its own equivalent failure point.
    client.deltaContacts = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("simulated network failure");
      return { contacts: [], deltaLink: "link-1" };
    });

    const handle = startMicrosoftContactsSyncLoop(db, {
      mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
      client,
      intervalMs: 60_000,
    });

    await vi.waitFor(async () => {
      expect(calls).toBe(2);
    });
    await handle.stop();

    const bookCounts = await Promise.all(
      [failing, healthy].map(async (account) => {
        const books = await listMicrosoftAddressBooksForConnectedAccount(
          db,
          account.connectedAccountId,
        );
        return books.length;
      }),
    );
    // Whichever account happened to fail first, the other account's own
    // Address Book still landed.
    expect(bookCounts).toEqual([1, 1]);
  });
});
