import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { ensureClaimToken } from "../auth/claim.js";
import type { Db } from "../db/client.js";
import { folders, mailAccounts, messages, threads } from "../db/schema.js";
import { setVerdict } from "../gatekeeper/verdicts.js";
import { reindexMessages } from "../sync/search-index.js";
import { createTestDb, resetTestDb, TEST_MAIL_CREDENTIAL_KEY } from "../test-support/db.js";

/**
 * `POST /search` (#50, ADR-0016, `docs/search-ux-spec.md`): the HTTP layer —
 * auth, Mail Account ownership, and assembling the wire shape (Thread
 * projection, folder pill, Index Watermark) around `sync/search-query.ts`'s
 * ranking, which `sync/search-query.test.ts` covers in depth.
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

async function createOwnedMailAccount(
  app: FastifyInstance,
  cookie: string,
  emailAddress = "vic@example.com",
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/mail-accounts",
    headers: { cookie },
    payload: {
      emailAddress,
      imap: { host: "imap.example.com", port: 993, security: "tls" },
      smtp: { host: "smtp.example.com", port: 587, security: "starttls" },
      username: emailAddress,
      password: "correct-horse-battery-staple",
    },
  });
  expect(response.statusCode).toBe(201);
  return (response.json().mailAccount as { id: string }).id;
}

/** Unique per seeded message: `(folder_id, uid)` is the Message's real identity, and one test seeds several. */
let nextUid = 1;

async function seedInboxMessage(
  mailAccountId: string,
  overrides: { subject?: string; fromAddress?: string; bodyText?: string | null } = {},
): Promise<{ threadId: string; folderId: string }> {
  const threadId = randomUUID();
  await db.insert(threads).values({ id: threadId, mailAccountId });
  // One INBOX per Mail Account, however many times this is called — the
  // `(mail_account_id, path)` unique index is the real folder identity.
  await db
    .insert(folders)
    .values({ id: randomUUID(), mailAccountId, path: "INBOX", name: "INBOX", role: "inbox" })
    .onConflictDoNothing({ target: [folders.mailAccountId, folders.path] });
  const [folder] = await db
    .select({ id: folders.id })
    .from(folders)
    .where(and(eq(folders.mailAccountId, mailAccountId), eq(folders.path, "INBOX")))
    .limit(1);
  if (!folder) throw new Error("INBOX was not seeded");
  const folderId = folder.id;
  const messageId = randomUUID();
  await db.insert(messages).values({
    id: messageId,
    mailAccountId,
    threadId,
    folderId,
    uid: nextUid++,
    subject: overrides.subject ?? "Quarterly budget",
    fromName: "Vic van Cooten",
    fromAddress: overrides.fromAddress ?? "vic.van.cooten@a-insights.eu",
    sentAt: new Date("2024-06-15T00:00:00Z"),
    receivedAt: new Date("2024-06-15T00:00:00Z"),
    bodyText: overrides.bodyText ?? null,
  });
  await reindexMessages(db, [messageId]);
  return { threadId, folderId };
}

