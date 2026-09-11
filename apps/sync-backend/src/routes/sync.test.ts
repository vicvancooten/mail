import { randomUUID } from "node:crypto";
import type {
  ComposeSaveOutcome,
  CompositionDelta,
  ConnectedAccountDelta,
  GmailLabelDelta,
  LabelDelta,
  MailAccountDelta,
  MutationOutcome,
  NoteDelta,
  TaskDelta,
  TaskListDelta,
  ThreadDelta,
} from "@mail/shared";
import { EMPTY_COMPOSE_DOCUMENT, EMPTY_NOTE_DOCUMENT } from "@mail/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { ensureClaimToken } from "../auth/claim.js";
import { markConnectedAccountNeedsReauth } from "../connected-accounts/store.js";
import type { Db } from "../db/client.js";
import {
  appliedMutations,
  composeSaveLedger,
  compositions,
  connectedAccountFacets,
  folders,
  mailAccounts,
  messages,
  notes,
  taskLists,
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
async function createOwnedMailAccount(
  app: FastifyInstance,
  cookie: string,
  overrides: { emailAddress?: string } = {},
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/mail-accounts",
    headers: { cookie },
    payload: {
      emailAddress: overrides.emailAddress ?? "vic@example.com",
      imap: { host: "imap.example.com", port: 993, security: "tls" },
      smtp: { host: "smtp.example.com", port: 587, security: "starttls" },
      username: overrides.emailAddress ?? "vic@example.com",
      password: "correct-horse-battery-staple",
    },
  });
  expect(response.statusCode).toBe(201);
  return (response.json().mailAccount as { id: string }).id;
}

