import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { ImapFlow } from "imapflow";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { folders, mailAccounts, messages } from "../db/schema.js";
import {
  getMailAccountById,
  type MailAccountRow,
  toWireMailAccount,
} from "../mail-accounts/store.js";
import { createTestDb, resetTestDb } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import { runBodySweepBatch } from "./body-sweep.js";
import { resolveThread } from "./threading.js";

/**
 * #127's Gmail download-cap pause against a fake `ImapFlow`, the same
 * posture as `protocol-writes.test.ts`'s server-kind gate: nothing in this
 * repo's dev infra (GreenMail advertises no `X-GM-EXT-1`, nor does it ever
 * refuse a FETCH for bandwidth) can produce Gmail's real cap response, so a
 * fake client that throws it on cue is the only way to prove the pause
 * without a live Gmail account.
 */

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

/** Gmail's own wording for the daily bandwidth/download cap (`gmail-download-cap.ts`). */
const GMAIL_CAP_ERROR = Object.assign(new Error("Command failed."), {
  responseStatus: "NO",
  responseText: "Account exceeded bandwidth limits. Please try again later.",
});

function createFakeClient(fetchAll: () => Promise<unknown[]>): { client: ImapFlow } {
  const fake = {
    async getMailboxLock(path: string) {
      return { path, release() {} };
    },
    async fetchAll() {
      return fetchAll();
    },
  };
  return { client: fake as unknown as ImapFlow };
}

async function seedFolder(mailAccountId: string): Promise<string> {
  const id = randomUUID();
  await db
    .insert(folders)
    .values({ id, mailAccountId, path: "INBOX", name: "INBOX", role: "inbox" });
  return id;
}

async function seedPendingMessage(
  account: MailAccountRow,
  folderId: string,
  uid: number,
  receivedAt: Date,
): Promise<string> {
  const threadId = await resolveThread(db, {
    mailAccountId: account.id,
    threadingIds: [randomUUID()],
    subject: "Test",
    receivedAt,
  });
  const id = randomUUID();
  await db.insert(messages).values({
    id,
    mailAccountId: account.id,
    threadId,
    folderId,
    uid,
    subject: "Test",
    sentAt: receivedAt,
    receivedAt,
  });
  return id;
}

describe("runBodySweepBatch's Gmail download-cap pause (#127, ADR-0020)", () => {
  it("pauses without a sync error and does not retry before the resume time, on a Gmail account", async () => {
    const account = await createTestMailAccount(db, { serverKind: "gmail" });
    const folderId = await seedFolder(account.id);
    await seedPendingMessage(account, folderId, 1, new Date("2026-01-01T00:00:00Z"));

    const { client } = createFakeClient(() => {
      throw GMAIL_CAP_ERROR;
    });

    const result = await runBodySweepBatch(db, client, account.id, 10);
    expect(result.complete).toBe(false);
    expect(result.processed).toBe(0);
    expect(result.pausedUntil).toBeInstanceOf(Date);
    expect(result.pausedUntil?.getTime()).toBeGreaterThan(Date.now());

    const row = await getMailAccountById(db, account.id);
    expect(row?.bodySweepPausedUntil?.getTime()).toBe(result.pausedUntil?.getTime());
    // No sync error recorded — this is the resident loop's `setSyncStatus`
    // column, and the pause never touches it (`live-session.ts` isn't even
    // involved in this unit test, but the invariant is that nothing in
    // `runBodySweepBatch` writes it).
    expect(row?.lastSyncError).toBeNull();
    expect(row?.syncState).toBe("stopped");

    if (!row) throw new Error("account row missing");
    const wire = toWireMailAccount(row);
    expect(wire.sync.state).not.toBe("error");
    expect(wire.sync.lastError).toBeNull();
    expect(wire.indexWatermark.complete).toBe(false);

    // A second call before the resume time must not hit IMAP again.
    const second = await runBodySweepBatch(db, client, account.id, 10);
    expect(second.pausedUntil).toBeInstanceOf(Date);
    expect(second.processed).toBe(0);
  });

  it("resumes and advances the Index Watermark once the resume time has passed", async () => {
    const account = await createTestMailAccount(db, { serverKind: "gmail" });
    const folderId = await seedFolder(account.id);
    const receivedAt = new Date("2026-01-01T00:00:00Z");
    await seedPendingMessage(account, folderId, 1, receivedAt);

    // Simulate a pause already recorded in the past — the resume time has
    // already elapsed, without waiting out the real 24h delay in a test.
    await db
      .update(mailAccounts)
      .set({ bodySweepPausedUntil: new Date(Date.now() - 1000) })
      .where(eq(mailAccounts.id, account.id));

    const { client } = createFakeClient(async () => [{ uid: 1, bodyStructure: undefined }]);

    const result = await runBodySweepBatch(db, client, account.id, 10);
    expect(result).toEqual({ processed: 1, complete: false });

    const row = await getMailAccountById(db, account.id);
    expect(row?.bodySweepPausedUntil).toBeNull();
    expect(row?.bodyWatermark?.toISOString()).toBe(receivedAt.toISOString());
  });

  it("only counts and advances through rows whose bodies were actually persisted", async () => {
    const account = await createTestMailAccount(db, { serverKind: "gmail" });
    const folderId = await seedFolder(account.id);
    const newer = new Date("2026-01-02T00:00:00Z");
    const older = new Date("2026-01-01T00:00:00Z");
    await seedPendingMessage(account, folderId, 2, newer);
    await seedPendingMessage(account, folderId, 1, older);

    const { client } = createFakeClient(async () => [{ uid: 2, bodyStructure: undefined }]);

    const result = await runBodySweepBatch(db, client, account.id, 10);
    expect(result).toEqual({ processed: 1, complete: false });

    const row = await getMailAccountById(db, account.id);
    expect(row?.bodyWatermark?.toISOString()).toBe(newer.toISOString());
  });

  it("still throws (and does not pause) on a generic-kind account", async () => {
    const account = await createTestMailAccount(db, { serverKind: "generic" });
    const folderId = await seedFolder(account.id);
    await seedPendingMessage(account, folderId, 1, new Date("2026-01-01T00:00:00Z"));

    const { client } = createFakeClient(() => {
      throw GMAIL_CAP_ERROR;
    });

    await expect(runBodySweepBatch(db, client, account.id, 10)).rejects.toBe(GMAIL_CAP_ERROR);

    const row = await getMailAccountById(db, account.id);
    expect(row?.bodySweepPausedUntil).toBeNull();
  });
});
