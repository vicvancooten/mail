import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../db/client.js";
import { mailAccounts } from "../db/schema.js";
import type { MailAccountRow } from "../mail-accounts/store.js";
import { markNeedsReauth } from "../mail-accounts/store.js";
import { createTestDb, resetTestDb, TEST_MAIL_CREDENTIAL_KEY } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import * as liveSession from "./live-session.js";
import { createSyncManager, startAllMailAccountSyncs } from "./manager.js";

/**
 * `SyncManager`'s own bookkeeping (#35) — one session per account id, start
 * on create, restart on reauth, stop on shutdown — tested against a fake
 * `startLiveSyncSession` rather than a real IMAP connection: this module
 * knows nothing about IMAP, only about which handles exist.
 */
let db: Db;
let closeDb: () => Promise<void>;
let account: MailAccountRow;

beforeEach(async () => {
  const created = await createTestDb();
  db = created.db;
  closeDb = () => created.sql.end();
  await resetTestDb(db);
  account = await createTestMailAccount(db);
});

afterAll(async () => {
  await closeDb?.();
});

function fakeSession() {
  return { stop: vi.fn(async () => undefined) };
}

describe("createSyncManager", () => {
  it("starts exactly one session per Mail Account id, even if start() is called twice", () => {
    const started = vi.spyOn(liveSession, "startLiveSyncSession").mockReturnValue(fakeSession());
    const manager = createSyncManager(db, { mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY });

    manager.start(account);
    manager.start(account);

    expect(started).toHaveBeenCalledTimes(1);
    started.mockRestore();
  });

  it("stops the existing session and starts a fresh one on restart()", async () => {
    const sessions = [fakeSession(), fakeSession()];
    const started = vi
      .spyOn(liveSession, "startLiveSyncSession")
      .mockReturnValueOnce(sessions[0] as never)
      .mockReturnValueOnce(sessions[1] as never);
    const manager = createSyncManager(db, { mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY });

    manager.start(account);
    await manager.restart(account.id);

    expect(sessions[0]?.stop).toHaveBeenCalledOnce();
    expect(started).toHaveBeenCalledTimes(2);
    started.mockRestore();
  });

  it("restart() is a no-op if the account was deleted in the meantime", async () => {
    const started = vi.spyOn(liveSession, "startLiveSyncSession").mockReturnValue(fakeSession());
    const manager = createSyncManager(db, { mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY });
    manager.start(account);

    await db.delete(mailAccounts).where(eq(mailAccounts.id, account.id));
    await manager.restart(account.id);

    expect(started).toHaveBeenCalledTimes(1); // only the original start(), no second one
    started.mockRestore();
  });

  it("stopAll() stops every running session", async () => {
    const other = await createTestMailAccount(db);
    const sessions = [fakeSession(), fakeSession()];
    const started = vi
      .spyOn(liveSession, "startLiveSyncSession")
      .mockReturnValueOnce(sessions[0] as never)
      .mockReturnValueOnce(sessions[1] as never);
    const manager = createSyncManager(db, { mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY });

    manager.start(account);
    manager.start(other);
    await manager.stopAll();

    expect(sessions[0]?.stop).toHaveBeenCalledOnce();
    expect(sessions[1]?.stop).toHaveBeenCalledOnce();
    started.mockRestore();
  });
});

describe("startAllMailAccountSyncs", () => {
  it("starts a session for every existing Mail Account, Needs Reauth included", async () => {
    await markNeedsReauth(db, account.id);
    const other = await createTestMailAccount(db);

    const started: string[] = [];
    const manager = {
      start: (row: MailAccountRow) => {
        started.push(row.id);
      },
      restart: vi.fn(),
      stopAll: vi.fn(),
    };

    await startAllMailAccountSyncs(db, manager);

    // Needs Reauth still gets a `start()` call — `live-session.ts`'s own
    // pre-check is what parks it in `stopped` without connecting, not the
    // manager deciding on its behalf.
    expect(started.sort()).toEqual([account.id, other.id].sort());
  });
});
