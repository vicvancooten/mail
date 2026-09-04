import { randomUUID } from "node:crypto";
import type {
  ComposeSaveOutcome,
  CompositionDelta,
  GmailLabelDelta,
  LabelDelta,
  MailAccountDelta,
  MutationOutcome,
  ThreadDelta,
} from "@mail/shared";
import { EMPTY_COMPOSE_DOCUMENT } from "@mail/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { ensureClaimToken } from "../auth/claim.js";
import type { Db } from "../db/client.js";
import {
  appliedMutations,
  composeSaveLedger,
  compositions,
  folders,
  mailAccounts,
  messages,
  threads,
} from "../db/schema.js";
import { persistGmailLabels } from "../sync/gmail-labels.js";
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
    mailAccountVerify: async () => ({ ok: true, serverKind: "generic" }),
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
      // The delta endpoint exposes `authKind`, never the credential (#119).
      expect(delta.created[0]).toMatchObject({ authKind: { kind: "password" } });
      expect(delta.updated).toEqual([]);
      expect(delta.destroyed).toEqual([]);
      expect(delta.hasMore).toBe(false);
      expect(delta.reset).toBeUndefined();

      // Token round-trip: nothing changed since `newState`, so the
      // collection is entirely absent from the response — `unreadInboxCount`
      // (#53) is the one field that's never gated on "something changed".
      const second = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: { user: { MailAccount: delta.newState } },
      });
      expect(second.statusCode).toBe(200);
      expect(second.json().user).toEqual({ unreadInboxCount: 0 });
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
      // A bootstrap (#41) still carries a delta even with zero Labels: the
      // Client needs a `newState` to persist for this collection, or it can
      // never tell "bootstrapped, got nothing" from "haven't asked yet".
      expect(bootstrap.json().mailAccounts[accountId].Label).toMatchObject({
        created: [],
        updated: [],
        destroyed: [],
        hasMore: false,
      });

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

  describe("GmailLabel (per Mail Account, #126, ADR-0020)", () => {
    it("carries a Gmail Mail Account's own Labels and none of the system labels", async () => {
      const app = buildTestApp();
      const cookie = await claimOwner(app);
      const accountId = await createOwnedMailAccount(app, cookie);
      // Server kind is fixed to "generic" by `buildTestApp`'s stubbed verify
      // (no live Gmail server here) — flip it directly, the same seam
      // `mail-accounts/store.ts#updateMailAccountServerKind` uses in
      // production once a real reconnect re-detects it.
      await db
        .update(mailAccounts)
        .set({ serverKind: "gmail" })
        .where(eq(mailAccounts.id, accountId));
      await persistGmailLabels(db, accountId, "gmail", [
        { role: null, name: "Kids", path: "Family/Kids", selectable: true },
        { role: "inbox", name: "Inbox", path: "INBOX", selectable: true },
        { role: "all", name: "All Mail", path: "[Gmail]/All Mail", selectable: true },
        { role: null, name: "Important", path: "[Gmail]/Important", selectable: true },
      ]);

      const response = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: { mailAccounts: { [accountId]: { GmailLabel: null } } },
      });
      expect(response.statusCode).toBe(200);
      const delta = response.json().mailAccounts[accountId].GmailLabel as GmailLabelDelta;
      expect(delta.created).toHaveLength(1);
      expect(delta.created[0]).toMatchObject({
        mailAccountId: accountId,
        name: "Kids",
        path: "Family/Kids",
      });
      expect(delta.destroyed).toEqual([]);

      const unchanged = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: { mailAccounts: { [accountId]: { GmailLabel: delta.newState } } },
      });
      expect(unchanged.json().mailAccounts).toEqual({});
    });

    it("carries an empty collection for a generic Mail Account", async () => {
      const app = buildTestApp();
      const cookie = await claimOwner(app);
      const accountId = await createOwnedMailAccount(app, cookie);

      const response = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: { mailAccounts: { [accountId]: { GmailLabel: null } } },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().mailAccounts[accountId].GmailLabel).toMatchObject({
        created: [],
        updated: [],
        destroyed: [],
        hasMore: false,
      });
    });

    it("reflects a rename or deletion observed on the next sync as a destroy plus a create", async () => {
      const app = buildTestApp();
      const cookie = await claimOwner(app);
      const accountId = await createOwnedMailAccount(app, cookie);
      await db
        .update(mailAccounts)
        .set({ serverKind: "gmail" })
        .where(eq(mailAccounts.id, accountId));
      await persistGmailLabels(db, accountId, "gmail", [
        { role: null, name: "Kids", path: "Family/Kids", selectable: true },
      ]);

      const bootstrap = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: { mailAccounts: { [accountId]: { GmailLabel: null } } },
      });
      const bootstrapDelta = bootstrap.json().mailAccounts[accountId].GmailLabel as GmailLabelDelta;

      // Gmail renamed "Family/Kids" to "Family/Toddlers" — observed the next
      // time `persistGmailLabels` runs (`live-session.ts`/`sync-account.ts`),
      // not by anything this route does.
      await persistGmailLabels(db, accountId, "gmail", [
        { role: null, name: "Toddlers", path: "Family/Toddlers", selectable: true },
      ]);

      const after = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: { mailAccounts: { [accountId]: { GmailLabel: bootstrapDelta.newState } } },
      });
      const delta = after.json().mailAccounts[accountId].GmailLabel as GmailLabelDelta;
      expect(delta.created).toHaveLength(1);
      expect(delta.created[0]).toMatchObject({ name: "Toddlers", path: "Family/Toddlers" });
      expect(delta.destroyed).toEqual(bootstrapDelta.created.map((row) => row.id));
    });
  });

  describe("Preference (User-scoped, #54)", () => {
    it("bootstraps with sensible defaults, then reports an edit across a token round-trip", async () => {
      const app = buildTestApp();
      const cookie = await claimOwner(app);

      const bootstrap = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: { user: { Preference: null } },
      });
      expect(bootstrap.statusCode).toBe(200);
      const bootstrapped = bootstrap.json().user.Preference;
      expect(bootstrapped.created).toHaveLength(1);
      expect(bootstrapped.created[0]).toMatchObject({
        autoAdvanceEnabled: true,
        autoAdvanceDirection: "older",
        undoSendDelaySeconds: 10,
      });

      const edited = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: {
          user: {
            Preference: bootstrapped.newState,
            mutations: [
              {
                id: "01ADVANCE",
                intent: { type: "setAutoAdvance", enabled: false, direction: "newer" },
              },
              {
                id: "01DELAY",
                intent: { type: "setUndoSendDelay", undoSendDelaySeconds: 30 },
              },
            ],
          },
        },
      });
      const editedBody = edited.json().user;
      expect(editedBody.mutations).toEqual([
        { id: "01ADVANCE", status: "applied" },
        { id: "01DELAY", status: "applied" },
      ]);
      expect(editedBody.Preference.updated[0]).toMatchObject({
        autoAdvanceEnabled: false,
        autoAdvanceDirection: "newer",
        undoSendDelaySeconds: 30,
      });

      // A retried id (a dropped response over a flaky connection) replays the
      // recorded outcome rather than re-applying — the same idempotency
      // ledger every other mutation queue rides (ADR-0010).
      const retried = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: {
          user: {
            mutations: [
              {
                id: "01ADVANCE",
                intent: { type: "setAutoAdvance", enabled: false, direction: "newer" },
              },
            ],
          },
        },
      });
      expect(retried.json().user.mutations).toEqual([{ id: "01ADVANCE", status: "applied" }]);
    });

    it("is not requested unless asked", async () => {
      const app = buildTestApp();
      const cookie = await claimOwner(app);

      const response = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: { user: { MailAccount: null } },
      });
      expect(response.json().user.Preference).toBeUndefined();
    });
  });

  describe("Mail-Account-scoped Preferences: setSignature / setNotificationsEnabled (#54)", () => {
    it("sets and clears the signature through the ordinary mutation queue", async () => {
      const app = buildTestApp();
      const cookie = await claimOwner(app);
      const accountId = await createOwnedMailAccount(app, cookie);

      const set = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: {
          mailAccounts: {
            [accountId]: {
              mutations: [
                {
                  id: "01SIG",
                  intent: { type: "setSignature", signature: "Ada Lovelace" },
                },
              ],
            },
          },
        },
      });
      expect(set.json().mailAccounts[accountId].mutations).toEqual([
        { id: "01SIG", status: "applied" },
      ]);

      const confirm = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: { user: { MailAccount: null } },
      });
      expect(confirm.json().user.MailAccount.created[0]).toMatchObject({
        id: accountId,
        signature: "Ada Lovelace",
      });
    });

    it("toggles the notification preference", async () => {
      const app = buildTestApp();
      const cookie = await claimOwner(app);
      const accountId = await createOwnedMailAccount(app, cookie);

      const bootstrap = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: { user: { MailAccount: null } },
      });
      expect(bootstrap.json().user.MailAccount.created[0]).toMatchObject({
        notificationsEnabled: true,
      });

      await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: {
          mailAccounts: {
            [accountId]: {
              mutations: [
                {
                  id: "01NOTIF",
                  intent: { type: "setNotificationsEnabled", enabled: false },
                },
              ],
            },
          },
        },
      });

      const after = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: { user: { MailAccount: bootstrap.json().user.MailAccount.newState } },
      });
      expect(after.json().user.MailAccount.updated[0]).toMatchObject({
        notificationsEnabled: false,
      });
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

  describe("composeSaves (#45, ADR-0014)", () => {
    it("creates the Composition lazily on the first save for an unseen id", async () => {
      const app = buildTestApp();
      const cookie = await claimOwner(app);
      const accountId = await createOwnedMailAccount(app, cookie);

      const response = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: {
          mailAccounts: {
            [accountId]: {
              composeSaves: [
                {
                  id: "comp-1",
                  saveId: "01SAVE-A",
                  version: 0,
                  subject: "Hello",
                  document: EMPTY_COMPOSE_DOCUMENT,
                  to: [],
                  cc: [],
                  bcc: [],
                },
              ],
            },
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const outcomes = response.json().mailAccounts[accountId].composeSaves as ComposeSaveOutcome[];
      expect(outcomes).toEqual([
        { id: "comp-1", saveId: "01SAVE-A", status: "applied", version: 1 },
      ]);

      const [row] = await db.select().from(compositions).where(eq(compositions.id, "comp-1"));
      expect(row?.subject).toBe("Hello");
      expect(row?.status).toBe("draft");
      expect(row?.version).toBe(1);
    });

    it("bumps the version on a matching save, and rejects a stale one as a conflict", async () => {
      const app = buildTestApp();
      const cookie = await claimOwner(app);
      const accountId = await createOwnedMailAccount(app, cookie);

      const save = (saveId: string, version: number, subject: string) => ({
        method: "POST" as const,
        url: "/sync",
        headers: { cookie },
        payload: {
          mailAccounts: {
            [accountId]: {
              composeSaves: [
                {
                  id: "comp-1",
                  saveId,
                  version,
                  subject,
                  document: EMPTY_COMPOSE_DOCUMENT,
                  to: [],
                  cc: [],
                  bcc: [],
                },
              ],
            },
          },
        },
      });

      await app.inject(save("01A", 0, "v1")); // creates at version 1
      const second = await app.inject(save("01B", 1, "v2"));
      expect(second.json().mailAccounts[accountId].composeSaves).toEqual([
        { id: "comp-1", saveId: "01B", status: "applied", version: 2 },
      ]);

      // A stale save — still claiming version 1, but the row is now at 2 — is
      // a conflict, never a silent overwrite (ADR-0012).
      const stale = await app.inject(save("01C", 1, "a lost edit"));
      expect(stale.json().mailAccounts[accountId].composeSaves).toEqual([
        { id: "comp-1", saveId: "01C", status: "conflict", version: 2 },
      ]);
      const [row] = await db.select().from(compositions).where(eq(compositions.id, "comp-1"));
      expect(row?.subject).toBe("v2"); // untouched by the rejected save
    });

    it("is exactly-once: replaying the same saveId returns the recorded outcome without re-applying", async () => {
      const app = buildTestApp();
      const cookie = await claimOwner(app);
      const accountId = await createOwnedMailAccount(app, cookie);

      const flush = () =>
        app.inject({
          method: "POST",
          url: "/sync",
          headers: { cookie },
          payload: {
            mailAccounts: {
              [accountId]: {
                composeSaves: [
                  {
                    id: "comp-1",
                    saveId: "01RETRY",
                    version: 0,
                    subject: "original",
                    document: EMPTY_COMPOSE_DOCUMENT,
                    to: [],
                    cc: [],
                    bcc: [],
                  },
                ],
              },
            },
          },
        });

      const first = await flush();
      expect(first.json().mailAccounts[accountId].composeSaves).toEqual([
        { id: "comp-1", saveId: "01RETRY", status: "applied", version: 1 },
      ]);

      // Directly change the subject, bypassing the save pipeline — a retry
      // that re-applied (rather than idempotently replaying the ledger)
      // would stomp it back to "original".
      await db
        .update(compositions)
        .set({ subject: "changed elsewhere" })
        .where(eq(compositions.id, "comp-1"));

      const retry = await flush();
      expect(retry.json().mailAccounts[accountId].composeSaves).toEqual([
        { id: "comp-1", saveId: "01RETRY", status: "applied", version: 1 },
      ]);
      expect(
        await db.select().from(composeSaveLedger).where(eq(composeSaveLedger.id, "01RETRY")),
      ).toHaveLength(1);

      const [row] = await db.select().from(compositions).where(eq(compositions.id, "comp-1"));
      expect(row?.subject).toBe("changed elsewhere"); // the replay never touched it
    });

    it("rejects every queued composeSave for a Mail Account the User does not own, rather than holding it", async () => {
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
              composeSaves: [
                {
                  id: "comp-1",
                  saveId: "01FOREIGN",
                  version: 0,
                  subject: "nope",
                  document: EMPTY_COMPOSE_DOCUMENT,
                  to: [],
                  cc: [],
                  bcc: [],
                },
              ],
            },
          },
        },
      });

      expect(response.json().mailAccounts[someoneElses.id].composeSaves).toEqual([
        {
          id: "comp-1",
          saveId: "01FOREIGN",
          status: "rejected",
          version: 0,
          reason: "mail_account_not_found",
        },
      ]);
    });
  });
  describe("Composition + the send path (#46, ADR-0007)", () => {
    /** One `POST /sync` that saves a sendable Composition and asks for the collection back. */
    async function saveSendableDraft(
      app: FastifyInstance,
      cookie: string,
      accountId: string,
      id = "comp-1",
    ) {
      return app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: {
          mailAccounts: {
            [accountId]: {
              Composition: null,
              composeSaves: [
                {
                  id,
                  saveId: `save-${id}`,
                  version: 0,
                  subject: "Lunch",
                  document: EMPTY_COMPOSE_DOCUMENT,
                  to: [{ name: null, address: "ada@example.test" }],
                  cc: [],
                  bcc: [],
                },
              ],
            },
          },
        },
      });
    }

    it("serves the Composition collection, so a Draft and its send state reach every device", async () => {
      const app = buildTestApp();
      const cookie = await claimOwner(app);
      const accountId = await createOwnedMailAccount(app, cookie);

      const saved = await saveSendableDraft(app, cookie, accountId);
      const delta = saved.json().mailAccounts[accountId].Composition as CompositionDelta;
      expect(delta.created).toHaveLength(1);
      expect(delta.created[0]).toMatchObject({
        id: "comp-1",
        status: "draft",
        subject: "Lunch",
        submitAfter: null,
        sendError: null,
      });

      const unchanged = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: { mailAccounts: { [accountId]: { Composition: delta.newState } } },
      });
      expect(unchanged.json().mailAccounts).toEqual({});
    });

    it("reports a send as an update against the token the Client already held", async () => {
      const app = buildTestApp();
      const cookie = await claimOwner(app);
      const accountId = await createOwnedMailAccount(app, cookie);

      const saved = await saveSendableDraft(app, cookie, accountId);
      const bootstrapped = saved.json().mailAccounts[accountId].Composition as CompositionDelta;

      const response = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: {
          mailAccounts: {
            [accountId]: {
              Composition: bootstrapped.newState,
              mutations: [
                { id: "01SEND", intent: { type: "sendComposition", compositionId: "comp-1" } },
              ],
            },
          },
        },
      });

      // Resuming from a real token, not a bootstrap: this only works because
      // the row's `sync_rev` advanced when the send transition wrote it, which
      // is the `compositions_bump_sync_rev` trigger doing its job.
      const delta = response.json().mailAccounts[accountId].Composition as CompositionDelta;
      expect(delta.created).toEqual([]);
      expect(delta.updated).toHaveLength(1);
      expect(delta.updated[0]).toMatchObject({ id: "comp-1", status: "pending" });
      expect(delta.newState).not.toBe(bootstrapped.newState);
    });

    it("accepts a send and reports the countdown's absolute deadline in the same round trip", async () => {
      const app = buildTestApp();
      const cookie = await claimOwner(app);
      const accountId = await createOwnedMailAccount(app, cookie);
      await saveSendableDraft(app, cookie, accountId);

      const response = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: {
          mailAccounts: {
            [accountId]: {
              Composition: null,
              mutations: [
                { id: "01SEND", intent: { type: "sendComposition", compositionId: "comp-1" } },
              ],
            },
          },
        },
      });

      const body = response.json().mailAccounts[accountId];
      expect(body.mutations).toEqual([{ id: "01SEND", status: "applied" }]);
      // ADR-0014: "the countdown starts only when the Sync Backend accepts
      // it" — and this is the round trip that hands the Client the deadline.
      const composition = (body.Composition as CompositionDelta).created[0];
      expect(composition?.status).toBe("pending");
      expect(composition?.submitAfter).not.toBeNull();
      // Default delay, 10s (poc-spec.md §Preferences), from the server's clock.
      const [row] = await db.select().from(compositions).where(eq(compositions.id, "comp-1"));
      const window = (row?.submitAfter?.getTime() ?? 0) - (row?.updatedAt.getTime() ?? 0);
      expect(window).toBe(10_000);
    });

    it("sends the content of the autosave that rode the same round trip, not the previous one", async () => {
      const app = buildTestApp();
      const cookie = await claimOwner(app);
      const accountId = await createOwnedMailAccount(app, cookie);
      await saveSendableDraft(app, cookie, accountId);

      // What a Send press actually looks like: the composer's final,
      // un-debounced autosave and the send intent in one request.
      await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: {
          mailAccounts: {
            [accountId]: {
              composeSaves: [
                {
                  id: "comp-1",
                  saveId: "save-final",
                  version: 1,
                  subject: "Lunch at one",
                  document: EMPTY_COMPOSE_DOCUMENT,
                  to: [{ name: null, address: "ada@example.test" }],
                  cc: [],
                  bcc: [],
                },
              ],
              mutations: [
                { id: "01SEND", intent: { type: "sendComposition", compositionId: "comp-1" } },
              ],
            },
          },
        },
      });

      const [row] = await db.select().from(compositions).where(eq(compositions.id, "comp-1"));
      expect(row?.status).toBe("pending");
      expect(row?.subject).toBe("Lunch at one");
    });

    it("honours the User's own Undo Send delay, including `off` as a zero-length window", async () => {
      const app = buildTestApp();
      const cookie = await claimOwner(app);
      const accountId = await createOwnedMailAccount(app, cookie);
      await saveSendableDraft(app, cookie, accountId);

      const patched = await app.inject({
        method: "PATCH",
        url: "/send-settings",
        headers: { cookie },
        payload: { undoSendDelaySeconds: 0 },
      });
      expect(patched.statusCode).toBe(200);

      await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: {
          mailAccounts: {
            [accountId]: {
              mutations: [
                { id: "01SEND", intent: { type: "sendComposition", compositionId: "comp-1" } },
              ],
            },
          },
        },
      });

      // `off` is N = 0: a real Pending Send row that is simply already due.
      const [row] = await db.select().from(compositions).where(eq(compositions.id, "comp-1"));
      expect(row?.status).toBe("pending");
      expect(row?.submitAfter?.getTime()).toBe(row?.updatedAt.getTime());
    });

    it("cancels a Pending Send back to a Draft, content intact", async () => {
      const app = buildTestApp();
      const cookie = await claimOwner(app);
      const accountId = await createOwnedMailAccount(app, cookie);
      await saveSendableDraft(app, cookie, accountId);

      const flush = (id: string, intent: unknown) =>
        app.inject({
          method: "POST",
          url: "/sync",
          headers: { cookie },
          payload: {
            mailAccounts: { [accountId]: { Composition: null, mutations: [{ id, intent }] } },
          },
        });

      await flush("01SEND", { type: "sendComposition", compositionId: "comp-1" });
      const cancelled = await flush("01CANCEL", {
        type: "cancelSend",
        compositionId: "comp-1",
      });

      expect(cancelled.json().mailAccounts[accountId].mutations).toEqual([
        { id: "01CANCEL", status: "applied" },
      ]);
      const composition = (cancelled.json().mailAccounts[accountId].Composition as CompositionDelta)
        .created[0];
      expect(composition).toMatchObject({ status: "draft", subject: "Lunch", submitAfter: null });
    });

    it("rejects a cancel that lost the claim as `too_late`", async () => {
      const app = buildTestApp();
      const cookie = await claimOwner(app);
      const accountId = await createOwnedMailAccount(app, cookie);
      await saveSendableDraft(app, cookie, accountId);

      await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: {
          mailAccounts: {
            [accountId]: {
              mutations: [
                { id: "01SEND", intent: { type: "sendComposition", compositionId: "comp-1" } },
              ],
            },
          },
        },
      });
      // The sweeper's claim, taken while the cancel was in flight.
      await db
        .update(compositions)
        .set({ status: "submitting" })
        .where(eq(compositions.id, "comp-1"));

      const cancelled = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: {
          mailAccounts: {
            [accountId]: {
              mutations: [
                { id: "01CANCEL", intent: { type: "cancelSend", compositionId: "comp-1" } },
              ],
            },
          },
        },
      });

      expect(cancelled.json().mailAccounts[accountId].mutations).toEqual([
        { id: "01CANCEL", status: "rejected", reason: "too_late" },
      ]);
    });

    it("is exactly-once: replaying a send intent's id never arms a second Pending Send", async () => {
      const app = buildTestApp();
      const cookie = await claimOwner(app);
      const accountId = await createOwnedMailAccount(app, cookie);
      await saveSendableDraft(app, cookie, accountId);

      const send = () =>
        app.inject({
          method: "POST",
          url: "/sync",
          headers: { cookie },
          payload: {
            mailAccounts: {
              [accountId]: {
                mutations: [
                  { id: "01SEND", intent: { type: "sendComposition", compositionId: "comp-1" } },
                ],
              },
            },
          },
        });

      await send();
      await db
        .update(compositions)
        .set({ status: "draft", submitAfter: null })
        .where(eq(compositions.id, "comp-1"));

      // A replayed id replays its recorded outcome rather than re-applying —
      // so the Composition the User cancelled is not silently re-armed.
      const replay = await send();
      expect(replay.json().mailAccounts[accountId].mutations).toEqual([
        { id: "01SEND", status: "applied" },
      ]);
      const [row] = await db.select().from(compositions).where(eq(compositions.id, "comp-1"));
      expect(row?.status).toBe("draft");
    });

    it("rejects a send whose Composition has no recipient", async () => {
      const app = buildTestApp();
      const cookie = await claimOwner(app);
      const accountId = await createOwnedMailAccount(app, cookie);

      await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: {
          mailAccounts: {
            [accountId]: {
              composeSaves: [
                {
                  id: "comp-2",
                  saveId: "save-comp-2",
                  version: 0,
                  subject: "Nobody",
                  document: EMPTY_COMPOSE_DOCUMENT,
                  to: [],
                  cc: [],
                  bcc: [],
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
        payload: {
          mailAccounts: {
            [accountId]: {
              mutations: [
                { id: "01SEND", intent: { type: "sendComposition", compositionId: "comp-2" } },
              ],
            },
          },
        },
      });
      expect(response.json().mailAccounts[accountId].mutations).toEqual([
        { id: "01SEND", status: "rejected", reason: "no_recipients" },
      ]);
    });
  });
});
