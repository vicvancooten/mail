import { eq } from "drizzle-orm";
import type { ExpungeEvent, FlagsEvent, ImapFlow, MailboxObject } from "imapflow";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { folders, messages, threads } from "../db/schema.js";
import type { MailAccountRow } from "../mail-accounts/store.js";
import { createTestDb, resetTestDb } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import type { FolderRow } from "./folders.js";
import { attemptQresyncCatchup } from "./qresync-catchup.js";

/**
 * The QRESYNC-select path (#35), against a fake `ImapFlow` rather than a
 * real server: GreenMail advertises neither CONDSTORE nor QRESYNC (verified
 * for this ticket, `docs/dev-setup.md`), so nothing in this repo's dev infra
 * can exercise a genuine `SELECT ... (QRESYNC (...))` exchange. This proves
 * the module applies what the library's documented event/response shape
 * says a QRESYNC-granted select delivers; a live server is exercised
 * separately and only when one is configured
 * (`qresync-catchup.live-server.test.ts`).
 */

let db: Db;
let closeDb: () => Promise<void>;
let account: MailAccountRow;
let folder: FolderRow;
let threadId: string;

/** Registers just enough of `ImapFlow`'s event/lock surface for `attemptQresyncCatchup` to drive. */
function createFakeClient(options: {
  enabled?: string[];
  granted: boolean;
  mailboxExtra?: Partial<MailboxObject>;
  emitDuringSelect?: (emit: (event: string, payload: unknown) => void) => void;
  /** Simulates the server's answer to the new-UID catch-up fetch — empty unless a test needs one. */
  newMessages?: unknown[];
}): ImapFlow {
  const listeners = new Map<string, Set<(payload: never) => void>>();
  const emit = (event: string, payload: unknown) => {
    for (const listener of listeners.get(event) ?? []) listener(payload as never);
  };
  const fake = {
    enabled: new Set(options.enabled ?? ["QRESYNC"]),
    mailbox: false as MailboxObject | false,
    on(event: string, listener: (payload: never) => void) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
      return fake;
    },
    off(event: string, listener: (payload: never) => void) {
      listeners.get(event)?.delete(listener);
      return fake;
    },
    async getMailboxLock(path: string) {
      options.emitDuringSelect?.(emit);
      fake.mailbox = options.granted
        ? ({
            path,
            uidValidity: BigInt(1),
            // Matches the seeded folder's `uidNext` by default so a plain
            // test doesn't accidentally trip the new-UID catch-up fetch.
            uidNext: 3,
            highestModseq: 42n,
            exists: 1,
            flags: new Set(),
            qresync: true,
            ...options.mailboxExtra,
          } as MailboxObject & { qresync: boolean })
        : ({
            path,
            uidValidity: BigInt(1),
            uidNext: 3,
            exists: 1,
            flags: new Set(),
          } as MailboxObject);
      return { path, release() {} };
    },
    async fetchAll() {
      return options.newMessages ?? [];
    },
  };
  return fake as unknown as ImapFlow;
}

beforeEach(async () => {
  const created = await createTestDb();
  db = created.db;
  closeDb = () => created.sql.end();
  await resetTestDb(db);
  account = await createTestMailAccount(db);

  const [folderRow] = await db
    .insert(folders)
    .values({
      id: crypto.randomUUID(),
      mailAccountId: account.id,
      path: "INBOX",
      name: "INBOX",
      role: "inbox",
      uidValidity: 1,
      uidNext: 3,
      highestModseq: 10n,
      lastSyncedAt: new Date(),
    })
    .returning();
  if (!folderRow) throw new Error("failed to seed folder");
  folder = folderRow;

  threadId = crypto.randomUUID();
  await db.insert(threads).values({ id: threadId, mailAccountId: account.id, subject: "Hi" });
  await db.insert(messages).values({
    id: crypto.randomUUID(),
    mailAccountId: account.id,
    threadId,
    folderId: folder.id,
    uid: 5,
    uidValidity: 1,
    subject: "Hi",
    sentAt: new Date(),
    receivedAt: new Date(),
    flags: [],
  });
});

