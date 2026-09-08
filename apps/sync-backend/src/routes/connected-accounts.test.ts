import { randomUUID } from "node:crypto";
import { EMPTY_COMPOSE_DOCUMENT } from "@mail/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { ensureClaimToken } from "../auth/claim.js";
import type { Db } from "../db/client.js";
import {
  compositions,
  connectedAccountFacets,
  connectedAccounts,
  mailAccounts,
  syncTombstones,
  threads,
} from "../db/schema.js";
import type { ProviderAdapters } from "../mail-accounts/provider-adapter.js";
import type { SyncManager } from "../sync/manager.js";
import { createTestDb, resetTestDb, TEST_MAIL_CREDENTIAL_KEY } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";

const PUBLIC_URL = "http://localhost:3000";

let db: Db;
let closeDb: () => Promise<void>;

function extractCookie(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  if (!raw) throw new Error("no Set-Cookie header on response");
  return raw.split(";")[0] ?? raw;
}

function buildTestApp(
  overrides: { providerAdapters?: ProviderAdapters; syncManager?: SyncManager } = {},
) {
  return buildApp({
    db,
    publicUrl: PUBLIC_URL,
    mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
    providerAdapters: overrides.providerAdapters,
    syncManager: overrides.syncManager,
  });
}

/** Claims the instance as the Owner and returns both the session cookie and the new User's id. */
async function claimOwner(app: FastifyInstance): Promise<{ cookie: string; userId: string }> {
  let captured = "";
  const originalInfo = app.log.info.bind(app.log);
  app.log.info = ((payload: unknown, ...rest: unknown[]) => {
    if (typeof payload === "object" && payload && "claimToken" in payload) {
      captured = String((payload as { claimToken: string }).claimToken);
    }
    return originalInfo(payload as never, ...(rest as []));
  }) as typeof app.log.info;
  await ensureClaimToken(db, app.log, PUBLIC_URL);
  app.log.info = originalInfo;

  const response = await app.inject({
    method: "POST",
    url: "/auth/claim",
    payload: { token: captured, username: "vic", password: "a-long-enough-password" },
  });
  const body = response.json() as { user: { id: string } };
  return { cookie: extractCookie(response.headers["set-cookie"]), userId: body.user.id };
}

beforeEach(async () => {
  const created = await createTestDb();
  db = created.db;
  closeDb = () => created.sql.end();
  await resetTestDb(db);
});

afterAll(async () => {
  await closeDb?.();
});