describe("POST /search", () => {
  it("401s without a session", async () => {
    const app = buildTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/search",
      payload: { mailAccountId: "x", text: "hello" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("404s a Mail Account this User does not own", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const response = await app.inject({
      method: "POST",
      url: "/search",
      headers: { cookie },
      payload: { mailAccountId: "not-mine", text: "hello" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("400s a request missing mailAccountId", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const response = await app.inject({
      method: "POST",
      url: "/search",
      headers: { cookie },
      payload: { text: "hello" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("finds mail by a sender's address local part, and carries the Thread projection, folder pill and Index Watermark", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const mailAccountId = await createOwnedMailAccount(app, cookie);
    const { threadId, folderId } = await seedInboxMessage(mailAccountId, {
      fromAddress: "kowalski0@a-insights.eu",
    });

    const response = await app.inject({
      method: "POST",
      url: "/search",
      headers: { cookie },
      payload: { mailAccountId, text: "kowalski0" },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      results: {
        thread: { id: string };
        matchedMessageId: string;
        folder: { id: string; role: string | null };
      }[];
      cursor: string | null;
      indexWatermark: { coveredSince: string | null; complete: boolean };
    };
    expect(body.results).toHaveLength(1);
    expect(body.results[0]?.thread.id).toBe(threadId);
    expect(body.results[0]?.folder).toEqual({ id: folderId, name: "INBOX", role: "inbox" });
    expect(body.cursor).toBeNull();
    expect(body.indexWatermark).toEqual({ coveredSince: null, complete: false });
  });

  it("badges a held Thread and a Blocked Sender's mail (#55, docs/search-ux-spec.md §The row)", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const mailAccountId = await createOwnedMailAccount(app, cookie);

    const held = await seedInboxMessage(mailAccountId, {
      subject: "Held stranger",
      fromAddress: "stranger@example.test",
    });
    await db
      .update(threads)
      .set({ heldSender: "stranger@example.test", heldAt: new Date() })
      .where(eq(threads.id, held.threadId));

    const blocked = await seedInboxMessage(mailAccountId, {
      subject: "Blocked villain",
      fromAddress: "villain@example.test",
    });
    await setVerdict(
      db,
      mailAccountId,
      { scope: "address", value: "villain@example.test" },
      "blocked",
      "screener",
    );

    const plain = await seedInboxMessage(mailAccountId, {
      subject: "Ordinary correspondent",
      fromAddress: "colleague@example.test",
    });

    const response = await app.inject({
      method: "POST",
      url: "/search",
      headers: { cookie },
      payload: { mailAccountId, text: "", from: "example.test" },
    });
    expect(response.statusCode).toBe(200);
    const results = (
      response.json() as { results: { thread: { id: string }; gatekeeper: string | null }[] }
    ).results;
    const badgeByThread = new Map(results.map((row) => [row.thread.id, row.gatekeeper]));
    expect(badgeByThread.get(held.threadId)).toBe("held");
    expect(badgeByThread.get(blocked.threadId)).toBe("blocked");
    expect(badgeByThread.get(plain.threadId)).toBeNull();
  });

  it("returns no results, not an error, for a query nothing matches", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const mailAccountId = await createOwnedMailAccount(app, cookie);
    await seedInboxMessage(mailAccountId);

    const response = await app.inject({
      method: "POST",
      url: "/search",
      headers: { cookie },
      payload: { mailAccountId, text: "nomatch" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ results: [], cursor: null });
  });
});

describe("POST /search — Account Scope (#68, ADR-0016 amendment)", () => {
  it("404s when an additionalMailAccountIds entry is not owned by this User", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const mailAccountId = await createOwnedMailAccount(app, cookie);

    const response = await app.inject({
      method: "POST",
      url: "/search",
      headers: { cookie },
      payload: { mailAccountId, additionalMailAccountIds: ["not-mine"], text: "hello" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("merges results from mailAccountId and every additionalMailAccountIds entry", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const first = await createOwnedMailAccount(app, cookie, "vic@example.com");
    const second = await createOwnedMailAccount(app, cookie, "vic-work@example.com");
    const { threadId: firstThreadId } = await seedInboxMessage(first, {
      subject: "Quarterly roadmap",
    });
    const { threadId: secondThreadId } = await seedInboxMessage(second, {
      subject: "Quarterly numbers",
    });

    const response = await app.inject({
      method: "POST",
      url: "/search",
      headers: { cookie },
      payload: { mailAccountId: first, additionalMailAccountIds: [second], text: "quarterly" },
    });
    expect(response.statusCode).toBe(200);
    const threadIds = (response.json() as { results: { thread: { id: string } }[] }).results.map(
      (row) => row.thread.id,
    );
    expect(new Set(threadIds)).toEqual(new Set([firstThreadId, secondThreadId]));
  });

  it("returns the weakest Index Watermark across the Account Scope", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const complete = await createOwnedMailAccount(app, cookie, "vic@example.com");
    const partial = await createOwnedMailAccount(app, cookie, "vic-work@example.com");
    await db
      .update(mailAccounts)
      .set({ bodyWatermark: new Date("2020-01-01T00:00:00Z"), bodySweepComplete: true })
      .where(eq(mailAccounts.id, complete));
    await db
      .update(mailAccounts)
      .set({ bodyWatermark: new Date("2024-06-01T00:00:00Z"), bodySweepComplete: false })
      .where(eq(mailAccounts.id, partial));

    const response = await app.inject({
      method: "POST",
      url: "/search",
      headers: { cookie },
      payload: { mailAccountId: complete, additionalMailAccountIds: [partial], text: "hello" },
    });
    expect(response.statusCode).toBe(200);
    // `complete` alone would report `{ coveredSince: "2020-01-01...", complete: true }`
    // (the pre-#68 single-account read) — merged with `partial`, the Scope
    // is only as complete as its weakest account, and `coveredSince` is
    // `partial`'s more recent (i.e. less history covered) date, never
    // `complete`'s more comfortable one.
    const body = response.json() as {
      indexWatermark: { coveredSince: string | null; complete: boolean };
    };
    expect(body.indexWatermark).toEqual({
      coveredSince: new Date("2024-06-01T00:00:00Z").toISOString(),
      complete: false,
    });
  });
});
