import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { ensureClaimToken } from "../auth/claim.js";
import type { DavDiscoveryResult } from "../connected-accounts/dav-discovery.js";
import type { Db } from "../db/client.js";
import { createTestDb, resetTestDb, TEST_MAIL_CREDENTIAL_KEY } from "../test-support/db.js";

const PUBLIC_URL = "http://localhost:3000";

let db: Db;
let closeDb: () => Promise<void>;

function extractCookie(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  if (!raw) throw new Error("no Set-Cookie header on response");
  return raw.split(";")[0] ?? raw;
}

function buildTestApp(discoverDav: () => Promise<DavDiscoveryResult>) {
  return buildApp({
    db,
    publicUrl: PUBLIC_URL,
    mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
    connectedAccountDiscoverDav: discoverDav,
  });
}

async function claimOwner(app: FastifyInstance): Promise<string> {
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
  return extractCookie(response.headers["set-cookie"]);
}

const SUCCESSFUL_DISCOVERY: DavDiscoveryResult = {
  ok: true,
  principalUrl: "https://dav.example.com/principals/vic/",
  homeSetUrl: "https://dav.example.com/calendars/vic/",
  supportsScheduling: true,
  collections: { count: 2, names: ["Work", "Home"] },
};

const VALID_CALDAV_PAYLOAD = {
  serverAddress: "dav.example.com",
  username: "vic",
  password: "an-app-specific-password",
  facet: "calendar" as const,
};

beforeEach(async () => {
  const created = await createTestDb();
  db = created.db;
  closeDb = () => created.sql.end();
  await resetTestDb(db);
});

afterAll(async () => {
  await closeDb?.();
});

describe("POST /connected-accounts/caldav", () => {
  it("requires a session", async () => {
    const app = buildTestApp(async () => SUCCESSFUL_DISCOVERY);
    const response = await app.inject({
      method: "POST",
      url: "/connected-accounts/caldav",
      payload: VALID_CALDAV_PAYLOAD,
    });
    expect(response.statusCode).toBe(401);
  });

  it("writes no row when discovery can't reach any candidate host", async () => {
    const app = buildTestApp(async () => ({ ok: false, reason: "unreachable" }));
    const cookie = await claimOwner(app);

    const response = await app.inject({
      method: "POST",
      url: "/connected-accounts/caldav",
      headers: { cookie },
      payload: VALID_CALDAV_PAYLOAD,
    });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: "unreachable" });

    const rows = await db.query.connectedAccounts.findMany();
    expect(rows).toHaveLength(0);
  });

  it("writes no row when the credential is rejected", async () => {
    const app = buildTestApp(async () => ({ ok: false, reason: "credentials_rejected" }));
    const cookie = await claimOwner(app);

    const response = await app.inject({
      method: "POST",
      url: "/connected-accounts/caldav",
      headers: { cookie },
      payload: VALID_CALDAV_PAYLOAD,
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: "credentials_rejected" });
  });

  it("writes no row when the server has no home-set for this facet", async () => {
    const app = buildTestApp(async () => ({ ok: false, reason: "no_home_set" }));
    const cookie = await claimOwner(app);

    const response = await app.inject({
      method: "POST",
      url: "/connected-accounts/caldav",
      headers: { cookie },
      payload: VALID_CALDAV_PAYLOAD,
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: "no_home_set" });
  });

  it("creates the account and its first Facet on successful discovery, reporting what was found", async () => {
    const app = buildTestApp(async () => SUCCESSFUL_DISCOVERY);
    const cookie = await claimOwner(app);

    const response = await app.inject({
      method: "POST",
      url: "/connected-accounts/caldav",
      headers: { cookie },
      payload: VALID_CALDAV_PAYLOAD,
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).toMatchObject({
      facet: "calendar",
      discovered: { count: 2, names: ["Work", "Home"] },
      supportsScheduling: true,
    });
    expect(JSON.stringify(body)).not.toContain("an-app-specific-password");

    const [account] = await db.query.connectedAccounts.findMany();
    expect(account).toMatchObject({
      provider: "caldav_carddav",
      identity: "vic",
      serverAddress: "dav.example.com",
      daveUsername: "vic",
    });
    const facets = await db.query.connectedAccountFacets.findMany();
    expect(facets).toMatchObject([
      {
        connectedAccountId: account?.id,
        kind: "calendar",
        davPrincipalUrl: SUCCESSFUL_DISCOVERY.ok ? SUCCESSFUL_DISCOVERY.principalUrl : undefined,
        davHomeSetUrl: SUCCESSFUL_DISCOVERY.ok ? SUCCESSFUL_DISCOVERY.homeSetUrl : undefined,
        davSupportsScheduling: true,
      },
    ]);
  });

  it("refuses a duplicate identity — the attach route is what turns on a second Facet", async () => {
    const app = buildTestApp(async () => SUCCESSFUL_DISCOVERY);
    const cookie = await claimOwner(app);
    await app.inject({
      method: "POST",
      url: "/connected-accounts/caldav",
      headers: { cookie },
      payload: VALID_CALDAV_PAYLOAD,
    });

    const response = await app.inject({
      method: "POST",
      url: "/connected-accounts/caldav",
      headers: { cookie },
      payload: { ...VALID_CALDAV_PAYLOAD, facet: "contacts" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "duplicate_identity" });
  });
});