describe("GET /connected-accounts/:id/facets/:kind/removal-preview", () => {
  it("requires a session", async () => {
    const app = buildTestApp();
    const response = await app.inject({
      method: "GET",
      url: `/connected-accounts/${randomUUID()}/facets/mail/removal-preview`,
    });
    expect(response.statusCode).toBe(401);
  });

  it("404s for an id this User doesn't own", async () => {
    const app = buildTestApp();
    const { cookie } = await claimOwner(app);
    const response = await app.inject({
      method: "GET",
      url: `/connected-accounts/${randomUUID()}/facets/mail/removal-preview`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it("400s for an unknown Facet kind", async () => {
    const app = buildTestApp();
    const { cookie, userId } = await claimOwner(app);
    const account = await createTestMailAccount(db, { userId });
    const response = await app.inject({
      method: "GET",
      url: `/connected-accounts/${account.connectedAccountId}/facets/nonsense/removal-preview`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(400);
  });

  it("names the Thread count and that this is the last Facet", async () => {
    const app = buildTestApp();
    const { cookie, userId } = await claimOwner(app);
    const account = await createTestMailAccount(db, { userId });
    await db.insert(threads).values([
      { id: randomUUID(), mailAccountId: account.id },
      { id: randomUUID(), mailAccountId: account.id },
    ]);

    const response = await app.inject({
      method: "GET",
      url: `/connected-accounts/${account.connectedAccountId}/facets/mail/removal-preview`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      threadCount: 2,
      accountRemoved: true,
      pendingSendBlockSeconds: null,
    });
  });

  it("reports a still-cancellable Pending Send's remaining Undo Send seconds", async () => {
    const app = buildTestApp();
    const { cookie, userId } = await claimOwner(app);
    const account = await createTestMailAccount(db, { userId });
    await db.insert(compositions).values({
      id: randomUUID(),
      mailAccountId: account.id,
      status: "pending",
      document: EMPTY_COMPOSE_DOCUMENT,
      submitAfter: new Date(Date.now() + 8_000),
    });

    const response = await app.inject({
      method: "GET",
      url: `/connected-accounts/${account.connectedAccountId}/facets/mail/removal-preview`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { pendingSendBlockSeconds: number };
    expect(body.pendingSendBlockSeconds).toBeGreaterThan(0);
    expect(body.pendingSendBlockSeconds).toBeLessThanOrEqual(8);
  });
});

describe("DELETE /connected-accounts/:id/facets/:kind", () => {
  it("requires a session", async () => {
    const app = buildTestApp();
    const response = await app.inject({
      method: "DELETE",
      url: `/connected-accounts/${randomUUID()}/facets/mail`,
    });
    expect(response.statusCode).toBe(401);
  });

  it("404s for an id this User doesn't own", async () => {
    const app = buildTestApp();
    const { cookie } = await claimOwner(app);
    const response = await app.inject({
      method: "DELETE",
      url: `/connected-accounts/${randomUUID()}/facets/mail`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it("removes the last Facet's row, credential and Mail Account, and tombstones both collections", async () => {
    const app = buildTestApp();
    const { cookie, userId } = await claimOwner(app);
    const account = await createTestMailAccount(db, { userId });

    const response = await app.inject({
      method: "DELETE",
      url: `/connected-accounts/${account.connectedAccountId}/facets/mail`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ accountRemoved: true });

    const [connectedAccountRow] = await db
      .select()
      .from(connectedAccounts)
      .where(eq(connectedAccounts.id, account.connectedAccountId));
    expect(connectedAccountRow).toBeUndefined();

    const [mailAccountRow] = await db
      .select()
      .from(mailAccounts)
      .where(eq(mailAccounts.id, account.id));
    expect(mailAccountRow).toBeUndefined();

    const tombstones = await db
      .select({ collection: syncTombstones.collection, entityId: syncTombstones.entityId })
      .from(syncTombstones);
    expect(tombstones).toEqual(
      expect.arrayContaining([
        { collection: "ConnectedAccount", entityId: account.connectedAccountId },
        { collection: "MailAccount", entityId: account.id },
      ]),
    );
  });

  it("re-adding the same identity right after removal is never blocked", async () => {
    const app = buildTestApp();
    const { cookie, userId } = await claimOwner(app);
    const account = await createTestMailAccount(db, { userId, emailAddress: "vic@example.com" });

    await app.inject({
      method: "DELETE",
      url: `/connected-accounts/${account.connectedAccountId}/facets/mail`,
      headers: { cookie },
    });

    // The unique `(user_id, provider, identity)` index is gone with the row —
    // inserting a fresh Connected Account for the same address never conflicts.
    await expect(
      createTestMailAccount(db, { userId, emailAddress: "vic@example.com" }),
    ).resolves.toBeTruthy();
  });

  it("blocks removal of a Mail Facet with a still-cancellable Pending Send, and names the remaining seconds", async () => {
    const app = buildTestApp();
    const { cookie, userId } = await claimOwner(app);
    const account = await createTestMailAccount(db, { userId });
    await db.insert(compositions).values({
      id: randomUUID(),
      mailAccountId: account.id,
      status: "pending",
      document: EMPTY_COMPOSE_DOCUMENT,
      submitAfter: new Date(Date.now() + 5_000),
    });

    const response = await app.inject({
      method: "DELETE",
      url: `/connected-accounts/${account.connectedAccountId}/facets/mail`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(409);
    const body = response.json() as { error: string; secondsRemaining: number };
    expect(body.error).toBe("pending_send");
    expect(body.secondsRemaining).toBeGreaterThan(0);

    // Nothing was removed — the account, its Facet and the Mail Account all survive the block.
    const [connectedAccountRow] = await db
      .select()
      .from(connectedAccounts)
      .where(eq(connectedAccounts.id, account.connectedAccountId));
    expect(connectedAccountRow).toBeTruthy();
  });

  it("turning off one Facet on a multi-Facet account keeps the account and the Grant's scope untouched", async () => {
    const app = buildTestApp();
    const { cookie, userId } = await claimOwner(app);
    const account = await createTestMailAccount(db, {
      userId,
      oauth: { accessToken: "irrelevant-access-token", provider: "google" },
    });
    await db.insert(connectedAccountFacets).values({
      id: randomUUID(),
      connectedAccountId: account.connectedAccountId,
      kind: "calendar",
    });

    const response = await app.inject({
      method: "DELETE",
      url: `/connected-accounts/${account.connectedAccountId}/facets/mail`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ accountRemoved: false });

    const [connectedAccountRow] = await db
      .select()
      .from(connectedAccounts)
      .where(eq(connectedAccounts.id, account.connectedAccountId));
    expect(connectedAccountRow).toBeTruthy(); // the account survives — Calendar is still turned on

    const remainingFacets = await db
      .select({ kind: connectedAccountFacets.kind })
      .from(connectedAccountFacets)
      .where(eq(connectedAccountFacets.connectedAccountId, account.connectedAccountId));
    expect(remainingFacets).toEqual([{ kind: "calendar" }]);

    const [mailAccountRow] = await db
      .select()
      .from(mailAccounts)
      .where(eq(mailAccounts.id, account.id));
    expect(mailAccountRow).toBeUndefined(); // the Mail Facet's own mirror is gone
  });

  it("stops the removed Mail Facet's resident sync session", async () => {
    const stop = vi.fn(async () => undefined);
    const syncManager: SyncManager = {
      start: vi.fn(),
      restart: vi.fn(),
      stop,
      stopAll: vi.fn(),
    };
    const app = buildTestApp({ syncManager });
    const { cookie, userId } = await claimOwner(app);
    const account = await createTestMailAccount(db, { userId });

    await app.inject({
      method: "DELETE",
      url: `/connected-accounts/${account.connectedAccountId}/facets/mail`,
      headers: { cookie },
    });

    expect(stop).toHaveBeenCalledWith(account.id);
  });

  it("revokes a Google Grant best-effort on whole-account removal, never failing removal if it throws", async () => {
    const revoke = vi.fn(async () => {
      throw new Error("Google is unreachable");
    });
    const app = buildTestApp({ providerAdapters: { google: { revoke } as never } });
    const { cookie, userId } = await claimOwner(app);
    const account = await createTestMailAccount(db, {
      userId,
      oauth: { accessToken: "irrelevant-access-token", provider: "google" },
    });

    const response = await app.inject({
      method: "DELETE",
      url: `/connected-accounts/${account.connectedAccountId}/facets/mail`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(revoke).toHaveBeenCalledWith("unused-in-this-ticket-refresh-token");
  });

  it("never calls revoke when turning off one Facet leaves the account (and its Grant) in place", async () => {
    const revoke = vi.fn(async () => undefined);
    const app = buildTestApp({ providerAdapters: { google: { revoke } as never } });
    const { cookie, userId } = await claimOwner(app);
    const account = await createTestMailAccount(db, {
      userId,
      oauth: { accessToken: "irrelevant-access-token", provider: "google" },
    });
    await db.insert(connectedAccountFacets).values({
      id: randomUUID(),
      connectedAccountId: account.connectedAccountId,
      kind: "calendar",
    });

    await app.inject({
      method: "DELETE",
      url: `/connected-accounts/${account.connectedAccountId}/facets/mail`,
      headers: { cookie },
    });

    expect(revoke).not.toHaveBeenCalled();
  });
});
