import { randomUUID } from "node:crypto";
import type { ComposeDocument } from "@mail/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { compositions, syncTombstones } from "../db/schema.js";
import type { MailAccountRow } from "../mail-accounts/store.js";
import { createTestDb, resetTestDb } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import {
  acceptSend,
  cancelSend,
  claimSend,
  dueSendCandidateIds,
  MAX_SEND_ATTEMPTS,
  markPermanentFailure,
  markSent,
  mintMessageId,
  pruneSentCompositions,
  releaseForReauth,
  retryDelayMs,
  SENT_RETENTION_MS,
  scheduleRetry,
} from "./pending-send.js";

/**
 * ADR-0007's state machine, at the level the ADR itself argues about: an
 * atomic claim, a cancel that loses *and says so*, an absolute `submit_after`
 * that survives a restart, `off` as `N = 0` rather than a bypass, and the
 * three-way failure split.
 */

let db: Db;
let closeDb: () => Promise<void>;
let account: MailAccountRow;

const DOC: ComposeDocument = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }],
};

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

async function insertDraft(overrides: Partial<typeof compositions.$inferInsert> = {}) {
  const id = overrides.id ?? randomUUID();
  await db.insert(compositions).values({
    id,
    mailAccountId: account.id,
    subject: "Subject",
    document: DOC,
    toAddresses: [{ name: null, address: "someone@example.test" }],
    version: 1,
    ...overrides,
  });
  return id;
}

async function row(id: string) {
  const [found] = await db.select().from(compositions).where(eq(compositions.id, id)).limit(1);
  if (!found) throw new Error("composition row vanished");
  return found;
}

describe("acceptSend", () => {
  it("moves a Draft to pending with an absolute submit_after measured from the server's clock", async () => {
    const id = await insertDraft();
    const now = new Date("2026-09-01T12:00:00.000Z");

    const result = await acceptSend(db, account.id, id, 10, now);

    expect(result).toEqual({ status: "accepted", submitAfter: new Date("2026-09-01T12:00:10Z") });
    const after = await row(id);
    expect(after.status).toBe("pending");
    expect(after.submitAfter?.toISOString()).toBe("2026-09-01T12:00:10.000Z");
  });

  it("treats the `off` delay as N = 0 — a Pending Send row that is simply already due", async () => {
    const id = await insertDraft();
    const now = new Date("2026-09-01T12:00:00.000Z");

    await acceptSend(db, account.id, id, 0, now);

    // The row exists (ADR-0007 rejected a synchronous bypass) and the sweeper
    // finds it immediately, which is the entire difference `off` makes.
    expect((await row(id)).status).toBe("pending");
    expect(await dueSendCandidateIds(db, now)).toEqual([id]);
  });

  it("clears a previous permanent rejection's badge — sending again is what 'resolved' means", async () => {
    const id = await insertDraft({ sendError: "550 5.7.1 relay denied" });
    await acceptSend(db, account.id, id, 5);
    expect((await row(id)).sendError).toBeNull();
  });

  it("rejects a Composition with no recipient at all, rather than queuing an unsendable message", async () => {
    const id = await insertDraft({ toAddresses: [] });
    expect(await acceptSend(db, account.id, id, 10)).toEqual({
      status: "rejected",
      reason: "no_recipients",
    });
    expect((await row(id)).status).toBe("draft");
  });

  it("rejects a Composition whose only recipients are syntactically invalid, not just an empty list", async () => {
    // Non-empty, but garbage — e.g. a partial chip a client-side race left
    // behind (#4). `recipientCount` alone would let this through; validity
    // must be checked instead.
    const id = await insertDraft({
      toAddresses: [{ name: null, address: "jo" }],
      ccAddresses: [{ name: null, address: "not-an-address" }],
    });
    expect(await acceptSend(db, account.id, id, 10)).toEqual({
      status: "rejected",
      reason: "no_recipients",
    });
    expect((await row(id)).status).toBe("draft");
  });

  it("rejects a Composition that is not a Draft — a Pending Send is never re-armed in place", async () => {
    const id = await insertDraft({ status: "pending", submitAfter: new Date() });
    expect(await acceptSend(db, account.id, id, 10)).toEqual({
      status: "rejected",
      reason: "not_a_draft",
    });
  });

  it("rejects an id belonging to another Mail Account", async () => {
    const other = await createTestMailAccount(db);
    const id = await insertDraft();
    expect(await acceptSend(db, other.id, id, 10)).toEqual({
      status: "rejected",
      reason: "not_found",
    });
  });
});

