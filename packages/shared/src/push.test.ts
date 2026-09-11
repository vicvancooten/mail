import { describe, expect, it } from "vitest";
import {
  notificationActionRequestSchema,
  pushPayloadSchema,
  registerPushSubscriptionRequestSchema,
} from "./push.js";

describe("registerPushSubscriptionRequestSchema", () => {
  it("accepts a well-formed PushSubscription#toJSON() shape", () => {
    const result = registerPushSubscriptionRequestSchema.safeParse({
      endpoint: "https://push.example.test/abc",
      keys: { p256dh: "p256dh-value", auth: "auth-value" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-URL endpoint", () => {
    const result = registerPushSubscriptionRequestSchema.safeParse({
      endpoint: "not-a-url",
      keys: { p256dh: "p", auth: "a" },
    });
    expect(result.success).toBe(false);
  });
});

describe("pushPayloadSchema", () => {
  it("accepts every one of the five kinds, needs_reauth with and without a Mail Account (#204)", () => {
    const payloads = [
      {
        kind: "new_mail",
        mailAccountId: "acct-1",
        threadId: "thread-1",
        senderName: "Alice",
        senderAddress: "alice@example.com",
        subject: "Hi",
        snippet: "Just checking in",
        badgeCount: 1,
      },
      { kind: "new_mail_burst", mailAccountId: "acct-1", count: 50, badgeCount: 50 },
      {
        kind: "failed_send",
        mailAccountId: "acct-1",
        compositionId: "comp-1",
        subject: "Re: hi",
        detail: "550 rejected",
        badgeCount: 0,
      },
      {
        kind: "needs_reauth",
        mailAccountId: "acct-1",
        connectedAccountId: "conn-1",
        facet: "mail",
        emailAddress: "vic@example.com",
        badgeCount: 0,
      },
      {
        kind: "needs_reauth",
        mailAccountId: null,
        connectedAccountId: "conn-1",
        facet: "calendar",
        emailAddress: "vic@example.com",
        badgeCount: 0,
      },
    ];
    for (const payload of payloads) {
      expect(pushPayloadSchema.safeParse(payload).success).toBe(true);
    }
  });

  it("rejects a payload missing the fields its own kind requires", () => {
    expect(pushPayloadSchema.safeParse({ kind: "new_mail", badgeCount: 0 }).success).toBe(false);
  });

  it("accepts the Gatekeeper digest (#55)", () => {
    const result = pushPayloadSchema.safeParse({
      kind: "gatekeeper_digest",
      mailAccountId: "acct-1",
      senders: ["Ada Lovelace", "grace@example.com"],
      count: 3,
      badgeCount: 0,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown kind", () => {
    expect(pushPayloadSchema.safeParse({ kind: "snooze_expired" }).success).toBe(false);
  });

  it("accepts the calendar_reminder kind (#245, #246, ADR-0028), events[] included", () => {
    const result = pushPayloadSchema.safeParse({
      kind: "calendar_reminder",
      events: [
        {
          reminderDueId: "rd-1",
          eventId: "evt-1",
          seriesId: "series-1",
          title: "Standup",
          body: "in 5 min",
        },
      ],
      badgeCount: 0,
    });
    expect(result.success).toBe(true);
  });

  it("accepts the calendar_answer kind (#243), answers[] included", () => {
    const result = pushPayloadSchema.safeParse({
      kind: "calendar_answer",
      eventId: "evt-1",
      seriesId: "series-1",
      title: "Standup",
      answers: [
        { attendeeName: "Ada", attendeeEmail: "ada@example.com", responseStatus: "accepted" },
      ],
      badgeCount: 0,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a calendar_answer responseStatus outside accepted/declined/tentative", () => {
    const result = pushPayloadSchema.safeParse({
      kind: "calendar_answer",
      eventId: "evt-1",
      seriesId: "series-1",
      title: "Standup",
      answers: [
        { attendeeName: null, attendeeEmail: "ada@example.com", responseStatus: "needsAction" },
      ],
      badgeCount: 0,
    });
    expect(result.success).toBe(false);
  });
});

describe("notificationActionRequestSchema", () => {
  it("accepts the one action a mail notification offers", () => {
    const result = notificationActionRequestSchema.safeParse({
      id: "01ULID",
      mailAccountId: "acct-1",
      intent: { type: "archive", threadId: "thread-1" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an intent type outside the allowlist", () => {
    const result = notificationActionRequestSchema.safeParse({
      id: "01ULID",
      mailAccountId: "acct-1",
      intent: { type: "trash", threadId: "thread-1" },
    });
    expect(result.success).toBe(false);
  });

  it("accepts snoozeReminder with a null mailAccountId (#246, ADR-0028) — a Reminder Due row has none", () => {
    const result = notificationActionRequestSchema.safeParse({
      id: "01ULID",
      mailAccountId: null,
      intent: {
        type: "snoozeReminder",
        reminderDueIds: ["rd-1"],
        snoozeUntil: { kind: "minutes", minutes: 5 },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a snoozeUntil minutes value outside the fixed 5/10/15 set", () => {
    const result = notificationActionRequestSchema.safeParse({
      id: "01ULID",
      mailAccountId: null,
      intent: {
        type: "snoozeReminder",
        reminderDueIds: ["rd-1"],
        snoozeUntil: { kind: "minutes", minutes: 7 },
      },
    });
    expect(result.success).toBe(false);
  });

  it("accepts snoozeUntil's 'eventStart' kind", () => {
    const result = notificationActionRequestSchema.safeParse({
      id: "01ULID",
      mailAccountId: null,
      intent: {
        type: "snoozeReminder",
        reminderDueIds: ["rd-1"],
        snoozeUntil: { kind: "eventStart" },
      },
    });
    expect(result.success).toBe(true);
  });
});
