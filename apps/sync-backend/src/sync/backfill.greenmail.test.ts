import { eq } from "drizzle-orm";
import { ImapFlow } from "imapflow";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { folders, messages } from "../db/schema.js";
import { deriveCredentialKey } from "../mail-accounts/credential-crypto.js";
import type { MailAccountRow } from "../mail-accounts/store.js";
import { createTestDb, resetTestDb, TEST_MAIL_CREDENTIAL_KEY } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import { buildTestMessage } from "../test-support/mime.js";
import { establishFolderBaseline, runAccountBackfill, runBackfillBatch } from "./backfill.js";
import { discoverFolders, findFolderByRole, persistFolders } from "./folders.js";
import { connectMailAccount } from "./imap-connection.js";

/**
 * #36's resumable, bounded header backfill, against GreenMail: newest-first,
 * batched independently of the resident IDLE loop, and resumable purely from
 * what's persisted on the folder row — no in-memory state a restart could
 * lose.
 */
const IMAP_HOST = process.env.IMAP_TEST_HOST ?? "localhost";
const IMAP_PORT = Number(process.env.IMAP_TEST_PORT ?? 3143);

let db: Db;
let closeDb: () => Promise<void>;
let account: MailAccountRow;
let client: ImapFlow | null = null;

function at(day: number): Date {
  return new Date(Date.UTC(2025, 6, day, 9, 0, 0));
}

async function seedInbox(emailAddress: string, count: number): Promise<void> {
  const seeder = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: false,
    auth: { user: emailAddress, pass: "anything" },
    logger: false,
  });
  await seeder.connect();
  try {
    for (let i = 1; i <= count; i += 1) {
      await seeder.append(
        "INBOX",
        buildTestMessage({
          from: `Sender ${i} <sender-${i}@example.test>`,
          to: emailAddress,
          subject: `Message ${i}`,
          date: at(i),
          messageId: `backfill-${i}@example.test`,
          text: `Body ${i}`,
        }),
        [],
        at(i),
      );
    }
  } finally {
    await seeder.logout().catch(() => undefined);
    seeder.close();
  }
}

async function connect(): Promise<ImapFlow> {
  client = await connectMailAccount(db, account, {
    credentialKey: deriveCredentialKey(TEST_MAIL_CREDENTIAL_KEY),
  });
  return client;
}

async function closeClient(): Promise<void> {
  if (!client) return;
  await client.logout().catch(() => undefined);
  client.close();
  client = null;
}

beforeEach(async () => {
  const created = await createTestDb();
  db = created.db;
  closeDb = () => created.sql.end();
  await resetTestDb(db);
});

afterEach(async () => {
  await closeClient();
});

afterAll(async () => {
  await closeDb?.();
});

describe("establishFolderBaseline against GreenMail", () => {
  it("sets a fresh backfill cursor at the folder's current message count, without fetching any message", async () => {
    const emailAddress = `backfill-est-${Date.now()}@mail.test`;
    await seedInbox(emailAddress, 5);
    account = await createTestMailAccount(db, {
      emailAddress,
      imapHost: IMAP_HOST,
      imapPort: IMAP_PORT,
    });

    const imap = await connect();
    const live = await persistFolders(db, account.id, await discoverFolders(imap));
    const inbox = live.find((folder) => folder.role === "inbox");
    if (!inbox) throw new Error("INBOX was not discovered");

    const result = await establishFolderBaseline(db, imap, inbox);
    expect(result).toEqual({ rebuilt: false, established: true });

    const [row] = await db.select().from(folders).where(eq(folders.id, inbox.id));
    expect(row).toMatchObject({ backfillCursorSeq: 5, backfillComplete: false });
    expect(row?.uidValidity).toBeGreaterThan(0);

    // No message fetched — only mailbox metadata.
    const stored = await db.select().from(messages).where(eq(messages.mailAccountId, account.id));
    expect(stored).toHaveLength(0);
  });

  it("marks an already-empty folder's backfill complete immediately", async () => {
    const emailAddress = `backfill-empty-${Date.now()}@mail.test`;
    account = await createTestMailAccount(db, {
      emailAddress,
      imapHost: IMAP_HOST,
      imapPort: IMAP_PORT,
    });

    const imap = await connect();
    const live = await persistFolders(db, account.id, await discoverFolders(imap));
    const inbox = live.find((folder) => folder.role === "inbox");
    if (!inbox) throw new Error("INBOX was not discovered");

    await establishFolderBaseline(db, imap, inbox);
    const [row] = await db.select().from(folders).where(eq(folders.id, inbox.id));
    expect(row).toMatchObject({ backfillCursorSeq: 0, backfillComplete: true });
  });

  it("is a no-op for a folder that's already tracked and wasn't rebuilt", async () => {
    const emailAddress = `backfill-noop-${Date.now()}@mail.test`;
    await seedInbox(emailAddress, 3);
    account = await createTestMailAccount(db, {
      emailAddress,
      imapHost: IMAP_HOST,
      imapPort: IMAP_PORT,
    });

    const imap = await connect();
    const live = await persistFolders(db, account.id, await discoverFolders(imap));
    const inbox = live.find((folder) => folder.role === "inbox");
    if (!inbox) throw new Error("INBOX was not discovered");

    await establishFolderBaseline(db, imap, inbox);
    const tracked = await findFolderByRole(db, account.id, "inbox");
    if (!tracked) throw new Error("INBOX was not tracked");

    const second = await establishFolderBaseline(db, imap, tracked);
    expect(second).toEqual({ rebuilt: false, established: false });
  });
});

