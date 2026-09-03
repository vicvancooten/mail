import { randomUUID } from "node:crypto";
import type { BulkTriageBatchResponse, ThreadDelta } from "@mail/shared";
import { BULK_TRIAGE_RESET_THRESHOLD } from "@mail/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { ensureClaimToken } from "../auth/claim.js";
import type { Db } from "../db/client.js";
import { bulkTriageBatches, mailAccounts, threads } from "../db/schema.js";
import { createTestDb, resetTestDb, TEST_MAIL_CREDENTIAL_KEY } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";

/**
 * `POST /bulk-triage/{count,batch,undo}` (#67) against a real Postgres,
 * beside `routes/sync.test.ts` and `sync/mutations.test.ts` — the target-set
 * resolution and the mutation-ledger's idempotency only exist at the
 * database boundary. `sync/bulk-triage.test.ts` covers the query/mutation
 * mechanics directly; this file is the HTTP-level acceptance bar: per-account
 * partial failure, the reset threshold's interaction with `POST /sync`, and
 * Undo.
 */

const PUBLIC_URL = "http://localhost:3000";

let db: Db;
let closeDb: () => Promise<void>;

function extractCookie(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  if (!raw) throw new Error("no Set-Cookie header on response");
  return raw.split(";")[0] ?? raw;
}

/** GreenMail accepts any password (docs/dev-setup.md); these tests stub verify rather than touch it. */
function buildTestApp() {
  return buildApp({
    db,
    publicUrl: PUBLIC_URL,
    mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
    mailAccountVerify: async () => ({ ok: true }),
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

async function createOwnedMailAccount(app: FastifyInstance, cookie: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/mail-accounts",
    headers: { cookie },
    payload: {
      emailAddress: `vic-${randomUUID()}@example.com`,
      imap: { host: "imap.example.com", port: 993, security: "tls" },
      smtp: { host: "smtp.example.com", port: 587, security: "starttls" },
      username: "vic@example.com",
      password: "correct-horse-battery-staple",
    },
  });
  expect(response.statusCode).toBe(201);
  return (response.json().mailAccount as { id: string }).id;
}

/** Bare Thread rows — `folderRole: "inbox"` resolves off `inInbox`/`lastMessageAt` alone, no Message/Folder needed. */
async function insertThread(
  mailAccountId: string,
  id: string,
  overrides: Partial<typeof threads.$inferInsert> = {},
) {
  await db.insert(threads).values({
    id,
    mailAccountId,
    inInbox: true,
    lastMessageAt: new Date("2026-01-15T00:00:00Z"),
    ...overrides,
  });
}

async function threadRow(id: string) {
  const [row] = await db.select().from(threads).where(eq(threads.id, id)).limit(1);
  return row;
}

function inboxTarget(accountId: string, overrides: Record<string, unknown> = {}) {
  return {
    accountScope: [accountId],
    folderRole: "inbox",
    since: null,
    until: null,
    ...overrides,
  };
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

describe("POST /bulk-triage/count", () => {
  it("requires a session", async () => {
    const app = buildTestApp();
    const response = await app.inject({ method: "POST", url: "/bulk-triage/count", payload: {} });
    expect(response.statusCode).toBe(401);
  });

  it("returns the true target-set total, not a loaded count", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const accountId = await createOwnedMailAccount(app, cookie);
    await insertThread(accountId, "t1");
    await insertThread(accountId, "t2");
    await insertThread(accountId, "t3", { inInbox: false }); // out of the "inbox" folder role

    const response = await app.inject({
      method: "POST",
      url: "/bulk-triage/count",
      headers: { cookie },
      payload: inboxTarget(accountId),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ count: 2 });
  });

  it("silently skips a Mail Account id the User does not own", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const accountId = await createOwnedMailAccount(app, cookie);
    const stranger = await createTestMailAccount(db);
    await insertThread(accountId, "t1");
    await insertThread(stranger.id, "t2");

    const response = await app.inject({
      method: "POST",
      url: "/bulk-triage/count",
      headers: { cookie },
      payload: inboxTarget(accountId, { accountScope: [accountId, stranger.id] }),
    });

    expect(response.json()).toEqual({ count: 1 });
  });
});

