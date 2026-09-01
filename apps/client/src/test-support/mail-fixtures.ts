import type { CollectionDelta, MailAccount, Thread } from "@mail/shared";

/** Builders for the `POST /sync` wire shapes, so a test states only the field it is about. */

export function makeMailAccount(id: string, overrides: Partial<MailAccount> = {}): MailAccount {
  return {
    id,
    emailAddress: `${id}@example.test`,
    imap: { host: "imap.example.test", port: 993, security: "tls" },
    smtp: { host: "smtp.example.test", port: 465, security: "tls" },
    status: "active",
    sync: { state: "idle", lastProgressAt: null, lastError: null },
    indexWatermark: { coveredSince: null, complete: false },
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export function makeThread(
  id: string,
  mailAccountId: string,
  overrides: Partial<Thread> = {},
): Thread {
  const lastMessageAt = overrides.lastMessageAt ?? "2026-06-01T12:00:00.000Z";
  return {
    id,
    mailAccountId,
    subject: `Subject ${id}`,
    participants: [{ name: "Ada", address: "ada@example.test" }],
    snippet: `Snippet ${id}`,
    lastMessageId: `${id}-msg`,
    firstMessageAt: lastMessageAt,
    lastMessageAt,
    messageCount: 1,
    unreadCount: 0,
    starred: false,
    hasAttachments: false,
    inInbox: true,
    updatedAt: "2026-06-01T12:00:00.000Z",
    ...overrides,
  };
}

/** `2026-06-01T12:00:00.000Z` plus `minutes`, so a test can order Threads by an obvious knob. */
export function minutesAfterEpoch(minutes: number): string {
  return new Date(Date.parse("2026-06-01T12:00:00.000Z") + minutes * 60_000).toISOString();
}

export function delta<Payload>(overrides: Partial<CollectionDelta<Payload>> = {}) {
  return {
    created: [],
    updated: [],
    destroyed: [],
    newState: "state-1",
    hasMore: false,
    ...overrides,
  } satisfies CollectionDelta<Payload>;
}
