import { randomUUID } from "node:crypto";
import { LOCAL_CALENDAR_CAPABILITIES, personalCalendarId } from "@mail/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ensurePersonalCalendar } from "../calendars/store.js";
import type { Db } from "../db/client.js";
import { calendars, connectedAccountFacets, type InvitationRow, series } from "../db/schema.js";
import { createTestDb, resetTestDb } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import {
  addInvitationAsPrivateCopy,
  ensureLocalFallbackSeries,
  findSelfAttendee,
  resolveLocalFallbackCalendar,
} from "./local-fallback.js";

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

function localCalendar(
  overrides: Partial<typeof calendars.$inferInsert> & { id: string; userId: string },
) {
  return {
    name: "Some Calendar",
    description: null,
    timeZone: "UTC",
    originType: "local" as const,
    connectedAccountId: null,
    color: "#4285F4",
    isDefault: false,
    mailAccountId: null,
    mirrored: true,
    capabilities: LOCAL_CALENDAR_CAPABILITIES,
    ...overrides,
  };
}

function invitationRow(
  overrides: Partial<InvitationRow> & { mailAccountId: string },
): InvitationRow {
  return {
    id: randomUUID(),
    messageId: randomUUID(),
    threadId: randomUUID(),
    kind: "request",
    method: "REQUEST",
    source: "ical",
    uid: `uid-${randomUUID()}`,
    recurrenceId: "",
    sequence: 0,
    dtstamp: new Date("2026-01-01T00:00:00Z"),
    organizer: { name: "Organiser", address: "organiser@example.com", role: null, partstat: null },
    attendees: [],
    vevent: {
      title: "Standup",
      description: null,
      location: null,
      start: "2026-01-05T09:00:00.000Z",
      end: "2026-01-05T09:30:00.000Z",
      allDay: false,
      tzid: "UTC",
      status: "CONFIRMED",
    },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("resolveLocalFallbackCalendar", () => {
  it("picks the default Calendar when it is among the ones linked to this Mail Account", async () => {
    const account = await createTestMailAccount(db);
    const linkedDefault = randomUUID();
    const linkedOther = randomUUID();
    await db.insert(calendars).values([
      localCalendar({
        id: linkedOther,
        userId: account.userId,
        mailAccountId: account.id,
        createdAt: new Date("2026-01-01T00:00:00Z"),
      }),
      localCalendar({
        id: linkedDefault,
        userId: account.userId,
        mailAccountId: account.id,
        isDefault: true,
        createdAt: new Date("2026-01-02T00:00:00Z"),
      }),
    ]);

    const resolved = await resolveLocalFallbackCalendar(db, account.userId, account.id);
    expect(resolved).toBe(linkedDefault);
  });

  it("falls back to the oldest linked Calendar when none of them is the default", async () => {
    const account = await createTestMailAccount(db);
    const older = randomUUID();
    const newer = randomUUID();
    await db.insert(calendars).values([
      localCalendar({
        id: newer,
        userId: account.userId,
        mailAccountId: account.id,
        createdAt: new Date("2026-01-02T00:00:00Z"),
      }),
      localCalendar({
        id: older,
        userId: account.userId,
        mailAccountId: account.id,
        createdAt: new Date("2026-01-01T00:00:00Z"),
      }),
    ]);

    const resolved = await resolveLocalFallbackCalendar(db, account.userId, account.id);
    expect(resolved).toBe(older);
  });

  it("falls back to the default Calendar when it is Local but not linked to this Mail Account", async () => {
    const account = await createTestMailAccount(db);
    const defaultId = randomUUID();
    await db
      .insert(calendars)
      .values(localCalendar({ id: defaultId, userId: account.userId, isDefault: true }));

    const resolved = await resolveLocalFallbackCalendar(db, account.userId, account.id);
    expect(resolved).toBe(defaultId);
  });

  it("falls back to the Personal Calendar when nothing else applies", async () => {
    const account = await createTestMailAccount(db);
    const resolved = await resolveLocalFallbackCalendar(db, account.userId, account.id);
    expect(resolved).toBe(personalCalendarId(account.userId));
  });
});

describe("findSelfAttendee", () => {
  it("matches the Mail Account's own address or the Message's Alias, case-insensitively", () => {
    const invitation = invitationRow({
      mailAccountId: "x",
      attendees: [{ address: "Bob@Example.com", name: "Bob", role: null, partstat: null }],
    });
    expect(findSelfAttendee(invitation, ["bob@example.com", null])).toBe(true);
    expect(findSelfAttendee(invitation, [null, "bob@example.com"])).toBe(true);
    expect(findSelfAttendee(invitation, ["nobody@example.com"])).toBe(false);
    expect(findSelfAttendee(invitation, [null, null])).toBe(false);
  });
});

describe("ensureLocalFallbackSeries", () => {
  it("creates a fallback Series on the Personal Calendar when the Mail Account has no Calendar Facet", async () => {
    const account = await createTestMailAccount(db);
    await ensurePersonalCalendar(db, account.userId);
    const invitation = invitationRow({
      mailAccountId: account.id,
      attendees: [{ address: account.emailAddress, name: null, role: null, partstat: null }],
    });

    const row = await ensureLocalFallbackSeries(db, account.userId, invitation, [
      account.emailAddress,
    ]);

    expect(row).not.toBeNull();
    expect(row?.calendarId).toBe(personalCalendarId(account.userId));
    expect(row?.uid).toBe(invitation.uid);
    expect(row?.attendees).toEqual([
      { email: account.emailAddress, name: null, responseStatus: "needsAction" },
    ]);
  });

  it("is idempotent: a second call for the same UID returns the same row", async () => {
    const account = await createTestMailAccount(db);
    await ensurePersonalCalendar(db, account.userId);
    const invitation = invitationRow({
      mailAccountId: account.id,
      attendees: [{ address: account.emailAddress, name: null, role: null, partstat: null }],
    });

    const first = await ensureLocalFallbackSeries(db, account.userId, invitation, [
      account.emailAddress,
    ]);
    const second = await ensureLocalFallbackSeries(db, account.userId, invitation, [
      account.emailAddress,
    ]);
    expect(second?.id).toBe(first?.id);

    const rows = await db.select().from(series).where(eq(series.uid, invitation.uid));
    expect(rows).toHaveLength(1);
  });

  it("returns null when the Mail Account's Connected Account has an active Calendar Facet", async () => {
    const account = await createTestMailAccount(db);
    await ensurePersonalCalendar(db, account.userId);
    await db.insert(connectedAccountFacets).values({
      id: randomUUID(),
      connectedAccountId: account.connectedAccountId,
      kind: "calendar",
      status: "active",
    });
    const invitation = invitationRow({
      mailAccountId: account.id,
      attendees: [{ address: account.emailAddress, name: null, role: null, partstat: null }],
    });

    const row = await ensureLocalFallbackSeries(db, account.userId, invitation, [
      account.emailAddress,
    ]);
    expect(row).toBeNull();
  });

  it("returns null when the invited address names no Attendee this Invitation lists", async () => {
    const account = await createTestMailAccount(db);
    await ensurePersonalCalendar(db, account.userId);
    const invitation = invitationRow({
      mailAccountId: account.id,
      attendees: [{ address: "someone-else@example.com", name: null, role: null, partstat: null }],
    });

    const row = await ensureLocalFallbackSeries(db, account.userId, invitation, [
      account.emailAddress,
    ]);
    expect(row).toBeNull();
  });
});

describe("addInvitationAsPrivateCopy", () => {
  it("creates a private copy with no Attendee entry of the User's own", async () => {
    const account = await createTestMailAccount(db);
    await ensurePersonalCalendar(db, account.userId);
    const invitation = invitationRow({
      mailAccountId: account.id,
      attendees: [{ address: "someone-else@example.com", name: null, role: null, partstat: null }],
    });

    const result = await addInvitationAsPrivateCopy(db, account.userId, invitation);
    expect(result).toEqual({ ok: true });

    const [row] = await db.select().from(series).where(eq(series.uid, invitation.uid));
    expect(row?.calendarId).toBe(personalCalendarId(account.userId));
    expect(row?.attendees).toEqual([]);
  });

  it("is idempotent", async () => {
    const account = await createTestMailAccount(db);
    await ensurePersonalCalendar(db, account.userId);
    const invitation = invitationRow({ mailAccountId: account.id });

    await addInvitationAsPrivateCopy(db, account.userId, invitation);
    await addInvitationAsPrivateCopy(db, account.userId, invitation);

    const rows = await db.select().from(series).where(eq(series.uid, invitation.uid));
    expect(rows).toHaveLength(1);
  });
});
