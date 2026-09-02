import { eq } from "drizzle-orm";
import { ImapFlow } from "imapflow";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { messages } from "../db/schema.js";
import { deriveCredentialKey } from "../mail-accounts/credential-crypto.js";
import { getMailAccountById, type MailAccountRow } from "../mail-accounts/store.js";
import { createTestDb, resetTestDb, TEST_MAIL_CREDENTIAL_KEY } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import { buildTestMessage } from "../test-support/mime.js";
import { runBodySweep, runBodySweepBatch } from "./body-sweep.js";
import { discoverFolders, persistFolders } from "./folders.js";
import { connectMailAccount } from "./imap-connection.js";
import { ingestFolder } from "./ingest.js";

/**
 * #36's run-once background body sweep and the Index Watermark it advances,
 * against GreenMail: newest-pending-first account-wide, resumable the same
 * way the header backfill is (nothing but the DB row remembers progress),
 * and terminating (`bodySweepComplete`) only once nothing is left.
 */
const IMAP_HOST = process.env.IMAP_TEST_HOST ?? "localhost";
const IMAP_PORT = Number(process.env.IMAP_TEST_PORT ?? 3143);

let db: Db;
let closeDb: () => Promise<void>;
let account: MailAccountRow;
let client: ImapFlow | null = null;

function at(day: number): Date {
  return new Date(Date.UTC(2025, 7, day, 9, 0, 0));
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
          subject: `Sweep ${i}`,
          date: at(i),
          messageId: `sweep-${i}@example.test`,
          text: `Body text ${i}`,
          html: `<p>Body html ${i}</p>`,
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

/** Headers-only ingest — bodies stay lazy, exactly what backfill leaves the sweep to do. */
async function ingestHeaders(emailAddress: string): Promise<void> {
  account = await createTestMailAccount(db, {
    emailAddress,
    imapHost: IMAP_HOST,
    imapPort: IMAP_PORT,
  });
  const imap = await connect();
  const live = await persistFolders(db, account.id, await discoverFolders(imap));
  const inbox = live.find((folder) => folder.role === "inbox");
  if (!inbox) throw new Error("INBOX was not discovered");
  await ingestFolder(db, imap, inbox);
  await closeClient();
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

describe("runBodySweepBatch against GreenMail", () => {
  it("fetches bodies newest-received-first and advances the Index Watermark", async () => {
    const emailAddress = `sweep-batch-${Date.now()}@mail.test`;
    await seedInbox(emailAddress, 5);
    await ingestHeaders(emailAddress);

    const before = await getMailAccountById(db, account.id);
    expect(before).toMatchObject({ bodyWatermark: null, bodySweepComplete: false });

    const imap = await connect();
    const result = await runBodySweepBatch(db, imap, account.id, 2);
    expect(result).toEqual({ processed: 2, complete: false });

    const rows = await db.select().from(messages).where(eq(messages.mailAccountId, account.id));
    const withBody = rows.filter((row) => row.bodyFetchedAt !== null);
    expect(withBody).toHaveLength(2);
    // Newest-received-first: messages 5 and 4 (of 5) are the ones swept.
    expect(withBody.map((row) => row.subject).sort()).toEqual(["Sweep 4", "Sweep 5"]);
    expect(withBody.every((row) => row.bodyText?.includes("Body text"))).toBe(true);
    expect(withBody.every((row) => row.snippet !== null)).toBe(true);

    const account1 = await getMailAccountById(db, account.id);
    expect(account1?.bodyWatermark?.toISOString()).toBe(at(4).toISOString());
    expect(account1?.bodySweepComplete).toBe(false);
  });

  it("reaches complete once nothing account-wide is left pending", async () => {
    const emailAddress = `sweep-complete-${Date.now()}@mail.test`;
    await seedInbox(emailAddress, 3);
    await ingestHeaders(emailAddress);

    const imap = await connect();
    let result = await runBodySweepBatch(db, imap, account.id, 10); // one batch covers everything
    expect(result).toEqual({ processed: 3, complete: false });

    result = await runBodySweepBatch(db, imap, account.id, 10); // nothing left
    expect(result).toEqual({ processed: 0, complete: true });

    const row = await getMailAccountById(db, account.id);
    expect(row?.bodySweepComplete).toBe(true);
  });

  it("re-opens once new mail arrives after completion", async () => {
    const emailAddress = `sweep-reopen-${Date.now()}@mail.test`;
    await seedInbox(emailAddress, 1);
    await ingestHeaders(emailAddress);

    const imap = await connect();
    await runBodySweepBatch(db, imap, account.id, 10);
    let result = await runBodySweepBatch(db, imap, account.id, 10);
    expect(result.complete).toBe(true);

    // A new arrival, ingested headers-only, the way the live delta path does.
    const seeder = new ImapFlow({
      host: IMAP_HOST,
      port: IMAP_PORT,
      secure: false,
      auth: { user: emailAddress, pass: "anything" },
      logger: false,
    });
    await seeder.connect();
    try {
      await seeder.append(
        "INBOX",
        buildTestMessage({
          from: "Later Sender <later@example.test>",
          to: emailAddress,
          subject: "Landed after completion",
          date: at(30),
          messageId: "sweep-reopen-new@example.test",
          text: "Fresh.",
        }),
        [],
        at(30),
      );
    } finally {
      await seeder.logout().catch(() => undefined);
      seeder.close();
    }

    const live = await persistFolders(db, account.id, await discoverFolders(imap));
    const inbox = live.find((folder) => folder.role === "inbox");
    if (!inbox) throw new Error("INBOX vanished");
    await ingestFolder(db, imap, inbox);

    result = await runBodySweepBatch(db, imap, account.id, 10);
    expect(result.complete).toBe(false);
    expect(result.processed).toBeGreaterThan(0);
    const row = await getMailAccountById(db, account.id);
    expect(row?.bodySweepComplete).toBe(false);
  });
});

describe("runBodySweep against GreenMail", () => {
  it("drains every pending body and then goes idle", async () => {
    const emailAddress = `sweep-loop-${Date.now()}@mail.test`;
    await seedInbox(emailAddress, 6);
    await ingestHeaders(emailAddress);

    const imap = await connect();
    let stopped = false;
    let resolveStop!: () => void;
    const stopSignal = new Promise<void>((resolve) => {
      resolveStop = resolve;
    });

    const loop = runBodySweep(db, imap, account.id, {
      batchSize: 2,
      pauseMs: 5,
      idlePollMs: 5,
      stopSignal,
      isStopped: () => stopped,
    });

    // Poll for completion rather than racing a fixed delay — GreenMail's
    // round-trip time per batch isn't fixed, and this is what "goes idle"
    // actually means: `bodySweepComplete` flips once the first empty batch
    // comes back, which `runBodySweepBatch` already proves happens as soon
    // as the pending set is drained.
    const deadline = Date.now() + 10_000;
    let complete = false;
    while (Date.now() < deadline) {
      const row = await getMailAccountById(db, account.id);
      if (row?.bodySweepComplete) {
        complete = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    stopped = true;
    resolveStop();
    await loop;

    expect(complete).toBe(true);
    const rows = await db.select().from(messages).where(eq(messages.mailAccountId, account.id));
    expect(rows.every((row) => row.bodyFetchedAt !== null)).toBe(true);
  }, 15_000);
});
