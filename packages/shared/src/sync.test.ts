import { describe, expect, it } from "vitest";
import {
  correspondentSchema,
  correspondentSearchResponseSchema,
  gmailLabelDeltaSchema,
  gmailLabelSchema,
  labelDeltaSchema,
  labelSchema,
  mailAccountDeltaSchema,
  mutationIntentSchema,
  queuedMutationSchema,
  syncRequestSchema,
  syncResponseSchema,
  threadDeltaSchema,
  threadSchema,
} from "./sync.js";

const VALID_SNOOZE_INTENT = {
  type: "snooze" as const,
  threadId: "thread-1",
  until: "2026-06-01T08:00:00.000Z",
};

const VALID_THREAD = {
  id: "thread-1",
  mailAccountId: "account-1",
  subject: "Re: dinner",
  participants: [{ name: "Ann", address: "ann@example.com" }],
  snippet: "See you at 8",
  lastMessageId: "message-1",
  firstMessageAt: "2026-01-01T00:00:00.000Z",
  lastMessageAt: "2026-01-02T00:00:00.000Z",
  messageCount: 2,
  unreadCount: 1,
  starred: false,
  hasAttachments: false,
  inInbox: true,
  folderRole: "inbox",
  hasSentMessage: false,
  pinned: false,
  labelIds: ["account-1:Work"],
  gmailLabelIds: [],
  heldSender: null,
  heldRecipientAlias: null,
  snoozeUntil: null,
  updatedAt: "2026-01-02T00:00:00.000Z",
};

