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
  it("accepts every one of the four kinds", () => {
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

  it("rejects an unknown kind", () => {
    expect(pushPayloadSchema.safeParse({ kind: "gatekeeper_digest" }).success).toBe(false);
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
});
