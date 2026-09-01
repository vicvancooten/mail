import { randomUUID } from "node:crypto";
import type { ComposeDocument } from "@mail/shared";
import { eq } from "drizzle-orm";
import type Mail from "nodemailer/lib/mailer/index.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { compositions } from "../db/schema.js";
import {
  getMailAccountById,
  type MailAccountRow,
  markNeedsReauth,
} from "../mail-accounts/store.js";
import { createTestDb, resetTestDb } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import { acceptSend, MAX_SEND_ATTEMPTS, retryDelayMs } from "./pending-send.js";
import { type AppendToSent, sweepDueSends } from "./send-sweeper.js";

/**
 * The sweep, end to end, with the mail server stood in for: claim → submit →
 * `Sent` APPEND, the three-way failure split, and the two exactly-once
 * properties the ticket names — "kill the process mid-delay: mail sends after
 * restart, exactly once", and a second sweep finding nothing left to do.
 *
 * The real SMTP and IMAP conversations are `send.greenmail.test.ts`'s; what
 * cannot be tested against GreenMail at all is failure, because GreenMail
 * accepts everything (docs/dev-setup.md) — hence the injected transport.
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

async function insertPendingSend(delaySeconds = 0, acceptedAt = new Date()) {
  const id = randomUUID();
  await db.insert(compositions).values({
    id,
    mailAccountId: account.id,
    subject: "Lunch",
    document: DOC,
    toAddresses: [{ name: null, address: "ada@example.test" }],
    version: 1,
  });
  await acceptSend(db, account.id, id, delaySeconds, acceptedAt);
  return id;
}

async function row(id: string) {
  const [found] = await db.select().from(compositions).where(eq(compositions.id, id)).limit(1);
  if (!found) throw new Error("composition row vanished");
  return found;
}

interface Recorder {
  transmitted: Mail.Options[];
  appended: { compositionId: string; mime: string }[];
  appendToSent: AppendToSent;
}

function recorder(): Recorder {
  const rec: Recorder = {
    transmitted: [],
    appended: [],
    appendToSent: async ({ row: composition, mime }) => {
      rec.appended.push({ compositionId: composition.id, mime: mime.toString("utf8") });
    },
  };
  return rec;
}

function sweep(rec: Recorder, sendMail?: (options: Mail.Options) => Promise<unknown>, now?: Date) {
  return sweepDueSends(db, (id) => getMailAccountById(db, id), {
    credentialKey: Buffer.alloc(32),
    appendToSent: rec.appendToSent,
    sendMail:
      sendMail ??
      (async (options) => {
        rec.transmitted.push(options);
      }),
    ...(now ? { now } : {}),
  });
}

describe("sweepDueSends", () => {
  it("submits a due send once, writes it to Sent, and marks the Composition sent", async () => {
    const id = await insertPendingSend();
    const rec = recorder();

    expect(await sweep(rec)).toMatchObject({ processed: 1, sent: 1 });
    expect(rec.transmitted).toHaveLength(1);

    const after = await row(id);
    expect(after.status).toBe("sent");
    expect(after.sentAt).not.toBeNull();
    expect(after.messageId).not.toBeNull();
    // The `Sent` copy carries the same minted id the recipient's copy did.
    expect(rec.appended[0]?.mime).toContain(`<${after.messageId}>`);
  });

  it("leaves nothing behind for a second sweep — the mail goes out exactly once", async () => {
    await insertPendingSend();
    const rec = recorder();

    await sweep(rec);
    expect(await sweep(rec)).toMatchObject({ processed: 0, sent: 0 });
    expect(rec.transmitted).toHaveLength(1);
  });

  it("sends an overdue Pending Send after a restart, exactly once", async () => {
    // The shape of "kill the process mid-delay": the row was accepted with a
    // 10s window five minutes ago and nothing ever swept it.
    const id = await insertPendingSend(10, new Date(Date.now() - 5 * 60_000));
    const rec = recorder();

    // A fresh boot's very first sweep. `submit_after` being absolute is the
    // whole mechanism — nothing here knows a restart happened.
    expect(await sweep(rec)).toMatchObject({ sent: 1 });
    expect(rec.transmitted).toHaveLength(1);
    expect((await row(id)).status).toBe("sent");

    expect(await sweep(rec)).toMatchObject({ processed: 0 });
    expect(rec.transmitted).toHaveLength(1);
  });

  it("does not touch a send whose Undo window has not elapsed", async () => {
    await insertPendingSend(30);
    const rec = recorder();
    expect(await sweep(rec)).toMatchObject({ processed: 0 });
    expect(rec.transmitted).toEqual([]);
  });

  it("returns a permanent rejection to a Draft badged with the server's text, and never writes to Sent", async () => {
    const id = await insertPendingSend();
    const rec = recorder();

    const result = await sweep(rec, async () => {
      throw Object.assign(new Error("Message failed"), {
        responseCode: 550,
        response: "550 5.7.1 relay denied",
      });
    });

    expect(result).toMatchObject({ failed: 1, sent: 0 });
    const after = await row(id);
    expect(after.status).toBe("draft");
    expect(after.sendError).toBe("550 5.7.1 relay denied");
    // ADR-0007: nothing is written to `Sent` until submission succeeds.
    expect(rec.appended).toEqual([]);
  });

  it("retries a transient failure with backoff, keeping one Message-ID across both attempts", async () => {
    const id = await insertPendingSend();
    const rec = recorder();
    const firstSweepAt = new Date();

    let attempts = 0;
    const flaky = async (options: Mail.Options) => {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error("Message failed"), {
          responseCode: 451,
          response: "451 4.3.0 try again later",
        });
      }
      rec.transmitted.push(options);
    };

    expect(await sweep(rec, flaky, firstSweepAt)).toMatchObject({ retried: 1 });
    const held = await row(id);
    expect(held.status).toBe("submitting");
    expect(held.sendError).toBe("451 4.3.0 try again later");
    expect(held.nextAttemptAt?.getTime()).toBe(firstSweepAt.getTime() + retryDelayMs(1));
    const mintedId = held.messageId;

    // Nothing to do until the backoff elapses.
    expect(await sweep(rec, flaky, firstSweepAt)).toMatchObject({ processed: 0 });

    const later = new Date(firstSweepAt.getTime() + retryDelayMs(1) + 1_000);
    expect(await sweep(rec, flaky, later)).toMatchObject({ sent: 1 });
    const after = await row(id);
    expect(after.status).toBe("sent");
    expect(after.messageId).toBe(mintedId);
    expect(after.sendError).toBeNull();
    expect(rec.appended[0]?.mime).toContain(`<${mintedId}>`);
  });

  it("gives up on a send that has exhausted its retries, as a badged Draft", async () => {
    const id = await insertPendingSend();
    await db
      .update(compositions)
      .set({ status: "submitting", sendAttempts: MAX_SEND_ATTEMPTS - 1, nextAttemptAt: new Date() })
      .where(eq(compositions.id, id));
    const rec = recorder();

    const result = await sweep(rec, async () => {
      throw Object.assign(new Error("Message failed"), {
        responseCode: 421,
        response: "421 service not available",
      });
    });

    expect(result).toMatchObject({ failed: 1 });
    const after = await row(id);
    expect(after.status).toBe("draft");
    expect(after.sendError).toBe("421 service not available");
  });

  it("holds the send and parks the Mail Account in Needs Reauth when the credential is rejected", async () => {
    const id = await insertPendingSend();
    const rec = recorder();

    const result = await sweep(rec, async () => {
      throw Object.assign(new Error("Invalid login: 535 authentication failed"), { code: "EAUTH" });
    });

    expect(result).toMatchObject({ held: 1, sent: 0, failed: 0 });
    expect((await getMailAccountById(db, account.id))?.status).toBe("needs_reauth");
    const after = await row(id);
    expect(after.status).toBe("pending");
    expect(after.sendAttempts).toBe(0);
    expect(rec.appended).toEqual([]);
  });

  it("holds a Needs Reauth account's due send indefinitely without ever claiming it", async () => {
    const id = await insertPendingSend();
    await markNeedsReauth(db, account.id);
    const rec = recorder();
    expect(await sweep(rec)).toMatchObject({ held: 1, sent: 0 });
    // Untouched: not claimed, no attempt burned, no Message-ID minted.
    const after = await row(id);
    expect(after.status).toBe("pending");
    expect(after.sendAttempts).toBe(0);
    expect(after.messageId).toBeNull();
    expect(rec.transmitted).toEqual([]);
  });

  it("still marks a send sent when the Sent APPEND itself fails — the mail is already out", async () => {
    const id = await insertPendingSend();
    const rec = recorder();
    const failingAppend: AppendToSent = async () => {
      throw new Error("IMAP APPEND failed");
    };

    const result = await sweepDueSends(db, (accountId) => getMailAccountById(db, accountId), {
      credentialKey: Buffer.alloc(32),
      appendToSent: failingAppend,
      sendMail: async (options) => {
        rec.transmitted.push(options);
      },
    });

    expect(result).toMatchObject({ sent: 1 });
    expect((await row(id)).status).toBe("sent");
    expect(rec.transmitted).toHaveLength(1);
  });
});
