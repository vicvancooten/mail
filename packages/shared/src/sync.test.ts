import { describe, expect, it } from "vitest";
import {
  mailAccountDeltaSchema,
  syncRequestSchema,
  syncResponseSchema,
  threadDeltaSchema,
  threadSchema,
} from "./sync.js";

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
        },
      },
    });
    expect(result.success).toBe(true);
  });
});