const VALID_LABEL = {
  id: "account-1:Work",
  mailAccountId: "account-1",
  name: "Work",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

const VALID_GMAIL_LABEL = {
  id: "account-1:Family/Kids",
  mailAccountId: "account-1",
  name: "Kids",
  path: "Family/Kids",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

describe("threadSchema", () => {
  it("accepts a well-formed Thread", () => {
    expect(threadSchema.safeParse(VALID_THREAD).success).toBe(true);
  });

  it("allows a null snippet (body still behind the Index Watermark)", () => {
    const result = threadSchema.safeParse({ ...VALID_THREAD, snippet: null });
    expect(result.success).toBe(true);
  });

  it("rejects a non-integer unreadCount", () => {
    const result = threadSchema.safeParse({ ...VALID_THREAD, unreadCount: 1.5 });
    expect(result.success).toBe(false);
  });

  it("requires pinned and labelIds (#43)", () => {
    const { pinned, ...withoutPinned } = VALID_THREAD;
    expect(threadSchema.safeParse(withoutPinned).success).toBe(false);
    const { labelIds, ...withoutLabelIds } = VALID_THREAD;
    expect(threadSchema.safeParse(withoutLabelIds).success).toBe(false);
  });

  it("requires gmailLabelIds, alongside but never merged into labelIds (#126, ADR-0020)", () => {
    const { gmailLabelIds, ...withoutGmailLabelIds } = VALID_THREAD;
    expect(threadSchema.safeParse(withoutGmailLabelIds).success).toBe(false);
    expect(
      threadSchema.safeParse({ ...VALID_THREAD, gmailLabelIds: ["account-1:Family/Kids"] }).success,
    ).toBe(true);
  });

  it("requires heldSender, and takes an address for a Screening Hold (#55)", () => {
    const { heldSender, ...withoutHeldSender } = VALID_THREAD;
    expect(threadSchema.safeParse(withoutHeldSender).success).toBe(false);
    expect(
      threadSchema.safeParse({ ...VALID_THREAD, heldSender: "stranger@example.com" }).success,
    ).toBe(true);
  });

  it("requires heldRecipientAlias, and takes an Alias for a Blocked-Alias-offering hold (#103)", () => {
    const { heldRecipientAlias, ...withoutHeldRecipientAlias } = VALID_THREAD;
    expect(threadSchema.safeParse(withoutHeldRecipientAlias).success).toBe(false);
    expect(
      threadSchema.safeParse({ ...VALID_THREAD, heldRecipientAlias: "sales@theirdomain.com" })
        .success,
    ).toBe(true);
  });

  it("accepts an empty labelIds array", () => {
    expect(threadSchema.safeParse({ ...VALID_THREAD, labelIds: [] }).success).toBe(true);
  });

  it("requires snoozeUntil, and takes an ISO datetime for a snoozed Thread (#76)", () => {
    const { snoozeUntil, ...withoutSnoozeUntil } = VALID_THREAD;
    expect(threadSchema.safeParse(withoutSnoozeUntil).success).toBe(false);
    expect(
      threadSchema.safeParse({ ...VALID_THREAD, snoozeUntil: "2026-06-01T08:00:00.000Z" }).success,
    ).toBe(true);
  });
});

describe("labelSchema", () => {
  it("accepts a well-formed Label", () => {
    expect(labelSchema.safeParse(VALID_LABEL).success).toBe(true);
  });

  it("rejects a Label missing a name", () => {
    const { name, ...withoutName } = VALID_LABEL;
    expect(labelSchema.safeParse(withoutName).success).toBe(false);
  });
});

describe("gmailLabelSchema", () => {
  it("accepts a well-formed Gmail Label (#126, ADR-0020)", () => {
    expect(gmailLabelSchema.safeParse(VALID_GMAIL_LABEL).success).toBe(true);
  });

  it("rejects a Gmail Label missing a path", () => {
    const { path, ...withoutPath } = VALID_GMAIL_LABEL;
    expect(gmailLabelSchema.safeParse(withoutPath).success).toBe(false);
  });
});

const VALID_CORRESPONDENT = {
  id: "account-1:ann@example.com",
  mailAccountId: "account-1",
  address: "ann@example.com",
  name: "Ann",
  sentCount: 3,
  receivedCount: 1,
  lastSeenAt: "2026-01-02T00:00:00.000Z",
  score: 12.5,
  updatedAt: "2026-01-02T00:00:00.000Z",
};

describe("correspondentSchema", () => {
  it("accepts a well-formed Correspondent", () => {
    expect(correspondentSchema.safeParse(VALID_CORRESPONDENT).success).toBe(true);
  });

  it("allows a null display name", () => {
    expect(correspondentSchema.safeParse({ ...VALID_CORRESPONDENT, name: null }).success).toBe(
      true,
    );
  });

  it("rejects a non-integer sentCount", () => {
    const result = correspondentSchema.safeParse({ ...VALID_CORRESPONDENT, sentCount: 1.5 });
    expect(result.success).toBe(false);
  });
});

describe("correspondentSearchResponseSchema", () => {
  it("accepts a list of matches", () => {
    const result = correspondentSearchResponseSchema.safeParse({
      correspondents: [VALID_CORRESPONDENT],
    });
    expect(result.success).toBe(true);
  });
});

describe("collectionDeltaSchema", () => {
  it("accepts an ordinary Thread delta with no reset flag", () => {
    const result = threadDeltaSchema.safeParse({
      created: [VALID_THREAD],
      updated: [],
      destroyed: ["thread-2"],
      newState: "opaque-token",
      hasMore: false,
    });
    expect(result.success).toBe(true);
  });

  it("accepts reset: true", () => {
    const result = threadDeltaSchema.safeParse({
      created: [VALID_THREAD],
      updated: [],
      destroyed: [],
      newState: "opaque-token",
      hasMore: true,
      reset: true,
    });
    expect(result.success).toBe(true);
  });

  it("rejects reset: false — the field is absent, never a literal false", () => {
    const result = threadDeltaSchema.safeParse({
      created: [],
      updated: [],
      destroyed: [],
      newState: "opaque-token",
      hasMore: false,
      reset: false,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a payload row that fails the collection's own schema", () => {
    const result = mailAccountDeltaSchema.safeParse({
      created: [{ id: "not-a-mail-account" }],
      updated: [],
      destroyed: [],
      newState: "opaque-token",
      hasMore: false,
    });
    expect(result.success).toBe(false);
  });

  it("accepts a Label delta (#43) the same shape as any other collection", () => {
    const result = labelDeltaSchema.safeParse({
      created: [VALID_LABEL],
      updated: [],
      destroyed: [],
      newState: "opaque-token",
      hasMore: false,
    });
    expect(result.success).toBe(true);
  });

  it("accepts a GmailLabel delta (#126) the same shape as any other collection", () => {
    const result = gmailLabelDeltaSchema.safeParse({
      created: [VALID_GMAIL_LABEL],
      updated: [],
      destroyed: [],
      newState: "opaque-token",
      hasMore: false,
    });
    expect(result.success).toBe(true);
  });
});

describe("syncRequestSchema", () => {
  it("distinguishes an omitted collection from a bootstrap (null) token", () => {
    const result = syncRequestSchema.safeParse({
      user: { MailAccount: null },
      mailAccounts: { "account-1": { Thread: "opaque-token" } },
    });
    expect(result.success).toBe(true);
    expect(result.data?.user?.MailAccount).toBeNull();
  });

  it("accepts a Label token alongside Thread (#43)", () => {
    const result = syncRequestSchema.safeParse({
      mailAccounts: { "account-1": { Thread: "th-token", Label: null } },
    });
    expect(result.success).toBe(true);
    expect(result.data?.mailAccounts?.["account-1"]?.Label).toBeNull();
  });

  it("accepts a GmailLabel token alongside Thread (#126)", () => {
    const result = syncRequestSchema.safeParse({
      mailAccounts: { "account-1": { Thread: "th-token", GmailLabel: null } },
    });
    expect(result.success).toBe(true);
    expect(result.data?.mailAccounts?.["account-1"]?.GmailLabel).toBeNull();
  });

  it("accepts an empty request — a Client asking about nothing yet", () => {
    expect(syncRequestSchema.safeParse({}).success).toBe(true);
  });

  it("rejects an unknown top-level shape", () => {
    const result = syncRequestSchema.safeParse({ collections: { Thread: "x" } });
    // Unknown keys are ignored by default zod objects, but `collections`
    // (singular, mis-shaped) must not be mistaken for `mailAccounts`.
    expect(result.success).toBe(true);
    expect(result.data).toEqual({});
  });
});

describe("syncResponseSchema", () => {
  it("round-trips an all-quiet poll with no changed collections", () => {
    const result = syncResponseSchema.safeParse({ user: {}, mailAccounts: {} });
    expect(result.success).toBe(true);
  });

  it("round-trips a populated response", () => {
    const result = syncResponseSchema.safeParse({
      user: {
        MailAccount: {
          created: [],
          updated: [],
          destroyed: [],
          newState: "token",
          hasMore: false,
        },
      },
      mailAccounts: {
        "account-1": {
          Thread: {
            created: [VALID_THREAD],
            updated: [],
            destroyed: [],
            newState: "token",
            hasMore: false,
          },
          Label: {
            created: [VALID_LABEL],
            updated: [],
            destroyed: [],
            newState: "token",
            hasMore: false,
          },
          mutations: [{ id: "01JQ", status: "applied" }],
        },
      },
    });
    expect(result.success).toBe(true);
  });
});

describe("mutationIntentSchema", () => {
  it("accepts setStarred and setRead", () => {
    expect(
      mutationIntentSchema.safeParse({ type: "setStarred", threadId: "t1", starred: true }).success,
    ).toBe(true);
    expect(
      mutationIntentSchema.safeParse({ type: "setRead", threadId: "t1", read: false }).success,
    ).toBe(true);
  });

  it("accepts archive and trash, with no boolean payload", () => {
    expect(mutationIntentSchema.safeParse({ type: "archive", threadId: "t1" }).success).toBe(true);
    expect(mutationIntentSchema.safeParse({ type: "trash", threadId: "t1" }).success).toBe(true);
  });

  it("rejects an unknown intent type", () => {
    const result = mutationIntentSchema.safeParse({ type: "pin", threadId: "t1" });
    expect(result.success).toBe(false);
  });

  it("accepts setPinned (#43)", () => {
    expect(
      mutationIntentSchema.safeParse({ type: "setPinned", threadId: "t1", pinned: true }).success,
    ).toBe(true);
  });

  it("accepts applyLabel and removeLabel, keyed by name not id (#43)", () => {
    expect(
      mutationIntentSchema.safeParse({ type: "applyLabel", threadId: "t1", name: "Work" }).success,
    ).toBe(true);
    expect(
      mutationIntentSchema.safeParse({ type: "removeLabel", threadId: "t1", name: "Work" }).success,
    ).toBe(true);
  });

  it("accepts snooze, with an ISO `until` (#76)", () => {
    expect(mutationIntentSchema.safeParse(VALID_SNOOZE_INTENT).success).toBe(true);
  });

  it("rejects snooze with a non-ISO `until`", () => {
    const result = mutationIntentSchema.safeParse({ ...VALID_SNOOZE_INTENT, until: "tomorrow" });
    expect(result.success).toBe(false);
  });

  it("accepts restoreToInbox and unsnooze — Undo's own real inverses (#95, ADR-0019)", () => {
    expect(mutationIntentSchema.safeParse({ type: "restoreToInbox", threadId: "t1" }).success).toBe(
      true,
    );
    expect(mutationIntentSchema.safeParse({ type: "unsnooze", threadId: "t1" }).success).toBe(true);
  });

  it("accepts unblockAndRestore, keyed to a sender plus the exact Threads it restores (#95)", () => {
    expect(
      mutationIntentSchema.safeParse({
        type: "unblockAndRestore",
        sender: { scope: "address", value: "stranger@example.test" },
        threadIds: ["t1", "t2"],
      }).success,
    ).toBe(true);
  });

  it("rejects unblockAndRestore with no threadIds array", () => {
    const result = mutationIntentSchema.safeParse({
      type: "unblockAndRestore",
      sender: { scope: "address", value: "stranger@example.test" },
    });
    expect(result.success).toBe(false);
  });
});

describe("queuedMutationSchema", () => {
  it("requires an id alongside the intent", () => {
    const result = queuedMutationSchema.safeParse({
      intent: { type: "setStarred", threadId: "t1", starred: true },
    });
    expect(result.success).toBe(false);
  });

  it("round-trips a queued mutation", () => {
    const result = queuedMutationSchema.safeParse({
      id: "01JQUEUED",
      intent: { type: "setRead", threadId: "t1", read: true },
    });
    expect(result.success).toBe(true);
  });
});

describe("syncRequestSchema mutations", () => {
  it("carries a per-account mutation queue alongside Thread", () => {
    const result = syncRequestSchema.safeParse({
      mailAccounts: {
        "account-1": {
          Thread: null,
          mutations: [
            { id: "01JQ", intent: { type: "setStarred", threadId: "t1", starred: true } },
          ],
        },
      },
    });
    expect(result.success).toBe(true);
  });
});