describe("cancelSend", () => {
  it("restores a Draft with its content untouched — a status change, not a copy", async () => {
    const id = await insertDraft({ subject: "Dinner plans" });
    await acceptSend(db, account.id, id, 10);

    expect(await cancelSend(db, account.id, id)).toEqual({ status: "cancelled" });
    const after = await row(id);
    expect(after.status).toBe("draft");
    expect(after.submitAfter).toBeNull();
    expect(after.subject).toBe("Dinner plans");
    expect(after.document).toEqual(DOC);
  });

  it("loses to the claim and says so: a cancel after `submitting` is `too_late`", async () => {
    const id = await insertDraft();
    await acceptSend(db, account.id, id, 0);
    await claimSend(db, id, () => mintMessageId(account.emailAddress));

    expect(await cancelSend(db, account.id, id)).toEqual({
      status: "rejected",
      reason: "too_late",
    });
    expect((await row(id)).status).toBe("submitting");
  });
});

describe("claimSend", () => {
  it("is atomic: two claims racing one due row, exactly one wins", async () => {
    const id = await insertDraft();
    await acceptSend(db, account.id, id, 0);

    const [first, second] = await Promise.all([
      claimSend(db, id, () => mintMessageId(account.emailAddress)),
      claimSend(db, id, () => mintMessageId(account.emailAddress)),
    ]);

    const winners = [first, second].filter((row) => row !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.status).toBe("submitting");
    expect(winners[0]?.sendAttempts).toBe(1);
  });

  it("is atomic against a cancel racing it: never both claimed and cancelled", async () => {
    const id = await insertDraft();
    await acceptSend(db, account.id, id, 0);

    const [claimed, cancelled] = await Promise.all([
      claimSend(db, id, () => mintMessageId(account.emailAddress)),
      cancelSend(db, account.id, id),
    ]);

    // One or the other, never both — and the row's status agrees with whoever
    // won, which is what "submission is the point of no return" rests on.
    expect(claimed !== null).not.toBe(cancelled.status === "cancelled");
    expect((await row(id)).status).toBe(claimed ? "submitting" : "draft");
  });

  it("mints the Message-ID before Nodemailer could ever see it, and a retry re-uses it", async () => {
    const id = await insertDraft();
    await acceptSend(db, account.id, id, 0);

    const first = await claimSend(db, id, () => mintMessageId(account.emailAddress));
    expect(first?.messageId).toMatch(/@mail\.test$/);
    expect(first?.sendAttempts).toBe(1);
    if (!first) throw new Error("claim failed");

    // The real retry path: a transient failure schedules the next attempt,
    // and *that* is what makes the row claimable again. Two ids here would be
    // two messages in the world.
    await scheduleRetry(db, first, "451 try again", new Date(Date.now() - retryDelayMs(1) - 1_000));
    const second = await claimSend(db, id, () => mintMessageId(account.emailAddress));
    expect(second?.messageId).toBe(first.messageId);
    expect(second?.sendAttempts).toBe(2);
  });

  it("refuses a submitting row with no scheduled retry — one already inside an SMTP conversation", async () => {
    const id = await insertDraft();
    await acceptSend(db, account.id, id, 0);
    await claimSend(db, id, () => mintMessageId(account.emailAddress));
    expect(await claimSend(db, id, () => mintMessageId(account.emailAddress))).toBeNull();
  });

  it("returns null for a row cancelled out from under it", async () => {
    const id = await insertDraft();
    await acceptSend(db, account.id, id, 0);
    await cancelSend(db, account.id, id);
    expect(await claimSend(db, id, () => mintMessageId(account.emailAddress))).toBeNull();
  });
});

