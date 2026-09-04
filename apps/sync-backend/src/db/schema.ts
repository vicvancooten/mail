import type { AttachmentMeta, ComposeDocument, Recipient } from "@mail/shared";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  customType,
  doublePrecision,
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
 * Postgres `bytea` (ADR-0012's Blob Store): drizzle-orm has no first-class
 * column for it, so this is the one `customType` in the schema. `postgres`
 * (the driver `db/client.ts` builds on) already serialises/parses a `Buffer`
 * as `bytea` by default — this only has to name the Postgres-side type.
 */
const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

/**
 * Postgres `tsvector` (ADR-0016's Search Index `doc` column): drizzle-orm has
 * no first-class column for this either. Every value is written by a raw SQL
 * expression built from `to_tsvector`/`setweight` (`sync/search-index.ts`),
 * never read back into JS — a query only ever matches (`@@`) or ranks
 * (`ts_rank_cd`) it in SQL — so this type exists purely to name the
 * Postgres-side column, the same role `bytea` plays above.
 */
const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

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
  /**
   * The Undo Send delay in seconds (#46, ADR-0007), User-scoped per
   * poc-spec.md §Preferences. Lives on this row rather than in a preference
   * collection because #54 owns that collection and has not landed — it is
   * the "existing inline default" #54's own ticket says migrates into it.
   * Server-held rather than sent up with each send: ADR-0007 measures the
   * delay "from server receipt, never from the Client's clock", so
   * `submit_after` is this server's to compute. `0` is `off`, which is a
   * zero-length window, never a bypass of the Pending Send row.
   */
  undoSendDelaySeconds: integer("undo_send_delay_seconds").notNull().default(10),
  /**
   * The rest of `Preference` (#54, poc-spec.md §Preferences): Auto-advance,
   * User-scoped alongside `undoSendDelaySeconds` above. Same posture as that
   * column — one row per User, no separate table, because a User has exactly
   * one of each.
   *
   * Theme lived here too until #72 (ADR-0011 amended): moved to a Device
   * Preference, since Appearance means something different per device.
   */
  autoAdvanceEnabled: boolean("auto_advance_enabled").notNull().default(true),
  autoAdvanceDirection: text("auto_advance_direction", { enum: ["older", "newer"] })
    .notNull()
    .default("older"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  // The delta sync API's (#37, #54) cursor pair for the `Preference`
  // collection, stamped by the same `bump_sync_rev` trigger `mail_accounts`
  // and `threads` already use (migration 0006) — see that migration's own
  // comment for what the two columns mean.
  syncRev: bigint("sync_rev", { mode: "number" }).notNull().default(0),
  syncCreatedRev: bigint("sync_created_rev", { mode: "number" }).notNull().default(0),
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
    /** The plain-text signature (#47, compose-spec §Signature) — null until the User sets one. */
    signature: text("signature"),
    /** The notification on/off toggle (#54, poc-spec.md §Preferences) — the Mail-Account-scoped half of Preferences, alongside `signature`. */
    notificationsEnabled: boolean("notifications_enabled").notNull().default(true),
    // Gatekeeper's opt-in and its Cutoff (#55, CONTEXT.md §Gatekeeper).
    // Off by default: screening is opt-in per Mail Account, and an account
    // added before this ticket existed must not start holding mail on
    // upgrade. `gatekeeperCutoff` is stamped at enable and **kept** across a
    // disable — re-enabling without a Reset would otherwise re-screen every
    // stranger who wrote during the gap, which is precisely the "everything
    // already in the mailbox is grandfathered" promise the Cutoff exists to
    // make. `sync/gatekeeper/settings.ts` is the only writer.
    gatekeeperEnabled: boolean("gatekeeper_enabled").notNull().default(false),
    gatekeeperCutoff: timestamp("gatekeeper_cutoff", { withTimezone: true }),
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
    // Not part of the message rollup above — `sync/thread-rollup.ts` never
    // touches this column. It is `sync/mutations.ts`'s own field (#42): an
    // archive/trash intent sets it to `false` directly, and nothing sets it
    // back (there is no `unarchive` yet). Kept independent of the messages'
    // real `folder_id` on purpose: the *actual* IMAP move that follows is
    // asynchronous and can only learn a message's new UID once it completes
    // (`sync/protocol-writes.ts`), so this is the synchronous half of the
    // Optimistic Action's ack, and the folder move is the asynchronous
    // mirror of it (ADR-0006).
    inInbox: boolean("in_inbox").notNull().default(true),
    // Sidebar folder destinations (#74): `folderRole` is `inInbox`'s own
    // sibling, not a re-derivation of it — an App-owned field `sync/
    // mutations.ts`'s `archive`/`trash` cases (and the Screener decisions
    // and Bulk Triage's `done` action that share their effect) set directly,
    // synchronously, the same "ack now, real IMAP MOVE follows async"
    // reasoning `inInbox`'s own comment gives. Kept as a third state next to
    // `inInbox` rather than derived from it (`inInbox: false` alone can't
    // say which) because the Archive and Trash sidebar entries need to tell
    // the two apart. `hasSentMessage` below is the opposite shape — a real
    // rollup-computed signal, because Sent has no Optimistic Action of its
    // own to flip a flag: a Thread lands there by actually containing a
    // Message the Sync Backend ingested from the account's real `\Sent`
    // folder, which the rollup already sees on every pass.
    // "junk" (#102) is Spam's own destination — see `@mail/shared`'s
    // `folderRoleSchema`-equivalent doc comment on the wire `Thread` type.
    folderRole: text("folder_role", { enum: ["inbox", "archive", "trash", "junk"] })
      .notNull()
      .default("inbox"),
    hasSentMessage: boolean("has_sent_message").notNull().default(false),
    // Pin (#43, CONTEXT.md): an App Feature, `sync/mutations.ts`'s own field
    // exactly like `inInbox` above — no rollup ever touches it, only a
    // `setPinned` intent does. Deliberately not the same thing as `starred`:
    // a Star is a Protocol Feature mirroring IMAP's own `\Flagged`, a Pin
    // has zero IMAP-side trace (ADR-0006).
    pinned: boolean("pinned").notNull().default(false),
    // Labels currently applied to this Thread (#43), as `labels.id`s —
    // denormalized here the same way `inInbox`/`pinned` are, so the Client's
    // one Thread projection carries membership without a join. `sync/
    // mutations.ts` is the only writer; `labels` below is the id→name
    // collection those ids resolve against.
    labelIds: text("label_ids").array().notNull().default([]),
    // The Screening Hold (#55, CONTEXT.md, ADR-0008): the normalized `From`
    // address of the Unscreened Sender holding this Thread in the Screener,
    // null when it is not held. An App Feature with no IMAP-side trace —
    // ADR-0008 is explicit that only the *Blocked* branch touches IMAP, and
    // that asymmetry is what makes Approve's "release with original received
    // dates" free: the mail never moved, so `receivedAt` was never rewritten.
    //
    // On the Thread rather than the Message because the hold is only ever
    // created by a message that *started* a Thread (poc-spec.md), so a
    // Thread has exactly one holding sender or none, and the Screener's
    // "one decision per stranger" grouping is a `GROUP BY` on this column.
    // `sync/thread-rollup.ts` never touches it; `sync/gatekeeper/` is the
    // only writer, the same way `inInbox`/`pinned` belong to
    // `sync/mutations.ts` alone.
    heldSender: text("held_sender"),
    heldAt: timestamp("held_at", { withTimezone: true }),
    // Snooze (#76, CONTEXT.md): the instant this Thread wakes, or null when
    // it isn't snoozed. An App Feature, `sync/mutations.ts`'s own field
    // exactly like `pinned`/`heldSender` above — no rollup ever touches it.
    // `sync/snooze.ts`'s wake sweep is the only thing that ever clears it
    // (there is no "un-snooze early" intent), the same one-directional shape
    // `inInbox` itself already has for `archive`/`trash`.
    snoozeUntil: timestamp("snooze_until", { withTimezone: true }),
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
    // The Screener's own query (#55) and every hold-aware exclusion the
    // badge/Inbox make: partial, because a held Thread is a rounding error
    // against an 80k-thread account and a full index would be almost
    // entirely `null` rows nobody ever looks up.
    index("threads_held_sender_idx")
      .on(table.mailAccountId, table.heldSender)
      .where(sql`${table.heldSender} is not null`),
    // The Snooze wake sweep's own query (#76, `sync/snooze.ts`): partial for
    // the same reason `threads_held_sender_idx` above is — a snoozed Thread
    // is a rounding error against an 80k-thread account, and the sweep only
    // ever needs the rows this admits.
    index("threads_snooze_until_idx")
      .on(table.snoozeUntil)
      .where(sql`${table.snoozeUntil} is not null`),
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

/**
 * A Label (#43, CONTEXT.md, ADR-0006): a User-defined tag, App Feature, no
 * management UI/colors/nesting at PoC scope. `id` is **deterministic**
 * (`labelId` in `packages/shared/src/labels.ts`, `(mailAccountId, name)`)
 * rather than minted here and handed back — `sync/mutations.ts`'s
 * `applyLabel` computes the same id a Client already predicted offline, so
 * creating a brand-new Label by applying it is one Optimistic Action, not
 * two. `threads.labelIds` is the membership side; this table is only the
 * id→name definition, synced as its own ADR-0011 collection.
 */
export const labels = pgTable(
  "labels",
  {
    id: text("id").primaryKey(),
    mailAccountId: text("mail_account_id")
      .notNull()
      .references(() => mailAccounts.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    // Same shared `sync_rev_seq` trigger as `threads`/`mail_accounts` — see
    // their comments above.
    syncRev: bigint("sync_rev", { mode: "number" }).notNull().default(0),
    syncCreatedRev: bigint("sync_created_rev", { mode: "number" }).notNull().default(0),
  },
  (table) => [
    uniqueIndex("labels_account_name_key").on(table.mailAccountId, table.name),
    index("labels_sync_rev_idx").on(table.mailAccountId, table.syncRev),
  ],
);
export type LabelRow = typeof labels.$inferSelect;

/**
 * A Correspondent (#49, CONTEXT.md, compose-spec §Recipient autocomplete):
 * an address this Mail Account has actually exchanged mail with, derived
 * from message history and never hand-edited. `id` is deterministic
 * (`correspondentId` in `packages/shared/src/correspondents.ts`, scoped to
 * `(mailAccountId, normalizedAddress)`) so re-ingesting the same address
 * upserts one row rather than duplicating it.
 *
 * Built and maintained entirely by `sync/correspondents.ts`, hooked off
 * `sync/ingest.ts#storeMessage`'s "genuinely new row" branch — see that
 * module's own doc comment for why counting happens there and only there
 * (it is the single point every message this account will ever hold passes
 * through exactly once, backfill, delta and a just-sent message's own Sent
 * `APPEND` alike, so there is nowhere else that could double- or
 * under-count).
 *
 * `sentCount`/`receivedCount` are raw, monotonic counters; `score` is the
 * ranking compose-spec asks for — sent-weight far above received-weight,
 * with recency decay — evaluated against "now" at the moment of the write
 * that produced it (`sync/correspondents.ts#computeScore`). It is therefore
 * a snapshot that only moves when this Correspondent is mailed again, not a
 * value that passively decays between messages; acceptable for a synced
 * ranking snapshot, and the same tradeoff `threads.snippet` already makes
 * ("derived once", CONTEXT.md) rather than recomputed on every read.
 *
 * Only the top ~500 rows by `score` per Mail Account are ever kept
 * (`sync/correspondents.ts#capCorrespondents`) — compose-spec's "top ~500
 * synced ... for a <50ms first keystroke" is therefore satisfied by simply
 * syncing the *whole* collection, the same full-collection shape `labels`
 * already has, rather than a second top-K sync protocol.
 */
export const correspondents = pgTable(
  "correspondents",
  {
    id: text("id").primaryKey(),
    mailAccountId: text("mail_account_id")
      .notNull()
      .references(() => mailAccounts.id, { onDelete: "cascade" }),
    /** Lowercased, trimmed (`normalizeCorrespondentAddress`) — the natural key half of `id`. */
    normalizedAddress: text("normalized_address").notNull(),
    /** The address as best-cased/observed, for display and for the composed `To:` header. */
    address: text("address").notNull(),
    /** The best-known display name — the longest one ever seen, on the assumption a fuller name is a better one. */
    name: text("name"),
    sentCount: integer("sent_count").notNull().default(0),
    receivedCount: integer("received_count").notNull().default(0),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    score: doublePrecision("score").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    // Same shared `sync_rev_seq` trigger as `threads`/`labels` — see
    // `mailAccounts.syncRev`'s doc comment.
    syncRev: bigint("sync_rev", { mode: "number" }).notNull().default(0),
    syncCreatedRev: bigint("sync_created_rev", { mode: "number" }).notNull().default(0),
  },
  (table) => [
    uniqueIndex("correspondents_account_address_key").on(
      table.mailAccountId,
      table.normalizedAddress,
    ),
    // `capCorrespondents`'s own query: the account's correspondents, worst
    // score first, so trimming past the top ~500 is an indexed scan rather
    // than a sort of the whole table.
    index("correspondents_account_score_idx").on(table.mailAccountId, table.score),
    index("correspondents_sync_rev_idx").on(table.mailAccountId, table.syncRev),
  ],
);
export type CorrespondentRow = typeof correspondents.$inferSelect;

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
  /**
   * The part's own `Content-Transfer-Encoding` (lowercased), from
   * BODYSTRUCTURE — e.g. `base64`, `quoted-printable`, `7bit`. Internal to
   * the fetch-through download (`routes/messages.ts`), never sent on the
   * wire: `ImapFlow#download()`'s own transfer-encoding auto-detection
   * (a second FETCH for the part's `.MIME` headers) is unreliable for a
   * nested, dotted part id against at least GreenMail, silently returning
   * still-encoded bytes — decoding against this ingest-time value instead
   * means the download never depends on that second FETCH succeeding.
   */
  encoding: string | null;
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
    /**
     * `true` when `bodyHtml` is `plainTextToHtml`'s synthesized markup (no
     * native HTML alternative on the wire) rather than the sender's own
     * document — the Width decision (#98, `apps/client/DESIGN.md`): the
     * reading pane fills the pane with an HTML body but centers a
     * plain-text one at a readable column width. `null` for a body fetched
     * before this column existed; `routes/messages.ts` reads that as
     * `false` (the pre-existing "fills the pane" behavior) rather than
     * guessing.
     */
    bodyIsPlainText: boolean("body_is_plain_text"),
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
 * The Search Index (#50, CONTEXT.md, ADR-0016): a narrow side table rather
 * than a generated column on `messages` — the wide, toasted table `messages`
 * already is would be needlessly re-scanned by every ranking query, and a
 * generated column's `ALTER TABLE ... ADD COLUMN ... STORED` is a table
 * rewrite ADR-0009's migrate-on-boot can't afford. `doc` is `simple` +
 * `unaccent`, **no stemming** (this mailbox mixes Dutch and English inside
 * one thread), weighted subject (A) / participants (B) / split address parts
 * (C) / body text + attachment filenames (D) — see `sync/search-index.ts`,
 * the one writer.
 *
 * `folderId`/`threadId` are denormalized off `messages` so `POST /search`'s
 * Candidate Window scan (`mailAccountId`, `sentAt DESC`, the folder
 * exclusion/scope) never has to join back to it before the `LIMIT 500`;
 * `sync/threading.ts#mergeThreads` updates `threadId` here in lockstep with
 * `messages.thread_id` when two Threads collapse into one.
 *
 * `indexVersion` is what makes the index rebuildable without touching
 * `messages`: bumping `sync/search-index.ts#CURRENT_SEARCH_INDEX_VERSION`
 * (an analyzer change — stopwords, address rules, weights) is read by
 * `sync/search-index-loop.ts`'s background, batched, stale-version-first
 * sweep, never by a migration — search keeps serving the old rows for
 * whatever's left unrebuilt.
 */
export const messageSearch = pgTable(
  "message_search",
  {
    messageId: text("message_id")
      .primaryKey()
      .references(() => messages.id, { onDelete: "cascade" }),
    mailAccountId: text("mail_account_id")
      .notNull()
      .references(() => mailAccounts.id, { onDelete: "cascade" }),
    // Not a foreign key: a Thread merge (`sync/threading.ts#mergeThreads`)
    // reassigns this column in bulk to the survivor's id in the same
    // statement that reassigns `messages.thread_id`, and the losing Thread
    // row is deleted a moment later in that same function — a FK here would
    // make ordering between those two statements matter for no benefit this
    // table needs.
    threadId: text("thread_id").notNull(),
    folderId: text("folder_id")
      .notNull()
      .references(() => folders.id, { onDelete: "cascade" }),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
    doc: tsvector("doc").notNull(),
    indexVersion: integer("index_version").notNull(),
  },
  (table) => [
    index("message_search_doc_idx").using("gin", table.doc),
    index("message_search_account_recency_idx").on(table.mailAccountId, table.sentAt),
    // `sync/search-index-loop.ts`'s own candidate query: every row not yet at
    // the current analyzer version, cheaply findable without a sequential
    // scan however large the table gets.
    index("message_search_index_version_idx").on(table.indexVersion),
  ],
);
export type MessageSearchRow = typeof messageSearch.$inferSelect;

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

/**
 * The idempotency ledger for Optimistic Action mutations (ADR-0010's
 * Client-generated ULID key, ADR-0011's mutation-flush divergence, #39).
 * One row per mutation id this server has ever seen: `sync/mutations.ts`
 * checks it before applying anything, so a retry of the same id — the
 * expected shape of a dropped response over a flaky connection — replays
 * the recorded outcome instead of re-applying, which is what makes a flush
 * exactly-once rather than at-least-once. `id` is the ULID itself, so the
 * primary key alone is the uniqueness guarantee even under a genuine
 * concurrent resend.
 */
export const appliedMutations = pgTable(
  "applied_mutations",
  {
    id: text("id").primaryKey(),
    // Exactly one of `mailAccountId`/`userId` is set: a Mail-Account-scoped
    // mutation (#39) carries the former, a User-scoped one (#54's
    // `UserMutationIntent`) the latter. One ledger rather than two because
    // the id-keyed lookup this table exists for (`ledgerRow` in
    // `sync/mutations.ts`) doesn't care which scope minted the id — ULIDs
    // are unique regardless.
    mailAccountId: text("mail_account_id").references(() => mailAccounts.id, {
      onDelete: "cascade",
    }),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    intentType: text("intent_type").notNull(),
    status: text("status", { enum: ["applied", "rejected"] }).notNull(),
    /** Present only when `status` is `rejected` — why, so the outcome is self-explaining on replay. */
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("applied_mutations_account_idx").on(table.mailAccountId),
    index("applied_mutations_user_idx").on(table.userId),
  ],
);

/**
 * The idempotency ledger for a Bulk Triage batch (#67, `routes/bulk-triage.ts`,
 * `@mail/shared`'s `bulkTriageBatchRequestSchema`) — the same
 * Client-generated-ULID-key pattern `appliedMutations` is, kept as its own
 * table rather than widened into it: a batch's outcome carries a
 * per-account breakdown and the exact set of Threads it touched, neither of
 * which `MutationOutcome`'s `{status, reason}` shape has room for, and a
 * batch is scoped to the requesting **User** (Account Scope can name several
 * Mail Accounts in one request) rather than to one Mail Account the way
 * every `appliedMutations` row is.
 *
 * `affectedThreadIds` is what makes Undo exact rather than a re-run of the
 * original target set (`routes/bulk-triage.ts#undoBulkTriageAction`): the
 * target set is evaluated at the *original* request's instant, and a Thread
 * that has since moved back into range on its own must not be swept up by a
 * later Undo. `accounts` is the full per-account outcome, so a retried
 * request replays it verbatim rather than recomputing it — recomputing could
 * legitimately disagree (an account that reached Needs Reauth in between).
 */
export const bulkTriageBatches = pgTable(
  "bulk_triage_batches",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    action: text("action", { enum: ["done", "markRead"] }).notNull(),
    affectedThreadIds: text("affected_thread_ids").array().notNull().default([]),
    accounts: jsonb("accounts").$type<BulkTriageAccountOutcomeRow[]>().notNull(),
    /** Set the instant `POST /bulk-triage/undo` reverses this batch — null while it is still undoable (or was never undone). */
    undoneAt: timestamp("undone_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** `createdAt` + the Undo window (`@mail/shared`'s `BULK_TRIAGE_UNDO_WINDOW_SECONDS`) — past this, `POST /bulk-triage/undo` answers `expired`. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("bulk_triage_batches_user_idx").on(table.userId)],
);
export type BulkTriageBatchRow = typeof bulkTriageBatches.$inferSelect;

/** One Mail Account's recorded share of a batch — `accounts`'s element type, mirroring `@mail/shared`'s `BulkTriageAccountOutcome`. */
export interface BulkTriageAccountOutcomeRow {
  mailAccountId: string;
  status: "applied" | "rejected";
  affectedCount: number;
  reason?: string;
}

/**
 * The write-through outbox for the two Protocol Features (#42, ADR-0006):
 * one row per real IMAP command still owed to the mail server after an
 * Optimistic Action's synchronous ack — `\Seen`/`\Flagged` for
 * `setRead`/`setStarred`, a `MOVE` to the account's Archive/Trash folder for
 * `archive`/`trash`, and a `MOVE` back to Inbox for `inbox` — Undo's own
 * real inverse (#95, ADR-0019). `sync/mutations.ts` is the only writer;
 * `sync/protocol-writes.ts#drainProtocolWrites` is the only reader, run
 * periodically against a short-lived connection
 * (`sync/protocol-write-loop.ts`) rather than the resident IDLE session, so
 * a slow or failing mail server never blocks `POST /sync`'s own ack.
 *
 * Keyed to `messageId`, not `threadId`: the intents above act on every
 * Message in a Thread, and a Thread's Messages can span folders (a Sent
 * self-copy never moves when its Inbox copy is archived). The drain always
 * re-reads a Message's *current* folder and flag state rather than trusting
 * anything cached on this row, which is what makes two Optimistic Actions on
 * the same Message (archive, then trash, before either drains) resolve to
 * the right end state with no extra bookkeeping here.
 */
export const protocolWrites = pgTable(
  "protocol_writes",
  {
    id: text("id").primaryKey(),
    mailAccountId: text("mail_account_id")
      .notNull()
      .references(() => mailAccounts.id, { onDelete: "cascade" }),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    // "inbox" (#95, ADR-0019) is Undo's inverse move — `restoreToInbox` puts a
    // thread back where it was. "junk" (#102) is Spam's own move —
    // `sync/protocol-writes.ts`'s `moveBatch` handles it exactly like
    // "archive"/"trash", targeting whichever folder carries that special-use
    // role. Drizzle's `enum` here is TypeScript-only, so widening it needs no
    // migration.
    kind: text("kind", {
      enum: ["seen", "flagged", "archive", "trash", "inbox", "junk"],
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("protocol_writes_account_idx").on(table.mailAccountId, table.createdAt)],
);

/**
 * A Gatekeeper Verdict (#55, CONTEXT.md, ADR-0008): where one sender stands
 * with Gatekeeper on **one** Mail Account. An App Feature — IMAP has no way
 * to say "I don't want to hear from this person" — whose Blocked branch is
 * the one narrow exception ADR-0008 carves out, a real `\Trash` move on
 * arrival.
 *
 * Unscreened is the **absence of a row**, never a stored value: a sender the
 * User has not decided on and one whose Verdict was cleared (a Reset, an
 * unblock, a Deny) are the same state, and giving them two representations
 * would eventually give them two behaviours. Every `verdict` here is
 * therefore `approved` or `blocked`.
 *
 * `id` is deterministic (`@mail/shared`'s `gatekeeperVerdictId`, over
 * `(mailAccountId, scope, value)`), which is what makes "verdicts never
 * cross accounts" a property of the primary key rather than of every query
 * remembering to filter — the same shape `labelId`/`correspondentId`
 * already use. `source` and `updatedAt` are poc-spec.md's "source +
 * timestamp recorded on every verdict": what made this sender Approved a
 * year ago is answerable without a separate audit log.
 *
 * Not an ADR-0011 synced collection, deliberately. Enabling seeds one row
 * per address in the User's whole Sent history — thousands on a real
 * mailbox — and no Client surface renders that list: the Screener renders
 * *held Threads* (which carry their own sender on `threads.held_sender`),
 * and Settings renders only the Blocked list, which is small and reads
 * through `GET /mail-accounts/:id/gatekeeper`.
 */
export const gatekeeperVerdicts = pgTable(
  "gatekeeper_verdicts",
  {
    id: text("id").primaryKey(),
    mailAccountId: text("mail_account_id")
      .notNull()
      .references(() => mailAccounts.id, { onDelete: "cascade" }),
    scope: text("scope", { enum: ["address", "domain"] }).notNull(),
    /** A normalized address (plus tag intact) or a bare domain — `@mail/shared`'s `normalizeSenderAddress`. */
    value: text("value").notNull(),
    verdict: text("verdict", { enum: ["approved", "blocked"] }).notNull(),
    // Spam (#102, CONTEXT.md, ADR-0008 amendment): only ever meaningful
    // alongside `verdict: "blocked"` — it is not a fourth Verdict value, only
    // the flag that picks Junk over Trash as the destination
    // (`gatekeeper/decisions.ts#spamSender`, `gatekeeper/screening.ts`).
    spam: boolean("spam").notNull().default(false),
    source: text("source", { enum: ["seed", "sent", "screener", "settings"] }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The resolution lookup: one round trip asking for this account's
    // address row and domain row at once (`gatekeeper/verdicts.ts`).
    index("gatekeeper_verdicts_lookup_idx").on(table.mailAccountId, table.scope, table.value),
    // The Blocked Senders list, and nothing else — partial, because
    // blocked rows are a handful against a seed of thousands of approvals.
    index("gatekeeper_verdicts_blocked_idx")
      .on(table.mailAccountId, table.updatedAt)
      .where(sql`${table.verdict} = 'blocked'`),
  ],
);
export type GatekeeperVerdictRow = typeof gatekeeperVerdicts.$inferSelect;

/**
 * A Composition (#45, CONTEXT.md, ADR-0012/0013/0014): the App Feature
 * authoritative copy of a message being written. `id` is Client-generated
 * (a ULID, the same "offline-derivable" shape a Label's id has) so autosave
 * from the first keystroke never waits on a round trip for one to exist —
 * `sync/compose-store.ts#applyComposeSave` creates the row lazily on the
 * first save it sees for an unknown id, scoped to `mailAccountId` the same
 * way every other per-account table is.
 *
 * `status` is ADR-0007's state machine over ADR-0012's "one entity, two
 * states": `draft` while the User is writing, `pending` from the moment a
 * send is accepted, `submitting` from the sweeper's atomic claim, `sent`
 * once the `Sent` APPEND lands. A cancel and a permanent rejection both
 * return the row to `draft` — see `@mail/shared`'s `compositionStatusSchema`
 * for why, and why `failed` stays reserved rather than written. `discarded`
 * (#101) is Delete's own one-directional status, the same "flip a field,
 * never delete the row" shape a Thread's `archive`/`trash` already use —
 * `undiscardComposition` (#95) is its real inverse, restoring `draft`.
 *
 * `document` is the ProseMirror JSON itself (ADR-0013: "a Composition is a
 * structured document, not HTML") — the mail HTML and plaintext alternative
 * are derived from it at push time (`compose/mail-serializer.ts`) and never
 * stored. `version` is ADR-0012's optimistic-concurrency counter: bumped by
 * every accepted save, and what a stale save (a second device's autosave
 * racing this one) is rejected against.
 *
 * `imapDraftUid`/`imapDraftFolderId` and `pushedContentHash` are the
 * debounced IMAP push's own bookkeeping (`sync/draft-push.ts`): the one UID
 * this Composition owns in the account's Drafts folder, and the hash of the
 * content last pushed under it, so an idle-but-open composer pushes once
 * rather than on every debounce tick.
 */
export const compositions = pgTable(
  "compositions",
  {
    id: text("id").primaryKey(),
    mailAccountId: text("mail_account_id")
      .notNull()
      .references(() => mailAccounts.id, { onDelete: "cascade" }),
    status: text("status", {
      enum: ["draft", "pending", "submitting", "sent", "failed", "discarded"],
    })
      .notNull()
      .default("draft"),
    schemaVersion: integer("schema_version").notNull().default(1),
    subject: text("subject").notNull().default(""),
    document: jsonb("document").$type<ComposeDocument>().notNull(),
    toAddresses: jsonb("to_addresses").$type<Recipient[]>().notNull().default([]),
    ccAddresses: jsonb("cc_addresses").$type<Recipient[]>().notNull().default([]),
    bccAddresses: jsonb("bcc_addresses").$type<Recipient[]>().notNull().default([]),
    /**
     * The reply/forward threading headers (#47, compose-spec §Threading
     * headers) — computed once client-side at composer-open and carried
     * through every autosave unchanged (`@mail/shared`'s `composeSaveSchema`
     * doc comment). Null/`[]` for an ordinary new-compose Composition.
     * `submit.ts#submitComposition` passes both straight to Nodemailer.
     */
    inReplyTo: text("in_reply_to"),
    references: text("references").array().notNull().default([]),
    /** Optimistic-concurrency counter (ADR-0012), bumped on every accepted save. */
    version: integer("version").notNull().default(0),
    /** The Composition's one live message in the account's Drafts folder, or null before the first push. */
    imapDraftUid: bigint("imap_draft_uid", { mode: "number" }),
    imapDraftFolderId: text("imap_draft_folder_id").references(() => folders.id, {
      onDelete: "set null",
    }),
    /** sha256 of the content last exported — a push is skipped when this still matches (ADR-0012). */
    pushedContentHash: text("pushed_content_hash"),
    lastPushedAt: timestamp("last_pushed_at", { withTimezone: true }),
    /**
     * The Blob Store's references for this Composition (#48, ADR-0012:
     * "attachment references"), metadata only — the bytes live in
     * `attachment_blobs`, keyed by each entry's own `id`. Neither
     * `compose/compose-store.ts#applySave` nor an ordinary autosave ever
     * writes this column; only `compose/blob-store.ts` does, on upload and
     * on delete, which is also what bumps `syncRev` (via the shared
     * `bump_sync_rev` trigger) so an attachment change reaches every device
     * the same way a content edit does.
     */
    attachments: jsonb("attachments").$type<AttachmentMeta[]>().notNull().default([]),
    /**
     * The Pending Send's own columns (#46, ADR-0007). `submitAfter` is the
     * **absolute** instant the sweeper may claim this row — absolute, so "a
     * boot-time sweep submits everything due, however long the backend was
     * down" needs no extra bookkeeping, and so the delay can never be
     * measured against a Client's clock. Null for a Draft.
     *
     * `messageId` is minted by the Sync Backend at claim time and written
     * **before** anything reaches Nodemailer (compose-spec §Threading
     * headers), so a transient-failure retry re-uses it rather than minting
     * a second id for the same mail; the `Sent` APPEND carries the identical
     * value. `sendAttempts`/`nextAttemptAt` are the transient-retry backoff
     * ADR-0007 keeps *inside* `submitting`. `sendError` is the SMTP
     * rejection verbatim, non-null exactly while a Draft wears the "Send
     * failed" badge (compose-spec §Send-time validation & failure).
     */
    submitAfter: timestamp("submit_after", { withTimezone: true }),
    messageId: text("message_id"),
    sendAttempts: integer("send_attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    sendError: text("send_error"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    // Same shared `sync_rev_seq` trigger as `threads`/`labels` (migration
    // 0011) — the `Composition` collection (#46) pages exactly the way
    // theirs do. See `mailAccounts.syncRev`.
    syncRev: bigint("sync_rev", { mode: "number" }).notNull().default(0),
    syncCreatedRev: bigint("sync_created_rev", { mode: "number" }).notNull().default(0),
  },
  (table) => [
    index("compositions_account_status_idx").on(table.mailAccountId, table.status),
    // The debounced push's own candidate query (`sync/draft-push.ts`): every
    // draft not yet known to be pushed at its current content.
    index("compositions_push_pending_idx")
      .on(table.mailAccountId, table.updatedAt)
      .where(sql`${table.status} = 'draft'`),
    // The send sweeper's due query (`compose/send-sweeper.ts`), across every
    // account on the instance — deliberately not scoped to one Mail Account,
    // because a boot-time sweep asks "what is due anywhere".
    index("compositions_send_due_idx")
      .on(table.submitAfter)
      .where(sql`${table.status} in ('pending', 'submitting')`),
    index("compositions_sync_rev_idx").on(table.mailAccountId, table.syncRev),
  ],
);
export type CompositionRow = typeof compositions.$inferSelect;

/**
 * The idempotency ledger for `composeSaves` (ADR-0014, #45) — the exact
 * shape `appliedMutations` is for `mutations`, kept as its own table rather
 * than widened into it: a save's outcome carries a `version` a
 * `MutationOutcome` has no field for, and `status` has a third value
 * (`conflict`) that would otherwise be meaningless on every other intent
 * type. `id` is the save's own `saveId`, so a retried autosave (a dropped
 * response over a flaky connection, the ordinary case ADR-0010 accounts for)
 * replays this row's recorded `version` instead of being re-validated
 * against the Composition's now-advanced `version` and misread as a
 * conflict with itself.
 */
export const composeSaveLedger = pgTable(
  "compose_save_ledger",
  {
    id: text("id").primaryKey(),
    compositionId: text("composition_id").notNull(),
    status: text("status", { enum: ["applied", "conflict", "rejected"] }).notNull(),
    version: integer("version").notNull(),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("compose_save_ledger_composition_idx").on(table.compositionId)],
);

/**
 * The Blob Store (#48, ADR-0012): one attachment's bytes, `bytea` behind the
 * narrow put/get/delete-by-id seam `compose/blob-store.ts` is. `id` is
 * server-minted at upload time (never Client-generated the way a
 * Composition's own id is) — it is also the seam's own natural key, and
 * `compositions.attachments` carries it as each entry's `id`.
 *
 * `compositionId` is `NOT NULL` with `onDelete: "cascade"` **on purpose**:
 * ADR-0012 names a 24h sweeper for "blobs with no parent Composition" as the
 * general Blob Store design's cleanup mechanism, but this table's own FK
 * makes that class of orphan structurally impossible instead — a blob is
 * never insertable without a Composition row already behind it (the upload
 * route creates one lazily first, the same "created lazily on first
 * content" path autosave uses), and deleting a Composition deletes its
 * blobs in the same statement, no sweeper required. An abandoned
 * attach-then-never-sent composer is simply a Draft with an attachment
 * forever, which is exactly what "Drafts never auto-expire" already says is
 * fine.
 */
export const attachmentBlobs = pgTable(
  "attachment_blobs",
  {
    id: text("id").primaryKey(),
    compositionId: text("composition_id")
      .notNull()
      .references(() => compositions.id, { onDelete: "cascade" }),
    bytes: bytea("bytes").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("attachment_blobs_composition_idx").on(table.compositionId)],
);
export type AttachmentBlobRow = typeof attachmentBlobs.$inferSelect;

/**
 * A Web Push subscription (#53, ADR-0015): one device's `PushSubscription`,
 * stored against the **User**, never the Session — "a subscription that
 * dies with a 60-day cookie rotation is one that stops working silently".
 * `endpoint` is the subscription's real identity (what a `404`/`410` from
 * the push service prunes by, and what `POST`/`DELETE /push/subscriptions`
 * key on); `p256dh`/`auth` are the ECDH/auth secret the Notifier encrypts a
 * payload against so the relaying push service only ever sees ciphertext.
 * A device re-registering the same endpoint (a reload, a second tab open on
 * the same install) upserts rather than duplicating.
 */
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull().unique(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("push_subscriptions_user_idx").on(table.userId)],
);
export type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect;

/**
 * The Notifier's durable outbox (#53, ADR-0015): one row per push-worthy
 * event, inserted at the moment policy decides it is one (a new
 * Approved-Sender Inbox message, a Needs Reauth transition, a permanently
 * failed send) and drained by `notifier/deliver-loop.ts` independently of
 * whichever code path noticed the event. Durability is the point —
 * "fire-and-forget would re-push the first half of a 40-message batch after
 * a container restart" — a row surviving a crash between "policy said yes"
 * and "a push actually went out" is what makes a restart resumable instead
 * of silently dropping whatever was mid-flight.
 *
 * `dedupKey` + the unique index is deliberately a *second* line of defense,
 * not the primary one: the real "exactly once" guarantee for each kind
 * already lives where the event is detected (a message's own
 * `(folder_id, uid)` uniqueness for `new_mail`, the atomic conditional
 * transition in `mail-accounts/store.ts#markNeedsReauth` for
 * `needs_reauth`, `compose/pending-send.ts`'s atomic claim for
 * `failed_send`) — this index only catches an accidental double-insert
 * racing that guarantee, per kind: the Message id for `new_mail`, the
 * Composition id for `failed_send`, `${mailAccountId}:${transition instant}`
 * for `needs_reauth` (never the bare Mail Account id — a second, later
 * transition into Needs Reauth for the same account is a genuine new event,
 * not a repeat of the first).
 */
export const notifierOutbox = pgTable(
  "notifier_outbox",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    mailAccountId: text("mail_account_id")
      .notNull()
      .references(() => mailAccounts.id, { onDelete: "cascade" }),
    kind: text("kind", {
      enum: ["new_mail", "failed_send", "needs_reauth", "gatekeeper_digest"],
    }).notNull(),
    dedupKey: text("dedup_key").notNull(),
    /** The push payload's content, minus `badgeCount` — computed fresh at delivery time (ADR-0015: "at Notifier-fire time"), never stored stale. */
    payload: jsonb("payload").$type<NotifierOutboxPayload>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("notifier_outbox_kind_dedup_key").on(table.kind, table.dedupKey),
    // `deliver-loop.ts`'s own candidate query: every undelivered row, grouped
    // by account so a `new_mail` burst across one account collapses
    // together rather than per-row.
    index("notifier_outbox_pending_idx")
      .on(table.mailAccountId, table.createdAt)
      .where(sql`${table.deliveredAt} is null`),
  ],
);
export type NotifierOutboxRow = typeof notifierOutbox.$inferSelect;

/** One outbox row's kind-specific content — everything a push payload needs except the badge count, which is always computed fresh at send time. */
export type NotifierOutboxPayload =
  | {
      kind: "new_mail";
      threadId: string;
      senderName: string | null;
      senderAddress: string | null;
      subject: string;
      snippet: string | null;
    }
  | { kind: "failed_send"; compositionId: string; subject: string; detail: string }
  | { kind: "needs_reauth"; emailAddress: string }
  | { kind: "gatekeeper_digest"; senders: string[]; count: number };