/** The Connected Account (#199, ADR-0022) a Mail Account's own creation always mints alongside it. */
async function connectedAccountIdFor(mailAccountId: string): Promise<string> {
  const [row] = await db
    .select({ connectedAccountId: mailAccounts.connectedAccountId })
    .from(mailAccounts)
    .where(eq(mailAccounts.id, mailAccountId));
  if (!row) throw new Error(`no Mail Account ${mailAccountId}`);
  return row.connectedAccountId;
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

  describe("Label (User-scoped, #43, #186)", () => {
    it("bootstraps, then reports a newly created Label across a token round-trip", async () => {
      const app = buildTestApp();
      const cookie = await claimOwner(app);
      const accountId = await createOwnedMailAccount(app, cookie);
      await insertThreadWithMessage(accountId, "thread-1");

      const bootstrap = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: { user: { Label: null } },
      });
      expect(bootstrap.statusCode).toBe(200);
      // A bootstrap (#41) still carries a delta even with zero Labels: the
      // Client needs a `newState` to persist for this collection, or it can
      // never tell "bootstrapped, got nothing" from "haven't asked yet".
      expect(bootstrap.json().user.Label).toMatchObject({
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
          user: { Label: null },
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
      expect(applied.json().mailAccounts[accountId].mutations).toEqual([
        { id: "01LABEL", status: "applied" },
      ]);
      const delta = applied.json().user.Label as LabelDelta;
      expect(delta.created).toHaveLength(1);
      expect(delta.created[0]).toMatchObject({ name: "Work" });
      // The owning User, never a Mail Account (#186).
      expect(delta.created[0]).not.toHaveProperty("mailAccountId");

      const unchanged = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: { user: { Label: delta.newState } },
      });
      expect(unchanged.json().user.Label).toBeUndefined();
    });

    it("carries one Label for a name applied from two of the User's Mail Accounts (#186)", async () => {
      const app = buildTestApp();
      const cookie = await claimOwner(app);
      const firstAccountId = await createOwnedMailAccount(app, cookie);
      const secondAccountId = await createOwnedMailAccount(app, cookie, {
        emailAddress: "second@mail.test",
      });
      await insertThreadWithMessage(firstAccountId, "thread-1");
      await insertThreadWithMessage(secondAccountId, "thread-2");

      const response = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: {
          user: { Label: null },
          mailAccounts: {
            [firstAccountId]: {
              mutations: [
                {
                  id: "01FIRST",
                  intent: { type: "applyLabel", threadId: "thread-1", name: "Follow up" },
                },
              ],
            },
            [secondAccountId]: {
              mutations: [
                {
                  id: "01SECOND",
                  intent: { type: "applyLabel", threadId: "thread-2", name: "Follow up" },
                },
              ],
            },
          },
        },
      });
      const delta = response.json().user.Label as LabelDelta;
      expect(delta.created.map((row) => row.name)).toEqual(["Follow up"]);
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
      expect(response.json().user.Label).toBeUndefined();
    });
  });

  describe("Note (User-scoped, #192, ADR-0023)", () => {
    it("bootstraps empty, then reports a Note created through createNote across a token round-trip", async () => {
      const app = buildTestApp();
      const cookie = await claimOwner(app);

      const bootstrap = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: { user: { Note: null } },
      });
      expect(bootstrap.statusCode).toBe(200);
      expect(bootstrap.json().user.Note).toMatchObject({
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
          user: {
            Note: null,
            mutations: [{ id: "01CREATE", intent: { type: "createNote", noteId: "note-1" } }],
          },
        },
      });
      expect(applied.json().user.mutations).toEqual([{ id: "01CREATE", status: "applied" }]);
      const delta = applied.json().user.Note as NoteDelta;
      expect(delta.created).toHaveLength(1);
      expect(delta.created[0]).toMatchObject({ id: "note-1", labelIds: [] });

      const unchanged = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: { user: { Note: delta.newState } },
      });
      expect(unchanged.json().user.Note).toBeUndefined();
    });

    it("carries the second Client's create on the next sync round — the acceptance line itself", async () => {
      const app = buildTestApp();
      const cookie = await claimOwner(app);

      // One Client creates...
      await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: {
          user: {
            mutations: [{ id: "01CREATE", intent: { type: "createNote", noteId: "note-1" } }],
          },
        },
      });
      // ...and saves a body.
      await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: {
          user: {
            documentSaves: [
              { collection: "Note", id: "note-1", saveId: "01SAVE", document: EMPTY_NOTE_DOCUMENT },
            ],
          },
        },
      });

      // A second Client's next sync round, from nothing held, sees both.
      const secondClient = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: { user: { Note: null } },
      });
      const delta = secondClient.json().user.Note as NoteDelta;
      expect(delta.created).toHaveLength(1);
      expect(delta.created[0]).toMatchObject({ id: "note-1", document: EMPTY_NOTE_DOCUMENT });
    });

    it("removes a deleted Note from the collection — deleteNote, create's real inverse", async () => {
      const app = buildTestApp();
      const cookie = await claimOwner(app);
      const created = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: {
          user: {
            Note: null,
            mutations: [{ id: "01CREATE", intent: { type: "createNote", noteId: "note-1" } }],
          },
        },
      });
      const token = (created.json().user.Note as NoteDelta).newState;

      const deleted = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: {
          user: {
            Note: token,
            mutations: [{ id: "01DELETE", intent: { type: "deleteNote", noteId: "note-1" } }],
          },
        },
      });
      expect(deleted.json().user.mutations).toEqual([{ id: "01DELETE", status: "applied" }]);
      expect((deleted.json().user.Note as NoteDelta).destroyed).toEqual(["note-1"]);
    });

    it("soft-deletes with trashNote — the row rides `updated`, not `destroyed` (#194)", async () => {
      const app = buildTestApp();
      const cookie = await claimOwner(app);
      const created = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: {
          user: {
            Note: null,
            mutations: [{ id: "01CREATE", intent: { type: "createNote", noteId: "note-1" } }],
          },
        },
      });
      const token = (created.json().user.Note as NoteDelta).newState;

      const trashed = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: {
          user: {
            Note: token,
            mutations: [{ id: "01TRASH", intent: { type: "trashNote", noteId: "note-1" } }],
          },
        },
      });

      expect(trashed.json().user.mutations).toEqual([{ id: "01TRASH", status: "applied" }]);
      const delta = trashed.json().user.Note as NoteDelta;
      expect(delta.destroyed).toEqual([]);
      expect(delta.updated).toHaveLength(1);
      expect(delta.updated[0]).toMatchObject({ id: "note-1" });
      expect(delta.updated[0]?.deletedAt).not.toBeNull();
    });

    it("restores across the second Client — the delta round trip #194's own acceptance line asks for", async () => {
      const app = buildTestApp();
      const cookie = await claimOwner(app);
      await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: {
          user: {
            mutations: [
              { id: "01CREATE", intent: { type: "createNote", noteId: "note-1" } },
              { id: "01TRASH", intent: { type: "trashNote", noteId: "note-1" } },
            ],
          },
        },
      });

      // A second Client, from nothing held, sees the Note already deleted.
      const secondClient = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: { user: { Note: null } },
      });
      const firstDelta = secondClient.json().user.Note as NoteDelta;
      expect(firstDelta.created[0]?.deletedAt).not.toBeNull();

      const restored = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: {
          user: {
            Note: firstDelta.newState,
            mutations: [{ id: "01RESTORE", intent: { type: "restoreNote", noteId: "note-1" } }],
          },
        },
      });
      const secondDelta = restored.json().user.Note as NoteDelta;
      expect(secondDelta.updated[0]?.deletedAt).toBeNull();
    });
  });

  describe("ConnectedAccount (User-scoped, #200, ADR-0022)", () => {
    it("bootstraps with the Connected Account a Mail Account add creates, then reports nothing on an unchanged token", async () => {
      const app = buildTestApp();
      const cookie = await claimOwner(app);
      const accountId = await createOwnedMailAccount(app, cookie);
      const connectedAccountId = await connectedAccountIdFor(accountId);

      const first = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: { user: { ConnectedAccount: null } },
      });
      expect(first.statusCode).toBe(200);
      const delta = first.json().user.ConnectedAccount as ConnectedAccountDelta;
      expect(delta.created).toHaveLength(1);
      expect(delta.created[0]).toMatchObject({
        id: connectedAccountId,
        provider: "other_imap",
        status: "active",
        facets: [{ kind: "mail", status: "active" }],
      });
      // Never a credential, not even a masked one (ADR-0003).
      expect(delta.created[0]).not.toHaveProperty("credential");
      expect(JSON.stringify(delta.created[0])).not.toContain("credential");
      expect(delta.updated).toEqual([]);
      expect(delta.destroyed).toEqual([]);
      expect(delta.hasMore).toBe(false);

      const second = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: { user: { ConnectedAccount: delta.newState } },
      });
      expect(second.statusCode).toBe(200);
      expect(second.json().user.ConnectedAccount).toBeUndefined();
    });

    it("answers reset: true for a token the server no longer knows", async () => {
      const app = buildTestApp();
      const cookie = await claimOwner(app);
      await createOwnedMailAccount(app, cookie);

      const response = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: { user: { ConnectedAccount: "this-is-not-a-real-token" } },
      });
      expect(response.statusCode).toBe(200);
      const delta = response.json().user.ConnectedAccount as ConnectedAccountDelta;
      expect(delta.reset).toBe(true);
      expect(delta.created).toHaveLength(1);
    });

    it("carries an account-level Needs Reauth transition as an update, and a Client that missed the change picks it up next poll (#200's own acceptance line)", async () => {
      const app = buildTestApp();
      const cookie = await claimOwner(app);
      const accountId = await createOwnedMailAccount(app, cookie);
      const connectedAccountId = await connectedAccountIdFor(accountId);

      const bootstrap = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: { user: { ConnectedAccount: null } },
      });
      const token = (bootstrap.json().user.ConnectedAccount as ConnectedAccountDelta).newState;

      await markConnectedAccountNeedsReauth(db, connectedAccountId);

      const polled = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: { user: { ConnectedAccount: token } },
      });
      const delta = polled.json().user.ConnectedAccount as ConnectedAccountDelta;
      expect(delta.created).toEqual([]);
      expect(delta.destroyed).toEqual([]);
      expect(delta.updated).toHaveLength(1);
      expect(delta.updated[0]).toMatchObject({
        id: connectedAccountId,
        status: "needs_reauth",
        facets: [{ kind: "mail", status: "needs_reauth" }],
      });
    });

    it("carries a Facet-only status change as an update — a Facet has no sync_rev of its own to bump", async () => {
      const app = buildTestApp();
      const cookie = await claimOwner(app);
      const accountId = await createOwnedMailAccount(app, cookie);
      const connectedAccountId = await connectedAccountIdFor(accountId);

      const bootstrap = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: { user: { ConnectedAccount: null } },
      });
      const token = (bootstrap.json().user.ConnectedAccount as ConnectedAccountDelta).newState;

      // A Facet-only write — no column on `connected_accounts` itself
      // changes — still has to surface on the collection's own next delta
      // round: the parent-bump trigger (`db/migrations/0042_*.sql`) is what
      // makes that true.
      await db
        .update(connectedAccountFacets)
        .set({ status: "needs_reauth" })
        .where(eq(connectedAccountFacets.connectedAccountId, connectedAccountId));

      const polled = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: { user: { ConnectedAccount: token } },
      });
      const delta = polled.json().user.ConnectedAccount as ConnectedAccountDelta;
      expect(delta.updated).toHaveLength(1);
      expect(delta.updated[0]).toMatchObject({
        id: connectedAccountId,
        status: "active",
        facets: [{ kind: "mail", status: "needs_reauth" }],
      });
    });
  });

  describe("TaskList & Task (User-scoped, #251, ADR-0030)", () => {
    it("seeds exactly one default List named 'Tasks' on the first sync of the collection", async () => {
      const app = buildTestApp();
      const cookie = await claimOwner(app);

      const bootstrap = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: { user: { TaskList: null } },
      });

      const delta = bootstrap.json().user.TaskList as TaskListDelta;
      expect(delta.created).toHaveLength(1);
      expect(delta.created[0]).toMatchObject({ name: "Tasks", sections: [], isDefault: true });
    });

    it("never mints a second default List for two devices racing the first sync", async () => {
      const app = buildTestApp();
      const cookie = await claimOwner(app);

      const [first, second] = await Promise.all([
        app.inject({
          method: "POST",
          url: "/sync",
          headers: { cookie },
          payload: { user: { TaskList: null } },
        }),
        app.inject({
          method: "POST",
          url: "/sync",
          headers: { cookie },
          payload: { user: { TaskList: null } },
        }),
      ]);
      expect((first.json().user.TaskList as TaskListDelta).created).toHaveLength(1);
      expect((second.json().user.TaskList as TaskListDelta).created).toHaveLength(1);

      // The DB itself has exactly one row — not just two responses that
      // happen to agree.
      const rows = await db.select().from(taskLists);
      expect(rows).toHaveLength(1);
    });

    it("the seeded default List can never be deleted, even after renaming it away from 'Tasks'", async () => {
      const app = buildTestApp();
      const cookie = await claimOwner(app);
      const bootstrap = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: { user: { TaskList: null } },
      });
      const defaultId = (bootstrap.json().user.TaskList as TaskListDelta).created[0]?.id as string;

      await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: {
          user: {
            mutations: [
              {
                id: "01RENAME",
                intent: { type: "renameTaskList", taskListId: defaultId, name: "Errands" },
              },
            ],
          },
        },
      });

      const deleted = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: {
          user: {
            mutations: [
              {
                id: "01DELETE",
                intent: { type: "deleteTaskList", taskListId: defaultId, taskIds: [] },
              },
            ],
          },
        },
      });
      expect(deleted.json().user.mutations).toEqual([
        { id: "01DELETE", status: "rejected", reason: "default_list" },
      ]);
    });

    it("replicates a Task whole, completed included, ids the Client's own ULIDs", async () => {
      const app = buildTestApp();
      const cookie = await claimOwner(app);
      const bootstrap = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: { user: { TaskList: null } },
      });
      const defaultId = (bootstrap.json().user.TaskList as TaskListDelta).created[0]?.id as string;

      const created = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: {
          user: {
            Task: null,
            mutations: [
              {
                id: "01CREATE",
                intent: {
                  type: "createTask",
                  taskId: "task-1",
                  taskListId: defaultId,
                  sectionId: null,
                  title: "Buy milk",
                  order: 0,
                },
              },
              { id: "01COMPLETE", intent: { type: "completeTask", taskId: "task-1" } },
            ],
          },
        },
      });
      expect(created.json().user.mutations).toEqual([
        { id: "01CREATE", status: "applied" },
        { id: "01COMPLETE", status: "applied" },
      ]);
      const delta = created.json().user.Task as TaskDelta;
      expect(delta.created[0]).toMatchObject({
        id: "task-1",
        taskListId: defaultId,
        completed: true,
      });

      // A second Client, from nothing held, sees the completed Task too —
      // "completed Tasks are included in replication and never windowed out".
      const secondClient = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: { user: { Task: null } },
      });
      const secondDelta = secondClient.json().user.Task as TaskDelta;
      expect(secondDelta.created).toHaveLength(1);
      expect(secondDelta.created[0]).toMatchObject({ id: "task-1", completed: true });
    });

    it("a Task body saves through documentSaves with collection: 'Task'", async () => {
      const app = buildTestApp();
      const cookie = await claimOwner(app);
      const bootstrap = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: { user: { TaskList: null } },
      });
      const defaultId = (bootstrap.json().user.TaskList as TaskListDelta).created[0]?.id as string;
      await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: {
          user: {
            mutations: [
              {
                id: "01CREATE",
                intent: {
                  type: "createTask",
                  taskId: "task-1",
                  taskListId: defaultId,
                  sectionId: null,
                  title: "Buy milk",
                  order: 0,
                },
              },
            ],
          },
        },
      });

      const saved = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: {
          user: {
            documentSaves: [
              { collection: "Task", id: "task-1", saveId: "01SAVE", document: EMPTY_NOTE_DOCUMENT },
            ],
          },
        },
      });
      expect(saved.json().user.documentSaves).toEqual([
        { collection: "Task", id: "task-1", saveId: "01SAVE", status: "applied" },
      ]);

      const secondClient = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: { user: { Task: null } },
      });
      const delta = secondClient.json().user.Task as TaskDelta;
      expect(delta.created[0]).toMatchObject({ id: "task-1", document: EMPTY_NOTE_DOCUMENT });
    });

    it("deleteTaskList/restoreTaskList round-trips across two Clients — List and every Task it took come back", async () => {
      const app = buildTestApp();
      const cookie = await claimOwner(app);
      const list = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: {
          user: {
            mutations: [
              {
                id: "01LIST",
                intent: { type: "createTaskList", taskListId: "list-1", name: "Errands" },
              },
              {
                id: "01TASK",
                intent: {
                  type: "createTask",
                  taskId: "task-1",
                  taskListId: "list-1",
                  sectionId: null,
                  title: "Buy milk",
                  order: 0,
                },
              },
            ],
          },
        },
      });
      expect(list.json().user.mutations).toEqual([
        { id: "01LIST", status: "applied" },
        { id: "01TASK", status: "applied" },
      ]);

      await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: {
          user: {
            mutations: [
              {
                id: "01DELETE",
                intent: { type: "deleteTaskList", taskListId: "list-1", taskIds: ["task-1"] },
              },
            ],
          },
        },
      });

      // A second Client, from nothing held, sees both soft-deleted.
      const secondClient = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: { user: { TaskList: null, Task: null } },
      });
      const listDelta = secondClient.json().user.TaskList as TaskListDelta;
      const taskDelta = secondClient.json().user.Task as TaskDelta;
      expect(listDelta.created.find((row) => row.id === "list-1")?.deletedAt).not.toBeNull();
      expect(taskDelta.created.find((row) => row.id === "task-1")?.deletedAt).not.toBeNull();

      const restored = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: {
          user: {
            TaskList: listDelta.newState,
            Task: taskDelta.newState,
            mutations: [
              {
                id: "01RESTORE",
                intent: { type: "restoreTaskList", taskListId: "list-1", taskIds: ["task-1"] },
              },
            ],
          },
        },
      });
      expect(restored.json().user.mutations).toEqual([{ id: "01RESTORE", status: "applied" }]);
      const restoredListDelta = restored.json().user.TaskList as TaskListDelta;
      const restoredTaskDelta = restored.json().user.Task as TaskDelta;
      expect(restoredListDelta.updated[0]?.deletedAt).toBeNull();
      expect(restoredTaskDelta.updated[0]?.deletedAt).toBeNull();
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
        homeTimeZone: "",
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
              {
                id: "01TIMEZONE",
                intent: { type: "setHomeTimeZone", homeTimeZone: "Europe/Amsterdam" },
              },
            ],
          },
        },
      });
      const editedBody = edited.json().user;
      expect(editedBody.mutations).toEqual([
        { id: "01ADVANCE", status: "applied" },
        { id: "01DELAY", status: "applied" },
        { id: "01TIMEZONE", status: "applied" },
      ]);
      expect(editedBody.Preference.updated[0]).toMatchObject({
        autoAdvanceEnabled: false,
        autoAdvanceDirection: "newer",
        undoSendDelaySeconds: 30,
        homeTimeZone: "Europe/Amsterdam",
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

  describe("Mail-Account-scoped Preferences: setSignature / setNotificationsEnabled / setRemoteImages (#54, #146)", () => {
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

    it("sets remoteImages through the ordinary mutation queue and round-trips it through sync (#146)", async () => {
      const app = buildTestApp();
      const cookie = await claimOwner(app);
      const accountId = await createOwnedMailAccount(app, cookie);

      const bootstrap = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: { user: { MailAccount: null } },
      });
      // Unset, and this freshly created account has Gatekeeper off — the
      // read-time default is Always (#146), not the stored raw value.
      expect(bootstrap.json().user.MailAccount.created[0]).toMatchObject({
        remoteImages: "always",
      });

      await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: {
          mailAccounts: {
            [accountId]: {
              mutations: [{ id: "01IMG", intent: { type: "setRemoteImages", value: "ask" } }],
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
        remoteImages: "ask",
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

  describe("documentSaves (#192, #250, ADR-0023)", () => {
    /** The text of a stored Note's first block — `NoteBlock.content`'s loose union needs narrowing before an index reads it. */
    function firstText(document: unknown): unknown {
      const blocks = document as { content?: unknown }[];
      const content = blocks[0]?.content as { text?: string }[] | undefined;
      return content?.[0]?.text;
    }

    it("creates the Note lazily on the first save for an unseen id", async () => {
      const app = buildTestApp();
      const cookie = await claimOwner(app);

      const response = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { cookie },
        payload: {
          user: {
            documentSaves: [
              {
                collection: "Note",
                id: "note-1",
                saveId: "01SAVE-A",
                document: EMPTY_NOTE_DOCUMENT,
              },
            ],
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().user.documentSaves).toEqual([
        { collection: "Note", id: "note-1", saveId: "01SAVE-A", status: "applied" },
      ]);
      const [row] = await db.select().from(notes).where(eq(notes.id, "note-1"));
      expect(row?.document).toEqual(EMPTY_NOTE_DOCUMENT);
    });

    it("never rejects a later save — takes the latest by receipt, no etag, no conflict (ADR-0023)", async () => {
      const app = buildTestApp();
      const cookie = await claimOwner(app);
      const save = (saveId: string, text: string) => ({
        method: "POST" as const,
        url: "/sync",
        headers: { cookie },
        payload: {
          user: {
            documentSaves: [
              {
                collection: "Note",
                id: "note-1",
                saveId,
                document: [
                  {
                    id: "b1",
                    type: "paragraph",
                    props: {},
                    content: [{ type: "text", text, styles: {} }],
                    children: [],
                  },
                ],
              },
            ],
          },
        },
      });

      await app.inject(save("01A", "first"));
      // A "stale" save, in the sense a version-checked channel like
      // `composeSaves` would reject — here it simply applies, last write
      // (by receipt, not by content) wins, silently.
      const second = await app.inject(save("01B", "second"));

      expect(second.json().user.documentSaves).toEqual([
        { collection: "Note", id: "note-1", saveId: "01B", status: "applied" },
      ]);
      const [row] = await db.select().from(notes).where(eq(notes.id, "note-1"));
      expect(firstText(row?.document)).toBe("second");
    });

    it("two Clients editing one Note while offline both flush without error — the last to arrive is the stored body", async () => {
      const app = buildTestApp();
      const cookie = await claimOwner(app);
      const deviceA = () =>
        app.inject({
          method: "POST",
          url: "/sync",
          headers: { cookie },
          payload: {
            user: {
              documentSaves: [
                {
                  collection: "Note",
                  id: "note-1",
                  saveId: "01A",
                  document: [
                    {
                      id: "b1",
                      type: "paragraph",
                      props: {},
                      content: [{ type: "text", text: "from A", styles: {} }],
                      children: [],
                    },
                  ],
                },
              ],
            },
          },
        });
      const deviceB = () =>
        app.inject({
          method: "POST",
          url: "/sync",
          headers: { cookie },
          payload: {
            user: {
              documentSaves: [
                {
                  collection: "Note",
                  id: "note-1",
                  saveId: "01B",
                  document: [
                    {
                      id: "b1",
                      type: "paragraph",
                      props: {},
                      content: [{ type: "text", text: "from B", styles: {} }],
                      children: [],
                    },
                  ],
                },
              ],
            },
          },
        });

      const [responseA, responseB] = await Promise.all([deviceA(), deviceB()]);

      expect(responseA.statusCode).toBe(200);
      expect(responseB.statusCode).toBe(200);
      expect(responseA.json().user.documentSaves[0].status).toBe("applied");
      expect(responseB.json().user.documentSaves[0].status).toBe("applied");
      const [row] = await db.select().from(notes).where(eq(notes.id, "note-1"));
      // Whichever reached the Sync Backend last (by receipt) is what stuck —
      // exactly one of the two, not a merge of both.
      expect(["from A", "from B"]).toContain(firstText(row?.document));
    });

    it("is exactly-once at the Client's dequeue: replaying the same saveId still answers applied", async () => {
      const app = buildTestApp();
      const cookie = await claimOwner(app);
      const save = () =>
        app.inject({
          method: "POST",
          url: "/sync",
          headers: { cookie },
          payload: {
            user: {
              documentSaves: [
                {
                  collection: "Note",
                  id: "note-1",
                  saveId: "01RETRY",
                  document: EMPTY_NOTE_DOCUMENT,
                },
              ],
            },
          },
        });

      const first = await save();
      expect(first.json().user.documentSaves).toEqual([
        { collection: "Note", id: "note-1", saveId: "01RETRY", status: "applied" },
      ]);

      const retry = await save();
      expect(retry.json().user.documentSaves).toEqual([
        { collection: "Note", id: "note-1", saveId: "01RETRY", status: "applied" },
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
