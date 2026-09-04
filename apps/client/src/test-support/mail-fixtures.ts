import type { CollectionDelta, Composition, Label, MailAccount, Thread } from "@mail/shared";
import { EMPTY_COMPOSE_DOCUMENT } from "@mail/shared";

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
    signature: null,
    notificationsEnabled: true,
    gatekeeper: { enabled: false, cutoff: null },
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
    folderRole: "inbox",
    hasSentMessage: false,
    pinned: false,
    labelIds: [],
    heldSender: null,
    heldRecipientAlias: null,
    snoozeUntil: null,
    updatedAt: "2026-06-01T12:00:00.000Z",
    ...overrides,
  };
}

export function makeLabel(
  id: string,
  mailAccountId: string,
  overrides: Partial<Label> = {},
): Label {
  return {
    id,
    mailAccountId,
    name: id,
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

/** A wire `Composition` (#46) — a Draft by default; overrides carry it into a send state. */
export function makeComposition(
  id: string,
  mailAccountId: string,
  overrides: Partial<Composition> = {},
): Composition {
  return {
    id,
    mailAccountId,
    status: "draft",
    subject: `subject ${id}`,
    document: EMPTY_COMPOSE_DOCUMENT,
    to: [{ name: null, address: "ada@example.test" }],
    cc: [],
    bcc: [],
    inReplyTo: null,
    references: [],
    version: 1,
    submitAfter: null,
    sendError: null,
    messageId: null,
    sentAt: null,
    updatedAt: "2026-06-01T12:00:00.000Z",
    attachments: [],
    ...overrides,
  };
}
