import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { folders, gatekeeperVerdicts, messages, protocolWrites, threads } from "../db/schema.js";
import { getMailAccountById, type MailAccountRow } from "../mail-accounts/store.js";
import { computeUnreadInboxCount } from "../notifier/badge.js";
import { listUndelivered } from "../notifier/outbox.js";
import { handleNewArrivals } from "../sync/arrivals.js";
import type { FolderRow } from "../sync/folders.js";
import { refreshThreadRollups } from "../sync/thread-rollup.js";
import { resolveThread } from "../sync/threading.js";
import { createTestDb, resetTestDb } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import { approveSender, blockSender, denySender, unblockSender } from "./decisions.js";
import { disableGatekeeper, enableGatekeeper, resetGatekeeper } from "./settings.js";
import {
  approveSendRecipients,
  countApprovedSenders,
  listBlockedSenders,
  resolveVerdict,
  setVerdict,
} from "./verdicts.js";

/**
 * Gatekeeper v1's acceptance bar (#55, poc-spec.md §Gatekeeper v1,
 * ADR-0008), against a real Postgres. The one branch that needs a real mail
 * server — a Block's `\Trash` move being visible to another IMAP client — is
 * `screening.greenmail.test.ts`; everything here is about *which* mail is
 * held, blocked or let through, and what each Screener decision does to it.
 */

let db: Db;
let closeDb: () => Promise<void>;
let account: MailAccountRow;
let inbox: FolderRow;
let sent: FolderRow;
let trash: FolderRow;

const BEFORE_CUTOFF = new Date("2026-01-01T09:00:00.000Z");

beforeEach(async () => {
  const created = await createTestDb();
  db = created.db;
  closeDb = () => created.sql.end();
  await resetTestDb(db);
  account = await createTestMailAccount(db);
  inbox = await seedFolder("inbox", "INBOX");
  sent = await seedFolder("sent", "Sent");
  trash = await seedFolder("trash", "Trash");
});

afterAll(async () => {
  await closeDb?.();
});

async function seedFolder(role: FolderRow["role"], path: string): Promise<FolderRow> {
  const [row] = await db
    .insert(folders)
    .values({ id: randomUUID(), mailAccountId: account.id, path, name: path, role })
    .returning();
  if (!row) throw new Error("folder insert returned no row");
  return row;
}

/** Refreshes the in-memory account row after a settings change — every screening decision reads it. */
async function reloadAccount(): Promise<MailAccountRow> {
  const row = await getMailAccountById(db, account.id);
  if (!row) throw new Error("account vanished");
  account = row;
  return row;
}

interface DeliverInput {
  from: string;
  fromName?: string;
  subject?: string;
  messageId?: string;
  inReplyTo?: string;
  receivedAt?: Date;
  folder?: FolderRow;
  to?: { name: string | null; address: string }[];
}

/**
 * Stores one message the way `sync/ingest.ts#storeMessage` would (Thread
 * resolved off the reference chain, rollup refreshed) and then runs the live
 * arrival path over it — screening and the Notifier, in that order. This is
 * the seam every case below exercises, rather than calling `screenArrivals`
 * directly: the acceptance bar is about what a delivery *does*, badge and
 * push included.
 */
async function deliver(input: DeliverInput): Promise<{ messageId: string; threadId: string }> {
  const folder = input.folder ?? inbox;
  const receivedAt = input.receivedAt ?? new Date();
  const messageIdHeader = input.messageId ?? `${randomUUID()}@example.test`;
  const threadId = await resolveThread(db, {
    mailAccountId: account.id,
    threadingIds: input.inReplyTo ? [messageIdHeader, input.inReplyTo] : [messageIdHeader],
    subject: input.subject ?? "Hello",
    receivedAt,
  });
  const id = randomUUID();
  await db.insert(messages).values({
    id,
    mailAccountId: account.id,
    threadId,
    folderId: folder.id,
    uid: Math.floor(Math.random() * 1_000_000) + 1,
    messageIdHeader,
    inReplyTo: input.inReplyTo ?? null,
    subject: input.subject ?? "Hello",
    fromName: input.fromName ?? null,
    fromAddress: input.from,
    toAddresses: input.to ?? [{ name: null, address: account.emailAddress }],
    sentAt: receivedAt,
    receivedAt,
    seen: false,
  });
  await refreshThreadRollups(db, [threadId]);
  await handleNewArrivals(db, folder, account, [id]);
  return { messageId: id, threadId };
}

