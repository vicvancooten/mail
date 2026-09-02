import { randomUUID } from "node:crypto";
import type { ComposeDocument } from "@mail/shared";
import { eq } from "drizzle-orm";
import { ImapFlow } from "imapflow";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { compositions, folders } from "../db/schema.js";
import { deriveCredentialKey } from "../mail-accounts/credential-crypto.js";
import type { MailAccountRow } from "../mail-accounts/store.js";
import { createTestDb, resetTestDb, TEST_MAIL_CREDENTIAL_KEY } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import { buildTestMessage } from "../test-support/mime.js";
import { pushDraftsForAccount } from "./draft-push.js";
import { connectMailAccount } from "./imap-connection.js";

/**
 * The compose-spec acceptance bar ("Draft readable in another IMAP client
 * after the debounced push; edits there never destroyed") end to end
 * against GreenMail, mirroring `protocol-writes.greenmail.test.ts`'s own
 * "verify from a second connection" shape.
 */
const IMAP_HOST = process.env.IMAP_TEST_HOST ?? "localhost";
const IMAP_PORT = Number(process.env.IMAP_TEST_PORT ?? 3143);

let db: Db;
let closeDb: () => Promise<void>;
let account: MailAccountRow;
let other: ImapFlow | null = null;

const DOC: ComposeDocument = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "Hello from the composer." }] }],
};

beforeEach(async () => {
  const created = await createTestDb();
  db = created.db;
  closeDb = () => created.sql.end();
  await resetTestDb(db);
  const emailAddress = `draft-push-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@mail.test`;
  account = await createTestMailAccount(db, {
    emailAddress,
    imapHost: IMAP_HOST,
    imapPort: IMAP_PORT,
  });
});

afterEach(async () => {
  await other?.logout().catch(() => undefined);
  other?.close();
  other = null;
});

afterAll(async () => {
  await closeDb?.();
});

async function connectOther(): Promise<ImapFlow> {
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: false,
    auth: { user: account.emailAddress, pass: "anything" },
    logger: false,
  });
  await client.connect();
  other = client;
  return client;
}

async function seedDraftsFolder(o: ImapFlow): Promise<string> {
  await o.mailboxCreate("Drafts");
  const id = randomUUID();
  await db
    .insert(folders)
    .values({ id, mailAccountId: account.id, path: "Drafts", name: "Drafts", role: "drafts" });
  return id;
}

/** An idle, changed-since-last-push Composition — old enough to clear the 30s debounce window. */
async function insertDraft(overrides: Partial<typeof compositions.$inferInsert> = {}) {
  const id = overrides.id ?? randomUUID();
  const idleUpdatedAt = new Date(Date.now() - 60_000);
  await db.insert(compositions).values({
    id,
    mailAccountId: account.id,
    subject: "Draft subject",
    document: DOC,
    version: 1,
    updatedAt: idleUpdatedAt,
    ...overrides,
  });
  return id;
}

async function draftRow(id: string) {
  const [row] = await db.select().from(compositions).where(eq(compositions.id, id)).limit(1);
  if (!row) throw new Error("composition row vanished");
  return row;
}

/**
 * `STATUS`, not a cached `SELECT` — a connection that already has this
 * mailbox open (from an earlier lock, in a test that itself deletes or
 * appends through it) would otherwise report the message count as of that
 * stale `SELECT`, not the server's current state after a change made from a
 * *different* connection.
 */
async function mailboxCount(client: ImapFlow, path: string): Promise<number> {
  const status = await client.status(path, { messages: true });
  return status.messages ?? -1;
}

async function connectAccount(): Promise<ImapFlow> {
  return connectMailAccount(db, account, {
    credentialKey: deriveCredentialKey(TEST_MAIL_CREDENTIAL_KEY),
  });
}

