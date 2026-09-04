import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { oauthSignInAttempts, users } from "../db/schema.js";
import { createTestDb, resetTestDb } from "../test-support/db.js";
import {
  consumeSignInAttempt,
  deleteExpiredSignInAttempts,
  deriveCodeChallenge,
  startSignInAttempt,
} from "./sign-in-attempts.js";

/**
 * The two things `routes/oauth-signin.test.ts` can't reach through HTTP:
 * what an *expired* attempt does, and the sweep that clears attempts nobody
 * ever came back for. Single-use-ness and cross-User rejection are covered
 * there, through the flow that actually depends on them.
 */

let db: Db;
let closeDb: () => Promise<void>;
let userId: string;

beforeEach(async () => {
  const created = await createTestDb();
  db = created.db;
  closeDb = () => created.sql.end();
  await resetTestDb(db);
  userId = randomUUID();
  await db
    .insert(users)
    .values({ id: userId, username: `user-${userId}`, passwordHash: "x", role: "member" });
});

afterAll(async () => {
  await closeDb?.();
});

const START = { provider: "google" as const, purpose: "add_mail_account" as const };

it("derives PKCE's S256 challenge from the verifier, base64url and unpadded", () => {
  // RFC 7636's own worked example.
  expect(deriveCodeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
});

describe("consumeSignInAttempt", () => {
  it("returns the attempt exactly once, deleting the row as it reads", async () => {
    const { state } = await startSignInAttempt(db, { userId, ...START });

    const first = await consumeSignInAttempt(db, { state, userId, provider: "google" });
    const second = await consumeSignInAttempt(db, { state, userId, provider: "google" });

    expect(first).toMatchObject({ userId, provider: "google", purpose: "add_mail_account" });
    expect(second).toBeNull();
    expect(await db.select().from(oauthSignInAttempts)).toHaveLength(0);
  });

  it("refuses an expired attempt, and still consumes it — an expired state is never redeemable twice either", async () => {
    const twentyMinutesAgo = new Date(Date.now() - 20 * 60 * 1000);
    const { state } = await startSignInAttempt(db, { userId, ...START }, twentyMinutesAgo);

    expect(await consumeSignInAttempt(db, { state, userId, provider: "google" })).toBeNull();
    expect(await db.select().from(oauthSignInAttempts)).toHaveLength(0);
  });

  it("refuses an attempt started for a different Provider", async () => {
    const { state } = await startSignInAttempt(db, { userId, ...START });
    expect(await consumeSignInAttempt(db, { state, userId, provider: "microsoft" })).toBeNull();
  });
});

describe("deleteExpiredSignInAttempts", () => {
  it("clears attempts nobody came back for, leaving live ones alone", async () => {
    await startSignInAttempt(db, { userId, ...START }, new Date(Date.now() - 20 * 60 * 1000));
    const live = await startSignInAttempt(db, { userId, ...START });

    await deleteExpiredSignInAttempts(db);

    const remaining = await db.select().from(oauthSignInAttempts);
    expect(remaining).toHaveLength(1);
    expect(
      await consumeSignInAttempt(db, { state: live.state, userId, provider: "google" }),
    ).not.toBeNull();
  });

  it("runs on the way in, so starting a sign-in is what keeps the table bounded", async () => {
    await startSignInAttempt(db, { userId, ...START }, new Date(Date.now() - 20 * 60 * 1000));
    expect(await db.select().from(oauthSignInAttempts)).toHaveLength(1);

    await startSignInAttempt(db, { userId, ...START });

    // The abandoned one is gone; only the attempt just started remains.
    expect(await db.select().from(oauthSignInAttempts)).toHaveLength(1);
  });
});
