import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { connectedAccountFacets } from "../db/schema.js";
import { createTestDb, resetTestDb, TEST_MAIL_CREDENTIAL_KEY } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import {
  deriveCredentialKey,
  unsealOAuthAccessToken,
  widenOAuthCredential,
} from "./credential-crypto.js";
import { attachFacetToConnectedAccount, getConnectedAccountById } from "./store.js";

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

describe("attachFacetToConnectedAccount", () => {
  it("lands the widened credential and a new active Facet row together (#202)", async () => {
    const mailAccount = await createTestMailAccount(db, { oauth: { accessToken: "mail-token" } });
    const key = deriveCredentialKey(TEST_MAIL_CREDENTIAL_KEY);

    const before = await getConnectedAccountById(db, mailAccount.connectedAccountId);
    if (!before) throw new Error("expected the Connected Account to exist");

    const widened = widenOAuthCredential(
      before.credential,
      {
        provider: "google",
        accessToken: "calendar-token",
        refreshToken: "fresh-refresh",
        expiresAt: "2026-02-01T00:00:00.000Z",
        scope: ["https://www.googleapis.com/auth/calendar", "openid", "email"],
      },
      "default",
      mailAccount.connectedAccountId,
      key,
    );

    await attachFacetToConnectedAccount(db, mailAccount.connectedAccountId, "calendar", widened);

    const after = await getConnectedAccountById(db, mailAccount.connectedAccountId);
    if (!after) throw new Error("expected the Connected Account to still exist");
    expect(after.credential.kind).toBe("oauth");
    expect(
      unsealOAuthAccessToken(after.credential, "default", mailAccount.connectedAccountId, key),
    ).toBe("calendar-token");

    const facets = await db
      .select()
      .from(connectedAccountFacets)
      .where(eq(connectedAccountFacets.connectedAccountId, mailAccount.connectedAccountId));
    const facetKinds = facets.map((facet) => facet.kind).sort();
    expect(facetKinds).toEqual(["calendar", "mail"]);
    const calendarFacet = facets.find((facet) => facet.kind === "calendar");
    expect(calendarFacet?.status).toBe("active");
    expect(calendarFacet?.scopesLastGrantedAt).not.toBeNull();
  });

  it("bumps the Connected Account's own syncRev (#200's trigger, exercised by inserting a Facet row directly)", async () => {
    const mailAccount = await createTestMailAccount(db, { oauth: { accessToken: "mail-token" } });
    const key = deriveCredentialKey(TEST_MAIL_CREDENTIAL_KEY);
    const before = await getConnectedAccountById(db, mailAccount.connectedAccountId);
    if (!before) throw new Error("expected the Connected Account to exist");

    const widened = widenOAuthCredential(
      before.credential,
      {
        provider: "google",
        accessToken: "contacts-token",
        refreshToken: "fresh-refresh",
        expiresAt: "2026-02-01T00:00:00.000Z",
        scope: ["https://www.googleapis.com/auth/contacts", "openid", "email"],
      },
      "default",
      mailAccount.connectedAccountId,
      key,
    );
    await attachFacetToConnectedAccount(db, mailAccount.connectedAccountId, "contacts", widened);

    const after = await getConnectedAccountById(db, mailAccount.connectedAccountId);
    expect(after?.syncRev).toBeGreaterThan(before.syncRev);
  });
});
