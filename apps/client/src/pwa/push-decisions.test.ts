import { describe, expect, it } from "vitest";
import {
  buildArchiveActionRequest,
  buildNotificationContent,
  hasVisibleClient,
  notificationClickTarget,
  parsePushPayload,
} from "./push-decisions.js";

describe("parsePushPayload", () => {
  it("parses a well-formed new_mail payload", () => {
    const raw = {
      kind: "new_mail",
      mailAccountId: "acct-1",
      threadId: "thread-1",
      senderName: "Alice",
      senderAddress: "alice@example.com",
      subject: "Hi",
      snippet: "Just checking in",
      badgeCount: 3,
    };
    expect(parsePushPayload(raw)).toEqual(raw);
  });

  it("rejects malformed data rather than throwing — untrusted network input", () => {
    expect(parsePushPayload({ kind: "new_mail" })).toBeNull();
    expect(parsePushPayload(null)).toBeNull();
    expect(parsePushPayload("not an object")).toBeNull();
    expect(parsePushPayload({ kind: "unknown_kind" })).toBeNull();
  });
});

describe("buildNotificationContent", () => {
  it("titles a new_mail notification with the sender, tags it by thread, and offers Archive", () => {
    const content = buildNotificationContent({
      kind: "new_mail",
      mailAccountId: "acct-1",
      threadId: "thread-1",
      senderName: "Alice",
      senderAddress: "alice@example.com",
      subject: "Hi",
      snippet: "Just checking in",
      badgeCount: 3,
    });
    expect(content.title).toBe("Alice");
    expect(content.body).toBe("Hi\nJust checking in");
    expect(content.tag).toBe("mail-thread-thread-1");
    expect(content.actions).toEqual([{ action: "archive", title: "Archive" }]);
  });

  it("falls back to the sender address when there's no display name", () => {
    const content = buildNotificationContent({
      kind: "new_mail",
      mailAccountId: "acct-1",
      threadId: "thread-1",
      senderName: null,
      senderAddress: "alice@example.com",
      subject: "Hi",
      snippet: null,
      badgeCount: 0,
    });
    expect(content.title).toBe("alice@example.com");
    expect(content.body).toBe("Hi");
  });

  it("carries no actions on a collapsed burst — the sender is ambiguous", () => {
    const content = buildNotificationContent({
      kind: "new_mail_burst",
      mailAccountId: "acct-1",
      count: 50,
      badgeCount: 50,
    });
    expect(content.title).toBe("50 new messages");
    expect(content.actions).toBeUndefined();
  });

  it("carries the SMTP rejection verbatim for a failed send", () => {
    const content = buildNotificationContent({
      kind: "failed_send",
      mailAccountId: "acct-1",
      compositionId: "comp-1",
      subject: "Re: hi",
      detail: "550 mailbox unavailable",
      badgeCount: 0,
    });
    expect(content.body).toBe("Re: hi: 550 mailbox unavailable");
    expect(content.actions).toBeUndefined();
  });

  it("names the account needing reauth", () => {
    const content = buildNotificationContent({
      kind: "needs_reauth",
      mailAccountId: "acct-1",
      emailAddress: "vic@example.com",
      badgeCount: 0,
    });
    expect(content.body).toContain("vic@example.com");
    expect(content.actions).toBeUndefined();
  });
});

describe("hasVisibleClient", () => {
  it("is true when any client is visible", () => {
    expect(hasVisibleClient([{ visibilityState: "hidden" }, { visibilityState: "visible" }])).toBe(
      true,
    );
  });

  it("is false when every client is hidden, or there are none", () => {
    expect(hasVisibleClient([{ visibilityState: "hidden" }])).toBe(false);
    expect(hasVisibleClient([])).toBe(false);
  });
});

describe("notificationClickTarget", () => {
  it("names the Thread for new_mail", () => {
    expect(
      notificationClickTarget({
        kind: "new_mail",
        mailAccountId: "acct-1",
        threadId: "thread-1",
        senderName: null,
        senderAddress: null,
        subject: "",
        snippet: null,
        badgeCount: 0,
      }),
    ).toEqual({ kind: "thread", mailAccountId: "acct-1", threadId: "thread-1" });
  });

  it("is focus-only for the other three kinds — nothing else to route to on a stacked-section Client", () => {
    expect(
      notificationClickTarget({
        kind: "new_mail_burst",
        mailAccountId: "acct-1",
        count: 2,
        badgeCount: 2,
      }),
    ).toEqual({ kind: "focus-only" });
    expect(
      notificationClickTarget({
        kind: "failed_send",
        mailAccountId: "acct-1",
        compositionId: "c",
        subject: "",
        detail: "",
        badgeCount: 0,
      }),
    ).toEqual({ kind: "focus-only" });
    expect(
      notificationClickTarget({
        kind: "needs_reauth",
        mailAccountId: "acct-1",
        emailAddress: "x@example.com",
        badgeCount: 0,
      }),
    ).toEqual({ kind: "focus-only" });
  });
});

describe("buildArchiveActionRequest", () => {
  it("shapes the direct-POST body around the given ULID", () => {
    expect(buildArchiveActionRequest("acct-1", "thread-1", "01ULID")).toEqual({
      id: "01ULID",
      mailAccountId: "acct-1",
      intent: { type: "archive", threadId: "thread-1" },
    });
  });
});
