import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { claimTokens, users } from "../db/schema.js";
import { createTestDb, resetTestDb } from "../test-support/db.js";
import { consumeClaimToken, ensureClaimToken, isClaimed } from "./claim.js";

const logger = Fastify({ logger: false }).log;
const PUBLIC_URL = "http://localhost:3000";

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

describe("isClaimed", () => {
  it("is false with no users", async () => {
    expect(await isClaimed(db)).toBe(false);
  });

  it("is true once any user exists", async () => {
    await db
      .insert(users)
      .values({ id: randomUUID(), username: "vic", passwordHash: "x", role: "owner" });
    expect(await isClaimed(db)).toBe(true);
  });
});

describe("ensureClaimToken", () => {
  it("mints a token when unclaimed", async () => {
    await ensureClaimToken(db, logger, PUBLIC_URL);
    const rows = await db.select().from(claimTokens);
    expect(rows).toHaveLength(1);
  });

  it("invalidates whatever token a previous boot printed", async () => {
    await ensureClaimToken(db, logger, PUBLIC_URL);
    const [first] = await db.select().from(claimTokens);

    await ensureClaimToken(db, logger, PUBLIC_URL);
    const [second] = await db.select().from(claimTokens);

    expect(second?.id).not.toBe(first?.id);
  });

  it("does nothing once the instance is claimed", async () => {
    await db
      .insert(users)
      .values({ id: randomUUID(), username: "vic", passwordHash: "x", role: "owner" });

    await ensureClaimToken(db, logger, PUBLIC_URL);

    expect(await db.select().from(claimTokens)).toHaveLength(0);
  });
});

/** The raw token only ever exists in the log line — capture it the way an operator would read it. */
async function mintAndCaptureToken(): Promise<string> {
  let captured = "";
  const originalInfo = logger.info.bind(logger);
  logger.info = ((payload: unknown, ...rest: unknown[]) => {
    if (typeof payload === "object" && payload && "claimToken" in payload) {
      captured = String((payload as { claimToken: string }).claimToken);
    }
    return originalInfo(payload as never, ...(rest as []));
  }) as typeof logger.info;

  await ensureClaimToken(db, logger, PUBLIC_URL);
  logger.info = originalInfo;

  if (!captured) throw new Error("ensureClaimToken did not log a claimToken");
  return captured;
}

describe("consumeClaimToken", () => {
  it("accepts the token exactly once", async () => {
    const token = await mintAndCaptureToken();

    expect(await consumeClaimToken(db, token)).toBe(true);
    expect(await consumeClaimToken(db, token)).toBe(false);
  });

  it("rejects an unknown token", async () => {
    expect(await consumeClaimToken(db, "not-a-real-token")).toBe(false);
  });

  it("rejects an expired token", async () => {
    const token = await mintAndCaptureToken();
    await db.update(claimTokens).set({ expiresAt: new Date(Date.now() - 1000) });

    expect(await consumeClaimToken(db, token)).toBe(false);
  });
});
