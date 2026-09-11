import { randomUUID } from "node:crypto";
import { LOCAL_CALENDAR_CAPABILITIES } from "@mail/shared";
import { eq } from "drizzle-orm";
import type Mail from "nodemailer/lib/mailer/index.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { calendars, imipRequests, series } from "../db/schema.js";
import { getMailAccountById, type MailAccountRow } from "../mail-accounts/store.js";
import { createTestDb, resetTestDb } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import { queueOrganizerSend } from "./local-organizer.js";
import { type AppendRequestToSent, sweepDueRequests } from "./request-sweeper.js";

/**
 * The `imip_requests` sweep, end to end (#242, ADR-0027) —
 * `reply-sweeper.test.ts`'s own shape: claim → submit → `Sent` APPEND, and
 * the three-way failure split reused from `compose/submit.ts#classifyFailure`.
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

async function queueDueRequest(): Promise<string> {
  const calendarId = `local:${randomUUID()}`;
  await db.insert(calendars).values({
    id: calendarId,
    userId: account.userId,
    name: "Personal",
    description: null,
    timeZone: "UTC",
    originType: "local",
    connectedAccountId: null,
    color: "#4285F4",
    isDefault: true,
    mailAccountId: account.id,
    mirrored: true,
    capabilities: LOCAL_CALENDAR_CAPABILITIES,
  });
  const seriesId = randomUUID();
  const [seriesRow] = await db
    .insert(series)
    .values({
      id: seriesId,
      userId: account.userId,
      calendarId,
      uid: "uid-1",
      title: "Standup",
      allDay: false,
      floating: false,
      tzid: "UTC",
      dtstart: new Date("2026-01-05T09:00:00.000Z"),
      durationMs: 30 * 60 * 1000,
      transparency: "opaque",
      attendees: [{ email: "bob@example.com", name: null, responseStatus: "needsAction" }],
    })
    .returning();
  if (!seriesRow) throw new Error("expected a row");

  const { requestIds } = await queueOrganizerSend(
    db,
    account.userId,
    seriesRow,
    { mailAccountId: account.id, address: account.emailAddress, name: null },
    {
      method: "REQUEST",
      recipients: [{ address: "bob@example.com", name: null }],
      bumpSequence: false,
    },
  );
  const requestId = requestIds[0];
  if (!requestId) throw new Error("expected a queued Request");
  await db
    .update(imipRequests)
    .set({ submitAfter: new Date(0) })
    .where(eq(imipRequests.id, requestId));
  return requestId;
}

interface Recorder {
  transmitted: Mail.Options[];
  appended: { requestId: string; mime: string }[];
  appendToSent: AppendRequestToSent;
}

function recorder(): Recorder {
  const rec: Recorder = {
    transmitted: [],
    appended: [],
    appendToSent: async ({ row: request, mime }) => {
      rec.appended.push({ requestId: request.id, mime: mime.toString("utf8") });
    },
  };
  return rec;
}

function sweep(rec: Recorder, sendMail?: (options: Mail.Options) => Promise<unknown>) {
  return sweepDueRequests(db, (id) => getMailAccountById(db, id), {
    credentialKey: Buffer.alloc(32),
    appendToSent: rec.appendToSent,
    sendMail:
      sendMail ??
      (async (options) => {
        rec.transmitted.push(options);
      }),
  });
}

describe("sweepDueRequests", () => {
  it("submits a due Request as a text/calendar; method=REQUEST mail and appends it to Sent", async () => {
    const requestId = await queueDueRequest();
    const rec = recorder();

    const result = await sweep(rec);

    expect(result).toMatchObject({ processed: 1, sent: 1 });
    expect(rec.transmitted).toHaveLength(1);
    expect(rec.transmitted[0]).toMatchObject({
      from: account.emailAddress,
      to: "bob@example.com",
    });
    expect(rec.transmitted[0]?.icalEvent).toMatchObject({ method: "REQUEST" });
    expect(rec.appended).toHaveLength(1);
    expect(rec.appended[0]?.mime).toContain("METHOD:REQUEST");

    const [row] = await db.select().from(imipRequests).where(eq(imipRequests.id, requestId));
    expect(row?.status).toBe("sent");
  });

  it("retries a transient SMTP failure and leaves the Request queued", async () => {
    await queueDueRequest();
    const rec = recorder();

    const result = await sweep(rec, async () => {
      throw Object.assign(new Error("try again"), { responseCode: 450 });
    });

    expect(result).toMatchObject({ processed: 1, retried: 1 });
    const [row] = await db
      .select()
      .from(imipRequests)
      .where(eq(imipRequests.mailAccountId, account.id));
    expect(row?.status).toBe("submitting");
    expect(row?.nextAttemptAt).not.toBeNull();
  });

  it("a permanent SMTP rejection cancels the Request rather than retrying forever", async () => {
    await queueDueRequest();
    const rec = recorder();

    const result = await sweep(rec, async () => {
      throw Object.assign(new Error("rejected"), { responseCode: 550, response: "550 5.7.1 no" });
    });

    expect(result).toMatchObject({ processed: 1, failed: 1 });
    const [row] = await db
      .select()
      .from(imipRequests)
      .where(eq(imipRequests.mailAccountId, account.id));
    expect(row?.status).toBe("cancelled");
    expect(row?.sendError).toContain("550");
  });
});