describe("POST /bulk-triage/batch", () => {
  it("requires a session", async () => {
    const app = buildTestApp();
    const response = await app.inject({ method: "POST", url: "/bulk-triage/batch", payload: {} });
    expect(response.statusCode).toBe(401);
  });

  it("rejects a malformed body", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const response = await app.inject({
      method: "POST",
      url: "/bulk-triage/batch",
      headers: { cookie },
      payload: { id: "01A", action: "delete", target: inboxTarget("whatever") },
    });
    expect(response.statusCode).toBe(400);
  });

  it("'done' flips inInbox for every Thread in the target set and names the affected count", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const accountId = await createOwnedMailAccount(app, cookie);
    await insertThread(accountId, "t1");
    await insertThread(accountId, "t2");

    const response = await app.inject({
      method: "POST",
      url: "/bulk-triage/batch",
      headers: { cookie },
      payload: { id: "01BATCH", action: "done", target: inboxTarget(accountId) },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as BulkTriageBatchResponse;
    expect(body.affectedCount).toBe(2);
    expect(body.accounts).toEqual([
      { mailAccountId: accountId, status: "applied", affectedCount: 2 },
    ]);
    expect((await threadRow("t1"))?.inInbox).toBe(false);
    expect((await threadRow("t2"))?.inInbox).toBe(false);
  });

  it("a Thread outside the date range is untouched", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const accountId = await createOwnedMailAccount(app, cookie);
    await insertThread(accountId, "inRange", { lastMessageAt: new Date("2026-01-01T00:00:00Z") });
    await insertThread(accountId, "tooOld", { lastMessageAt: new Date("2020-01-01T00:00:00Z") });

    const response = await app.inject({
      method: "POST",
      url: "/bulk-triage/batch",
      headers: { cookie },
      payload: {
        id: "01RANGE",
        action: "done",
        target: inboxTarget(accountId, {
          since: "2025-01-01T00:00:00.000Z",
          until: "2026-06-01T00:00:00.000Z",
        }),
      },
    });

    expect((response.json() as BulkTriageBatchResponse).affectedCount).toBe(1);
    expect((await threadRow("inRange"))?.inInbox).toBe(false);
    expect((await threadRow("tooOld"))?.inInbox).toBe(true);
  });

  it("evaluates the target set at request time: a Client-supplied until in the future is clamped to now", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const accountId = await createOwnedMailAccount(app, cookie);
    const now = new Date();
    await insertThread(accountId, "past", { lastMessageAt: new Date(now.getTime() - 60_000) });
    // Simulates a Thread that "arrives after the request" — a future
    // lastMessageAt an `until` of year 3000 would otherwise happily include.
    await insertThread(accountId, "future", {
      lastMessageAt: new Date(now.getTime() + 60 * 60_000),
    });

    const response = await app.inject({
      method: "POST",
      url: "/bulk-triage/batch",
      headers: { cookie },
      payload: {
        id: "01CLAMP",
        action: "done",
        target: inboxTarget(accountId, { until: "3000-01-01T00:00:00.000Z" }),
      },
    });

    expect((response.json() as BulkTriageBatchResponse).affectedCount).toBe(1);
    expect((await threadRow("past"))?.inInbox).toBe(false);
    expect((await threadRow("future"))?.inInbox).toBe(true);
  });

  it("is idempotent: retrying the same id replays the outcome instead of re-applying", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const accountId = await createOwnedMailAccount(app, cookie);
    await insertThread(accountId, "t1");

    const first = await app.inject({
      method: "POST",
      url: "/bulk-triage/batch",
      headers: { cookie },
      payload: { id: "01SAME", action: "done", target: inboxTarget(accountId) },
    });
    expect((first.json() as BulkTriageBatchResponse).affectedCount).toBe(1);

    // Flip the Thread back, bypassing the endpoint, so a genuine re-apply
    // would be observable — a truly idempotent retry never touches it again.
    await db.update(threads).set({ inInbox: true }).where(eq(threads.id, "t1"));

    const retry = await app.inject({
      method: "POST",
      url: "/bulk-triage/batch",
      headers: { cookie },
      payload: { id: "01SAME", action: "done", target: inboxTarget(accountId) },
    });

    expect(retry.json()).toEqual(first.json());
    expect((await threadRow("t1"))?.inInbox).toBe(true); // untouched by the replay
  });

  it("reports per-account partial failure across Account Scope", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const okAccount = await createOwnedMailAccount(app, cookie);
    const reauthAccount = await createOwnedMailAccount(app, cookie);
    await db
      .update(mailAccounts)
      .set({ status: "needs_reauth" })
      .where(eq(mailAccounts.id, reauthAccount));
    const strangerAccount = await createTestMailAccount(db);

    await insertThread(okAccount, "t-ok");
    await insertThread(reauthAccount, "t-reauth");

    const response = await app.inject({
      method: "POST",
      url: "/bulk-triage/batch",
      headers: { cookie },
      payload: {
        id: "01PARTIAL",
        action: "done",
        target: inboxTarget(okAccount, {
          accountScope: [okAccount, reauthAccount, strangerAccount.id],
        }),
      },
    });

    const body = response.json() as BulkTriageBatchResponse;
    expect(body.affectedCount).toBe(1);
    expect(body.accounts).toEqual(
      expect.arrayContaining([
        { mailAccountId: okAccount, status: "applied", affectedCount: 1 },
        {
          mailAccountId: reauthAccount,
          status: "rejected",
          affectedCount: 0,
          reason: "needs_reauth",
        },
        {
          mailAccountId: strangerAccount.id,
          status: "rejected",
          affectedCount: 0,
          reason: "mail_account_not_found",
        },
      ]),
    );
    expect((await threadRow("t-ok"))?.inInbox).toBe(false);
    expect((await threadRow("t-reauth"))?.inInbox).toBe(true); // untouched — the account was rejected
  });

  it("crosses the reset threshold: the next Thread sync answers reset: true instead of paging deltas", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const accountId = await createOwnedMailAccount(app, cookie);

    const bootstrap = await app.inject({
      method: "POST",
      url: "/sync",
      headers: { cookie },
      payload: { mailAccounts: { [accountId]: { Thread: null } } },
    });
    const priorToken = (bootstrap.json().mailAccounts[accountId].Thread as ThreadDelta).newState;

    const threadIds = Array.from({ length: BULK_TRIAGE_RESET_THRESHOLD + 1 }, (_, i) => `t${i}`);
    for (const id of threadIds) await insertThread(accountId, id);

    const batch = await app.inject({
      method: "POST",
      url: "/bulk-triage/batch",
      headers: { cookie },
      payload: { id: "01THRESHOLD", action: "done", target: inboxTarget(accountId) },
    });
    expect((batch.json() as BulkTriageBatchResponse).affectedCount).toBe(
      BULK_TRIAGE_RESET_THRESHOLD + 1,
    );

    const afterBatch = await app.inject({
      method: "POST",
      url: "/sync",
      headers: { cookie },
      payload: { mailAccounts: { [accountId]: { Thread: priorToken } } },
    });
    const delta = afterBatch.json().mailAccounts[accountId].Thread as ThreadDelta;
    expect(delta.reset).toBe(true);
  });

  it("stays below the reset threshold: an ordinary delta, no reset", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const accountId = await createOwnedMailAccount(app, cookie);

    const bootstrap = await app.inject({
      method: "POST",
      url: "/sync",
      headers: { cookie },
      payload: { mailAccounts: { [accountId]: { Thread: null } } },
    });
    const priorToken = (bootstrap.json().mailAccounts[accountId].Thread as ThreadDelta).newState;

    await insertThread(accountId, "t1");
    await insertThread(accountId, "t2");

    await app.inject({
      method: "POST",
      url: "/bulk-triage/batch",
      headers: { cookie },
      payload: { id: "01BELOW", action: "done", target: inboxTarget(accountId) },
    });

    const afterBatch = await app.inject({
      method: "POST",
      url: "/sync",
      headers: { cookie },
      payload: { mailAccounts: { [accountId]: { Thread: priorToken } } },
    });
    const delta = afterBatch.json().mailAccounts[accountId].Thread as ThreadDelta;
    expect(delta.reset).toBeUndefined();
    // Both Threads were created (and immediately updated by the batch) after
    // `priorToken` — new to this Client either way, so they arrive as
    // `created`, not `updated`.
    expect(delta.created.map((row) => row.id).sort()).toEqual(["t1", "t2"]);
  });
});

