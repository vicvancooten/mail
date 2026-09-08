import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { markConnectedAccountNeedsReauth } from "../connected-accounts/store.js";
import type { Db } from "../db/client.js";
import { createTestDb, resetTestDb } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import {
  countConnectedAccountsForProviderFacet,
  getProviderFacetHealth,
  recordFacetFirstGrant,
  recordFacetRefreshOutcome,
} from "./facet-health-store.js";

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

describe("recordFacetFirstGrant", () => {
  it("stamps firstGrantedAt the first time a Facet is granted at a Provider (#205)", async () => {
    await recordFacetFirstGrant(db, "google", "calendar");

    const health = await getProviderFacetHealth(db, "google");
    const calendar = health.get("calendar");
    expect(calendar?.firstGrantedAt).not.toBeNull();
  });

  it("never moves the timestamp on a second grant of the same Facet", async () => {
    await recordFacetFirstGrant(db, "google", "calendar");
    const first = (await getProviderFacetHealth(db, "google")).get("calendar")?.firstGrantedAt;

    await recordFacetFirstGrant(db, "google", "calendar");
    const second = (await getProviderFacetHealth(db, "google")).get("calendar")?.firstGrantedAt;

    expect(second?.getTime()).toBe(first?.getTime());
  });

  it("tracks each Facet at a Provider independently", async () => {
    await recordFacetFirstGrant(db, "google", "mail");

    const health = await getProviderFacetHealth(db, "google");
    expect(health.get("mail")?.firstGrantedAt).not.toBeNull();
    expect(health.get("calendar")).toBeUndefined();
  });
});

describe("recordFacetRefreshOutcome", () => {
  it("stamps a success, clearing any prior error and apiNotEnabled", async () => {
    await recordFacetRefreshOutcome(db, "google", "calendar", {
      error: "403 Calendar API has not been used",
      apiNotEnabled: true,
    });
    await recordFacetRefreshOutcome(db, "google", "calendar", { error: null });

    const health = await getProviderFacetHealth(db, "google");
    const calendar = health.get("calendar");
    expect(calendar?.lastRefreshError).toBeNull();
    expect(calendar?.apiNotEnabled).toBe(false);
    expect(calendar?.lastRefreshAt).not.toBeNull();
  });

  it("stamps a failure with its error", async () => {
    await recordFacetRefreshOutcome(db, "microsoft", "contacts", { error: "token expired" });

    const health = await getProviderFacetHealth(db, "microsoft");
    expect(health.get("contacts")?.lastRefreshError).toBe("token expired");
  });
});

describe("countConnectedAccountsForProviderFacet", () => {
  it("counts a Mail Facet's Connected Accounts, split active/parked", async () => {
    await createTestMailAccount(db, { oauth: { accessToken: "a" } });
    const parked = await createTestMailAccount(db, { oauth: { accessToken: "b" } });
    await markConnectedAccountNeedsReauth(db, parked.connectedAccountId);

    const counts = await countConnectedAccountsForProviderFacet(db, "google", "mail");
    expect(counts).toEqual({ connectedAccountCount: 2, parkedCount: 1 });
  });

  it("is zero for a Facet nothing has ever turned on", async () => {
    const counts = await countConnectedAccountsForProviderFacet(db, "google", "calendar");
    expect(counts).toEqual({ connectedAccountCount: 0, parkedCount: 0 });
  });
});
