import { describe, expect, it } from "vitest";
import {
  buildArchiveActionRequest,
  buildNotificationContent,
  buildSnoozeActionRequest,
  hasVisibleClient,
  notificationClickTarget,
  notificationTargetUrl,
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
      connectedAccountId: "conn-1",
      facet: "mail",
      emailAddress: "vic@example.com",
      badgeCount: 0,
    });
    expect(content.body).toContain("vic@example.com");
    expect(content.actions).toBeUndefined();
  });

  it("names the Facet, not a password, for a Calendar/Contacts needs_reauth (#204)", () => {
    const content = buildNotificationContent({
      kind: "needs_reauth",
      mailAccountId: null,
      connectedAccountId: "conn-1",
      facet: "calendar",
      emailAddress: "vic@example.com",
      badgeCount: 0,
    });
    expect(content.body).toBe("Calendar for vic@example.com needs reconnecting.");
  });

  it("titles a calendar_reminder by its one Event, tagged by that Event, and offers Snooze (#245, #246, ADR-0028)", () => {
    const content = buildNotificationContent({
      kind: "calendar_reminder",
      events: [
        {
          reminderDueId: "rd-1",
          eventId: "evt-1",
          seriesId: "series-1",
          title: "Standup",
          body: "in 5 min · 9:00 AM",
        },
      ],
      badgeCount: 0,
    });
    expect(content).toEqual({
      title: "Standup",
      body: "in 5 min · 9:00 AM",
      tag: "calendar-reminder-evt-1",
      actions: [{ action: "snooze", title: "Snooze 5 min" }],
    });
  });

  it("joins every Event's own body when a Reminder group fires together, keeping the earliest Event's tag", () => {
    const content = buildNotificationContent({
      kind: "calendar_reminder",
      events: [
        {
          reminderDueId: "rd-1",
          eventId: "evt-1",
          seriesId: "series-1",
          title: "Standup",
          body: "in 5 min",
        },
        {
          reminderDueId: "rd-2",
          eventId: "evt-2",
          seriesId: "series-2",
          title: "1:1",
          body: "now",
        },
      ],
      badgeCount: 0,
    });
    expect(content.title).toBe("Standup");
    expect(content.body).toBe("in 5 min\nnow");
    expect(content.tag).toBe("calendar-reminder-evt-1");
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

  it("names the Composition to reopen for a failed send", () => {
    expect(
      notificationClickTarget({
        kind: "failed_send",
        mailAccountId: "acct-1",
        compositionId: "c",
        subject: "",
        detail: "",
        badgeCount: 0,
      }),
    ).toEqual({ kind: "failed-send", mailAccountId: "acct-1", compositionId: "c" });
  });

  it("names the Facet cell whose settings/reauth screen to jump to for needs_reauth (#204)", () => {
    expect(
      notificationClickTarget({
        kind: "needs_reauth",
        mailAccountId: "acct-1",
        connectedAccountId: "conn-1",
        facet: "mail",
        emailAddress: "x@example.com",
        badgeCount: 0,
      }),
    ).toEqual({ kind: "needs-reauth", connectedAccountId: "conn-1", facet: "mail" });
  });

  it("is focus-only for a collapsed burst — an Inbox digest is ambiguous about which Thread to land on", () => {
    expect(
      notificationClickTarget({
        kind: "new_mail_burst",
        mailAccountId: "acct-1",
        count: 2,
        badgeCount: 2,
      }),
    ).toEqual({ kind: "focus-only" });
  });

  it("names the Screener for a Gatekeeper digest — a coalesced hold deep-links there, not to a single sender", () => {
    expect(
      notificationClickTarget({
        kind: "gatekeeper_digest",
        mailAccountId: "acct-1",
        count: 2,
        senders: ["Ada"],
        badgeCount: 0,
      }),
    ).toEqual({ kind: "screener", mailAccountId: "acct-1" });
  });

  it("names the Event (and its Reminder Due rows) for calendar_reminder, landing on the Day view at the earliest start (#246, ADR-0028)", () => {
    expect(
      notificationClickTarget({
        kind: "calendar_reminder",
        events: [
          {
            reminderDueId: "rd-1",
            eventId: "evt-1",
            seriesId: "series-1",
            title: "Standup",
            body: "in 5 min",
          },
          {
            reminderDueId: "rd-2",
            eventId: "evt-2",
            seriesId: "series-2",
            title: "1:1",
            body: "now",
          },
        ],
        badgeCount: 0,
      }),
    ).toEqual({ kind: "calendar-event", eventId: "evt-1", reminderDueIds: ["rd-1", "rd-2"] });
  });
});

describe("notificationTargetUrl", () => {
  it("deep-links a Thread into Mail with it selected, and the target's Mail Account so a narrowed Scope widens", () => {
    expect(
      notificationTargetUrl({ kind: "thread", mailAccountId: "acct-1", threadId: "t-1" }),
    ).toBe("/mail?thread=t-1&account=acct-1");
  });

  it("deep-links a Gatekeeper digest into the Screener", () => {
    expect(notificationTargetUrl({ kind: "screener", mailAccountId: "acct-1" })).toBe(
      "/mail?folder=screener&account=acct-1",
    );
  });

  it("deep-links Needs Reauth into Mail Accounts settings, naming the Connected Account and Facet (#204)", () => {
    expect(
      notificationTargetUrl({ kind: "needs-reauth", connectedAccountId: "conn-1", facet: "mail" }),
    ).toBe("/settings/mail-accounts?account=conn-1&facet=mail");
  });

  it("falls back to the default route for a failed send or a focus-only target", () => {
    expect(
      notificationTargetUrl({ kind: "failed-send", mailAccountId: "acct-1", compositionId: "c-1" }),
    ).toBe("/");
    expect(notificationTargetUrl({ kind: "focus-only" })).toBe("/");
  });

  it("deep-links a calendar-event target to the Event's own route (#246)", () => {
    expect(
      notificationTargetUrl({ kind: "calendar-event", eventId: "evt-1", reminderDueIds: ["rd-1"] }),
    ).toBe("/calendar/evt-1");
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

describe("buildSnoozeActionRequest", () => {
  it("shapes the direct-POST body as a fixed 5-minute, User-scoped snooze (#246, ADR-0028)", () => {
    expect(buildSnoozeActionRequest(["rd-1", "rd-2"], "01ULID")).toEqual({
      id: "01ULID",
      mailAccountId: null,
      intent: {
        type: "snoozeReminder",
        reminderDueIds: ["rd-1", "rd-2"],
        snoozeUntil: { kind: "minutes", minutes: 5 },
      },
    });
  });
});