describe("runBackfillBatch against GreenMail", () => {
  it("walks a folder newest-first, batch by batch, to completion", async () => {
    const emailAddress = `backfill-batches-${Date.now()}@mail.test`;
    await seedInbox(emailAddress, 7);
    account = await createTestMailAccount(db, {
      emailAddress,
      imapHost: IMAP_HOST,
      imapPort: IMAP_PORT,
    });

    const imap = await connect();
    const live = await persistFolders(db, account.id, await discoverFolders(imap));
    const inbox = live.find((folder) => folder.role === "inbox");
    if (!inbox) throw new Error("INBOX was not discovered");
    await establishFolderBaseline(db, imap, inbox);

    let folder = await findFolderByRole(db, account.id, "inbox");
    if (!folder) throw new Error("INBOX was not tracked");

    const seenUids: number[] = [];
    let done = false;
    while (!done) {
      const before = await db.select().from(messages).where(eq(messages.mailAccountId, account.id));
      const beforeUids = new Set(before.map((row) => row.uid));

      const result = await runBackfillBatch(db, imap, folder, 3);
      done = result.done;

      const after = await db.select().from(messages).where(eq(messages.mailAccountId, account.id));
      for (const row of after) {
        if (!beforeUids.has(row.uid)) seenUids.push(row.uid);
      }

      const refreshed = await findFolderByRole(db, account.id, "inbox");
      if (!refreshed) throw new Error("INBOX vanished mid-backfill");
      folder = refreshed;
    }

    // Newest UID first, strictly descending across every batch boundary.
    expect(seenUids).toHaveLength(7);
    expect([...seenUids].sort((left, right) => right - left)).toEqual(seenUids);

    expect(folder).toMatchObject({ backfillComplete: true, backfillCursorSeq: 0 });
    const all = await db.select().from(messages).where(eq(messages.mailAccountId, account.id));
    expect(all).toHaveLength(7);
  });

  it("resumes from the persisted cursor across a fresh connection — no in-memory state required", async () => {
    const emailAddress = `backfill-resume-${Date.now()}@mail.test`;
    await seedInbox(emailAddress, 6);
    account = await createTestMailAccount(db, {
      emailAddress,
      imapHost: IMAP_HOST,
      imapPort: IMAP_PORT,
    });

    const first = await connect();
    const live = await persistFolders(db, account.id, await discoverFolders(first));
    const inbox = live.find((folder) => folder.role === "inbox");
    if (!inbox) throw new Error("INBOX was not discovered");
    await establishFolderBaseline(db, first, inbox);

    let folder = await findFolderByRole(db, account.id, "inbox");
    if (!folder) throw new Error("INBOX was not tracked");
    await runBackfillBatch(db, first, folder, 2); // one batch: 2 of 6 messages
    await closeClient();

    const midway = await findFolderByRole(db, account.id, "inbox");
    if (!midway) throw new Error("INBOX vanished");
    expect(midway.backfillComplete).toBe(false);
    expect(midway.backfillCursorSeq).toBe(4);
    const storedMidway = await db
      .select()
      .from(messages)
      .where(eq(messages.mailAccountId, account.id));
    expect(storedMidway).toHaveLength(2);

    // A brand-new connection, reading only the persisted cursor — standing
    // in for the process having restarted between these two calls.
    const second = await connect();
    folder = midway;
    while (!folder.backfillComplete) {
      await runBackfillBatch(db, second, folder, 2);
      const refreshed = await findFolderByRole(db, account.id, "inbox");
      if (!refreshed) throw new Error("INBOX vanished mid-resume");
      folder = refreshed;
    }

    const all = await db.select().from(messages).where(eq(messages.mailAccountId, account.id));
    expect(all).toHaveLength(6); // no duplicates from resuming
    expect(new Set(all.map((row) => row.id)).size).toBe(6);
  });
});

describe("runAccountBackfill against GreenMail", () => {
  it("backfills every selectable folder to completion", async () => {
    const emailAddress = `backfill-account-${Date.now()}@mail.test`;
    await seedInbox(emailAddress, 4);
    const seeder = new ImapFlow({
      host: IMAP_HOST,
      port: IMAP_PORT,
      secure: false,
      auth: { user: emailAddress, pass: "anything" },
      logger: false,
    });
    await seeder.connect();
    try {
      await seeder.mailboxCreate("Archive");
      await seeder.append(
        "Archive",
        buildTestMessage({
          from: "Archived <archived@example.test>",
          to: emailAddress,
          subject: "Old",
          date: at(0),
          messageId: "backfill-archive@example.test",
          text: "Filed.",
        }),
        [],
        at(0),
      );
    } finally {
      await seeder.logout().catch(() => undefined);
      seeder.close();
    }

    account = await createTestMailAccount(db, {
      emailAddress,
      imapHost: IMAP_HOST,
      imapPort: IMAP_PORT,
    });
    const imap = await connect();
    const live = await persistFolders(db, account.id, await discoverFolders(imap));
    for (const folder of live) {
      if (folder.selectable) await establishFolderBaseline(db, imap, folder);
    }

    await runAccountBackfill(db, imap, account.id, {
      batchSize: 2,
      pauseMs: 5,
      stopSignal: new Promise<void>(() => undefined), // never fires — this test lets backfill run to completion
      isStopped: () => false,
    });

    const remaining = await db.select().from(folders).where(eq(folders.mailAccountId, account.id));
    for (const folder of remaining) {
      expect(folder.backfillComplete).toBe(true);
    }
    const all = await db.select().from(messages).where(eq(messages.mailAccountId, account.id));
    expect(all).toHaveLength(5);
  });
});