async function threadRow(threadId: string) {
  const [row] = await db.select().from(threads).where(eq(threads.id, threadId)).limit(1);
  if (!row) throw new Error("thread vanished");
  return row;
}

async function pendingKinds(): Promise<string[]> {
  return (await listUndelivered(db)).map((row) => row.kind);
}

describe("enabling Gatekeeper (#55)", () => {
  it("stamps the Cutoff and seeds Approved from Sent history, so day one's Screener is empty", async () => {
    // Two people this account has actually written to — one on To, one on Cc.
    await db.insert(messages).values({
      id: randomUUID(),
      mailAccountId: account.id,
      threadId: await resolveThread(db, {
        mailAccountId: account.id,
        threadingIds: ["outgoing@example.test"],
        subject: "Sent one",
        receivedAt: BEFORE_CUTOFF,
      }),
      folderId: sent.id,
      uid: 1,
      messageIdHeader: "outgoing@example.test",
      subject: "Sent one",
      fromAddress: account.emailAddress,
      toAddresses: [{ name: "Bob", address: "Bob@Partner.test" }],
      ccAddresses: [{ name: null, address: "cc-person@partner.test" }],
      sentAt: BEFORE_CUTOFF,
      receivedAt: BEFORE_CUTOFF,
    });

    const before = new Date();
    const { seeded } = await enableGatekeeper(db, account.id);
    await reloadAccount();

    expect(seeded).toBe(2);
    expect(account.gatekeeperEnabled).toBe(true);
    expect(account.gatekeeperCutoff?.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    // Normalized on the way in: the header said `Bob@Partner.test`.
    expect((await resolveVerdict(db, account.id, "bob@partner.test")).verdict).toBe("approved");
    expect((await resolveVerdict(db, account.id, "cc-person@partner.test")).verdict).toBe(
      "approved",
    );

    // A seeded sender writing back is not a stranger.
    const { threadId } = await deliver({ from: "bob@partner.test", subject: "Re-opening" });
    expect((await threadRow(threadId)).heldSender).toBeNull();
    expect(await pendingKinds()).toEqual(["new_mail"]);
  });

  it("grandfathers everything that arrived before the Cutoff", async () => {
    await enableGatekeeper(db, account.id);
    await reloadAccount();

    const { threadId } = await deliver({
      from: "ancient-stranger@example.test",
      receivedAt: BEFORE_CUTOFF,
    });
    expect((await threadRow(threadId)).heldSender).toBeNull();
  });

  it("holds nothing at all while Gatekeeper is switched off", async () => {
    const { threadId } = await deliver({ from: "stranger@example.test" });
    expect((await threadRow(threadId)).heldSender).toBeNull();
    expect(await pendingKinds()).toEqual(["new_mail"]);
  });
});

describe("the hold rule (#55)", () => {
  beforeEach(async () => {
    await enableGatekeeper(db, account.id);
    await reloadAccount();
  });

  it("holds a stranger's new Thread with no push and no badge, and fires one digest instead", async () => {
    const { threadId } = await deliver({
      from: "Stranger@Example.test",
      fromName: "A Stranger",
      subject: "Can we talk?",
    });

    const thread = await threadRow(threadId);
    expect(thread.heldSender).toBe("stranger@example.test");
    expect(thread.heldAt).not.toBeNull();
    // Still Inbox mail — a hold is not an archive (ADR-0008: never moved).
    expect(thread.inInbox).toBe(true);
    expect(thread.unreadCount).toBe(1);

    // No `new_mail` push; exactly one coalesced Gatekeeper digest naming them.
    const pending = await listUndelivered(db);
    expect(pending.map((row) => row.kind)).toEqual(["gatekeeper_digest"]);
    expect(pending[0]?.payload).toMatchObject({
      kind: "gatekeeper_digest",
      senders: ["A Stranger"],
      count: 1,
    });

    // And the badge does not move, even though the Thread is unread in the Inbox.
    expect(await computeUnreadInboxCount(db, account.userId)).toBe(0);
  });

  it("never holds a reply in an ongoing Thread, however the sender stands", async () => {
    await setVerdict(
      db,
      account.id,
      { scope: "address", value: "known@partner.test" },
      "approved",
      "seed",
    );
    const opener = await deliver({
      from: "known@partner.test",
      subject: "Project",
      messageId: "root@partner.test",
    });

    // A complete stranger joins the conversation.
    const reply = await deliver({
      from: "colleague-of-theirs@example.test",
      subject: "Re: Project",
      inReplyTo: "root@partner.test",
    });

    expect(reply.threadId).toBe(opener.threadId);
    expect((await threadRow(reply.threadId)).heldSender).toBeNull();
    expect(await pendingKinds()).toEqual(["new_mail", "new_mail"]);
  });

  it("never holds mail outside the Inbox", async () => {
    const archive = await seedFolder("archive", "Archive");
    const { threadId } = await deliver({ from: "stranger@example.test", folder: archive });
    expect((await threadRow(threadId)).heldSender).toBeNull();
  });

  it("keeps a stranger's follow-up inside the same held Thread silent", async () => {
    const first = await deliver({
      from: "stranger@example.test",
      subject: "Ping",
      messageId: "ping@example.test",
    });
    const followUp = await deliver({
      from: "stranger@example.test",
      subject: "Re: Ping",
      inReplyTo: "ping@example.test",
    });

    expect(followUp.threadId).toBe(first.threadId);
    // Still exactly the one digest from the first hold — the 4h silence holds.
    expect(await pendingKinds()).toEqual(["gatekeeper_digest"]);
    expect(await computeUnreadInboxCount(db, account.userId)).toBe(0);
  });
});

describe("Verdict resolution (#55)", () => {
  it("lets an address Verdict beat the domain Verdict it sits inside", async () => {
    await setVerdict(
      db,
      account.id,
      { scope: "domain", value: "noisy.test" },
      "blocked",
      "settings",
    );
    await setVerdict(
      db,
      account.id,
      { scope: "address", value: "friend@noisy.test" },
      "approved",
      "screener",
    );

    expect((await resolveVerdict(db, account.id, "anyone@noisy.test")).verdict).toBe("blocked");
    expect((await resolveVerdict(db, account.id, "friend@noisy.test")).verdict).toBe("approved");
  });

  it("refuses a domain Verdict on a public provider", async () => {
    await expect(
      setVerdict(db, account.id, { scope: "domain", value: "gmail.com" }, "blocked", "settings"),
    ).rejects.toThrow(/public provider/);
    const result = await blockSender(db, account.id, { scope: "domain", value: "gmail.com" });
    expect(result).toEqual({ ok: false, reason: "barred_verdict_domain" });
  });

  it("never lets one Mail Account's Verdicts reach another", async () => {
    const other = await createTestMailAccount(db);
    await setVerdict(
      db,
      account.id,
      { scope: "address", value: "shared@example.test" },
      "blocked",
      "screener",
    );
    expect((await resolveVerdict(db, other.id, "shared@example.test")).verdict).toBe("unscreened");
  });

  it("treats a plus-tagged address as its own sender", async () => {
    await setVerdict(
      db,
      account.id,
      { scope: "address", value: "vic+news@example.test" },
      "blocked",
      "screener",
    );
    expect((await resolveVerdict(db, account.id, "vic@example.test")).verdict).toBe("unscreened");
  });
});

describe("Screener decisions (#55)", () => {
  beforeEach(async () => {
    await enableGatekeeper(db, account.id);
    await reloadAccount();
  });

  it("Approve releases every held Thread with its original dates, and approves the sender", async () => {
    // A fixed instant just past the Cutoff: late enough to be screened, and
    // stable enough that the release can be checked against it exactly.
    const cutoff = account.gatekeeperCutoff;
    if (!cutoff) throw new Error("enabling Gatekeeper left no Cutoff");
    const arrivedAt = new Date(cutoff.getTime() + 1_000);
    const first = await deliver({
      from: "stranger@example.test",
      subject: "One",
      receivedAt: arrivedAt,
    });
    const second = await deliver({ from: "stranger@example.test", subject: "Two" });
    expect((await threadRow(first.threadId)).heldSender).toBe("stranger@example.test");

    const before = await threadRow(first.threadId);
    expect(
      await approveSender(db, account.id, { scope: "address", value: "stranger@example.test" }),
    ).toEqual({ ok: true });

    const after = await threadRow(first.threadId);
    expect(after.heldSender).toBeNull();
    expect(after.heldAt).toBeNull();
    expect(after.inInbox).toBe(true);
    // "Release with original dates": nothing about the Thread's position in
    // the list moved, because nothing was ever moved to release.
    expect(after.lastMessageAt?.toISOString()).toBe(arrivedAt.toISOString());
    expect(after.lastMessageAt?.toISOString()).toBe(before.lastMessageAt?.toISOString());
    expect((await threadRow(second.threadId)).heldSender).toBeNull();

    expect((await resolveVerdict(db, account.id, "stranger@example.test")).verdict).toBe(
      "approved",
    );
    // Released mail counts for the badge again — this is when the User can act on it.
    expect(await computeUnreadInboxCount(db, account.userId)).toBe(2);
  });

  it("Deny trashes the held Threads and leaves the sender Unscreened", async () => {
    const { threadId } = await deliver({ from: "stranger@example.test" });

    expect(
      await denySender(db, account.id, { scope: "address", value: "stranger@example.test" }),
    ).toEqual({ ok: true });

    const after = await threadRow(threadId);
    expect(after.heldSender).toBeNull();
    expect(after.inInbox).toBe(false);
    expect((await resolveVerdict(db, account.id, "stranger@example.test")).verdict).toBe(
      "unscreened",
    );
    // The real IMAP move is queued through the ordinary write-through outbox.
    const queued = await db
      .select()
      .from(protocolWrites)
      .where(eq(protocolWrites.mailAccountId, account.id));
    expect(queued.map((row) => row.kind)).toEqual(["trash"]);

    // Unscreened means the next one is held again.
    const again = await deliver({ from: "stranger@example.test", subject: "Trying again" });
    expect((await threadRow(again.threadId)).heldSender).toBe("stranger@example.test");
  });

  it("Block trashes the held Threads, records the Verdict, and lists them for unblocking", async () => {
    const { threadId } = await deliver({ from: "stranger@example.test" });

    expect(
      await blockSender(db, account.id, { scope: "address", value: "stranger@example.test" }),
    ).toEqual({ ok: true });

    expect((await threadRow(threadId)).inInbox).toBe(false);
    expect((await resolveVerdict(db, account.id, "stranger@example.test")).verdict).toBe("blocked");
    expect(await listBlockedSenders(db, account.id)).toEqual([
      expect.objectContaining({
        scope: "address",
        value: "stranger@example.test",
        source: "screener",
      }),
    ]);

    expect(
      await unblockSender(db, account.id, { scope: "address", value: "stranger@example.test" }),
    ).toEqual({ ok: true });
    // Back to Unscreened, never to Approved — the User stopped refusing them,
    // they never welcomed them.
    expect((await resolveVerdict(db, account.id, "stranger@example.test")).verdict).toBe(
      "unscreened",
    );
    expect(await listBlockedSenders(db, account.id)).toEqual([]);
  });

  it("Block is the sole off-switch for an Approved sender", async () => {
    await setVerdict(
      db,
      account.id,
      { scope: "address", value: "was-fine@example.test" },
      "approved",
      "seed",
    );
    await blockSender(db, account.id, { scope: "address", value: "was-fine@example.test" });
    expect((await resolveVerdict(db, account.id, "was-fine@example.test")).verdict).toBe("blocked");
  });

  it("a domain decision answers for every held sender inside that domain", async () => {
    const one = await deliver({ from: "a@conference.test", subject: "Hi 1" });
    const two = await deliver({ from: "b@conference.test", subject: "Hi 2" });

    expect(
      await blockSender(db, account.id, { scope: "domain", value: "conference.test" }),
    ).toEqual({ ok: true });
    expect((await threadRow(one.threadId)).heldSender).toBeNull();
    expect((await threadRow(two.threadId)).heldSender).toBeNull();
    expect((await resolveVerdict(db, account.id, "c@conference.test")).verdict).toBe("blocked");
  });
});

describe("a Blocked Sender's next message (#55, ADR-0008)", () => {
  beforeEach(async () => {
    await enableGatekeeper(db, account.id);
    await reloadAccount();
    await setVerdict(
      db,
      account.id,
      { scope: "address", value: "blocked@example.test" },
      "blocked",
      "screener",
    );
  });

  it("never reaches the Inbox, never pushes, and is queued for a real \\Trash move", async () => {
    const { threadId, messageId } = await deliver({
      from: "blocked@example.test",
      subject: "Ignore me",
    });

    const thread = await threadRow(threadId);
    expect(thread.inInbox).toBe(false);
    expect(thread.heldSender).toBeNull();
    expect(await pendingKinds()).toEqual([]);
    expect(await computeUnreadInboxCount(db, account.userId)).toBe(0);

    const queued = await db
      .select()
      .from(protocolWrites)
      .where(eq(protocolWrites.mailAccountId, account.id));
    expect(queued).toEqual([
      expect.objectContaining({ kind: "trash", messageId, mailAccountId: account.id }),
    ]);
  });

  it("trashes only their own message when they reply into a live conversation", async () => {
    const opener = await deliver({
      from: "colleague@partner.test",
      subject: "Budget",
      messageId: "budget@partner.test",
    });
    await approveSender(db, account.id, { scope: "address", value: "colleague@partner.test" });

    await deliver({
      from: "blocked@example.test",
      subject: "Re: Budget",
      inReplyTo: "budget@partner.test",
    });

    // The conversation the User is actually having stays in their Inbox.
    expect((await threadRow(opener.threadId)).inInbox).toBe(true);
    const queued = await db
      .select()
      .from(protocolWrites)
      .where(eq(protocolWrites.mailAccountId, account.id));
    expect(queued.map((row) => row.kind)).toEqual(["trash"]);
  });
});

describe("disable and Reset (#55)", () => {
  beforeEach(async () => {
    await enableGatekeeper(db, account.id);
    await reloadAccount();
  });

  it("disabling releases every hold but keeps the Verdicts", async () => {
    const { threadId } = await deliver({ from: "stranger@example.test" });
    await setVerdict(
      db,
      account.id,
      { scope: "address", value: "villain@example.test" },
      "blocked",
      "screener",
    );

    const { released } = await disableGatekeeper(db, account.id);
    await reloadAccount();

    expect(released).toBe(1);
    expect((await threadRow(threadId)).heldSender).toBeNull();
    expect(account.gatekeeperEnabled).toBe(false);
    expect((await resolveVerdict(db, account.id, "villain@example.test")).verdict).toBe("blocked");
    // The Cutoff is kept as the record of when screening started.
    expect(account.gatekeeperCutoff).not.toBeNull();
  });

  it("Reset clears every Verdict, re-seeds from Sent history and re-stamps the Cutoff", async () => {
    await db.insert(messages).values({
      id: randomUUID(),
      mailAccountId: account.id,
      threadId: await resolveThread(db, {
        mailAccountId: account.id,
        threadingIds: ["sent-again@example.test"],
        subject: "Sent",
        receivedAt: BEFORE_CUTOFF,
      }),
      folderId: sent.id,
      uid: 7,
      messageIdHeader: "sent-again@example.test",
      subject: "Sent",
      fromAddress: account.emailAddress,
      toAddresses: [{ name: null, address: "trusted@partner.test" }],
      sentAt: BEFORE_CUTOFF,
      receivedAt: BEFORE_CUTOFF,
    });
    await setVerdict(
      db,
      account.id,
      { scope: "address", value: "regret@example.test" },
      "blocked",
      "screener",
    );
    const { threadId } = await deliver({ from: "stranger@example.test" });
    const cutoffBefore = account.gatekeeperCutoff;

    // An explicit `now` a minute on, so the re-stamp is observable — the
    // Cutoff is second-granular (`settings.ts#flooredToSecond`), and a Reset
    // run in the same second as the enable would land on the same value.
    const resetAt = new Date(Date.now() + 60_000);
    const { seeded, released } = await resetGatekeeper(db, account.id, resetAt);
    await reloadAccount();

    expect(seeded).toBe(1);
    expect(released).toBe(1);
    expect(await countApprovedSenders(db, account.id)).toBe(1);
    expect((await resolveVerdict(db, account.id, "trusted@partner.test")).verdict).toBe("approved");
    expect((await resolveVerdict(db, account.id, "regret@example.test")).verdict).toBe(
      "unscreened",
    );
    expect((await threadRow(threadId)).heldSender).toBeNull();
    expect(account.gatekeeperEnabled).toBe(true);
    expect(account.gatekeeperCutoff?.getTime()).toBeGreaterThan(cutoffBefore?.getTime() ?? 0);
  });
});

describe("sending approves live (#55)", () => {
  it("approves every recipient of a successful send, but never un-blocks one", async () => {
    await enableGatekeeper(db, account.id);
    await setVerdict(
      db,
      account.id,
      { scope: "address", value: "blocked@example.test" },
      "blocked",
      "screener",
    );

    await approveSendRecipients(db, account.id, [
      "New.Person@example.test",
      "blocked@example.test",
      "not-an-address",
    ]);

    expect((await resolveVerdict(db, account.id, "new.person@example.test")).verdict).toBe(
      "approved",
    );
    expect((await resolveVerdict(db, account.id, "blocked@example.test")).verdict).toBe("blocked");
    const rows = await db
      .select()
      .from(gatekeeperVerdicts)
      .where(
        and(
          eq(gatekeeperVerdicts.mailAccountId, account.id),
          eq(gatekeeperVerdicts.source, "sent"),
        ),
      );
    expect(rows).toHaveLength(1);
  });

  it("means a stranger the User wrote to first is never screened when they answer", async () => {
    await enableGatekeeper(db, account.id);
    await reloadAccount();
    await approveSendRecipients(db, account.id, ["pen-pal@example.test"]);

    const { threadId } = await deliver({ from: "pen-pal@example.test", subject: "Re: hello" });
    expect((await threadRow(threadId)).heldSender).toBeNull();
  });
});

describe("the Trash folder's absence (#55)", () => {
  it("still records a Block, with nothing queued to move", async () => {
    await db.delete(folders).where(eq(folders.id, trash.id));
    await enableGatekeeper(db, account.id);
    await reloadAccount();
    const { threadId } = await deliver({ from: "stranger@example.test" });

    expect(
      await blockSender(db, account.id, { scope: "address", value: "stranger@example.test" }),
    ).toEqual({ ok: true });
    expect((await threadRow(threadId)).heldSender).toBeNull();
    expect((await threadRow(threadId)).inInbox).toBe(false);
    expect(
      await db.select().from(protocolWrites).where(eq(protocolWrites.mailAccountId, account.id)),
    ).toHaveLength(0);
  });
});
