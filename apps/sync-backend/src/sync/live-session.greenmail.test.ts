import { eq } from "drizzle-orm";
import { ImapFlow } from "imapflow";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { mailAccounts, messages } from "../db/schema.js";
import type { MailAccountRow } from "../mail-accounts/store.js";
import { createTestDb, resetTestDb, TEST_MAIL_CREDENTIAL_KEY } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import { buildTestMessage } from "../test-support/mime.js";
import { type LiveSyncSessionHandle, startLiveSyncSession } from "./live-session.js";

/**
 * The acceptance bar of #35, against GreenMail: a resident session picks up
 * new mail and flag changes without anything polling it from the test, and
 * survives its connection being killed out from under it.
 */
const IMAP_HOST = process.env.IMAP_TEST_HOST ?? "localhost";
const IMAP_PORT = Number(process.env.IMAP_TEST_PORT ?? 3143);

let db: Db;
let closeDb: () => Promise<void>;
let account: MailAccountRow;
let handle: LiveSyncSessionHandle | null = null;
let otherClient: ImapFlow | null = null;

function at(offsetMinutes: number): Date {
  return new Date(Date.now() + offsetMinutes * 60_000);
}

async function connectOtherClient(emailAddress: string): Promise<ImapFlow> {
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: false,
    auth: { user: emailAddress, pass: "anything" },
    logger: false,
  });
  await client.connect();
  otherClient = client;
  return client;
}

/** Polls `condition` until it is true or `timeoutMs` elapses — IDLE delivery has no fixed latency to await instead. */
async function waitUntil(condition: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!(await condition())) {
    throw new Error(`condition did not become true within ${timeoutMs}ms`);
  }
}

beforeEach(async () => {
  const created = await createTestDb();
  db = created.db;
  closeDb = () => created.sql.end();
  await resetTestDb(db);
  const emailAddress = `live-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@mail.test`;
  account = await createTestMailAccount(db, {
    emailAddress,
    imapHost: IMAP_HOST,
    imapPort: IMAP_PORT,
  });
});

afterEach(async () => {
  await handle?.stop();
  handle = null;
  await otherClient?.logout().catch(() => undefined);
  otherClient?.close();
  otherClient = null;
});

afterAll(async () => {
  await closeDb?.();
});

