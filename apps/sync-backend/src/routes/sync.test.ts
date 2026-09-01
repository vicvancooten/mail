import { randomUUID } from "node:crypto";
import type { LabelDelta, MailAccountDelta, MutationOutcome, ThreadDelta } from "@mail/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { ensureClaimToken } from "../auth/claim.js";
import type { Db } from "../db/client.js";
import { appliedMutations, folders, mailAccounts, messages, threads } from "../db/schema.js";
import { deleteEmptyThreads } from "../sync/threading.js";
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

/** Creates a Mail Account owned by the signed-in user, through the real route so it has every trigger-stamped column. */
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

async function insertThread(
  mailAccountId: string,
  id: string,
  overrides: Partial<typeof threads.$inferInsert> = {},
) {
  await db.insert(threads).values({ id, mailAccountId, ...overrides });
}

/** A Thread with one real Message, so a mutation's rollup effect is observable end-to-end. */
async function insertThreadWithMessage(mailAccountId: string, threadId: string): Promise<void> {
  await insertThread(mailAccountId, threadId);
  const folderId = randomUUID();
  await db.insert(folders).values({
    id: folderId,
    mailAccountId,
    path: "INBOX",
    name: "INBOX",
    role: "inbox",
  });
  await db.insert(messages).values({
    id: randomUUID(),
    mailAccountId,
    threadId,
    folderId,
    uid: 1,
    subject: "Test",
    sentAt: new Date("2026-01-01T00:00:00Z"),
    receivedAt: new Date("2026-01-01T00:00:00Z"),
    seen: false,
    flagged: false,
  });
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

describe("POST /sync", () => {
  it("requires a session", async () => {
    const app = buildTestApp();
    const response = await app.inject({ method: "POST", url: "/sync", payload: {} });
    expect(response.statusCode).toBe(401);
  });

  it("rejects a malformed body", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const response = await app.inject({
      method: "POST",
      url: "/sync",
      headers: { cookie },
      payload: { mailAccounts: "not-a-record" },
    });
    expect(response.statusCode).toBe(400);
  });

  describe("MailAccount (User-scoped)", () => {
    it("bootstraps with everything the User owns, then reports nothing on an unchanged token", async () => {
      const app = buildTestApp();
      const cookie = await claimOwner(app);
      const accountId = await createOwnedMailAccount(app, cookie);

      const first = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: { user: { MailAccount: null } },
      });
      expect(first.statusCode).toBe(200);
      const firstBody = first.json();
      const delta = firstBody.user.MailAccount as MailAccountDelta;
      expect(delta.created.map((row) => row.id)).toEqual([accountId]);
      expect(delta.updated).toEqual([]);
      expect(delta.destroyed).toEqual([]);
      expect(delta.hasMore).toBe(false);
      expect(delta.reset).toBeUndefined();

      // Token round-trip: nothing changed since `newState`, so the
      // collection is entirely absent from the response.
      const second = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: { user: { MailAccount: delta.newState } },
      });
      expect(second.statusCode).toBe(200);
      expect(second.json().user).toEqual({});
    });

    it("answers reset: true for a token the server no longer knows", async () => {
      const app = buildTestApp();
      const cookie = await claimOwner(app);
      const accountId = await createOwnedMailAccount(app, cookie);

      const response = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: { user: { MailAccount: "this-is-not-a-real-token" } },
      });
      expect(response.statusCode).toBe(200);
      const delta = response.json().user.MailAccount as MailAccountDelta;
      expect(delta.reset).toBe(true);
      expect(delta.created.map((row) => row.id)).toEqual([accountId]);
    });

    it("omits a Mail Account it does not own from the request entirely", async () => {
      const app = buildTestApp();
      const cookie = await claimOwner(app);
      await createOwnedMailAccount(app, cookie);
      const someoneElses = await createTestMailAccount(db);

      const response = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: { mailAccounts: { [someoneElses.id]: { Thread: null } } },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().mailAccounts).toEqual({});
    });
  });

  describe("Thread (per Mail Account)", () => {
    it("bootstraps, then reports created/updated/destroyed across a token round-trip", async () => {
      const app = buildTestApp();
      const cookie = await claimOwner(app);
      const accountId = await createOwnedMailAccount(app, cookie);
      await insertThread(accountId, "thread-1", { subject: "Hello" });

      const bootstrap = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: { mailAccounts: { [accountId]: { Thread: null } } },
      });
      expect(bootstrap.statusCode).toBe(200);
      const bootstrapDelta = bootstrap.json().mailAccounts[accountId].Thread as ThreadDelta;
      expect(bootstrapDelta.created.map((row) => row.id)).toEqual(["thread-1"]);
      expect(bootstrapDelta.updated).toEqual([]);

      // Unchanged: the collection is absent, not an empty-but-present result.
      const unchanged = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: { mailAccounts: { [accountId]: { Thread: bootstrapDelta.newState } } },
      });
      expect(unchanged.json().mailAccounts).toEqual({});

      // A second Thread appears as `created`, the first's subject change as `updated`.
      await insertThread(accountId, "thread-2", { subject: "New" });
      await db.update(threads).set({ subject: "Hello (edited)" }).where(eq(threads.id, "thread-1"));

      const afterChange = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: { mailAccounts: { [accountId]: { Thread: bootstrapDelta.newState } } },
      });
      const changeDelta = afterChange.json().mailAccounts[accountId].Thread as ThreadDelta;
      expect(changeDelta.created.map((row) => row.id)).toEqual(["thread-2"]);
      expect(changeDelta.updated.map((row) => row.id)).toEqual(["thread-1"]);
      expect(changeDelta.updated[0]?.subject).toBe("Hello (edited)");

      // Deleting the empty Thread tombstones it — the next sync reports it destroyed.
      await deleteEmptyThreads(db, accountId);
      const afterDestroy = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: { mailAccounts: { [accountId]: { Thread: changeDelta.newState } } },
      });
      const destroyDelta = afterDestroy.json().mailAccounts[accountId].Thread as ThreadDelta;
      expect(destroyDelta.destroyed.sort()).toEqual(["thread-1", "thread-2"]);
      expect(destroyDelta.created).toEqual([]);
      expect(destroyDelta.updated).toEqual([]);
    });

    it("resets when the account's Threads were rebuilt (UIDVALIDITY change) since the token", async () => {
      const app = buildTestApp();
      const cookie = await claimOwner(app);
      const accountId = await createOwnedMailAccount(app, cookie);
      await insertThread(accountId, "thread-1");

      const bootstrap = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: { mailAccounts: { [accountId]: { Thread: null } } },
      });
      const bootstrapDelta = bootstrap.json().mailAccounts[accountId].Thread as ThreadDelta;

      // Simulate `applyUidValidity`'s rebuild bump without a real IMAP folder.
      await db.update(mailAccounts).set({ threadsEpoch: 2 }).where(eq(mailAccounts.id, accountId));
      await insertThread(accountId, "thread-2");

      const afterRebuild = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: { mailAccounts: { [accountId]: { Thread: bootstrapDelta.newState } } },
      });
      const delta = afterRebuild.json().mailAccounts[accountId].Thread as ThreadDelta;
      expect(delta.reset).toBe(true);
      expect(delta.created.map((row) => row.id).sort()).toEqual(["thread-1", "thread-2"]);
      expect(delta.destroyed).toEqual([]);
    });
  });

  describe("Label (per Mail Account, #43)", () => {
    it("bootstraps, then reports a newly created Label across a token round-trip", async () => {
      const app = buildTestApp();
      const cookie = await claimOwner(app);
      const accountId = await createOwnedMailAccount(app, cookie);
      await insertThreadWithMessage(accountId, "thread-1");

      const bootstrap = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: { mailAccounts: { [accountId]: { Label: null } } },
      });
      expect(bootstrap.statusCode).toBe(200);
      expect(bootstrap.json().mailAccounts).toEqual({});

      const applied = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: {
          mailAccounts: {
            [accountId]: {
              Label: null,
              mutations: [
                {
                  id: "01LABEL",
                  intent: { type: "applyLabel", threadId: "thread-1", name: "Work" },
                },
              ],
            },
          },
        },
      });
      const body = applied.json().mailAccounts[accountId];
      expect(body.mutations).toEqual([{ id: "01LABEL", status: "applied" }]);
      const delta = body.Label as LabelDelta;
      expect(delta.created).toHaveLength(1);
      expect(delta.created[0]).toMatchObject({ mailAccountId: accountId, name: "Work" });

      const unchanged = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: { mailAccounts: { [accountId]: { Label: delta.newState } } },
      });
      expect(unchanged.json().mailAccounts).toEqual({});
    });

    it("is not requested unless asked — an ordinary Thread sync never carries a Label delta", async () => {
      const app = buildTestApp();
      const cookie = await claimOwner(app);
      const accountId = await createOwnedMailAccount(app, cookie);
      await insertThreadWithMessage(accountId, "thread-1");

      await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: {
          mailAccounts: {
            [accountId]: {
              mutations: [
                {
                  id: "01LABEL",
                  intent: { type: "applyLabel", threadId: "thread-1", name: "Work" },
                },
              ],
            },
          },
        },
      });

      const response = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: { mailAccounts: { [accountId]: { Thread: null } } },
      });
      const threadDelta = response.json().mailAccounts[accountId].Thread as ThreadDelta;
      // The Thread's own `labelIds` field already carries the applied Label
      // (it is denormalized onto the Thread row, not a join) — what this
      // asserts is that requesting only `Thread` never triggers a `Label`
      // collection query or response entry alongside it.
      expect(threadDelta.created[0]?.labelIds).toHaveLength(1);
      expect(response.json().mailAccounts[accountId].Label).toBeUndefined();
    });
  });

  describe("mutations (#39)", () => {
    it("applies queued mutations and the same response's Thread delta already reflects them", async () => {
      const app = buildTestApp();
      const cookie = await claimOwner(app);
      const accountId = await createOwnedMailAccount(app, cookie);
      await insertThreadWithMessage(accountId, "thread-1");

      const response = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: {
          mailAccounts: {
            [accountId]: {
              Thread: null,
              mutations: [
                {
                  id: "01STAR",
                  intent: { type: "setStarred", threadId: "thread-1", starred: true },
                },
              ],
            },
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json().mailAccounts[accountId];
      expect(body.mutations).toEqual([{ id: "01STAR", status: "applied" }]);
      const threadDelta = body.Thread as ThreadDelta;
      expect(threadDelta.created[0]?.starred).toBe(true);
    });

    it("is exactly-once: replaying the same id is reported applied without re-applying", async () => {
      const app = buildTestApp();
      const cookie = await claimOwner(app);
      const accountId = await createOwnedMailAccount(app, cookie);
      await insertThreadWithMessage(accountId, "thread-1");

      const flush = () =>
        app.inject({
          method: "POST",
          url: "/sync",
          headers: { cookie },
          payload: {
            mailAccounts: {
              [accountId]: {
                mutations: [
                  {
                    id: "01RETRY",
                    intent: { type: "setStarred", threadId: "thread-1", starred: true },
                  },
                ],
              },
            },
          },
        });

      const first = await flush();
      expect(first.json().mailAccounts[accountId].mutations).toEqual([
        { id: "01RETRY", status: "applied" },
      ]);

      // Directly unstar the underlying message, bypassing the mutation
      // pipeline — a re-applying (rather than idempotently replaying) retry
      // would flip it back to starred via the rollup it triggers.
      await db.update(messages).set({ flagged: false }).where(eq(messages.threadId, "thread-1"));

      const retry = await flush();
      expect(retry.json().mailAccounts[accountId].mutations).toEqual([
        { id: "01RETRY", status: "applied" },
      ]);
      const ledgerRows = await db
        .select()
        .from(appliedMutations)
        .where(eq(appliedMutations.id, "01RETRY"));
      expect(ledgerRows).toHaveLength(1);

      const [threadRow] = await db.select().from(threads).where(eq(threads.id, "thread-1"));
      // Unchanged since the first apply — proof the retry never re-touched
      // the message or re-ran the rollup.
      expect(threadRow?.starred).toBe(true);
    });

    it("rejects a mutation naming a Thread this account does not have, and processes the rest of the queue anyway", async () => {
      const app = buildTestApp();
      const cookie = await claimOwner(app);
      const accountId = await createOwnedMailAccount(app, cookie);
      await insertThreadWithMessage(accountId, "thread-1");

      const response = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: {
          mailAccounts: {
            [accountId]: {
              mutations: [
                {
                  id: "01GHOST",
                  intent: { type: "setStarred", threadId: "no-such-thread", starred: true },
                },
                { id: "01OK", intent: { type: "setStarred", threadId: "thread-1", starred: true } },
              ],
            },
          },
        },
      });

      const outcomes = response.json().mailAccounts[accountId].mutations as MutationOutcome[];
      expect(outcomes).toEqual([
        { id: "01GHOST", status: "rejected", reason: "thread_not_found" },
        { id: "01OK", status: "applied" },
      ]);
    });

    it("rejects every queued mutation for a Mail Account the User does not own, rather than holding them", async () => {
      const app = buildTestApp();
      const cookie = await claimOwner(app);
      await createOwnedMailAccount(app, cookie);
      const someoneElses = await createTestMailAccount(db);

      const response = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: {
          mailAccounts: {
            [someoneElses.id]: {
              mutations: [
                {
                  id: "01FOREIGN",
                  intent: { type: "setStarred", threadId: "thread-1", starred: true },
                },
              ],
            },
          },
        },
      });

      expect(response.json().mailAccounts[someoneElses.id].mutations).toEqual([
        { id: "01FOREIGN", status: "rejected", reason: "mail_account_not_found" },
      ]);
    });
  });
});