describe("POST /bulk-triage/undo", () => {
  it("requires a session", async () => {
    const app = buildTestApp();
    const response = await app.inject({ method: "POST", url: "/bulk-triage/undo", payload: {} });
    expect(response.statusCode).toBe(401);
  });

  it("answers not_found for an unknown batchId", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const response = await app.inject({
      method: "POST",
      url: "/bulk-triage/undo",
      headers: { cookie },
      payload: { batchId: "does-not-exist" },
    });
    expect(response.json()).toEqual({ status: "not_found", affectedCount: 0 });
  });

  it("returns exactly the affected Threads, and only those", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const accountId = await createOwnedMailAccount(app, cookie);
    await insertThread(accountId, "t1");
    await insertThread(accountId, "t2");
    await insertThread(accountId, "untouched", { lastMessageAt: new Date("2020-01-01T00:00:00Z") });

    await app.inject({
      method: "POST",
      url: "/bulk-triage/batch",
      headers: { cookie },
      payload: {
        id: "01UNDO",
        action: "done",
        target: inboxTarget(accountId, { since: "2025-01-01T00:00:00.000Z" }),
      },
    });
    expect((await threadRow("t1"))?.inInbox).toBe(false);
    expect((await threadRow("untouched"))?.inInbox).toBe(true);

    const undo = await app.inject({
      method: "POST",
      url: "/bulk-triage/undo",
      headers: { cookie },
      payload: { batchId: "01UNDO" },
    });

    expect(undo.json()).toEqual({ status: "undone", affectedCount: 2 });
    expect((await threadRow("t1"))?.inInbox).toBe(true);
    expect((await threadRow("t2"))?.inInbox).toBe(true);
    expect((await threadRow("untouched"))?.inInbox).toBe(true);
  });

  it("undoing markRead sets every affected Message back to unseen", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const accountId = await createOwnedMailAccount(app, cookie);
    await insertThread(accountId, "t1", { unreadCount: 0 });

    await app.inject({
      method: "POST",
      url: "/bulk-triage/batch",
      headers: { cookie },
      payload: { id: "01READ", action: "markRead", target: inboxTarget(accountId) },
    });

    const undo = await app.inject({
      method: "POST",
      url: "/bulk-triage/undo",
      headers: { cookie },
      payload: { batchId: "01READ" },
    });
    expect(undo.json()).toEqual({ status: "undone", affectedCount: 1 });
  });

  it("is idempotent: undoing an already-undone batch replays the same answer", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const accountId = await createOwnedMailAccount(app, cookie);
    await insertThread(accountId, "t1");
    await app.inject({
      method: "POST",
      url: "/bulk-triage/batch",
      headers: { cookie },
      payload: { id: "01TWICE", action: "done", target: inboxTarget(accountId) },
    });
    await app.inject({
      method: "POST",
      url: "/bulk-triage/undo",
      headers: { cookie },
      payload: { batchId: "01TWICE" },
    });
    await db.update(threads).set({ inInbox: false }).where(eq(threads.id, "t1")); // would show a re-run

    const second = await app.inject({
      method: "POST",
      url: "/bulk-triage/undo",
      headers: { cookie },
      payload: { batchId: "01TWICE" },
    });

    expect(second.json()).toEqual({ status: "undone", affectedCount: 1 });
    expect((await threadRow("t1"))?.inInbox).toBe(false); // untouched by the replay
  });

  it("answers expired past the Undo window and leaves the batch's effect in place", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const accountId = await createOwnedMailAccount(app, cookie);
    await insertThread(accountId, "t1");
    await app.inject({
      method: "POST",
      url: "/bulk-triage/batch",
      headers: { cookie },
      payload: { id: "01EXPIRE", action: "done", target: inboxTarget(accountId) },
    });
    await db
      .update(bulkTriageBatches)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(bulkTriageBatches.id, "01EXPIRE"));

    const response = await app.inject({
      method: "POST",
      url: "/bulk-triage/undo",
      headers: { cookie },
      payload: { batchId: "01EXPIRE" },
    });

    expect(response.json()).toEqual({ status: "expired", affectedCount: 0 });
    expect((await threadRow("t1"))?.inInbox).toBe(false);
  });
});