describe("startLiveSyncSession against GreenMail", () => {
  it("delivers new INBOX mail via IDLE with nothing polling for it", async () => {
    handle = startLiveSyncSession(db, account, {
      mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
      idleWakeDebounceMs: 20,
      autoIdleDelayMs: 100,
      pollIntervalMs: 60_000, // long enough that a poll tick could not be why this test passes
    });

    await waitUntil(async () => {
      const [row] = await db.select().from(mailAccounts).where(eq(mailAccounts.id, account.id));
      return row?.syncState === "idle";
    }, 5_000);

    const other = await connectOtherClient(account.emailAddress);
    await other.append(
      "INBOX",
      buildTestMessage({
        from: "Alice Anderson <alice@example.test>",
        to: account.emailAddress,
        subject: "Live from IDLE",
        date: at(0),
        messageId: `idle-${Date.now()}@example.test`,
        text: "Hello.",
      }),
      [],
      at(0),
    );

    await waitUntil(async () => {
      const rows = await db.select().from(messages).where(eq(messages.mailAccountId, account.id));
      return rows.length === 1;
    }, 5_000);
  }, 15_000);

  it("picks up a flag change made by another IMAP client", async () => {
    const other = await connectOtherClient(account.emailAddress);
    await other.append(
      "INBOX",
      buildTestMessage({
        from: "Alice Anderson <alice@example.test>",
        to: account.emailAddress,
        subject: "Read me from elsewhere",
        date: at(0),
        messageId: `idle-flag-${Date.now()}@example.test`,
        text: "Hello.",
      }),
      [],
      at(0),
    );

    handle = startLiveSyncSession(db, account, {
      mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
      idleWakeDebounceMs: 20,
      autoIdleDelayMs: 100,
      pollIntervalMs: 60_000,
    });

    await waitUntil(async () => {
      const rows = await db.select().from(messages).where(eq(messages.mailAccountId, account.id));
      return rows.length === 1;
    }, 5_000);

    const lock = await other.getMailboxLock("INBOX");
    try {
      await other.messageFlagsAdd("1:*", ["\\Seen", "\\Flagged"]);
    } finally {
      lock.release();
    }

    await waitUntil(async () => {
      const [row] = await db.select().from(messages).where(eq(messages.mailAccountId, account.id));
      return row?.seen === true && row?.flagged === true;
    }, 5_000);
  }, 15_000);

  it("self-restarts after its connection dies, and the restart is visible in status", async () => {
    let readyCount = 0;
    handle = startLiveSyncSession(db, account, {
      mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
      idleWakeDebounceMs: 20,
      autoIdleDelayMs: 100,
      pollIntervalMs: 60_000,
      backoffInitialMs: 50,
      backoffMaxMs: 200,
      onClientReady: (client) => {
        readyCount += 1;
        if (readyCount === 1) {
          // Kill the very first connection outright — no LOGOUT — the way a
          // dropped network or a killed server process would.
          client.close();
        }
      },
    });

    // The kill surfaces as `error` before the loop backs off and reconnects.
    await waitUntil(async () => {
      const [row] = await db.select().from(mailAccounts).where(eq(mailAccounts.id, account.id));
      return row?.syncState === "error" && row.lastSyncError !== null;
    }, 5_000);

    // It comes back on its own, and the account is healthy again with no
    // external call telling it to retry.
    await waitUntil(async () => {
      const [row] = await db.select().from(mailAccounts).where(eq(mailAccounts.id, account.id));
      return row?.syncState === "idle" && row.lastSyncError === null;
    }, 5_000);

    expect(readyCount).toBeGreaterThanOrEqual(2);

    // The restarted session is not just alive but actually syncing again.
    const other = await connectOtherClient(account.emailAddress);
    await other.append(
      "INBOX",
      buildTestMessage({
        from: "Alice Anderson <alice@example.test>",
        to: account.emailAddress,
        subject: "After the restart",
        date: at(0),
        messageId: `idle-restart-${Date.now()}@example.test`,
        text: "Still here.",
      }),
      [],
      at(0),
    );
    await waitUntil(async () => {
      const rows = await db.select().from(messages).where(eq(messages.mailAccountId, account.id));
      return rows.length === 1;
    }, 5_000);
  }, 20_000);

  it("polls a non-INBOX folder for new mail — IDLE only ever watches INBOX", async () => {
    const other = await connectOtherClient(account.emailAddress);
    await other.mailboxCreate("Archive");

    handle = startLiveSyncSession(db, account, {
      mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
      idleWakeDebounceMs: 20,
      autoIdleDelayMs: 100,
      // Short enough to observe within the test, long enough that the
      // immediate first-poll-on-connect (`residentLoop`'s own behaviour)
      // isn't what's being measured here — the append below happens after
      // that first pass has already run empty.
      pollIntervalMs: 300,
    });

    await waitUntil(async () => {
      const [row] = await db.select().from(mailAccounts).where(eq(mailAccounts.id, account.id));
      return row?.syncState === "idle";
    }, 5_000);

    await other.append(
      "Archive",
      buildTestMessage({
        from: "Alice Anderson <alice@example.test>",
        to: account.emailAddress,
        subject: "Filed away",
        date: at(0),
        messageId: `poll-${Date.now()}@example.test`,
        text: "Old thing.",
      }),
      [],
      at(0),
    );

    // Nothing about an Archive append touches INBOX's IDLE — this only
    // arrives because the poll timer visits every other selectable folder.
    await waitUntil(async () => {
      const rows = await db.select().from(messages).where(eq(messages.mailAccountId, account.id));
      return rows.length === 1;
    }, 5_000);
  }, 15_000);

  it("stops cleanly and does not restart when `stop()` is called", async () => {
    handle = startLiveSyncSession(db, account, {
      mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
      idleWakeDebounceMs: 20,
      autoIdleDelayMs: 100,
      pollIntervalMs: 60_000,
    });
    await waitUntil(async () => {
      const [row] = await db.select().from(mailAccounts).where(eq(mailAccounts.id, account.id));
      return row?.syncState === "idle";
    }, 5_000);

    await handle.stop();
    handle = null;

    // Give a would-be restart a moment it should not use.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const [row] = await db.select().from(mailAccounts).where(eq(mailAccounts.id, account.id));
    expect(row?.syncState).not.toBe("error");
  }, 10_000);
});
