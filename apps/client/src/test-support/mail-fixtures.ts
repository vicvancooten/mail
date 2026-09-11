import type {
  AddressBook,
  Calendar,
  CollectionDelta,
  Composition,
  ConnectedAccount,
  Contact,
  ContactRollback,
  Correspondent,
  Event,
  EventDelta,
  GmailLabel,
  Label,
  MailAccount,
  Note,
  Rollback,
  Task,
  TaskList,
  Thread,
} from "@mail/shared";
import {
  EMPTY_COMPOSE_DOCUMENT,
  EMPTY_NOTE_DOCUMENT,
  LOCAL_ALL_DAY_REMINDER_DEFAULT,
  LOCAL_CALENDAR_CAPABILITIES,
  LOCAL_CALENDAR_ORIGIN,
  LOCAL_TIMED_REMINDER_DEFAULT,
} from "@mail/shared";

/** Builders for the `POST /sync` wire shapes, so a test states only the field it is about. */

export function makeMailAccount(id: string, overrides: Partial<MailAccount> = {}): MailAccount {
  return {
    id,
    connectedAccountId: `${id}-connected`,
    emailAddress: `${id}@example.test`,
    imap: { host: "imap.example.test", port: 993, security: "tls" },
    smtp: { host: "smtp.example.test", port: 465, security: "tls" },
    status: "active",
    authKind: { kind: "password" },
    sync: { state: "idle", lastProgressAt: null, lastError: null },
    indexWatermark: { coveredSince: null, complete: false },
    serverKind: null,
    signature: null,
    notificationsEnabled: true,
    // Matches `gatekeeper.enabled: false` below via `resolveRemoteImagesSetting`'s
    // own default rule (#146) — a fixture with Gatekeeper off and this still
    // "approved-only" would be a self-contradictory account no real sync
    // response could ever produce.
    remoteImages: "always",
    gatekeeper: { enabled: false, cutoff: null },
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * A wire `ConnectedAccount` (#199, #200) — `makeMailAccount`'s own sibling.
 * `id` defaults to `${id}-connected` to match `makeMailAccount`'s own
 * default `connectedAccountId`, so `makeConnectedAccount(makeMailAccount("acct-1").connectedAccountId)`
 * (or just `makeConnectedAccount("acct-1-connected")`) is the matching row a
 * Connected Accounts table test seeds alongside it.
 */
export function makeConnectedAccount(
  id: string,
  overrides: Partial<ConnectedAccount> = {},
): ConnectedAccount {
  return {
    id,
    userId: "user-1",
    provider: "google",
    identity: `${id.replace(/-connected$/, "")}@example.test`,
    status: "active",
    facets: [{ kind: "mail", status: "active" }],
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
    gmailLabelIds: [],
    heldSender: null,
    heldRecipientAlias: null,
    snoozeUntil: null,
    updatedAt: "2026-06-01T12:00:00.000Z",
    ...overrides,
  };
}

/** A wire `Label` (#43) — User-scoped since #186, so the second argument is the owning User's id, not a Mail Account's. */
export function makeLabel(id: string, userId: string, overrides: Partial<Label> = {}): Label {
  return {
    id,
    userId,
    name: id,
    updatedAt: "2026-06-01T12:00:00.000Z",
    ...overrides,
  };
}

/** A wire `AddressBook` (#209, ADR-0023, ADR-0026) — Local by default; pass `origin: { kind: "connectedAccount", connectedAccountId }` for a mirrored one. */
export function makeAddressBook(id: string, overrides: Partial<AddressBook> = {}): AddressBook {
  return {
    id,
    name: "My Contacts",
    origin: { kind: "local" },
    mirrored: false,
    isDefault: true,
    capabilityTableId: "local",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** A wire `Contact` (#209, #210, ADR-0023, ADR-0026) — every field family defaults empty. */
export function makeContact(
  id: string,
  addressBookId: string,
  overrides: Partial<Contact> = {},
): Contact {
  return {
    id,
    addressBookId,
    name: {},
    emails: [],
    phones: [],
    addresses: [],
    websites: [],
    organizations: [],
    birthday: null,
    notes: "",
    labelIds: [],
    customFields: [],
    banner: null,
    photo: null,
    categories: [],
    deletedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** A wire `ContactRollback` (#216) — `makeContact`'s sibling for write-back's own "upstream wins" event. */
export function makeContactRollback(
  id: string,
  contactId: string,
  overrides: Partial<ContactRollback> = {},
): ContactRollback {
  return {
    id,
    contactId,
    contactName: "Ada Lovelace",
    reason: "google_conflict",
    createdAt: "2026-06-01T12:00:00.000Z",
    ...overrides,
  };
}

/** A wire `Note` (#192, ADR-0023) — User-scoped like `makeLabel`, whole-replicated with a body rather than only a name. */
export function makeNote(id: string, userId: string, overrides: Partial<Note> = {}): Note {
  return {
    id,
    userId,
    document: EMPTY_NOTE_DOCUMENT,
    labelIds: [],
    pinned: false,
    deletedAt: null,
    createdAt: "2026-06-01T12:00:00.000Z",
    updatedAt: "2026-06-01T12:00:00.000Z",
    ...overrides,
  };
}

/** A wire `TaskList` (#251, ADR-0030) — `makeNote`'s sibling: User-scoped, whole-replicated, its own body is `sections` rather than a document. */
export function makeTaskList(
  id: string,
  userId: string,
  overrides: Partial<TaskList> = {},
): TaskList {
  return {
    id,
    userId,
    name: id,
    sections: [],
    isDefault: false,
    order: 0,
    deletedAt: null,
    createdAt: "2026-06-01T12:00:00.000Z",
    updatedAt: "2026-06-01T12:00:00.000Z",
    ...overrides,
  };
}

/** A wire `Task` (#251, ADR-0030) — `makeNote`'s other sibling, placed in a List by `taskListId`. */
export function makeTask(
  id: string,
  userId: string,
  taskListId: string,
  overrides: Partial<Task> = {},
): Task {
  return {
    id,
    userId,
    taskListId,
    sectionId: null,
    title: id,
    document: EMPTY_NOTE_DOCUMENT,
    completed: false,
    completedAt: null,
    dueDate: null,
    dueTime: null,
    labelIds: [],
    threadLink: null,
    order: 0,
    deletedAt: null,
    createdAt: "2026-06-01T12:00:00.000Z",
    updatedAt: "2026-06-01T12:00:00.000Z",
    ...overrides,
  };
}

/** A wire `Calendar` (#229) — the Local Personal Calendar shape by default. */
export function makeCalendar(
  id: string,
  userId: string,
  overrides: Partial<Calendar> = {},
): Calendar {
  return {
    id,
    userId,
    name: "Personal",
    description: null,
    timeZone: "",
    origin: LOCAL_CALENDAR_ORIGIN,
    color: "#4285F4",
    isDefault: true,
    mailAccountId: null,
    mirrored: true,
    capabilities: LOCAL_CALENDAR_CAPABILITIES,
    remindersEnabled: true,
    reminderDefault: {
      timed: LOCAL_TIMED_REMINDER_DEFAULT,
      allDay: LOCAL_ALL_DAY_REMINDER_DEFAULT,
    },
    createdAt: "2026-06-01T12:00:00.000Z",
    updatedAt: "2026-06-01T12:00:00.000Z",
    ...overrides,
  };
}

/** A wire `Event` (#229) — always empty on this line, but this is what one row will look like once #230 lands. */
export function makeEvent(id: string, calendarId: string, overrides: Partial<Event> = {}): Event {
  return {
    id,
    calendarId,
    seriesId: id,
    originalStart: "2026-06-01T12:00:00.000Z",
    start: "2026-06-01T12:00:00.000Z",
    end: "2026-06-01T13:00:00.000Z",
    allDay: false,
    tzid: null,
    floating: false,
    title: "Event",
    location: null,
    status: "confirmed",
    transparency: "opaque",
    updatedAt: "2026-06-01T12:00:00.000Z",
    ...overrides,
  };
}

/** An `EventDelta` (#229) — `delta()`'s sibling, always carrying the two Event Window edges. */
export function eventDelta(overrides: Partial<EventDelta> = {}): EventDelta {
  return {
    created: [],
    updated: [],
    destroyed: [],
    newState: "state-1",
    hasMore: false,
    windowStart: "2026-03-01T00:00:00.000Z",
    windowEnd: "2027-06-01T00:00:00.000Z",
    ...overrides,
  };
}

/** A wire `Rollback` (#229, ADR-0025) — always empty until #237 produces one. */
export function makeRollback(
  id: string,
  userId: string,
  overrides: Partial<Rollback> = {},
): Rollback {
  return {
    id,
    userId,
    collection: "Event",
    entityId: "event-1",
    reason: null,
    occurredAt: "2026-06-01T12:00:00.000Z",
    ...overrides,
  };
}

/** A wire `GmailLabel` (#126, ADR-0020) — `makeLabel`'s sibling, with a `path` alongside the display `name`. */
export function makeGmailLabel(
  id: string,
  mailAccountId: string,
  overrides: Partial<GmailLabel> = {},
): GmailLabel {
  return {
    id,
    mailAccountId,
    name: id,
    path: id,
    updatedAt: "2026-06-01T12:00:00.000Z",
    ...overrides,
  };
}

/** A wire `Correspondent` (#49, compose-spec §Recipient autocomplete). */
export function makeCorrespondent(
  id: string,
  mailAccountId: string,
  overrides: Partial<Correspondent> = {},
): Correspondent {
  return {
    id,
    mailAccountId,
    address: `${id}@example.test`,
    name: null,
    sentCount: 0,
    receivedCount: 0,
    lastSeenAt: "2026-06-01T12:00:00.000Z",
    score: 0,
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
