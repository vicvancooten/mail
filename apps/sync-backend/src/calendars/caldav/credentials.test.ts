import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  deriveCredentialKey,
  sealPasswordCredential,
} from "../../connected-accounts/credential-crypto.js";
import type { Db } from "../../db/client.js";
import { connectedAccountFacets, connectedAccounts, users } from "../../db/schema.js";
import { createTestDb, resetTestDb } from "../../test-support/db.js";
import { createCaldavCredentialProvider } from "./credentials.js";

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

async function createCaldavAccount(
  userId: string,
  facetStatus: "active" | "needs_reauth" = "active",
): Promise<string> {
  const id = randomUUID();
  const credential = sealPasswordCredential("app-password", id, key);
  await db.insert(connectedAccounts).values({
    id,
    userId,
    provider: "caldav_carddav",
    identity: "person@example.com",
    credential,
    status: "active",
    serverAddress: "https://dav.example.com/",
    davUsername: "person@example.com",
  });
  await db.insert(connectedAccountFacets).values({
    id: randomUUID(),
    connectedAccountId: id,
    kind: "calendar",
    status: facetStatus,
  });
  return id;
}

describe("createCaldavCredentialProvider", () => {
  it("unseals the app password as Basic auth for an active Calendar Facet", async () => {
    const userId = await createUser();
    const connectedAccountId = await createCaldavAccount(userId);
    const provider = createCaldavCredentialProvider(db, key);

    expect(await provider.getAuth(connectedAccountId)).toEqual({
      username: "person@example.com",
      password: "app-password",
    });
  });

  it("returns null for a parked (Needs Reauth) Calendar Facet", async () => {
    const userId = await createUser();
    const connectedAccountId = await createCaldavAccount(userId, "needs_reauth");
    const provider = createCaldavCredentialProvider(db, key);

    expect(await provider.getAuth(connectedAccountId)).toBeNull();
  });

  it("returns null for a Connected Account on a different provider", async () => {
    const userId = await createUser();
    const id = randomUUID();
    await db.insert(connectedAccounts).values({
      id,
      userId,
      provider: "google",
      identity: "user@gmail.com",
      credential: sealPasswordCredential("irrelevant", id, key),
      status: "active",
    });
    const provider = createCaldavCredentialProvider(db, key);
    expect(await provider.getAuth(id)).toBeNull();
  });

  it("returns null for an unknown Connected Account", async () => {
    const provider = createCaldavCredentialProvider(db, key);
    expect(await provider.getAuth(randomUUID())).toBeNull();
  });
});
