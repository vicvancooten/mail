import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { ensureClaimToken } from "../auth/claim.js";
import type { Db } from "../db/client.js";
import { folders, messages, threads } from "../db/schema.js";
import { setVerdict } from "../gatekeeper/verdicts.js";
import { createTestDb, resetTestDb, TEST_MAIL_CREDENTIAL_KEY } from "../test-support/db.js";

/**
 * Gatekeeper's account-level routes (#55): the Settings surface #56 renders
 * and the three switches it drives. The screening *behaviour* those switches
 * turn on is `gatekeeper/gatekeeper.test.ts`'s subject — this file is about
 * the HTTP layer, ownership, and the shape that comes back.
 */

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

function buildTestApp() {
  return buildApp({
    db,
    publicUrl: PUBLIC_URL,
    mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
    mailAccountVerify: async () => ({ ok: true }),
  });
}

function extractCookie(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  if (!raw) throw new Error("no Set-Cookie header on response");
  return raw.split(";")[0] ?? raw;
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

async function createOwnedMailAccount(app: FastifyInstance, cookie: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/mail-accounts",
    headers: { cookie },
    payload: {
      emailAddress: "vic@example.com",
      imap: { host: "imap.example.com", port: 993, security: "tls" },
      smtp: { host: "smtp.example.com", port: 587, security: "starttls" },
      username: "vic@example.com",
      password: "correct-horse-battery-staple",
    },
  });
  expect(response.statusCode).toBe(201);
  return (response.json().mailAccount as { id: string }).id;
}

/** One message in a `Sent`-role folder, so the seed has history to sweep. */
async function seedSentMessageTo(mailAccountId: string, address: string): Promise<void> {
  const threadId = randomUUID();
  const folderId = randomUUID();
  await db.insert(threads).values({ id: threadId, mailAccountId });
  await db
    .insert(folders)
    .values({ id: folderId, mailAccountId, path: "Sent", name: "Sent", role: "sent" });
  await db.insert(messages).values({
    id: randomUUID(),
    mailAccountId,
    threadId,
    folderId,
    uid: 1,
    subject: "Earlier conversation",
    fromAddress: "vic@example.com",
    toAddresses: [{ name: null, address }],
    sentAt: new Date("2025-01-01T00:00:00Z"),
    receivedAt: new Date("2025-01-01T00:00:00Z"),
  });
}

describe("Gatekeeper routes (#55)", () => {
  it("401s without a session", async () => {
    const app = buildTestApp();
    const response = await app.inject({ method: "GET", url: "/mail-accounts/x/gatekeeper" });
    expect(response.statusCode).toBe(401);
  });

  it("404s a Mail Account this User does not own", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const response = await app.inject({
      method: "POST",
      url: "/mail-accounts/not-mine/gatekeeper/enable",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it("reports Gatekeeper off, with no Cutoff and nothing approved, before it is ever enabled", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const mailAccountId = await createOwnedMailAccount(app, cookie);

    const response = await app.inject({
      method: "GET",
      url: `/mail-accounts/${mailAccountId}/gatekeeper`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      gatekeeper: { enabled: false, cutoff: null },
      approvedCount: 0,
      blocked: [],
    });
  });

  it("enable stamps the Cutoff, reports what the seed approved, and shows up on the MailAccount collection", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const mailAccountId = await createOwnedMailAccount(app, cookie);
    await seedSentMessageTo(mailAccountId, "partner@example.test");

    const enabled = await app.inject({
      method: "POST",
      url: `/mail-accounts/${mailAccountId}/gatekeeper/enable`,
      headers: { cookie },
    });
    expect(enabled.statusCode).toBe(200);
    const body = enabled.json() as {
      gatekeeper: { enabled: boolean; cutoff: string | null };
      approvedCount: number;
      seeded: number;
    };
    expect(body).toMatchObject({ approvedCount: 1, seeded: 1 });
    expect(body.gatekeeper.enabled).toBe(true);
    expect(body.gatekeeper.cutoff).not.toBeNull();

    // Every Client learns about it through the ordinary delta, not this route.
    const sync = await app.inject({
      method: "POST",
      url: "/sync",
      headers: { cookie },
      payload: { user: { MailAccount: null } },
    });
    const accounts = (
      sync.json() as { user: { MailAccount: { created: { gatekeeper: unknown }[] } } }
    ).user.MailAccount.created;
    expect(accounts[0]?.gatekeeper).toEqual({
      enabled: true,
      cutoff: body.gatekeeper.cutoff,
    });
  });

  it("disable keeps the Verdicts, and lists the blocked ones for unblocking", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const mailAccountId = await createOwnedMailAccount(app, cookie);
    await app.inject({
      method: "POST",
      url: `/mail-accounts/${mailAccountId}/gatekeeper/enable`,
      headers: { cookie },
    });
    await setVerdict(
      db,
      mailAccountId,
      { scope: "address", value: "villain@example.test" },
      "blocked",
      "screener",
    );

    const disabled = await app.inject({
      method: "POST",
      url: `/mail-accounts/${mailAccountId}/gatekeeper/disable`,
      headers: { cookie },
    });
    expect(disabled.statusCode).toBe(200);
    const body = disabled.json() as {
      gatekeeper: { enabled: boolean; cutoff: string | null };
      blocked: { scope: string; value: string; source: string; decidedAt: string }[];
    };
    expect(body.gatekeeper.enabled).toBe(false);
    // The Cutoff survives a disable — it records when screening started.
    expect(body.gatekeeper.cutoff).not.toBeNull();
    expect(body.blocked).toEqual([
      expect.objectContaining({
        scope: "address",
        value: "villain@example.test",
        source: "screener",
      }),
    ]);
  });

  it("reset clears the Verdicts and re-seeds", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const mailAccountId = await createOwnedMailAccount(app, cookie);
    await seedSentMessageTo(mailAccountId, "partner@example.test");
    await app.inject({
      method: "POST",
      url: `/mail-accounts/${mailAccountId}/gatekeeper/enable`,
      headers: { cookie },
    });
    await setVerdict(
      db,
      mailAccountId,
      { scope: "address", value: "villain@example.test" },
      "blocked",
      "screener",
    );

    const reset = await app.inject({
      method: "POST",
      url: `/mail-accounts/${mailAccountId}/gatekeeper/reset`,
      headers: { cookie },
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toMatchObject({
      gatekeeper: { enabled: true },
      approvedCount: 1,
      seeded: 1,
      blocked: [],
    });
  });
});