describe("pushDraftsForAccount against GreenMail", () => {
  it("APPENDs a multipart/alternative message, readable from another IMAP client", async () => {
    const o = await connectOther();
    await seedDraftsFolder(o);
    const id = await insertDraft({ subject: "Meeting notes" });

    const client = await connectAccount();
    try {
      const result = await pushDraftsForAccount(db, client, account.id, account.emailAddress);
      expect(result.pushed).toBe(1);
    } finally {
      await client.logout().catch(() => undefined);
      client.close();
    }

    expect(await mailboxCount(o, "Drafts")).toBe(1);
    const lock = await o.getMailboxLock("Drafts");
    let source = "";
    let flags: Set<string> | undefined;
    try {
      for await (const message of o.fetch("1:*", { source: true, flags: true })) {
        source = message.source?.toString("utf8") ?? "";
        flags = message.flags;
      }
    } finally {
      lock.release();
    }
    expect(source).toContain("Meeting notes");
    expect(source).toMatch(/Content-Type:\s*multipart\/alternative/i);
    expect(source).toContain("Hello from the composer.");
    expect(flags?.has("\\Draft")).toBe(true);

    const row = await draftRow(id);
    expect(row.imapDraftUid).not.toBeNull();
    expect(row.pushedContentHash).not.toBeNull();
  });

  it("does not push a Composition still inside the idle debounce window", async () => {
    const o = await connectOther();
    await seedDraftsFolder(o);
    await insertDraft({ updatedAt: new Date() }); // just edited — not idle yet

    const client = await connectAccount();
    try {
      const result = await pushDraftsForAccount(db, client, account.id, account.emailAddress);
      expect(result.pushed).toBe(0);
    } finally {
      await client.logout().catch(() => undefined);
      client.close();
    }
    expect(await mailboxCount(o, "Drafts")).toBe(0);
  });

  it("skips a re-push once the content hash already matches (idle-but-open composer pushes once)", async () => {
    const o = await connectOther();
    await seedDraftsFolder(o);
    const id = await insertDraft();

    const client = await connectAccount();
    try {
      const first = await pushDraftsForAccount(db, client, account.id, account.emailAddress);
      expect(first.pushed).toBe(1);

      // A second tick with no content change and no fresh edit: candidates
      // are filtered by hash before this call ever runs, matching the real
      // loop's own `pendingDraftPushes` gate.
      await db
        .update(compositions)
        .set({ updatedAt: new Date(Date.now() - 60_000) })
        .where(eq(compositions.id, id));
      const second = await pushDraftsForAccount(db, client, account.id, account.emailAddress);
      expect(second.pushed).toBe(0);
    } finally {
      await client.logout().catch(() => undefined);
      client.close();
    }
    expect(await mailboxCount(o, "Drafts")).toBe(1);
  });

  it("degrades quietly when the account has no Drafts folder", async () => {
    await insertDraft();
    const client = await connectAccount();
    try {
      const result = await pushDraftsForAccount(db, client, account.id, account.emailAddress);
      expect(result.pushed).toBe(0);
      expect(result.skippedNoFolder).toBe(true);
    } finally {
      await client.logout().catch(() => undefined);
      client.close();
    }
  });

  it("supersedes its own previous copy (append + expunge old) on an ordinary re-push", async () => {
    const o = await connectOther();
    await seedDraftsFolder(o);
    const id = await insertDraft({ subject: "v1" });

    const client = await connectAccount();
    try {
      await pushDraftsForAccount(db, client, account.id, account.emailAddress);
      await db
        .update(compositions)
        .set({ subject: "v2", updatedAt: new Date(Date.now() - 60_000) })
        .where(eq(compositions.id, id));
      const second = await pushDraftsForAccount(db, client, account.id, account.emailAddress);
      expect(second.pushed).toBe(1);
    } finally {
      await client.logout().catch(() => undefined);
      client.close();
    }

    // Exactly one live copy — the old UID was expunged, not left behind.
    expect(await mailboxCount(o, "Drafts")).toBe(1);
    const lock = await o.getMailboxLock("Drafts");
    let source = "";
    try {
      for await (const message of o.fetch("1:*", { source: true })) {
        source = message.source?.toString("utf8") ?? "";
      }
    } finally {
      lock.release();
    }
    expect(source).toContain("v2");
    expect(source).not.toContain("v1");
  });

  it("never destroys a foreign message: a foreign draft under a different UID survives our push untouched", async () => {
    const o = await connectOther();
    await seedDraftsFolder(o);
    const id = await insertDraft({ subject: "ours v1" });

    const client = await connectAccount();
    try {
      await pushDraftsForAccount(db, client, account.id, account.emailAddress);
    } finally {
      await client.logout().catch(() => undefined);
      client.close();
    }

    // A foreign IMAP client appends its own, unrelated draft directly —
    // never known to Mail, never tracked by any Composition.
    await o.append(
      "Drafts",
      buildTestMessage({
        from: account.emailAddress,
        to: "someone@example.test",
        subject: "a foreign draft Mail never wrote",
        date: new Date(),
        messageId: "foreign-draft@example.test",
        text: "written from another IMAP client",
      }),
      ["\\Draft"],
    );
    expect(await mailboxCount(o, "Drafts")).toBe(2);

    await db
      .update(compositions)
      .set({ subject: "ours v2", updatedAt: new Date(Date.now() - 60_000) })
      .where(eq(compositions.id, id));

    const client2 = await connectAccount();
    try {
      const result = await pushDraftsForAccount(db, client2, account.id, account.emailAddress);
      expect(result.pushed).toBe(1);
    } finally {
      await client2.logout().catch(() => undefined);
      client2.close();
    }

    // Our old copy was superseded; the foreign one is exactly as it was.
    expect(await mailboxCount(o, "Drafts")).toBe(2);
    const lock = await o.getMailboxLock("Drafts");
    const sources: string[] = [];
    try {
      for await (const message of o.fetch("1:*", { source: true })) {
        sources.push(message.source?.toString("utf8") ?? "");
      }
    } finally {
      lock.release();
    }
    expect(sources.some((s) => s.includes("a foreign draft Mail never wrote"))).toBe(true);
    expect(sources.some((s) => s.includes("ours v2"))).toBe(true);
    expect(sources.some((s) => s.includes("ours v1"))).toBe(false);
  });

  it("re-exports without erroring when the previously pushed copy disappeared (foreign delete/edit)", async () => {
    const o = await connectOther();
    await seedDraftsFolder(o);
    const id = await insertDraft({ subject: "ours v1" });

    const client = await connectAccount();
    try {
      await pushDraftsForAccount(db, client, account.id, account.emailAddress);
    } finally {
      await client.logout().catch(() => undefined);
      client.close();
    }
    const pushed = await draftRow(id);
    const trackedUid = pushed.imapDraftUid;
    expect(trackedUid).not.toBeNull();

    // Simulate a foreign client deleting (or itself superseding) our copy.
    const lock = await o.getMailboxLock("Drafts");
    try {
      await o.messageDelete(trackedUid as number, { uid: true });
    } finally {
      lock.release();
    }
    expect(await mailboxCount(o, "Drafts")).toBe(0);

    await db
      .update(compositions)
      .set({ subject: "ours v2", updatedAt: new Date(Date.now() - 60_000) })
      .where(eq(compositions.id, id));

    const client2 = await connectAccount();
    try {
      const result = await pushDraftsForAccount(db, client2, account.id, account.emailAddress);
      expect(result.pushed).toBe(1);
    } finally {
      await client2.logout().catch(() => undefined);
      client2.close();
    }

    expect(await mailboxCount(o, "Drafts")).toBe(1);
    const row = await draftRow(id);
    expect(row.imapDraftUid).not.toBe(trackedUid);
  });
});
