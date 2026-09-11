import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  deriveCredentialKey,
  sealOAuthCredential,
} from "../../connected-accounts/credential-crypto.js";
import type { Db } from "../../db/client.js";
import { connectedAccountFacets, connectedAccounts, users } from "../../db/schema.js";
import { createTestDb, resetTestDb } from "../../test-support/db.js";
import { createGoogleCalendarCredentialProvider } from "./credentials.js";

let db: Db;
let closeDb: () => Promise<void>;
const key = deriveCredentialKey("test-credential-key");

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

async function createGoogleAccount(
  userId: string,
  facetStatus: "active" | "needs_reauth" = "active",
): Promise<string> {
  const id = randomUUID();
  const credential = sealOAuthCredential(
    {
      provider: "google",
      accessToken: "the-access-token",
      refreshToken: "the-refresh-token",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      scope: ["https://www.googleapis.com/auth/calendar"],
    },
    "default",
    id,
    key,
  );
  await db.insert(connectedAccounts).values({
    id,
    userId,
    provider: "google",
    identity: "user@gmail.com",
    credential,
    status: "active",
  });
  await db.insert(connectedAccountFacets).values({
    id: randomUUID(),
    connectedAccountId: id,
    kind: "calendar",
    status: facetStatus,
  });
  return id;
}

describe("createGoogleCalendarCredentialProvider", () => {
  it("unseals the Google account's shared 'default'-audience access token for an active Calendar Facet", async () => {
    const userId = await createUser();
    const connectedAccountId = await createGoogleAccount(userId);
    const provider = createGoogleCalendarCredentialProvider(db, key);

    expect(await provider.getAccessToken(connectedAccountId)).toBe("the-access-token");
  });

  it("returns null for a parked (Needs Reauth) Calendar Facet", async () => {
    const userId = await createUser();
    const connectedAccountId = await createGoogleAccount(userId, "needs_reauth");
    const provider = createGoogleCalendarCredentialProvider(db, key);

    expect(await provider.getAccessToken(connectedAccountId)).toBeNull();
  });

  it("returns null for an unknown Connected Account", async () => {
    const provider = createGoogleCalendarCredentialProvider(db, key);
    expect(await provider.getAccessToken(randomUUID())).toBeNull();
  });
});