describe("POST /connected-accounts/:id/caldav-facets", () => {
  async function createAccount(app: FastifyInstance, cookie: string): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/connected-accounts/caldav",
      headers: { cookie },
      payload: VALID_CALDAV_PAYLOAD,
    });
    return response.json().connectedAccountId;
  }

  it("requires a session", async () => {
    const app = buildTestApp(async () => SUCCESSFUL_DISCOVERY);
    const response = await app.inject({
      method: "POST",
      url: "/connected-accounts/some-id/caldav-facets",
      payload: { facet: "contacts" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("404s for an account this User doesn't own", async () => {
    const app = buildTestApp(async () => SUCCESSFUL_DISCOVERY);
    const cookie = await claimOwner(app);
    const response = await app.inject({
      method: "POST",
      url: "/connected-accounts/not-a-real-id/caldav-facets",
      headers: { cookie },
      payload: { facet: "contacts" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("runs discovery against the stored credential, never asking the request for one", async () => {
    let seenInput: unknown;
    const app = buildTestApp(async () => SUCCESSFUL_DISCOVERY);
    const cookie = await claimOwner(app);
    const accountId = await createAccount(app, cookie);

    // A second app instance whose `discoverDav` captures what it was called
    // with, wired to the same account already created above.
    const capturingApp = buildApp({
      db,
      publicUrl: PUBLIC_URL,
      mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
      connectedAccountDiscoverDav: async (input) => {
        seenInput = input;
        return {
          ok: true,
          principalUrl: SUCCESSFUL_DISCOVERY.ok ? SUCCESSFUL_DISCOVERY.principalUrl : "",
          homeSetUrl: SUCCESSFUL_DISCOVERY.ok ? SUCCESSFUL_DISCOVERY.homeSetUrl : "",
          supportsScheduling: false,
          collections: { count: 1, names: ["Contacts"] },
        };
      },
    });

    const response = await capturingApp.inject({
      method: "POST",
      url: `/connected-accounts/${accountId}/caldav-facets`,
      headers: { cookie },
      payload: { facet: "contacts" },
    });
    expect(response.statusCode).toBe(200);
    expect(seenInput).toMatchObject({
      serverAddress: "dav.example.com",
      username: "vic",
      password: "an-app-specific-password",
      facet: "contacts",
    });
    expect(response.json()).toMatchObject({
      facet: "contacts",
      discovered: { count: 1, names: ["Contacts"] },
    });

    const facets = await db.query.connectedAccountFacets.findMany();
    expect(facets.map((facet) => facet.kind).sort()).toEqual(["calendar", "contacts"]);
  });

  it("refuses to turn on a Facet the account already has", async () => {
    const app = buildTestApp(async () => SUCCESSFUL_DISCOVERY);
    const cookie = await claimOwner(app);
    const accountId = await createAccount(app, cookie);

    const response = await app.inject({
      method: "POST",
      url: `/connected-accounts/${accountId}/caldav-facets`,
      headers: { cookie },
      payload: { facet: "calendar" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "facet_already_exists" });
  });

  it("writes no Facet row when discovery fails", async () => {
    const createApp = buildTestApp(async () => SUCCESSFUL_DISCOVERY);
    const cookie = await claimOwner(createApp);
    const accountId = await createAccount(createApp, cookie);

    const failingApp = buildApp({
      db,
      publicUrl: PUBLIC_URL,
      mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
      connectedAccountDiscoverDav: async () => ({ ok: false, reason: "no_home_set" }),
    });
    const response = await failingApp.inject({
      method: "POST",
      url: `/connected-accounts/${accountId}/caldav-facets`,
      headers: { cookie },
      payload: { facet: "contacts" },
    });
    expect(response.statusCode).toBe(422);

    const facets = await db.query.connectedAccountFacets.findMany();
    expect(facets.map((facet) => facet.kind)).toEqual(["calendar"]);
  });
});
