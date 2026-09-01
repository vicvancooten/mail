import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { MailAccountCredential } from "../mail-accounts/credential-crypto.js";

/**
 * A User signed in to this instance (CONTEXT.md). Exactly one Owner is
 * created by the first-run claim; Member invites are not built yet
 * (poc-scope.md), but the column exists from day one per ADR-0004.
 *
 * `passwordHash` is the only credential column at PoC. TOTP and passkeys
 * (#32) add their own tables (`totp_credentials`, `passkey_credentials`)
 * keyed to `users.id` rather than widening this row — the `AuthMethod` seam
 * lives in code (`src/auth/auth-method.ts`), not as a single polymorphic
 * table.
 */
export const users = pgTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role", { enum: ["owner", "member"] })
    .notNull()
    .default("member"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * An opaque, DB-backed session (poc-spec.md §Auth & Users). `id` is the
 * SHA-256 hex digest of the bearer token that lives in the httpOnly cookie —
 * the raw token itself is never stored, only ever compared by re-hashing an
 * incoming cookie. `expiresAt` slides forward on use; see
 * `src/auth/sessions.ts`.
 */
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("sessions_user_id_idx").on(table.userId)],
);

/**
 * The one-time first-run claim token (ADR-0009 deployment): printed to the
 * logs on every boot while the instance is unclaimed, hashed at rest the
 * same way a session token is. A fresh boot invalidates whatever was printed
 * before, so a stale token in old logs can't claim a since-reconfigured
 * instance.
 */