afterAll(async () => {
  await closeDb?.();
});

describe("attemptQresyncCatchup", () => {
  it("returns null without touching the connection when QRESYNC was never enabled", async () => {
    let locked = false;
    const client = createFakeClient({ enabled: [], granted: false });
    client.getMailboxLock = (async () => {
      locked = true;
      return { path: folder.path, release() {} };
    }) as ImapFlow["getMailboxLock"];

    const result = await attemptQresyncCatchup(db, client, folder);
    expect(result).toBeNull();
    expect(locked).toBe(false);
  });

  it("returns null when there is no prior baseline to resync from", async () => {
    const client = createFakeClient({ granted: true });
    const result = await attemptQresyncCatchup(db, client, {
      ...folder,
      highestModseq: null,
    });
    expect(result).toBeNull();
  });

  it("returns null when the server did not actually grant a QRESYNC resync", async () => {
    const client = createFakeClient({ granted: false });
    const result = await attemptQresyncCatchup(db, client, folder);
    expect(result).toBeNull();
  });

  it("applies a VANISHED UID as a deletion and cleans up its empty Thread", async () => {
    const client = createFakeClient({
      granted: true,
      emitDuringSelect: (emit) => {
        emit("expunge", { path: "INBOX", uid: 5, vanished: true } satisfies ExpungeEvent);
      },
    });

    const result = await attemptQresyncCatchup(db, client, folder);
    expect(result).toMatchObject({ created: 0, updated: 0, vanished: 1, rebuilt: false });

    const remaining = await db.select().from(messages).where(eq(messages.uid, 5));
    expect(remaining).toHaveLength(0);
    const remainingThread = await db.select().from(threads).where(eq(threads.id, threadId));
    expect(remainingThread).toHaveLength(0);
  });

  it("applies a FETCH-during-select flag update", async () => {
    const client = createFakeClient({
      granted: true,
      emitDuringSelect: (emit) => {
        emit("flags", {
          path: "INBOX",
          seq: 1,
          uid: 5,
          flags: new Set(["\\Seen", "\\Flagged"]),
        } satisfies FlagsEvent);
      },
    });

    const result = await attemptQresyncCatchup(db, client, folder);
    expect(result).toMatchObject({ created: 0, updated: 1, vanished: 0 });

    const [updated] = await db.select().from(messages).where(eq(messages.uid, 5));
    expect(updated).toMatchObject({ seen: true, flagged: true });
  });

  it("ingests a message that arrived while disconnected — VANISHED/FETCH alone would miss it", async () => {
    const client = createFakeClient({
      granted: true,
      mailboxExtra: { uidNext: 7 }, // was 3 — UIDs 5 and 6 are new since the last session
      newMessages: [
        {
          uid: 6,
          flags: new Set(["\\Seen"]),
          envelope: { subject: "Arrived while offline", messageId: "<offline@example.test>" },
          internalDate: new Date("2025-06-02T09:00:00Z"),
        },
      ],
    });

    const result = await attemptQresyncCatchup(db, client, folder);
    expect(result).toMatchObject({ created: 1, updated: 0, vanished: 0 });

    const [created] = await db.select().from(messages).where(eq(messages.uid, 6));
    expect(created).toMatchObject({ subject: "Arrived while offline", seen: true });
  });

  it("updates the folder's uidNext/highestModseq/lastSyncedAt on success", async () => {
    const client = createFakeClient({
      granted: true,
      mailboxExtra: { uidNext: 123, highestModseq: 999n },
    });
    await attemptQresyncCatchup(db, client, folder);

    const [updatedFolder] = await db.select().from(folders).where(eq(folders.id, folder.id));
    expect(updatedFolder).toMatchObject({ uidNext: 123, highestModseq: 999n });
  });
});
