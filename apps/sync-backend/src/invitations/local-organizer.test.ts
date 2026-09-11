import { randomUUID } from "node:crypto";
import { LOCAL_CALENDAR_CAPABILITIES } from "@mail/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { calendars, imipRequests, series } from "../db/schema.js";
import { createTestDb, resetTestDb } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import { claimRequest, dueRequestCandidateIds, queueOrganizerSend } from "./local-organizer.js";

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

async function seedSeries(userId: string, mailAccountId: string) {
  const calendarId = `local:${randomUUID()}`;
  await db.insert(calendars).values({
    id: calendarId,
    userId,
    name: "Personal",
    description: null,
    timeZone: "UTC",
    originType: "local",
    connectedAccountId: null,
    color: "#4285F4",
    isDefault: true,
    mailAccountId,
    mirrored: true,
    capabilities: LOCAL_CALENDAR_CAPABILITIES,
  });
  const [row] = await db
    .insert(series)
    .values({
      id: randomUUID(),
      userId,
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
  if (!row) throw new Error("expected a row");
  return row;
}

describe("queueOrganizerSend", () => {
  it("is a no-op with an empty recipient list", async () => {
    const account = await createTestMailAccount(db);
    const row = await seedSeries(account.userId, account.id);

    const result = await queueOrganizerSend(
      db,
      account.userId,
      row,
      { mailAccountId: account.id, address: account.emailAddress, name: null },
      { method: "REQUEST", recipients: [], bumpSequence: true },
    );

    expect(result).toEqual({ sequence: 0, requestIds: [] });
    expect(await db.select().from(imipRequests)).toHaveLength(0);
  });

  it("bumps series.sequence only when asked, and shares one ics body across recipients", async () => {
    const account = await createTestMailAccount(db);
    const row = await seedSeries(account.userId, account.id);

    const result = await queueOrganizerSend(
      db,
      account.userId,
      row,
      { mailAccountId: account.id, address: account.emailAddress, name: "Alice" },
      {
        method: "REQUEST",
        recipients: [
          { address: "bob@example.com", name: null },
          { address: "carol@example.com", name: null },
        ],
        bumpSequence: true,
      },
    );

    expect(result.sequence).toBe(1);
    expect(result.requestIds).toHaveLength(2);
    const rows = await db.select().from(imipRequests);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.icsText))).toEqual(new Set([rows[0]?.icsText]));
    expect(rows.every((r) => r.sequence === 1)).toBe(true);

    const [seriesRow] = await db.select().from(series).where(eq(series.id, row.id));
    expect(seriesRow?.sequence).toBe(1);
  });
});

describe("the due-Request sweeper candidates", () => {
  it("a freshly-queued Request is not due until its submitAfter passes", async () => {
    const account = await createTestMailAccount(db);
    const row = await seedSeries(account.userId, account.id);
    const { requestIds } = await queueOrganizerSend(
      db,
      account.userId,
      row,
      { mailAccountId: account.id, address: account.emailAddress, name: null },
      {
        method: "REQUEST",
        recipients: [{ address: "bob@example.com", name: null }],
        bumpSequence: false,
      },
    );
    const requestId = requestIds[0];
    if (!requestId) throw new Error("expected a queued Request");

    // `queueOrganizerSend` queues with `submitAfter: now` (no Undo Send
    // delay for organiser mail, ADR-0027) — due immediately, not held.
    expect(await dueRequestCandidateIds(db, new Date())).toContain(requestId);

    const claimed = await claimRequest(db, requestId, () => "msg-id@example.com", new Date());
    expect(claimed?.status).toBe("submitting");
    expect(claimed?.messageId).toBe("msg-id@example.com");
  });
});