export const claimTokens = pgTable("claim_tokens", {
  id: text("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

/**
 * A short-lived, single-use server-side stand-in for "the password (or
 * passkey) check just passed" (#32): minted by `/auth/login` or
 * `/auth/passkeys/login/verify` when the User has a confirmed
 * `totp_credentials` row, redeemed by `/auth/login/totp`. No session exists
 * until the TOTP code checks out — this table is the only state in between.
 * `id` is the SHA-256 hash of the bearer token, same convention as
 * `sessions`/`claim_tokens`.
 */
export const loginChallenges = pgTable("login_challenges", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

/**
 * TOTP 2FA (#32), one row per User. `secret` is the base32 shared secret —
 * stored in plaintext, unlike `passwordHash`: TOTP verification needs the
 * symmetric secret back, not just a comparable hash, and no ADR carves out
 * an instance-held key for auth secrets the way ADR-0003 does for Mail
 * Account credentials. Accepted PoC tradeoff, matching the threat model
 * ADR-0003 already states plainly: the database alone is useless, the
 * database plus host access is not.
 *
 * `confirmed` is false from `/auth/totp/enroll` until `/auth/totp/confirm`
 * proves the User actually saved the secret in an authenticator app — an
 * unconfirmed row never gates login. `lastUsedTimeStep` is otplib's replay
 * guard: a code's time step is rejected once it's been accepted, so an
 * intercepted code can't be reused inside its own 30s window.
 */
export const totpCredentials = pgTable("totp_credentials", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  secret: text("secret").notNull(),
  confirmed: boolean("confirmed").notNull().default(false),
  lastUsedTimeStep: integer("last_used_time_step"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A registered passkey (#32): `id` is the credential id the authenticator
 * generates, base64url-encoded — the natural key passkey login looks up by,
 * per the `AuthMethod` seam's comment ("looked up by credential id instead
 * of username"). `publicKey` is base64url-encoded COSE bytes; it's public by
 * definition, so no encryption-at-rest concern applies the way it does for
 * `totp_credentials.secret`. `counter` and `backedUp`/`deviceType` are what
 * `@simplewebauthn/server` needs kept around for its own replay checks.
 */
export const passkeyCredentials = pgTable(
  "passkey_credentials",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    publicKey: text("public_key").notNull(),
    counter: integer("counter").notNull().default(0),
    deviceType: text("device_type", { enum: ["singleDevice", "multiDevice"] }).notNull(),
    backedUp: boolean("backed_up").notNull().default(false),
    transports: text("transports").array(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (table) => [index("passkey_credentials_user_id_idx").on(table.userId)],
);

/**
 * A single in-flight WebAuthn ceremony's server-generated challenge (#32),
 * for both passkey registration and passkey login. `id` is the SHA-256 hash
 * of an opaque token round-tripped through a short-lived cookie (see
 * `src/auth/webauthn-challenges.ts`) rather than a request-body field, so
 * the Client never has to thread it through by hand. `userId` is set for a
 * registration (bound to the already-authenticated User) and left `null`
 * for a login challenge, since passkey login is usernameless — the
 * credential id in the response resolves the User, not this row.
 */
export const webauthnChallenges = pgTable("webauthn_challenges", {
  id: text("id").primaryKey(),
  challenge: text("challenge").notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

/**
 * A connection to an external mail server, owned by exactly one User
 * (CONTEXT.md, ADR-0004) — no join table, no sharing. `imap*`/`smtp*`
 * columns are the provider-agnostic host/port/TLS shape both autodiscover
 * and manual entry produce (docs/research/0004 §6); `credential` is the
 * AEAD-sealed tagged union from ADR-0003, `jsonb` so a future `oauth`
 * variant needs no migration of the existing `password` rows, only a new
 * shape for new ones. `status` is the Needs Reauth state machine
 * (CONTEXT.md): a rejected credential parks a row in `needs_reauth` until
 * `src/mail-accounts/store.ts`'s reauth path clears it back to `active`.
 */
export const mailAccounts = pgTable(
  "mail_accounts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    emailAddress: text("email_address").notNull(),
    imapHost: text("imap_host").notNull(),
    imapPort: integer("imap_port").notNull(),
    imapSecurity: text("imap_security", { enum: ["tls", "starttls", "none"] }).notNull(),
    smtpHost: text("smtp_host").notNull(),
    smtpPort: integer("smtp_port").notNull(),
    smtpSecurity: text("smtp_security", { enum: ["tls", "starttls", "none"] }).notNull(),
    // The IMAP/SMTP login, kept separate from `emailAddress`: not every
    // provider's login is the mailbox address itself.
    username: text("username").notNull(),
    credential: jsonb("credential").$type<MailAccountCredential>().notNull(),
    status: text("status", { enum: ["active", "needs_reauth"] })
      .notNull()
      .default("active"),
    // The groundwork for ADR-0015's two-tier liveness (#35): the resident
    // sync loop (`sync/live-session.ts`) stamps `lastProgressAt` on every
    // IDLE keepalive or completed poll and `syncState` on every transition,
    // so a per-account staleness banner has something to read without
    // guessing from `status` (the credential verdict, not the connection's).
    // Nothing outside the loop writes these columns.
    syncState: text("sync_state", {
      enum: ["stopped", "connecting", "syncing", "idle", "error"],
    })
      .notNull()
      .default("stopped"),
    lastProgressAt: timestamp("last_progress_at", { withTimezone: true }),
    lastSyncError: text("last_sync_error"),
    // The Index Watermark (CONTEXT.md, #36): everything with `receivedAt` at
    // or after this instant is guaranteed to have had its body swept, across
    // every folder. Null until the sweep has completed at least one batch.
    // `bodySweepComplete` is the "runs once and then stops" terminus — once
    // true the sweep is caught up account-wide and `bodyWatermark` stops
    // meaning anything (search/reading treat the account as fully indexed).
    // Only `sync/body-sweep.ts` writes either column.
    bodyWatermark: timestamp("body_watermark", { withTimezone: true }),
    bodySweepComplete: boolean("body_sweep_complete").notNull().default(false),
    // Bumped whenever a Folder under this account is rebuilt from a
    // UIDVALIDITY change (`sync/ingest.ts#applyUidValidity`) — the "underlying
    // state was rebuilt" trigger ADR-0011 names for a Thread `reset: true`.
    // A Client's Thread state token embeds the epoch it was issued under
    // (`sync/sync-tokens.ts`); a mismatch means the rebuild deleted Threads
    // this account's tombstones don't individually account for, so #37
    // answers with a fresh full page instead of a `destroyed` list.
    threadsEpoch: integer("threads_epoch").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    // The delta sync API's (#37) cursor pair, stamped by the `bump_sync_rev`
    // trigger (migration 0006) on every insert/update — nothing in
    // application code writes these two columns directly. `syncRev` is this
    // row's position in the account-wide revision order every sync-tracked
    // table shares; `syncCreatedRev` is frozen at the row's first stamp, so
    // `sync/collection-sync.ts` can tell "new to a Client since token X"
    // (`syncCreatedRev > X`) apart from "changed since X" (`syncRev > X`)
    // without a second timestamp column to keep in sync by hand.
    syncRev: bigint("sync_rev", { mode: "number" }).notNull().default(0),
    syncCreatedRev: bigint("sync_created_rev", { mode: "number" }).notNull().default(0),
  },
  (table) => [
    index("mail_accounts_user_id_idx").on(table.userId),
    index("mail_accounts_sync_rev_idx").on(table.userId, table.syncRev),
  ],
);

/**
 * One IMAP mailbox on one Mail Account (#34). Everything below the Mail
 * Account is keyed by it, never by path alone — two Mail Accounts both have
 * an `INBOX` and they are different folders.
 *
 * `role` is ImapFlow's `specialUse` flag normalized to a lowercase name, so
 * the rest of the codebase asks "where is Trash on this account" rather than
 * matching localized folder names. It is `null` for ordinary user folders.
 *
 * `uidValidity`/`uidNext`/`highestModseq` are the IMAP sync state ADR-0005's
 * delta strategy runs on: a changed `uidValidity` invalidates every stored
 * UID for the folder (the ingest path deletes and re-ingests, which is
 * ADR-0011's `reset: true` at the storage layer), `highestModseq` is the
 * CONDSTORE/QRESYNC cursor #35 resumes from. They live here from day one
 * because they are folder *identity*, not a feature of the loop that reads
 * them.
 */
export const folders = pgTable(
  "folders",
  {
    id: text("id").primaryKey(),
    mailAccountId: text("mail_account_id")
      .notNull()
      .references(() => mailAccounts.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    name: text("name").notNull(),
    delimiter: text("delimiter"),
    role: text("role", {
      enum: ["inbox", "archive", "drafts", "sent", "junk", "trash", "flagged", "all"],
    }),
    subscribed: boolean("subscribed").notNull().default(true),
    /** False for `\Noselect` container folders — they hold no messages and are never opened. */
    selectable: boolean("selectable").notNull().default(true),
    uidValidity: bigint("uid_validity", { mode: "number" }),
    uidNext: bigint("uid_next", { mode: "number" }),
    highestModseq: bigint("highest_modseq", { mode: "bigint" }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    // Full-history backfill (#36), resumable across a process restart: the
    // next batch fetches sequence numbers ending at this cursor and working
    // downwards, newest-first. Set once — to the folder's `exists` count —
    // the first time this folder is ever established or rebuilt
    // (`sync/backfill.ts#establishFolderBaseline`), and decremented by every
    // completed batch. `null` means backfill has not started; `0` (with
    // `backfillComplete: true`) means every message down to sequence 1 has
    // its header stored. Sequence numbers, not UIDs, because the cursor
    // tracks "how much of the mailbox as it stood at connect time is left",
    // and appends after that point never renumber what came before.
    backfillCursorSeq: integer("backfill_cursor_seq"),
    backfillComplete: boolean("backfill_complete").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("folders_account_path_key").on(table.mailAccountId, table.path),
    index("folders_account_role_idx").on(table.mailAccountId, table.role),
  ],
);

/**
 * A Thread (CONTEXT.md): the conversation the message list shows and most
 * actions target. Scoped to one Mail Account — the same conversation seen
 * from two Mail Accounts is two Threads, because every downstream feature
 * (ADR-0011 collections, ADR-0016 search scope, Gatekeeper verdicts) is
 * account-scoped and a shared Thread would leak across that boundary.
 *
 * The columns after `subject` are a **rollup of the Thread's messages**,
 * recomputed by `sync/thread-rollup.ts` whenever any of them changes. They
 * are denormalized on purpose: ADR-0011's Thread projection is the list row,
 * `docs/poc-scope.md` puts a <1s cold start and <200ms search against an
 * 80k-thread corpus, and re-aggregating messages per row does not survive
 * that. Nothing outside the rollup writes them.
 */
export const threads = pgTable(
  "threads",
  {
    id: text("id").primaryKey(),
    mailAccountId: text("mail_account_id")
      .notNull()
      .references(() => mailAccounts.id, { onDelete: "cascade" }),
    /** The earliest message's subject with `Re:`/`Fwd:`-style prefixes stripped (`sync/subject.ts`). */
    subject: text("subject").notNull().default(""),
    /** Distinct `From` addresses oldest-first — the list row's avatar/name column. */
    participants: jsonb("participants").$type<ThreadParticipant[]>().notNull().default([]),
    /** The newest message's Snippet, or null while its body is still behind the Index Watermark. */
    snippet: text("snippet"),
    lastMessageId: text("last_message_id"),
    firstMessageAt: timestamp("first_message_at", { withTimezone: true }),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    messageCount: integer("message_count").notNull().default(0),
    unreadCount: integer("unread_count").notNull().default(0),
    /** Any message `\Flagged` — Star is a Protocol Feature and lives on the message (ADR-0006). */
    starred: boolean("starred").notNull().default(false),
    hasAttachments: boolean("has_attachments").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    // See `mailAccounts.syncRev`/`syncCreatedRev` above — same trigger, same
    // shared revision sequence, so a Thread page and a MailAccount page order
    // consistently against one another even though #37 never mixes them into
    // one query.
    syncRev: bigint("sync_rev", { mode: "number" }).notNull().default(0),
    syncCreatedRev: bigint("sync_created_rev", { mode: "number" }).notNull().default(0),
  },
  (table) => [
    index("threads_account_last_message_idx").on(table.mailAccountId, table.lastMessageAt),
    index("threads_sync_rev_idx").on(table.mailAccountId, table.syncRev),
  ],
);

/** One `From`/`To` participant as denormalized onto `threads.participants`. */
export interface ThreadParticipant {
  name: string | null;
  address: string;
}

/**
 * The threading index: every `Message-ID` this Mail Account has *seen* —
 * whether as a message it stores or only as a `References`/`In-Reply-To`
 * mention — mapped to the Thread it belongs to.
 *
 * This is what makes threading order-independent, which matters because
 * ADR-0005's backfill runs **newest-first**: a reply is almost always stored
 * before the message it answers. Storing the reply registers its parents'
 * ids here pointing at the new Thread, so when the parent finally arrives it
 * lands in the Thread that was already waiting for it. When a late arrival
 * turns out to reference two Threads that were separate until now, the
 * ingest merges them (`sync/threading.ts`).
 *
 * Deliberately reference-based only: no subject-similarity fallback. A
 * subject fallback merges unrelated mail — two people answering "Re: invoice"
 * become one conversation — and a wrongly merged Thread is much harder for a
 * User to recover from than a split one.
 */
export const threadMessageIds = pgTable(
  "thread_message_ids",
  {
    mailAccountId: text("mail_account_id")
      .notNull()
      .references(() => mailAccounts.id, { onDelete: "cascade" }),
    /** A `Message-ID` header value with the angle brackets and whitespace stripped. */
    messageIdHeader: text("message_id_header").notNull(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.mailAccountId, table.messageIdHeader] }),
    index("thread_message_ids_thread_idx").on(table.threadId),
  ],
);

/** One attachment as summarized from BODYSTRUCTURE at ingest; bytes are never stored (fetch-through). */
export interface MessageAttachment {
  /** IMAP body part id, e.g. `2.1` — what a later fetch-through downloads. */
  part: string;
  filename: string | null;
  mimeType: string;
  sizeBytes: number | null;
  /** `Content-ID` with brackets stripped (RFC 2392), for resolving `cid:` references at render. */
  contentId: string | null;
  inline: boolean;
}

/** One `From`/`To`/`Cc` address as stored on a message. */
export interface MessageAddress {
  name: string | null;
  address: string;
}

/**
 * One message in one IMAP folder (#34). The natural key is
 * `(folderId, uid)` — IMAP's own identity for a message — so re-ingesting a
 * folder updates rows instead of duplicating them ("zero lost or duplicated
 * messages", `docs/poc-scope.md`). A message that genuinely exists in two
 * folders (a Sent self-copy, a Gmail label) is two rows with the same
 * `messageIdHeader`, because that is two IMAP messages; threading pulls them
 * into one Thread.
 *
 * `seen`/`flagged` are the two **Protocol Features** (ADR-0006): read state
 * and Star, mirrored from `\Seen`/`\Flagged` so a User's existing stars are
 * there on first sync and changes made by any other IMAP client arrive.
 * `flags` keeps the raw set alongside them so nothing is lost in the
 * mapping. Pin, Label and Gatekeeper state are App Features and get their
 * own tables in their own tickets — never a column here.
 *
 * `bodyText`/`bodyHtml`/`snippet` are null until the body is fetched:
 * ADR-0005's backfill is headers-first with lazy bodies, and #36's sweep
 * fills them in behind the Index Watermark. `bodyHtml` is **always
 * sanitized** (`sync/sanitize.ts`) — raw sender HTML is never written here,
 * per `docs/research/0005`. `bodyFetchedAt` is the seam that sweep reads.
 */
export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    mailAccountId: text("mail_account_id")
      .notNull()
      .references(() => mailAccounts.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    folderId: text("folder_id")
      .notNull()
      .references(() => folders.id, { onDelete: "cascade" }),
    uid: bigint("uid", { mode: "number" }).notNull(),
    /** Snapshot of the folder's UIDVALIDITY when this row was written; a change invalidates `uid`. */
    uidValidity: bigint("uid_validity", { mode: "number" }),

    messageIdHeader: text("message_id_header"),
    inReplyTo: text("in_reply_to"),
    references: text("references").array().notNull().default([]),

    subject: text("subject").notNull().default(""),
    fromName: text("from_name"),
    fromAddress: text("from_address"),
    toAddresses: jsonb("to_addresses").$type<MessageAddress[]>().notNull().default([]),
    ccAddresses: jsonb("cc_addresses").$type<MessageAddress[]>().notNull().default([]),
    replyToAddresses: jsonb("reply_to_addresses").$type<MessageAddress[]>().notNull().default([]),

    /** The `Date` header, falling back to INTERNALDATE when the sender omitted or mangled it. */
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
    /** IMAP INTERNALDATE — arrival order, and what list sorting trusts over a spoofable `Date`. */
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),

    seen: boolean("seen").notNull().default(false),
    flagged: boolean("flagged").notNull().default(false),
    answered: boolean("answered").notNull().default(false),
    draft: boolean("draft").notNull().default(false),
    flags: text("flags").array().notNull().default([]),

    sizeBytes: integer("size_bytes"),
    hasAttachments: boolean("has_attachments").notNull().default(false),
    attachments: jsonb("attachments").$type<MessageAttachment[]>().notNull().default([]),

    snippet: text("snippet"),
    bodyText: text("body_text"),
    bodyHtml: text("body_html"),
    bodyFetchedAt: timestamp("body_fetched_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("messages_folder_uid_key").on(table.folderId, table.uid),
    index("messages_thread_idx").on(table.threadId),
    index("messages_account_received_idx").on(table.mailAccountId, table.receivedAt),
    index("messages_account_message_id_idx").on(table.mailAccountId, table.messageIdHeader),
    // #36's body sweep walks newest-first over exactly this predicate.
    index("messages_body_pending_idx")
      .on(table.mailAccountId, table.receivedAt)
      .where(sql`${table.bodyFetchedAt} is null`),
  ],
);

/**
 * A destroyed entity's record in the delta sync API (#37, ADR-0011): a Thread
 * merge's losing side (`sync/threading.ts#mergeThreads`) or a Thread left
 * with no messages (`deleteEmptyThreads`) writes one of these instead of
 * simply vanishing, so a Client's `destroyed` list can name it rather than
 * the Client discovering the gap on its own. Generic across collections
 * (`collection` + `entityId`) so a future Label/Draft/PendingSend deletion
 * reuses this table rather than growing its own.
 *
 * `mailAccountId` is null for a User-scoped collection's tombstone (nothing
 * writes one yet — `MailAccount` has no delete route). `syncRev` is stamped
 * from the same `sync_rev_seq` sequence `mail_accounts.syncRev`/
 * `threads.syncRev` draw from (`sync/tombstones.ts`), one call per row, so a
 * destroy and an upsert for two different entities never tie and pagination
 * never has to split a batch of same-revision rows across two pages.
 */
export const syncTombstones = pgTable(
  "sync_tombstones",
  {
    id: text("id").primaryKey(),
    mailAccountId: text("mail_account_id").references(() => mailAccounts.id, {
      onDelete: "cascade",
    }),
    collection: text("collection").notNull(),
    entityId: text("entity_id").notNull(),
    syncRev: bigint("sync_rev", { mode: "number" }).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("sync_tombstones_scope_idx").on(table.mailAccountId, table.collection, table.syncRev),
  ],
);
