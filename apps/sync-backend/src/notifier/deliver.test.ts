import { randomUUID } from "node:crypto";
import type { PushPayload } from "@mail/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import type { MailAccountRow } from "../mail-accounts/store.js";
import { createTestDb, resetTestDb } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import { deliverPending, type SendPushFn } from "./deliver.js";
import { insertOutboxEntry, listUndelivered } from "./outbox.js";
import { NEW_MAIL_BURST_CAP } from "./policy.js";
import { upsertPushSubscription } from "./subscriptions.js";

/**
 * `deliverPending` against a real Postgres — the burst collapse (poc-scope.md:
 * "past ~5 pushes in a short window, collapse into one 'N new messages'")
 * and the pruning-on-expiry rule (RFC 8030 / ADR-0015) are both stateful
 * enough to want the real outbox/subscriptions tables under them, not a fake
 * store.
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

async function seedSubscription(endpoint = `https://push.test/${randomUUID()}`): Promise<void> {
  await upsertPushSubscription(db, {
    userId: account.userId,
    endpoint,
    p256dh: "p256dh-key",
    auth: "auth-secret",
  });
}

async function seedNewMail(subject: string): Promise<void> {
  await insertOutboxEntry(db, {
    userId: account.userId,
    mailAccountId: account.id,
    kind: "new_mail",
    dedupKey: randomUUID(),
    payload: {
      kind: "new_mail",
      threadId: randomUUID(),
      senderName: "Alice",
      senderAddress: "alice@example.com",
      subject,
      snippet: null,
    },
  });
}

function recordingSender(): { sendPush: SendPushFn; sent: PushPayload[] } {
  const sent: PushPayload[] = [];
  const sendPush: SendPushFn = async (_subscription, payload) => {
    sent.push(payload);
    return { ok: true };
  };
  return { sendPush, sent };
}

describe("deliverPending", () => {
  it("does nothing when the outbox is empty", async () => {
    const { sendPush, sent } = recordingSender();
    const result = await deliverPending(db, { sendPush });
    expect(result).toEqual({ sent: 0, collapsed: 0, pruned: 0 });
    expect(sent).toEqual([]);
  });

  it("sends nothing but still marks the row delivered when no device is subscribed", async () => {
    await seedNewMail("Hi");
    const { sendPush } = recordingSender();
    const result = await deliverPending(db, { sendPush });
    expect(result.sent).toBe(0);
    expect(await listUndelivered(db)).toEqual([]);
  });

  it("sends one push per message under the burst cap, each carrying its own content", async () => {
    await seedSubscription();
    await seedNewMail("First");
    await seedNewMail("Second");

    const { sendPush, sent } = recordingSender();
    const result = await deliverPending(db, { sendPush });

    expect(result.sent).toBe(2);
    expect(result.collapsed).toBe(0);
    expect(
      sent.map((payload) => (payload.kind === "new_mail" ? payload.subject : null)).sort(),
    ).toEqual(["First", "Second"]);
    expect(await listUndelivered(db)).toEqual([]);
  });

  it("collapses a burst past the cap into one 'N new messages' push", async () => {
    await seedSubscription();
    const burstSize = 50;
    for (let i = 0; i < burstSize; i++) await seedNewMail(`Message ${i}`);
    expect(burstSize).toBeGreaterThan(NEW_MAIL_BURST_CAP);

    const { sendPush, sent } = recordingSender();
    const result = await deliverPending(db, { sendPush });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "new_mail_burst", count: burstSize });
    expect(result.sent).toBe(1);
    expect(result.collapsed).toBe(burstSize);
    // Every one of the 50 rows is resolved, not just the ones past the cap.
    expect(await listUndelivered(db)).toEqual([]);
  });

  it("sends to every subscribed device, not just one", async () => {
    await seedSubscription("https://push.test/device-a");
    await seedSubscription("https://push.test/device-b");
    await seedNewMail("Hi");

    const { sendPush, sent } = recordingSender();
    const result = await deliverPending(db, { sendPush });

    expect(result.sent).toBe(2);
    expect(sent).toHaveLength(2);
  });

  it("prunes a subscription on a 404/410 and still marks the event delivered", async () => {
    await seedSubscription();
    await seedNewMail("Hi");

    const sendPush: SendPushFn = async () => ({ ok: false, expired: true });
    const result = await deliverPending(db, { sendPush });

    expect(result.pruned).toBe(1);
    expect(result.sent).toBe(0);
    expect(await listUndelivered(db)).toEqual([]);

    // A second tick has nothing left to send to — the subscription is gone.
    const { sendPush: nextSend, sent } = recordingSender();
    await seedNewMail("Second");
    await deliverPending(db, { sendPush: nextSend });
    expect(sent).toEqual([]);
  });

  it("leaves a row undelivered on a transient failure so the next tick retries it", async () => {
    await seedSubscription();
    await seedNewMail("Hi");

    const sendPush: SendPushFn = async () => ({ ok: false, expired: false });
    await deliverPending(db, { sendPush });

    expect(await listUndelivered(db)).toHaveLength(1);
  });

  it("delivers failed_send and needs_reauth kinds individually, never collapsed", async () => {
    await seedSubscription();
    await insertOutboxEntry(db, {
      userId: account.userId,
      mailAccountId: account.id,
      kind: "needs_reauth",
      dedupKey: `${account.id}:1`,
      payload: { kind: "needs_reauth", emailAddress: account.emailAddress },
    });
    await insertOutboxEntry(db, {
      userId: account.userId,
      mailAccountId: account.id,
      kind: "failed_send",
      dedupKey: "composition-1",
      payload: {
        kind: "failed_send",
        compositionId: "composition-1",
        subject: "Re: hi",
        detail: "550 rejected",
      },
    });

    const { sendPush, sent } = recordingSender();
    await deliverPending(db, { sendPush });

    expect(sent.map((payload) => payload.kind).sort()).toEqual(["failed_send", "needs_reauth"]);
    expect(await listUndelivered(db)).toEqual([]);
  });

  it("carries the current unread-Inbox count on every payload, computed at delivery time", async () => {
    await seedSubscription();
    await seedNewMail("Hi");
    // No Threads seeded — the badge is 0 either way; this asserts the field
    // is actually present rather than testing the counter's own arithmetic
    // (that's `badge.test.ts`'s job).
    const { sendPush, sent } = recordingSender();
    await deliverPending(db, { sendPush });
    expect(sent[0]?.badgeCount).toBe(0);
  });
});

describe("subscription-independent rows across users are grouped correctly", () => {
  it("never sends one User's outbox row to another User's subscription", async () => {
    const otherAccount = await createTestMailAccount(db);
    await upsertPushSubscription(db, {
      userId: otherAccount.userId,
      endpoint: "https://push.test/other-user-device",
      p256dh: "k",
      auth: "a",
    });
    await seedNewMail("Hi"); // belongs to `account`, which has no subscription

    const { sendPush, sent } = recordingSender();
    await deliverPending(db, { sendPush });

    expect(sent).toEqual([]);
    expect(await listUndelivered(db)).toEqual([]);
  });
});