describe("dueSendCandidateIds", () => {
  it("includes an overdue row however long it has been overdue — the boot-time sweep", async () => {
    const id = await insertDraft();
    // A send accepted an hour ago against a backend that was then killed.
    await acceptSend(db, account.id, id, 10, new Date(Date.now() - 60 * 60_000));
    expect(await dueSendCandidateIds(db)).toEqual([id]);
  });

  it("excludes a row whose window has not elapsed", async () => {
    const id = await insertDraft();
    await acceptSend(db, account.id, id, 30);
    expect(await dueSendCandidateIds(db)).toEqual([]);
  });

  it("includes a submitting row whose retry backoff has elapsed, and excludes one still waiting", async () => {
    const due = await insertDraft({
      status: "submitting",
      sendAttempts: 1,
      nextAttemptAt: new Date(Date.now() - 1_000),
    });
    await insertDraft({
      status: "submitting",
      sendAttempts: 1,
      nextAttemptAt: new Date(Date.now() + 60_000),
    });
    expect(await dueSendCandidateIds(db)).toEqual([due]);
  });

  it("excludes a submitting row with no scheduled retry — one actively in an SMTP conversation", async () => {
    await insertDraft({ status: "submitting", sendAttempts: 1, nextAttemptAt: null });
    expect(await dueSendCandidateIds(db)).toEqual([]);
  });
});

describe("failure transitions", () => {
  it("returns a permanent rejection to a Draft badged with the server's text verbatim", async () => {
    const id = await insertDraft({ status: "submitting", messageId: "kept@mail.test" });
    await markPermanentFailure(db, id, "550 5.7.1 relay denied");

    const after = await row(id);
    expect(after.status).toBe("draft");
    expect(after.sendError).toBe("550 5.7.1 relay denied");
    expect(after.submitAfter).toBeNull();
    // Re-used if the User sends again, so one rejected mail never becomes two.
    expect(after.messageId).toBe("kept@mail.test");
  });

  it("keeps a transient failure inside `submitting` with a doubling backoff", async () => {
    const id = await insertDraft({ status: "submitting", sendAttempts: 1 });
    const now = new Date("2026-09-01T12:00:00.000Z");

    expect(await scheduleRetry(db, await row(id), "451 try again later", now)).toEqual({
      retrying: true,
    });
    const after = await row(id);
    expect(after.status).toBe("submitting");
    expect(after.sendError).toBe("451 try again later");
    expect(after.nextAttemptAt?.getTime()).toBe(now.getTime() + retryDelayMs(1));
    expect(retryDelayMs(2)).toBe(2 * retryDelayMs(1));
  });

  it("gives up on a transient failure eventually rather than retrying in silence forever", async () => {
    const id = await insertDraft({ status: "submitting", sendAttempts: MAX_SEND_ATTEMPTS });
    expect(await scheduleRetry(db, await row(id), "451 still down")).toEqual({ retrying: false });

    const after = await row(id);
    expect(after.status).toBe("draft");
    expect(after.sendError).toBe("451 still down");
  });

  it("holds a Needs Reauth account's send indefinitely, without burning an attempt", async () => {
    const id = await insertDraft();
    await acceptSend(db, account.id, id, 0, new Date(Date.now() - 5_000));
    const claimed = await claimSend(db, id, () => mintMessageId(account.emailAddress));
    if (!claimed) throw new Error("claim failed");

    await releaseForReauth(db, claimed);

    const after = await row(id);
    expect(after.status).toBe("pending");
    expect(after.sendAttempts).toBe(0);
    // Still due, so the first sweep after the User re-authenticates sends it.
    expect(await dueSendCandidateIds(db)).toEqual([id]);
  });
});

describe("pruneSentCompositions", () => {
  it("retires a sent Composition with a tombstone, so every Client learns the row is gone", async () => {
    const id = await insertDraft();
    await markSent(db, id, new Date(Date.now() - SENT_RETENTION_MS - 1_000));

    expect(await pruneSentCompositions(db)).toBe(1);
    expect(
      await db.select().from(compositions).where(eq(compositions.id, id)).limit(1),
    ).toHaveLength(0);

    const [tombstone] = await db
      .select()
      .from(syncTombstones)
      .where(eq(syncTombstones.entityId, id));
    expect(tombstone?.collection).toBe("Composition");
    expect(tombstone?.mailAccountId).toBe(account.id);
  });

  it("leaves a just-sent Composition alone, so a watching device sees it read `sent` first", async () => {
    const id = await insertDraft();
    await markSent(db, id);
    expect(await pruneSentCompositions(db)).toBe(0);
    expect((await row(id)).status).toBe("sent");
  });
});
