import type {
  AttachmentMeta,
  CalendarCapabilities,
  ComposeDocument,
  EventReminder,
  NoteDocument,
  Recipient,
  ReminderDefault,
  SeriesAttendee,
} from "@mail/shared";
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
import type {
  ConnectedAccountCredential,
  SealedSecret,
} from "../connected-accounts/credential-crypto.js";

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
  /**
   * Home Time Zone (#189, poc-spec.md §Preferences): the rest of `Preference`
   * again, same posture as `autoAdvanceEnabled` above — one row per User, no
   * separate table. `""` is "not seeded yet" (`@mail/shared`'s
   * `HOME_TIME_ZONE_UNSET`), not a default zone: the signing-in device seeds
   * its own IANA zone through the ordinary Optimistic Action queue rather
   * than this column ever guessing one from the server's clock.
   */
  homeTimeZone: text("home_time_zone").notNull().default(""),
  /**
   * "Answer received" notification on/off (#243, `Preference`'s own field):
   * the rest of `Preference` again, one row per User, no separate table —
   * its own per-User toggle beside the per-Calendar `remindersEnabled`
   * (`calendars.remindersEnabled`'s own doc comment) on the Notifications
   * page, since an Answer names no one Calendar the way a Reminder does.
   */
  answerNotificationsEnabled: boolean("answer_notifications_enabled").notNull().default(true),
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
 * A **Connected Account** (#199, ADR-0022, CONTEXT.md): one identity at one
 * Provider, owned by one User, holding exactly one credential — the row the
 * credential moved up to, out of `mail_accounts`. `provider` is the
 * glossary's four values (`@mail/shared`'s `Provider`); `identity` is the
 * signed-in address (Google/Microsoft) or the entered username (Other IMAP,
 * CalDAV/CardDAV) that makes this row unique per User and Provider.
 * `credential` is the AEAD-sealed tagged union
 * (`connected-accounts/credential-crypto.ts`), `jsonb` for the same reason it
 * always was on `mail_accounts` — a new `oauth` shape needs no migration of
 * existing `password` rows. `status` is the account-level half of Needs
 * Reauth (ADR-0022: "on the Connected Account when the credential is
 * rejected or the Grant withdrawn (every Facet stops)") — the Facet-level
 * half lives on `connected_account_facets` below.
 *
 * `serverAddress`/`davUsername` exist for CalDAV/CardDAV only (discovery
 * input, #203) — null for every other Provider, which enters nothing here
 * because Google/Microsoft's identity comes back from the Provider itself
 * and Other IMAP's own host/port live on its one Mail Facet
 * (`mail_accounts`), not here.
 */
export const connectedAccounts = pgTable(
  "connected_accounts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider", {
      enum: ["google", "microsoft", "other_imap", "caldav_carddav"],
    }).notNull(),
    identity: text("identity").notNull(),
    credential: jsonb("credential").$type<ConnectedAccountCredential>().notNull(),
    status: text("status", { enum: ["active", "needs_reauth"] })
      .notNull()
      .default("active"),
    /** CalDAV/CardDAV only (#203): the server or email address discovery started from. Null otherwise. */
    serverAddress: text("server_address"),
    /** CalDAV/CardDAV only (#203): the login entered alongside the app password. Null otherwise. */
    davUsername: text("dav_username"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    // #200 (ADR-0023): `ConnectedAccount` joins the User-scoped collection
    // registry, whole-replicated. Same stamping as `mailAccounts.syncRev`
    // above — one `bump_sync_rev` trigger, the shared `sync_rev_seq`. A
    // Facet's own status flip has no `syncRev` of its own to bump (Facets
    // ride this collection's payload, not a collection of their own); its
    // own migration-level trigger bumps its parent row's `syncRev` instead
    // (`db/migrations/0042_*.sql`).
    syncRev: bigint("sync_rev", { mode: "number" }).notNull().default(0),
    syncCreatedRev: bigint("sync_created_rev", { mode: "number" }).notNull().default(0),
  },
  (table) => [
    uniqueIndex("connected_accounts_user_provider_identity_key").on(
      table.userId,
      table.provider,
      table.identity,
    ),
    index("connected_accounts_user_id_idx").on(table.userId),
    index("connected_accounts_sync_rev_idx").on(table.userId, table.syncRev),
  ],
);
export type ConnectedAccountRow = typeof connectedAccounts.$inferSelect;

/**
 * A **Facet** (#199, ADR-0022, CONTEXT.md): one thing (Mail, Calendar,
 * Contacts) a Connected Account is turned on for, and the single register of
 * which Facets an account has — Mail included, so the Mail Account it
 * belongs to (`mail_accounts.connected_account_id`) always names exactly one
 * row here of `kind: "mail"`. `status` is Needs Reauth's Facet-level half
 * (ADR-0022: "on a single Facet when only its consent is refused ... that
 * Facet stops, the others continue"). `scopesLastGrantedAt` is when this
 * Facet's own consent was last (re-)granted — null until a Facet actually
 * completes a consent round, which for the Mail Facet created by this
 * ticket's boot-time upgrade is never (the existing Grant predates Facets).
 *
 * The `dav*` columns are CalDAV/CardDAV's own per-Facet discovery (#203) —
 * discovery runs separately per Facet because iCloud serves each from a
 * different host (ADR-0022) — and stay null for every other Provider and
 * for Mail everywhere.
 */
export const connectedAccountFacets = pgTable(
  "connected_account_facets",
  {
    id: text("id").primaryKey(),
    connectedAccountId: text("connected_account_id")
      .notNull()
      .references(() => connectedAccounts.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["mail", "calendar", "contacts"] }).notNull(),
    status: text("status", { enum: ["active", "needs_reauth"] })
      .notNull()
      .default("active"),
    scopesLastGrantedAt: timestamp("scopes_last_granted_at", { withTimezone: true }),
    /** CalDAV/CardDAV only (#203): the discovered principal URL. Null otherwise. */
    davPrincipalUrl: text("dav_principal_url"),
    /** CalDAV/CardDAV only (#203): the discovered calendar/address-book home-set URL. Null otherwise. */
    davHomeSetUrl: text("dav_home_set_url"),
    /** CalDAV/CardDAV only (#203): whether the server speaks RFC 6638 scheduling. Null otherwise. */
    davSupportsScheduling: boolean("dav_supports_scheduling"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("connected_account_facets_account_kind_key").on(
      table.connectedAccountId,
      table.kind,
    ),
  ],
);
export type ConnectedAccountFacetRow = typeof connectedAccountFacets.$inferSelect;

/**
 * A connection to an external mail server, owned by exactly one User
 * (CONTEXT.md, ADR-0004) — no join table, no sharing. `imap*`/`smtp*`
 * columns are the provider-agnostic host/port/TLS shape both autodiscover
 * and manual entry produce (docs/research/0004 §6). The credential and the
 * Needs Reauth status moved up to `connected_accounts`/
 * `connected_account_facets` in #199 (ADR-0022) — this row is now the Mail
 * Facet, named by `connectedAccountId`, and carries everything about mail
 * syncing that isn't the credential itself.
 */
export const mailAccounts = pgTable(
  "mail_accounts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The parent Connected Account (#199, ADR-0022) — always exactly one Mail Facet per Connected Account. */
    connectedAccountId: text("connected_account_id")
      .notNull()
      .unique()
      .references(() => connectedAccounts.id, { onDelete: "cascade" }),
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
    // Whether this Mail Account's server speaks Gmail's IMAP extension
    // (`X-GM-EXT-1`), detected by `mail-accounts/server-kind.ts` — ADR-0020:
    // "selection by server capability, not credential kind", so an
    // app-password Gmail account gets the same kind as one added by Google
    // sign-in. Set at verification for a new account (`mail-accounts/verify.ts`)
    // and on every connect for an existing one (`sync/imap-connection.ts`),
    // so a Mail Account added before this column existed picks it up on its
    // next sync rather than needing a migration backfill. Null until then —
    // the write paths this unblocks (label ops vs. moves) don't exist yet.
    serverKind: text("server_kind", { enum: ["gmail", "generic"] }),
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
    // The remote-images permission (#146, CONTEXT.md §Remote images) — a
    // third Mail-Account-scoped preference alongside `signature`/
    // `notificationsEnabled`, edited through the same mutation queue
    // (`setRemoteImages`). Null until the User picks one explicitly: the
    // effective setting is derived at read time from `gatekeeperEnabled`
    // (`@mail/shared#resolveRemoteImagesSetting`) rather than baked in as a
    // stored default, so turning Gatekeeper on or off keeps answering the
    // question correctly for every account that never touched this control.
    remoteImages: text("remote_images", { enum: ["always", "approved-only", "ask"] }),
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
    // Gmail's roughly 2.5 GB/day IMAP download cap (#127, ADR-0020's final
    // consequence): once the body sweep trips it on a `gmail`-kind account,
    // `sync/body-sweep.ts` stamps this instead of failing the sweep, and
    // skips fetching until it passes. Null the rest of the time — a sweep
    // that isn't paused has nothing here, and this is never set on a
    // `generic` account (that Provider's errors still tear the session down
    // as before). Doesn't touch `syncState`/`lastSyncError`: a paused sweep
    // is expected behaviour, not a sync error, and the Index Watermark
    // already states partial coverage on its own.
    bodySweepPausedUntil: timestamp("body_sweep_paused_until", { withTimezone: true }),
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
    // Labels currently applied to this Thread (#43), as `labels.id`s
    // (User-scoped since #186 — the owning User's one Label set, not this
    // account's) —
    // denormalized here the same way `inInbox`/`pinned` are, so the Client's
    // one Thread projection carries membership without a join. `sync/
    // mutations.ts` is the only writer; `labels` below is the id→name
    // collection those ids resolve against.
    labelIds: text("label_ids").array().notNull().default([]),
    // Gmail Labels currently on this Thread (#126, ADR-0020) — `labelIds`'s
    // sibling, never merged into it: a Gmail Label is never a Wicket Label
    // (CONTEXT.md). Always `[]` on a non-Gmail account. `sync/thread-rollup.ts`
    // is the only writer, computed from the union of every Message in the
    // Thread's `gmailLabels` (a Gmail conversation is not always labelled
    // identically on every message), mapped through
    // `gmail-labels.ts#gmailLabelId` and filtered to exclude system
    // pseudo-labels the same way `sync/gmail-labels.ts#persistGmailLabels`
    // excludes them from the `GmailLabel` collection itself.
    gmailLabelIds: text("gmail_label_ids").array().notNull().default([]),
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
    // The recipient Alias (#103, CONTEXT.md) this hold's opening message
    // resolved to at ingest — `gatekeeper/alias.ts#resolveRecipientAlias`'s
    // output, copied here the same instant `heldSender`/`heldAt` are set
    // (`gatekeeper/screening.ts#screenArrivals`), null whenever they are.
    // What `gatekeeper/decisions.ts`'s Block-Alias decision matches held
    // Threads against, the recipient-scoped sibling of `heldBySender`'s
    // `heldSender` match — never written by the rollup, only by Gatekeeper,
    // same as `heldSender` itself.
    heldRecipientAlias: text("held_recipient_alias"),
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
    // #103's Block-Alias decision's own query: "whatever is currently held
    // for this Alias" — the same partial-index reasoning as
    // `threads_held_sender_idx` above, keyed to the Alias instead.
    index("threads_held_recipient_alias_idx")
      .on(table.mailAccountId, table.heldRecipientAlias)
      .where(sql`${table.heldRecipientAlias} is not null`),
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
 * (`labelId` in `packages/shared/src/labels.ts`, `(userId, name)`) rather
 * than minted here and handed back — `sync/mutations.ts`'s `applyLabel`
 * computes the same id a Client already predicted offline, so creating a
 * brand-new Label by applying it is one Optimistic Action, not two.
 * `threads.labelIds` is the membership side; this table is only the id→name
 * definition, synced as its own ADR-0011 collection.
 *
 * **Owned by the User, not a Mail Account** (#186, ADR-0023): one set of
 * Labels spans every Mail Account a User owns, so a `threads.labelIds` entry
 * on any of those accounts names a row here. That is the precondition for a
 * Note carrying the same Labels mail does — a Note has no Mail Account to be
 * scoped to. `gmailLabels` below deliberately did *not* move with it: a
 * Gmail Label really is one Gmail account's own read-only tag, never a
 * Wicket Label. Migration 0037 merged each User's pre-existing same-named
 * per-account Labels (case-insensitively) into one row and remapped every
 * `threads.labelIds` entry onto the survivor.
 */
export const labels = pgTable(
  "labels",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    // Same shared `sync_rev_seq` trigger as `threads`/`mail_accounts` — see
    // their comments above.
    syncRev: bigint("sync_rev", { mode: "number" }).notNull().default(0),
    syncCreatedRev: bigint("sync_created_rev", { mode: "number" }).notNull().default(0),
  },
  (table) => [
    uniqueIndex("labels_user_name_key").on(table.userId, table.name),
    index("labels_sync_rev_idx").on(table.userId, table.syncRev),
  ],
);
export type LabelRow = typeof labels.$inferSelect;

/**
 * A Note (#192, ADR-0023): the first **new** caller of the collection
 * registry, and the first collection to carry a document body rather than
 * only intents. **User-scoped**, the same as `labels` above — one Note has
 * no Mail Account to belong to, which is also the precondition ADR-0023
 * names for a Note carrying the same `labelIds` mail does. Replicates
 * *whole*, no window (unlike `threads`' paging or a future Calendar's time
 * range) — a User has at most a handful of Notes at PoC scope.
 *
 * `id` is **not** deterministic like a `labels` row's: it is a
 * Client-minted ULID (`store/notes.ts#newNoteId`), the same "offline-derivable
 * address" reasoning `compositions.id` already uses, so a brand-new Note has
 * its `/notes/:noteId` address the instant it is created, before any server
 * round trip. `sync/mutations.ts`'s `createNote`/`deleteNote` intents are
 * what actually create and destroy this row; `sync/note-store.ts`'s
 * `noteSaves` channel only ever updates `document` on an existing one — see
 * that module's own doc comment for why it upserts anyway rather than
 * rejecting a save that raced a not-yet-applied `createNote`.
 *
 * `document` is BlockNote's own block document (#191, ADR-0024,
 * `packages/shared/src/notes.ts#noteDocumentSchema`) — deliberately loose,
 * the same reasoning `compositions.document` already has. There is no
 * `version`: a Note's body write is never rejected (ADR-0023's "takes the
 * latest by receipt"), so there is nothing here for a Client to have read
 * stale against.
 */
export const notes = pgTable(
  "notes",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    document: jsonb("document").$type<NoteDocument>().notNull(),
    /** Membership side of a Note's Labels (#192) — `threads.labelIds`'s own shape, naming rows in this same User's one `labels` set. */
    labelIds: text("label_ids").array().notNull().default([]),
    /** The grid's Pinned/Others split (#193) — a structural intent (`pinNote`/`unpinNote`), same shape as `threads.pinned` above but reached through the User-scoped Optimistic Action queue rather than a per-Mail-Account one. */
    pinned: boolean("pinned").notNull().default(false),
    /**
     * Soft delete and Recently Deleted (#194) — set by `trashNote`, cleared
     * by its real inverse `restoreNote` (`sync/mutations.ts`, ADR-0019). Null
     * for an ordinary Note. The row keeps syncing as an ordinary `updated`
     * row while this is set — never a `sync/tombstones.ts` entry until
     * `sync/note-purge.ts` physically deletes it `NOTE_TRASH_RETENTION_DAYS`
     * after this is stamped.
     */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    // Same shared `sync_rev_seq` trigger as `labels`/`threads` — see their
    // comments above.
    syncRev: bigint("sync_rev", { mode: "number" }).notNull().default(0),
    syncCreatedRev: bigint("sync_created_rev", { mode: "number" }).notNull().default(0),
  },
  (table) => [
    index("notes_sync_rev_idx").on(table.userId, table.syncRev),
    // `sync/note-purge.ts`'s own sweep query: every row past its retention
    // window, account-wide — a partial index (`deletedAt IS NOT NULL`) since
    // most Notes never carry one.
    index("notes_deleted_at_idx").on(table.deletedAt).where(sql`${table.deletedAt} is not null`),
  ],
);
export type NoteRow = typeof notes.$inferSelect;

/**
 * A Calendar (#229, CONTEXT.md's Calendar entry): "one named collection of
 * Events with exactly one Origin." **User-scoped**, same shape as `notes`
 * above — replicates whole, `id` is deterministic only for the one row this
 * ticket ever creates itself (`ensurePersonalCalendar`, `sync/calendars.ts`,
 * `packages/shared/src/calendars.ts#personalCalendarId`); a future mirrored
 * Calendar (#234) is minted per upstream row instead.
 *
 * `originType`/`connectedAccountId` are two columns rather than one jsonb
 * blob because a Calendar's Origin is exactly what determines its identity
 * and lifecycle (ADR-0025's cascade-on-Facet-off/remove) — a plain column a
 * query can filter on beats a jsonb path expression for that. There is
 * **no foreign key** from `connectedAccountId` to a `connected_accounts`
 * table: that table does not exist on this branch's ancestry yet (#200's
 * line is a sibling epic, not yet merged here) and nothing sets this column
 * non-null in this ticket — see this ticket's closing comment. `mailAccountId`
 * does have a real FK: Mail Accounts already exist on this line.
 *
 * `capabilities` is `jsonb` (ADR-0025's per-Calendar capability flags,
 * `packages/shared/src/calendars.ts#calendarCapabilitiesSchema`) — computed
 * once at creation (a Local Calendar's are constant;
 * a future adapter computes a mirrored one's, #234) and read back verbatim,
 * never queried on, the same reasoning `compositions.document` already
 * gives for a jsonb column with no index.
 */
export const calendars = pgTable(
  "calendars",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    timeZone: text("time_zone").notNull(),
    originType: text("origin_type", { enum: ["local", "connectedAccount"] }).notNull(),
    /** Set only once a mirrored Calendar exists (#234) — see this table's own doc comment for why there is no FK yet. */
    connectedAccountId: text("connected_account_id"),
    color: text("color").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    mailAccountId: text("mail_account_id").references(() => mailAccounts.id, {
      onDelete: "set null",
    }),
    mirrored: boolean("mirrored").notNull().default(true),
    capabilities: jsonb("capabilities").$type<CalendarCapabilities>().notNull(),
    /**
     * Google's `events.list` incremental-sync cursor (#234) — per-Calendar,
     * because Google mints it per-calendar, not per-account. `null` for a
     * Local Calendar and for a mirrored one that has never completed an
     * initial `events.list`. A `410 Gone` clears it back to `null` so the
     * next tick re-lists full and re-derives one, rather than ever setting
     * a Client-visible `reset: true` (the ticket's own acceptance line) —
     * the re-list's rows upsert into these same ids exactly like an
     * ordinary delta.
     */
    googleSyncToken: text("google_sync_token"),
    /**
     * Microsoft Graph's own incremental-sync cursor for this Calendar's
     * `calendarView/delta` (#248) — the Google column's own exact
     * counterpart, holding a full `@odata.deltaLink` URL rather than a bare
     * token (Graph's own convention: the link already encodes
     * `startDateTime`/`endDateTime` and every other query parameter the
     * initial call made). `null` for anything but a mirrored Graph
     * Calendar, and for one that has never completed an initial
     * `calendarView` list — an expired or invalid link is cleared back to
     * `null` the same "re-list fresh, re-derive one" way a Google `410`
     * clears `googleSyncToken`.
     */
    graphDeltaLink: text("graph_delta_link"),
    /**
     * Microsoft Graph's own `changeKey` for this Calendar row itself
     * (#248) — there is no delta-tracked list for the calendar collection
     * (`calendar-delta` lives only in beta), so `graph/calendar-list-sync.ts`
     * diffs a plain `GET /me/calendars` against this stored value instead:
     * unchanged means nothing about the calendar's own name/colour/`canEdit`
     * needs re-folding, no field-by-field comparison required. `null` for
     * anything but a mirrored Graph Calendar.
     */
    graphChangeKey: text("graph_change_key"),
    /**
     * CalDAV's own per-calendar-collection `getctag` (#247, RFC 6578/the
     * CalendarServer `getctag` extension) — checked before ever issuing a
     * `sync-collection` REPORT: unchanged since the last tick means nothing
     * in this collection moved, so `caldav/event-sync.ts` skips the REPORT
     * entirely for this tick, the acceptance line's own "getctag is checked
     * before asking for changes". `null` for anything but a mirrored CalDAV
     * Calendar, and for one that has never completed an initial sync.
     */
    davCtag: text("dav_ctag"),
    /**
     * CalDAV's own `sync-collection` REPORT cursor (#247, RFC 6578) — this
     * Calendar's own incremental-sync token, the exact counterpart to
     * `googleSyncToken`/`graphDeltaLink` above. A `403 valid-sync-token`
     * precondition failure clears this back to `null` so the next tick
     * re-walks the whole collection fresh via `calendar-multiget` and
     * upserts into these same rows — never a Client-visible `reset: true`,
     * the same contract Google's own `410` and Graph's own expired
     * `deltaLink` already keep.
     */
    davSyncToken: text("dav_sync_token"),
    /**
     * How many consecutive 15-minute enumerations in a row this mirrored
     * Calendar has been missing from its upstream's own calendar-list
     * response (#234's "a vanished Calendar is tombstoned only after a
     * second confirmation", reused verbatim by #248's Graph adapter) —
     * reset to `0` the moment it's seen again. `0` for a Local Calendar,
     * always.
     */
    missingConfirmations: integer("missing_confirmations").notNull().default(0),
    /**
     * Whether Wicket rings this Calendar's Reminders at all (#244, ADR-0028)
     * — User-scoped, synced, defaulting `true` for every Origin (this
     * ticket's own acceptance line). Read by #245's own due-table
     * materialiser, never by the mirror: the upstream never hears about it
     * either way.
     */
    remindersEnabled: boolean("reminders_enabled").notNull().default(true),
    /**
     * The Calendar's own Reminder Default (#244, ADR-0028's own doc
     * comment): "seeded once and never read from or written to the upstream
     * again" — `store.ts#ensurePersonalCalendar` and
     * `google/calendar-list-sync.ts`'s own `!existing` branch are the only
     * two places that ever set this to anything but the schema default
     * below; every later Calendar-list sync tick leaves it alone, the exact
     * same "seeded once" posture `capabilities` (above) does not share
     * (that one's freely recomputed on every fold). The bare `{timed: [],
     * allDay: []}` default only ever backs a row some future migration adds
     * with no seeding step of its own — every Calendar this ticket's own
     * code creates sets a real value at insert time.
     */
    reminderDefault: jsonb("reminder_default")
      .$type<ReminderDefault>()
      .notNull()
      .default({ timed: [], allDay: [] }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    // Same shared `sync_rev_seq` trigger as `labels`/`notes` above.
    syncRev: bigint("sync_rev", { mode: "number" }).notNull().default(0),
    syncCreatedRev: bigint("sync_created_rev", { mode: "number" }).notNull().default(0),
  },
  (table) => [index("calendars_sync_rev_idx").on(table.userId, table.syncRev)],
);
export type CalendarRow = typeof calendars.$inferSelect;

/**
 * A Series (#230, ADR-0025's storage vocabulary): the RFC 5545 body a
 * Calendar's Occurrence rows (`events` below) are materialised from.
 * **Not** an ADR-0011 collection — no `syncRev`, never read by
 * `sync/collection-registry.ts` — because "the Series body is an on-demand
 * fetch, not part of the `Event` delta" (this ticket's acceptance line);
 * `routes/calendars.ts` is its one reader, the same "fetch-through, not
 * synced" posture `messages` has for a mail body.
 *
 * `id` is a Client-generated ULID (this ticket's acceptance line) — see
 * `apps/client/src/store/ulid.ts#generateUlid`, the same idiom
 * `newNoteId`/`newCompositionId` already use. `rrules`/`rdates`/`exdates`
 * are RFC 5545 strings, not a structured object (`packages/shared/src/series.ts`'s
 * own doc comment explains why); `dtstart` and each `rdates`/`exdates` entry
 * are stored in this Series' own DATE-TIME form (`calendars/materialiser.ts`
 * is the one place that interprets the trio, per `allDay`/`floating`/`tzid`).
 */
export const series = pgTable(
  "series",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    calendarId: text("calendar_id")
      .notNull()
      .references(() => calendars.id, { onDelete: "cascade" }),
    /** `<seriesId>@<instance host>` for a Wicket-created Series (ADR-0025); an upstream's own UID otherwise. */
    uid: text("uid").notNull(),
    sequence: integer("sequence").notNull().default(0),
    title: text("title").notNull(),
    description: text("description"),
    location: text("location"),
    allDay: boolean("all_day").notNull().default(false),
    floating: boolean("floating").notNull().default(false),
    tzid: text("tzid"),
    dtstart: timestamp("dtstart", { withTimezone: true }).notNull(),
    durationMs: bigint("duration_ms", { mode: "number" }).notNull(),
    rrules: jsonb("rrules").$type<string[]>().notNull().default([]),
    rdates: jsonb("rdates").$type<string[]>().notNull().default([]),
    exdates: jsonb("exdates").$type<string[]>().notNull().default([]),
    transparency: text("transparency", { enum: ["opaque", "transparent"] })
      .notNull()
      .default("opaque"),
    attendees: jsonb("attendees").$type<SeriesAttendee[]>().notNull().default([]),
    /**
     * Up to `MAX_EVENT_REMINDERS` (#244, ADR-0028), capped in practice by the
     * owning Calendar's `capabilities.perEventReminders` —
     * `reminders.ts#eventReminderSchema`'s own doc comment. Round-trips with
     * Google's `reminders.overrides` (`google/event-body.ts`) and Graph's
     * single `reminderMinutesBeforeStart` slot (`graph/event-body.ts`); an
     * empty array means "use the Calendar's Reminder Default", never "no
     * Reminder at all".
     */
    reminders: jsonb("reminders").$type<EventReminder[]>().notNull().default([]),
    /** Set only for a mirrored Calendar's Series (#234); `null` for anything Wicket organises. */
    upstreamId: text("upstream_id"),
    etag: text("etag"),
    /**
     * The last known-good upstream body (#237, ADR-0025: "each mirrored
     * Series keeps an `upstreamSnapshot` so a revert needs no network") —
     * opaque JSON, written every time an outbox push actually lands
     * (`calendars/outbox-processor.ts`). A conflict's revert
     * (`calendars/outbox-rollback.ts#revertSeriesFromUpstreamSnapshot`) reads
     * this back onto the row directly rather than re-fetching Google, which
     * is the whole point: the three conflict shapes resolve with no network
     * round trip. `null` for a Series never yet confirmed upstream (a brand
     * new local Series, or one whose very first push was rejected).
     */
    upstreamSnapshot: jsonb("upstream_snapshot").$type<Record<string, unknown>>(),
    /**
     * CalDAV's own second conditional-write axis (#247, RFC 6638 §3.3):
     * respected alongside `etag`/`If-Match` wherever the server offers it —
     * `caldav/outbox-processor.ts` sends it back as `If-Schedule-Tag-Match`
     * on a scheduling-aware server's own writable Series. `null` for every
     * other Origin, and for a CalDAV Series whose server never returned one
     * (RFC 6638's own "Schedule-Tag is optional even on a scheduling-capable
     * collection").
     */
    davScheduleTag: text("dav_schedule_tag"),
    /**
     * Delete-a-Series and its Undo (#233, ADR-0019: `trashSeries`/
     * `restoreSeries`, `packages/shared/src/sync.ts#userMutationIntentSchema`).
     * The row itself, soft-deleted, **is** the 24-hour snapshot this ticket's
     * own body promises ("`restoreEvent` recreates a deleted Series from a
     * 24-hour snapshot") — the same "the row survives, only this field flips"
     * shape `notes.deletedAt` already has, just a purge delay of hours
     * (`SERIES_TRASH_RETENTION_HOURS`, `calendars/series-purge.ts`) rather
     * than `NOTE_TRASH_RETENTION_DAYS`. `calendars/materialise-loop.ts`
     * skips a soft-deleted row entirely — its Occurrences are torn down the
     * instant `trashSeries` applies, never left to the daily sweep.
     */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    /**
     * When the very first organiser-side `REQUEST` actually went out for this
     * Series (#242, ADR-0027) — `null` until then, regardless of how long the
     * Series has carried Attendees with nobody yet invited (an Attendee added
     * then removed before any send, say). `calendars/series-store.ts
     * #sendOrganizerUpdates` is the one place this is set, and the one place
     * that reads it to decide "create sends `REQUEST` at once, `SEQUENCE`
     * stays 0" from "every organiser-side send after the first bumps
     * `SEQUENCE`" — the distinction is about the first *mail sent*, not the
     * first *save*.
     */
    organizerFirstSentAt: timestamp("organizer_first_sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("series_calendar_id_idx").on(table.calendarId),
    index("series_user_id_idx").on(table.userId),
    index("series_deleted_at_idx").on(table.deletedAt).where(sql`${table.deletedAt} is not null`),
  ],
);
export type SeriesRow = typeof series.$inferSelect;

/**
 * An Override (#230, ADR-0025): one Occurrence that still happens but
 * differs from what its Series would otherwise produce. Keyed
 * `(seriesId, originalStart)` — the same pair an Occurrence row's own id is
 * built from — so the materialiser looks one up with no scan. "A cancelled
 * Occurrence is an `exdate` and nothing more" (this ticket's acceptance
 * line): there is deliberately no `status`/cancellation column here — a
 * cancelled instance is never an Override row, it is a `series.exdates`
 * entry with nothing materialised at all.
 */
export const overrides = pgTable(
  "overrides",
  {
    id: text("id").primaryKey(),
    seriesId: text("series_id")
      .notNull()
      .references(() => series.id, { onDelete: "cascade" }),
    originalStart: timestamp("original_start", { withTimezone: true }).notNull(),
    /** `null` on any of these four means "inherit the Series' own value" — never "cleared" (`packages/shared/src/series.ts#seriesOverrideSchema`). */
    start: timestamp("start", { withTimezone: true }),
    end: timestamp("end", { withTimezone: true }),
    title: text("title"),
    location: text("location"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("overrides_series_id_original_start_idx").on(table.seriesId, table.originalStart),
  ],
);
export type OverrideRow = typeof overrides.$inferSelect;

/**
 * The Reminder Due table (#245, ADR-0028): "one row per `(User, Occurrence,
 * minutesBefore)` with `dueAt` and `firedAt`, kept only for Occurrences
 * starting within the next five weeks." Derived, never edited directly — the
 * one writer is `calendars/reminder-due-store.ts#rebuildReminderDueForSeries`,
 * called every time `series-store.ts#rematerialiseSeries` runs (a Series or
 * Override edit, or the daily Materialisation Window roll) and again
 * whenever a Calendar's Reminder toggle/Reminder Default or a User's Home
 * Time Zone changes (`sync/mutations.ts`) — the exact change set ADR-0028
 * lists.
 *
 * `id` is `<eventId>:<minutesBefore>` — deterministic per `(Occurrence,
 * minutesBefore)` pair, the same "id names the row" convention `events.id`
 * itself uses, so a rebuild's own upsert never has to look a row up first.
 *
 * `seriesId` deliberately carries **no FK** — `events.seriesId`'s own doc
 * comment gives the exact reason: a mirrored Calendar's raw ingested
 * Occurrences (`calendars/google/event-sync.ts`) have no backing `series`
 * row at all, and this table's own coverage stops exactly where the
 * materialiser's already does (`selectMaterialisableSeries` walks genuine
 * `series` rows only) — not a new gap, the existing one.
 *
 * `eventId` **does** cascade: the Occurrence row disappearing (the window
 * rolled past it, an `exdate` now covers it, the Series shrank) is exactly
 * "cancelled" per ADR-0028's own "Skipped" rule, and deleting the Occurrence
 * row is already how the materialiser expresses that — no separate
 * "cancelled" handling needed here.
 */
export const reminderDue = pgTable(
  "reminder_due",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    calendarId: text("calendar_id")
      .notNull()
      .references(() => calendars.id, { onDelete: "cascade" }),
    seriesId: text("series_id").notNull(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    originalStart: timestamp("original_start", { withTimezone: true }).notNull(),
    minutesBefore: integer("minutes_before").notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    /**
     * `pending` until the 15-second loop claims it; `fired` once delivery is
     * recorded; `missed` when the catch-up rule (ADR-0028) says so silently —
     * both terminal, and a rebuild that recomputes the same `dueAt` leaves
     * either alone (`reminder-due-store.ts`'s own upsert `CASE`).
     */
    status: text("status", { enum: ["pending", "fired", "missed"] })
      .notNull()
      .default("pending"),
    firedAt: timestamp("fired_at", { withTimezone: true }),
    /**
     * #246, ADR-0028: "a snoozed Reminder is a one-off row in that same
     * table... flagged so a rebuild neither recomputes nor drops it." Set
     * only on the row `snoozeReminderDue` (`reminder-due-store.ts`) inserts;
     * `rebuildReminderDueForSeries`'s own stale-row query excludes it, so a
     * Series/Calendar/Home-Time-Zone rebuild leaves it alone entirely. Still
     * deleted by the ordinary `eventId` cascade when the Occurrence itself
     * is cancelled — no separate handling needed for that half of the rule.
     */
    snoozed: boolean("snoozed").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("reminder_due_series_id_idx").on(table.seriesId),
    // The 15-second loop's own candidate query (`dueReminderCandidateIds`) —
    // `pending-send.ts`'s own partial-index idiom for a claim-loop table.
    index("reminder_due_pending_idx").on(table.dueAt).where(sql`${table.status} = 'pending'`),
  ],
);
export type ReminderDueRow = typeof reminderDue.$inferSelect;

/**
 * Per-Connected-Account bookkeeping for the Google Calendar mirror loop
 * (#234) — **not** a Connected Account table itself (that's #200, not
 * merged onto this branch's ancestry yet; see `calendars.connectedAccountId`'s
 * own doc comment). Keyed on the same opaque `connectedAccountId` string a
 * mirrored `calendars` row carries, with no FK for the same reason. Exists
 * purely so the shared poll loop (`calendars/google/poll-loop.ts`) knows,
 * across restarts, when each cadence last ran for an account it has no
 * other durable state for — `lastCalendarListSyncAt` gates the 15-minute
 * enumeration, `lastEventSyncAt` gates the 5-or-30-minute Event cadence
 * (`calendars/google/cadence.ts`), and `pollRequestedAt` is a Google `watch`
 * push's "run the next tick now" (#234's own acceptance line: "a `watch`
 * notification only schedules an immediate poll; the poll remains
 * authoritative") rather than a queue of its own.
 */
export const calendarMirrorSyncState = pgTable("calendar_mirror_sync_state", {
  connectedAccountId: text("connected_account_id").primaryKey(),
  lastCalendarListSyncAt: timestamp("last_calendar_list_sync_at", { withTimezone: true }),
  lastEventSyncAt: timestamp("last_event_sync_at", { withTimezone: true }),
  pollRequestedAt: timestamp("poll_requested_at", { withTimezone: true }),
});
export type CalendarMirrorSyncStateRow = typeof calendarMirrorSyncState.$inferSelect;

/**
 * A Google Calendar `watch()` push channel (#234) — maps the opaque
 * `channelId`/`resourceId` Google's push notification headers carry back to
 * the Connected Account whose immediate poll it should trigger.
 * Google never guarantees delivery and a channel expires after 7 days with
 * no auto-renewal (the ticket's own line), so this table is purely an
 * accelerator: an unmatched or expired notification is dropped, silently,
 * and the ordinary poll cadence above still catches the change.
 */
export const calendarWatchChannels = pgTable("calendar_watch_channels", {
  channelId: text("channel_id").primaryKey(),
  resourceId: text("resource_id").notNull(),
  connectedAccountId: text("connected_account_id").notNull(),
  expiration: timestamp("expiration", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export type CalendarWatchChannelRow = typeof calendarWatchChannels.$inferSelect;

/**
 * An Event (#229/#230, CONTEXT.md's Occurrence entry): "one dated instance
 * derived from a Series by the Sync Backend." **User-scoped** on this line
 * (`calendars`' own doc comment explains why) even though a row is
 * naturally a Calendar's — `userId` is denormalized here the same reason
 * `syncTombstones.mailAccountId` is on other tables, so the registry's
 * plain `userScopedCollection` query shape (`sync/collection-registry.ts`)
 * applies with no join.
 *
 * Written by `calendars/materialiser.ts` via
 * `calendars/series-store.ts#rematerialiseSeries` for every `series` row
 * within the rolling Materialisation Window (`calendars/materialise-loop.ts`)
 * — `tzid`/`floating` mirror the owning Series' own columns (denormalized
 * onto every row it materialises, the same `userId` reasoning above) so a
 * grid never needs the Series body fetch just to render a row honestly
 * (ADR-0025).
 *
 * `seriesId` deliberately carries **no FK to `series`**: a Google-mirrored
 * Calendar's rows (#234, `calendars/google/event-sync.ts#upsertGoogleEvent`)
 * write here directly, keyed off Google's own `recurringEventId`/`id`, with
 * no `series` row behind them yet — reconciling a mirrored Calendar's own
 * recurrence into a real Series row is follow-up work, not this ticket's.
 * `series-store.ts#rematerialiseSeries` is the one writer that *does* always
 * have a real `series` row (its own parameter), FK or not.
 */
export const events = pgTable(
  "events",
  {
    /** `<seriesId>@<originalStart>` (ADR-0025) — see `packages/shared/src/events.ts#eventSchema`. */
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    calendarId: text("calendar_id")
      .notNull()
      .references(() => calendars.id, { onDelete: "cascade" }),
    seriesId: text("series_id").notNull(),
    /**
     * The upstream's own raw event id (#248) — `null` for a Local or
     * Google-mirrored row (Google's own delta never produces a bare
     * tombstone entry to reconcile against one, `google/event-sync.ts`'s
     * own doc comment). Graph's `calendarView/delta` does: a deleted item
     * arrives as `{id, "@removed": {...}}` with no `start`/`seriesMasterId`
     * to rebuild this row's own deterministic id from
     * (`graph/event-sync.ts`'s own doc comment) — this column is what lets
     * that lookup happen by Graph's own event id instead.
     */
    upstreamEventId: text("upstream_event_id"),
    originalStart: timestamp("original_start", { withTimezone: true }).notNull(),
    startAt: timestamp("start_at", { withTimezone: true }).notNull(),
    endAt: timestamp("end_at", { withTimezone: true }).notNull(),
    allDay: boolean("all_day").notNull().default(false),
    /** Set only when `allDay` and `floating` are both `false` — the owning Series' own IANA zone name. */
    tzid: text("tzid"),
    floating: boolean("floating").notNull().default(false),
    title: text("title").notNull(),
    location: text("location"),
    status: text("status", { enum: ["confirmed", "cancelled"] })
      .notNull()
      .default("confirmed"),
    transparency: text("transparency", { enum: ["opaque", "transparent"] })
      .notNull()
      .default("opaque"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    // Same shared `sync_rev_seq` trigger as `calendars`/`notes` above.
    syncRev: bigint("sync_rev", { mode: "number" }).notNull().default(0),
    syncCreatedRev: bigint("sync_created_rev", { mode: "number" }).notNull().default(0),
  },
  (table) => [
    index("events_sync_rev_idx").on(table.userId, table.syncRev),
    index("events_calendar_id_idx").on(table.calendarId),
    index("events_series_id_idx").on(table.seriesId),
    index("events_upstream_event_id_idx")
      .on(table.calendarId, table.upstreamEventId)
      .where(sql`${table.upstreamEventId} is not null`),
  ],
);
export type EventRow = typeof events.$inferSelect;

/**
 * A Rollback (#229, ADR-0025: "Rollback becomes a User-scoped collection...
 * one row per rejected outbox entry"). Built here because Contacts consumes
 * it too (#229's ticket body), but nothing produces a row until #237's
 * outbox/write-back lands — always empty on this line.
 */
export const rollbacks = pgTable(
  "rollbacks",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    collection: text("collection").notNull(),
    entityId: text("entity_id").notNull(),
    reason: text("reason"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    // Same shared `sync_rev_seq` trigger as `calendars`/`notes` above.
    syncRev: bigint("sync_rev", { mode: "number" }).notNull().default(0),
    syncCreatedRev: bigint("sync_created_rev", { mode: "number" }).notNull().default(0),
  },
  (table) => [index("rollbacks_sync_rev_idx").on(table.userId, table.syncRev)],
);
export type RollbackRow = typeof rollbacks.$inferSelect;

/**
 * The write-back outbox (#237, ADR-0025's bounded outbox): one queued
 * upstream push per Series, never more — a further edit before the last one
 * lands **replaces** the row (`calendars/outbox-store.ts#enqueueOutboxWrite`'s
 * `onConflictDoUpdate` on `series_id`) the same "last-write-wins per Series"
 * coalescing `pendingSeriesSaves` already gives the client queue, so `series
 * _id` is unique rather than this table growing one row per edit.
 *
 * Modelled on `compositions`' own Pending Send columns (ADR-0007) rather than
 * `protocol_writes`' simpler "just leave it queued forever" shape, because
 * ADR-0025 wants a genuine terminal rejection: `attempts`/`nextAttemptAt` are
 * `pending-send.ts`'s own atomic-claim backoff, `deadline` is the 24-hour
 * ceiling a transient failure retries against before rejecting for good.
 * There is deliberately no status column for "Needs Reauth" — a Facet with
 * no access token available right now is never claimed at all
 * (`outbox-loop.ts`), so it holds with no deadline touched and no attempt
 * counted for exactly as long as the Facet stays parked, with no extra state
 * to fall out of sync.
 *
 * `baseEtag` is the Series' own `etag` as of the moment this row was last
 * (re)enqueued — the processor's one piece of conflict-path-3 detection
 * ("a delta touching a Series with a queued write"): if `series.etag` has
 * since moved away from this value, something else already changed the
 * Series out from under the queued write, and that alone is a conflict, no
 * network call required to discover it.
 */
export const calendarOutbox = pgTable(
  "calendar_outbox",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    calendarId: text("calendar_id")
      .notNull()
      .references(() => calendars.id, { onDelete: "cascade" }),
    seriesId: text("series_id")
      .notNull()
      .unique()
      .references(() => series.id, { onDelete: "cascade" }),
    /**
     * What this push does upstream: `upsert` covers create-or-update (a
     * body save, or an `exdate` add/remove — both are "make Google's event
     * agree with the Series row" alike); `cancel`/`restore` are
     * `trashSeries`/`restoreSeries`'s own status flips (this ticket's own
     * acceptance line: "`restoreEvent` on Google is a status flip, not a
     * fresh create" — `restore` never calls `insertEvent`, only `patchEvent`).
     * `move` is #238's own "copy plus delete with a fresh UID": one push,
     * keyed to the *destination* Series (`seriesId`/`calendarId` above name
     * where it's going), that cancels the source Series' upstream event
     * (`moveFromSeriesId` below) and inserts a fresh one on the destination
     * Calendar — both inside the same push, so either side's failure rejects
     * the whole thing as one unit rather than leaving a half-moved Event.
     */
    operation: text("operation", {
      enum: ["upsert", "cancel", "restore", "move", "respond"],
    }).notNull(),
    /** Whether this push should notify attendees (`sendUpdates=all` vs `none`) — the User's "Send invitations" toggle, default on (`canSuppressInviteMail`). */
    sendInvitations: boolean("send_invitations").notNull().default(true),
    /**
     * `operation: "respond"` only (#240, ADR-0027): the Answer this push
     * carries — Google gets it inside the same full-body `PATCH` every other
     * `upsert` sends (the local `series.attendees` row was already rewritten
     * before this was enqueued, `calendars/series-store.ts#answerInvitation`),
     * but Graph has no generic attendee-response `PATCH` at all — only the
     * dedicated `accept`/`decline`/`tentativelyAccept` actions
     * (`graph/client.ts#respondToEvent`) — so its own processor needs this
     * value read back out rather than re-derived from `seriesRow.attendees`.
     * `null` for every other operation.
     */
    responseStatus: text("response_status", {
      enum: ["needsAction", "accepted", "declined", "tentative"],
    }),
    /**
     * `operation: "move"` only (#238) — the Series this push is moving
     * *from*, already soft-deleted by `series-store.ts#moveSeries` the
     * moment the move was requested, kept around (like any other
     * `trashSeries`) purely so this push can still find its `calendarId`/
     * `upstreamId`/`etag` to cancel. No FK: `events.seriesId`'s own doc
     * comment gives the same reason a Series-purge sweep racing a
     * long-retrying push must not itself become a foreign-key error —
     * `onDelete: "set null"` instead, and `outbox-rollback.ts#revertMoveFailure`
     * treats a `null` here (the source Series purged out from under a very
     * slow retry) as "nothing left to restore", not a bug.
     */
    moveFromSeriesId: text("move_from_series_id").references(() => series.id, {
      onDelete: "set null",
    }),
    /** See this table's own doc comment. */
    baseEtag: text("base_etag"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    deadline: timestamp("deadline", { withTimezone: true }).notNull(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("calendar_outbox_due_idx").on(table.nextAttemptAt)],
);
export type CalendarOutboxRow = typeof calendarOutbox.$inferSelect;

/**
 * A Gmail Label (#126, ADR-0020, CONTEXT.md): Gmail's own tag on a message,
 * which IMAP shows as a folder — browsable, never editable from Wicket, and
 * never a `labels` row above. Its own ADR-0011 collection, never merged into
 * `labels`. `id` is **deterministic** (`gmailLabelId` in
 * `packages/shared/src/gmail-labels.ts`, `(mailAccountId, path)`) the same
 * way a `labels` row's is, but for a different reason: Gmail — not the
 * User — assigns the path, so determinism here is purely so
 * `sync/gmail-labels.ts#persistGmailLabels` can upsert by id with no
 * lookup-by-path round trip, and so `threads.gmailLabelIds` (built off a raw
 * `X-GM-LABELS` string, never a join) always names the same row.
 *
 * `sync/gmail-labels.ts` is the only writer — fed by the same folder listing
 * `sync/folders.ts#discoverFolders` already performs on every sync, filtered
 * to the subset that is a genuine browsable User Gmail Label rather than one
 * of the four Folders Gmail's mail actually syncs into (All Mail, Spam,
 * Trash, Drafts — `sync/sync-plan.ts`'s `GMAIL_SYNCED_ROLES`) or one of its
 * housekeeping labels never shown (Inbox, Sent, Starred, Important,
 * Categories, Chats — #91 story 40). A rename changes Gmail's own IMAP path,
 * so it is a destroy of the old id plus a create of the new one, exactly like
 * `sync/folders.ts#persistFolders` already treats a renamed Folder.
 */
export const gmailLabels = pgTable(
  "gmail_labels",
  {
    id: text("id").primaryKey(),
    mailAccountId: text("mail_account_id")
      .notNull()
      .references(() => mailAccounts.id, { onDelete: "cascade" }),
    /** The display leaf, e.g. "Kids" for the label at path "Family/Kids" — `folders.ts`'s own `name`. */
    name: text("name").notNull(),
    /** Gmail's own full hierarchy, e.g. "Family/Kids" — `folders.ts`'s own `path`, and half of this row's deterministic id. */
    path: text("path").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    // Same shared `sync_rev_seq` trigger as `labels`/`threads` — see their
    // comments above.
    syncRev: bigint("sync_rev", { mode: "number" }).notNull().default(0),
    syncCreatedRev: bigint("sync_created_rev", { mode: "number" }).notNull().default(0),
  },
  (table) => [index("gmail_labels_sync_rev_idx").on(table.mailAccountId, table.syncRev)],
);
export type GmailLabelRow = typeof gmailLabels.$inferSelect;

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
 * folders (a Sent self-copy on a non-Gmail server) is two rows with the same
 * `messageIdHeader`, because that is two IMAP messages; threading pulls them
 * into one Thread. On Gmail this no longer includes a Gmail Label
 * (ADR-0020): a Gmail Label is read off the one All Mail copy as
 * `gmailLabels`, never a second synced Folder.
 *
 * `seen`/`flagged` are the two **Protocol Features** (ADR-0006): read state
 * and Star, mirrored from `\Seen`/`\Flagged` so a User's existing stars are
 * there on first sync and changes made by any other IMAP client arrive.
 * `flags` keeps the raw set alongside them so nothing is lost in the
 * mapping. Pin, Label and Gatekeeper state are App Features and get their
 * own tables in their own tickets — never a column here.
 *
 * `gmailLabels` (#122, ADR-0020) is null on a non-Gmail server and on every
 * Gmail Folder except All Mail — Spam/Trash/Drafts messages are never
 * labelled per message, only the row that actually needs it (a Gmail Label
 * is read through All Mail) gets one. `sync/ingest.ts#storeMessage` is the
 * only writer; `sync/inbox.ts#isInInbox` and `sync/inbox.ts#isSentMessage`
 * (#123 — `\Sent` stands in for the Sent Folder role Gmail never syncs) are
 * the seams that read it back.
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
    /**
     * The Alias (#103, CONTEXT.md) this message arrived at, resolved once at
     * ingest by `gatekeeper/alias.ts#resolveRecipientAlias`: `Delivered-To`,
     * then `X-Original-To`, then the first of `toAddresses`/`ccAddresses` at
     * the Mail Account's own domain — null when nothing on the message named
     * one. Stored per message, not derived on read, because the headers
     * (`Delivered-To`/`X-Original-To`) that make it trustworthy for a
     * Bcc'd-to-a-catch-all stranger only ever exist on the wire at ingest
     * time. `sync/ingest.ts#storeMessage` is the only writer.
     */
    recipientAlias: text("recipient_alias"),

    /** The `Date` header, falling back to INTERNALDATE when the sender omitted or mangled it. */
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
    /** IMAP INTERNALDATE — arrival order, and what list sorting trusts over a spoofable `Date`. */
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),

    seen: boolean("seen").notNull().default(false),
    flagged: boolean("flagged").notNull().default(false),
    answered: boolean("answered").notNull().default(false),
    draft: boolean("draft").notNull().default(false),
    flags: text("flags").array().notNull().default([]),
    /** This message's Gmail Labels (`X-GM-LABELS`), fetched per message on All Mail only — see the table doc comment. */
    gmailLabels: text("gmail_labels").array(),

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

/** One address named on an Invitation's `ORGANIZER`/`ATTENDEE` line. */
export interface InvitationParticipant {
  name: string | null;
  address: string;
  /** RFC 5546 `ROLE`, e.g. `REQ-PARTICIPANT`/`OPT-PARTICIPANT`/`CHAIR` — `null` when the property carried none. */
  role: string | null;
  /** RFC 5546 `PARTSTAT` on an `ATTENDEE` line — `null` for `ORGANIZER` (which has none) or when absent. */
  partstat: string | null;
}

/**
 * The parsed `VEVENT` an Invitation concerns — never the full RFC 5545
 * component, only what a future Reader card (#240) needs. `start`/`end` are
 * absent for a TNEF-sourced Invitation this ticket cannot decode (see
 * `invitations/tnef.ts`'s own doc comment).
 */
export interface InvitationVevent {
  title: string | null;
  description: string | null;
  location: string | null;
  start: string | null;
  end: string | null;
  allDay: boolean;
  tzid: string | null;
  /** RFC 5545 `STATUS` on the `VEVENT` itself (`CONFIRMED`/`TENTATIVE`/`CANCELLED`), uppercase — distinct from this row's own `kind`, which reads the iTIP `METHOD`. */
  status: string | null;
}

/**
 * An Invitation (#239, ADR-0027, CONTEXT.md): a calendar message found inside
 * an arriving Message and kept beside it — a request to attend an Event, an
 * Answer from an Attendee, or a cancellation, each naming the Event (by
 * `UID`) it concerns. Parsed once, at body-fetch time (`invitations/store.ts`
 * is the one writer, called from `sync/bodies.ts`/`sync/body-sweep.ts`
 * alongside the body itself becoming available), from a `text/calendar` part
 * or a TNEF (`winmail.dat`) attachment at any MIME depth.
 *
 * Not an ADR-0011 sync collection — no `syncRev`: "the Client never parses
 * iCalendar" (this ticket's acceptance line), so nothing here reaches the
 * wire yet. A later ticket (#240, the Reader's invite card) reads these rows
 * server-side and hands the Client only what a card needs.
 *
 * `recurrenceId` is `''` rather than `null` for "no `RECURRENCE-ID`" — a
 * nullable column can't back the uniqueness below, since Postgres never
 * considers two `NULL`s equal.
 */
export const invitations = pgTable(
  "invitations",
  {
    id: text("id").primaryKey(),
    mailAccountId: text("mail_account_id")
      .notNull()
      .references(() => mailAccounts.id, { onDelete: "cascade" }),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    /** Denormalized off `messages.thread_id` — what the SEQUENCE/DTSTAMP revision ordering below is scoped to (ADR-0027). */
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["request", "answer", "cancellation"] }).notNull(),
    /** The raw iTIP `METHOD`, uppercase (`REQUEST`/`REPLY`/`CANCEL`) — `kind` is this ticket's own bucketing of it (`invitations/ical.ts#mapMethodToKind`). */
    method: text("method").notNull(),
    /** Which extractor produced this row — `invitations/ical.ts` or `invitations/tnef.ts`. */
    source: text("source", { enum: ["ical", "tnef"] }).notNull(),
    uid: text("uid").notNull(),
    recurrenceId: text("recurrence_id").notNull().default(""),
    sequence: integer("sequence").notNull().default(0),
    dtstamp: timestamp("dtstamp", { withTimezone: true }).notNull(),
    organizer: jsonb("organizer").$type<InvitationParticipant | null>(),
    attendees: jsonb("attendees").$type<InvitationParticipant[]>().notNull().default([]),
    vevent: jsonb("vevent").$type<InvitationVevent | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // "An inline calendar part plus a named `.ics` are one Invitation"
    // (this ticket's acceptance line) — both parse to the same
    // `(uid, recurrenceId)` pair, so the second upsert refreshes the first
    // row rather than duplicating it; a re-ingest of the same Message is
    // idempotent for the same reason.
    uniqueIndex("invitations_message_uid_recurrence_key").on(
      table.messageId,
      table.uid,
      table.recurrenceId,
    ),
    // ADR-0027: "revisions of one UID in a Thread are ordered by SEQUENCE
    // then DTSTAMP" — `invitations/store.ts#latestInvitationRevision`'s own
    // query.
    index("invitations_thread_uid_revision_idx").on(
      table.threadId,
      table.uid,
      table.sequence,
      table.dtstamp,
    ),
  ],
);
export type InvitationRow = typeof invitations.$inferSelect;

/**
 * An outbound iMIP `REPLY` held for the User's Undo Send delay (#241,
 * ADR-0007, ADR-0027): the Local-fallback complement to #240's synced
 * Answer, one row per Answer sent through a Mail Account's own SMTP rather
 * than through an upstream Calendar API. **Never a `Composition`** — this
 * ticket's own acceptance line — so it gets its own minimal Pending Send
 * state machine (`invitations/local-answer.ts`) rather than riding
 * `compositions`, which carries a Draft/attachment/IMAP-push shape this row
 * has no use for.
 *
 * `icsText` is the whole `METHOD:REPLY` payload
 * (`invitations/reply-ics.ts#buildReplyIcs`), built once at Answer time from
 * the Series and the Invitation it answers — a later edit to either one
 * never reaches back into a row already queued, the same "frozen at accept
 * time" posture `compositions.document` does not share (that one is still
 * editable up to submission) but a `REPLY`'s content, once the User has
 * chosen a response, never needs to be.
 */
export const imipReplies = pgTable(
  "imip_replies",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    seriesId: text("series_id")
      .notNull()
      .references(() => series.id, { onDelete: "cascade" }),
    mailAccountId: text("mail_account_id")
      .notNull()
      .references(() => mailAccounts.id, { onDelete: "cascade" }),
    /** Where the `REPLY` goes — the Invitation's own `ORGANIZER` address. */
    organizerAddress: text("organizer_address").notNull(),
    organizerName: text("organizer_name"),
    /** The invited address verbatim, Alias included (ADR-0027) — carried in `icsText`'s own `ATTENDEE` line too, kept here for the Sent-copy subject/body. */
    attendeeAddress: text("attendee_address").notNull(),
    uid: text("uid").notNull(),
    sequence: integer("sequence").notNull(),
    responseStatus: text("response_status", {
      enum: ["accepted", "declined", "tentative"],
    }).notNull(),
    /** The Event's own title, for the Sent-copy subject line only — never re-read from `series` at submit time. */
    eventTitle: text("event_title"),
    icsText: text("ics_text").notNull(),
    status: text("status", {
      enum: ["pending", "submitting", "sent", "cancelled"],
    })
      .notNull()
      .default("pending"),
    submitAfter: timestamp("submit_after", { withTimezone: true }).notNull(),
    sendAttempts: integer("send_attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    sendError: text("send_error"),
    messageId: text("message_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The sweeper's one candidate query (`invitations/local-answer.ts#dueReplyCandidateIds`) — the same due-ness shape `compositions_send_due_idx` gives Pending Send.
    index("imip_replies_status_submit_after_idx").on(table.status, table.submitAfter),
    index("imip_replies_series_idx").on(table.seriesId),
  ],
);
export type ImipReplyRow = typeof imipReplies.$inferSelect;

/**
 * An outbound organiser-side iMIP `REQUEST`/`CANCEL`, one row per recipient
 * (#242, ADR-0027) — `imipReplies`' own mirror image: that one is the
 * Local-fallback *Attendee's* Answer, this one is the *Organiser's* own
 * scheduling mail on a self-scheduled Calendar (`invitesSentByUpstream:
 * false`), queued through `invitations/local-organizer.ts` and sent by
 * `invitations/request-sweeper.ts`. **Never a `Composition`**, same reasoning
 * as `imipReplies`.
 *
 * One row per recipient rather than one row carrying every Attendee, because
 * a single organiser-side edit can owe *different* mail to different
 * Attendees in the same save — "an added Attendee gets `REQUEST` alone, a
 * removed one `CANCEL` alone" — so the sweeper's own claim/submit/retry
 * bookkeeping stays per-recipient, exactly like `imipReplies`' own per-Answer
 * granularity.
 *
 * `icsText` is shared byte-for-byte across every row a single organiser
 * action queues together (built once from the Series at queue time,
 * `local-organizer.ts#queueOrganizerSend`) — only the envelope recipient
 * (`attendeeAddress`) differs row to row, never the `VEVENT` body.
 */
export const imipRequests = pgTable(
  "imip_requests",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    seriesId: text("series_id")
      .notNull()
      .references(() => series.id, { onDelete: "cascade" }),
    mailAccountId: text("mail_account_id")
      .notNull()
      .references(() => mailAccounts.id, { onDelete: "cascade" }),
    /** RFC 6047 iTIP method this row carries — always one of these two for the organiser side (a `REPLY` is `imipReplies`' own concern). */
    method: text("method", { enum: ["REQUEST", "CANCEL"] }).notNull(),
    /** The Calendar's own Mail Account address (ADR-0027: "`ORGANIZER`... always that same address, never an Alias"). */
    organizerAddress: text("organizer_address").notNull(),
    organizerName: text("organizer_name"),
    attendeeAddress: text("attendee_address").notNull(),
    attendeeName: text("attendee_name"),
    uid: text("uid").notNull(),
    sequence: integer("sequence").notNull(),
    /** RFC 5545 date-time string, `''` for "no `RECURRENCE-ID`" — a whole-Series send. Set only when cancelling a single Occurrence (`series-store.ts#addExdate`). */
    recurrenceId: text("recurrence_id").notNull().default(""),
    /** The Event's own title, for the Sent-copy subject line only — never re-read from `series` at submit time. */
    eventTitle: text("event_title"),
    icsText: text("ics_text").notNull(),
    status: text("status", {
      enum: ["pending", "submitting", "sent", "cancelled"],
    })
      .notNull()
      .default("pending"),
    submitAfter: timestamp("submit_after", { withTimezone: true }).notNull(),
    sendAttempts: integer("send_attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    sendError: text("send_error"),
    messageId: text("message_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("imip_requests_status_submit_after_idx").on(table.status, table.submitAfter),
    index("imip_requests_series_idx").on(table.seriesId),
  ],
);
export type ImipRequestRow = typeof imipRequests.$inferSelect;

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
    // `recipient` (#103, CONTEXT.md's Blocked Alias, ADR-0008's amendment):
    // the third scope, keyed not to a sender but to an Alias of the Mail
    // Account's own that mail arrived at. `gatekeeper/verdicts.ts#setVerdict`
    // is the one place that enforces it can only ever carry `verdict:
    // 'blocked'` — there is no Approved Alias.
    scope: text("scope", { enum: ["address", "domain", "recipient"] }).notNull(),
    /** A normalized address (plus tag intact), a bare domain, or a normalized Alias address for `recipient` scope — `@mail/shared`'s `normalizeSenderAddress`. */
    value: text("value").notNull(),
    verdict: text("verdict", { enum: ["approved", "blocked"] }).notNull(),
    // Spam (#102, CONTEXT.md, ADR-0008 amendment): only ever meaningful
    // alongside `verdict: "blocked"` — it is not a fourth Verdict value, only
    // the flag that picks Junk over Trash as the destination
    // (`gatekeeper/decisions.ts#spamSender`, `gatekeeper/screening.ts`).
    spam: boolean("spam").notNull().default(false),
    // `inbox` (#144): Spam/Approve/Block reached from an ordinary Inbox
    // Thread rather than the Screener — same column, no migration needed
    // (plain `text`, no DB-side check constraint; `@mail/shared`'s
    // `gatekeeperVerdictSourceSchema` is the one place that enumerates it).
    source: text("source", { enum: ["seed", "sent", "screener", "settings", "inbox"] }).notNull(),
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
/**
 * The instance's Web Push VAPID keypair (#53, ADR-0015 as amended): exactly
 * one row, `id: "singleton"`, minted by the Sync Backend itself the first
 * time it boots without `MAIL_VAPID_PUBLIC_KEY`/`MAIL_VAPID_PRIVATE_KEY` in
 * its environment — the "operator runs a CLI command and pastes two values
 * into `.env`" step is now an optional override rather than the only way in.
 *
 * Living here rather than in the environment is what makes the keypair
 * *co-located with the subscriptions it signs* (`push_subscriptions`, below):
 * a `pg_dump`/restore moves both together, where an env var is the half that
 * can go missing on its own and silently orphan every subscription. Nothing
 * ever replaces a working row — a fresh keypair invalidates every existing
 * subscription, so generation only happens when there is none (or when the
 * stored one can no longer be unsealed, which is the one case where it is
 * already unusable and re-minting is the repair).
 *
 * `privateKey` is sealed exactly like a Connected Account's password
 * (ADR-0003, `connected-accounts/credential-crypto.ts`), with this row's own id as the
 * associated data: a stolen database alone cannot push to anyone's devices,
 * which is the same bar the rest of this schema holds.
 */
export const vapidKeys = pgTable("vapid_keys", {
  /** Always `VAPID_KEYS_ROW_ID` — a one-row table, so the id is a constant rather than a minted value. */
  id: text("id").primaryKey(),
  publicKey: text("public_key").notNull(),
  privateKey: jsonb("private_key").$type<SealedSecret>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export type VapidKeyRow = typeof vapidKeys.$inferSelect;

/** The `vapid_keys` primary key, since there is only ever one row. */
export const VAPID_KEYS_ROW_ID = "singleton";

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
    // Nullable since #204: a `needs_reauth` notification for a Calendar or
    // Contacts Facet has no `mail_accounts` row to name — every other kind
    // is still Mail-only and always sets this.
    mailAccountId: text("mail_account_id").references(() => mailAccounts.id, {
      onDelete: "cascade",
    }),
    /** `needs_reauth` only (#204): which Connected Account parked, Mail Facet included — the deep link's own target. Null for every other kind. */
    connectedAccountId: text("connected_account_id").references(() => connectedAccounts.id, {
      onDelete: "cascade",
    }),
    /** `needs_reauth` only (#204): which Facet parked. Null for every other kind. */
    facet: text("facet", { enum: ["mail", "calendar", "contacts"] }),
    kind: text("kind", {
      enum: [
        "new_mail",
        "failed_send",
        "needs_reauth",
        "gatekeeper_digest",
        "calendar_reminder",
        "calendar_answer",
      ],
    }).notNull(),
    dedupKey: text("dedup_key").notNull(),
    /** The push payload's content, minus `badgeCount` — computed fresh at delivery time (ADR-0015: "at Notifier-fire time"), never stored stale. */
    payload: jsonb("payload").$type<NotifierOutboxPayload>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * `calendar_answer` only (#243): when this row becomes eligible for
     * delivery — `null` for every other kind, which stays "ready the moment
     * it's recorded" exactly as before. This is what makes "coalesced per
     * Event over a few minutes" (the ticket's own acceptance line) a real
     * hold rather than an immediate push: `notifier/record.ts
     * #recordCalendarAnswerNotification` sets this to a few minutes out on
     * the first Answer for an Event, and merges every later Answer for that
     * same Event straight into this row's own `payload` without moving it —
     * `deliver.ts`'s 2-second tick only ever picks the row up once this
     * passes.
     */
    readyAt: timestamp("ready_at", { withTimezone: true }),
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
  | { kind: "gatekeeper_digest"; senders: string[]; count: number }
  | {
      kind: "calendar_reminder";
      /**
       * "One payload kind with `events[]`" (ADR-0028), grouped per User by
       * due minute **at tick time** (`calendars/reminder-loop.ts`) — a lone
       * Reminder is an array of length one, never a special-cased shape of
       * its own. Title/body are computed once here, at recording time, the
       * same "everything a push payload needs except the badge count" this
       * table's own doc comment already promises for every other kind.
       */
      events: {
        /**
         * #246: the Reminder Due row this entry came from — the Snooze
         * action's own target (`snoozeReminderDue`, `reminder-due-store.ts`).
         * Never surfaced as "the id of anything" to the User; purely the
         * server-side handle a notification action posts back.
         */
        reminderDueId: string;
        eventId: string;
        seriesId: string;
        title: string;
        body: string;
      }[];
    }
  | {
      kind: "calendar_answer";
      eventId: string;
      seriesId: string;
      title: string;
      /**
       * Every Attendee's Answer this notification names, coalesced
       * (`notifier/record.ts`'s own doc comment) — one entry per distinct
       * Attendee address; a later Answer from the same Attendee before this
       * row delivers replaces their own entry rather than appending a
       * second one.
       */
      answers: {
        attendeeName: string | null;
        attendeeEmail: string;
        responseStatus: "accepted" | "declined" | "tentative";
      }[];
    };

/**
 * A Provider Registration (#115, ADR-0021, CONTEXT.md): the OAuth app the
 * Owner has registered with Google or Microsoft so this instance can ask
 * Users to sign in with it. Instance-wide, belongs to no User — `provider`
 * is the primary key itself, so there is exactly one row per Provider and a
 * fresh `PUT /instance/providers/:provider` upserts in place rather than
 * growing a history of past registrations.
 *
 * `clientSecret` is sealed the same way a Mail Account's `password`
 * credential is (ADR-0003's AEAD envelope, `credential-crypto.ts`), with the
 * Provider name as associated data instead of a Mail Account id — ADR-0021's
 * explicit choice, "the same key version as Mail Account credentials". The
 * client id sits beside it in the clear: it is not a secret, and the
 * Instance page shows it back to the Owner as confirmation of what is
 * registered.
 */
export const providerRegistrations = pgTable("provider_registrations", {
  provider: text("provider", { enum: ["google", "microsoft"] }).primaryKey(),
  clientId: text("client_id").notNull(),
  clientSecret: jsonb("client_secret").$type<SealedSecret>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  // Provider Health's Working/Failing (#118): stamped by every Grant refresh
  // attempt this Provider's adapter makes, across every Mail Account on it —
  // `lastRefreshAt` on every attempt, `lastRefreshError` cleared on success
  // and set on a transient failure, the same convention `mailAccounts.
  // lastSyncError` already uses. A `withdrawn` refresh does *not* write here:
  // that's a single Mail Account's Needs Reauth, not a Provider-wide fact.
  lastRefreshAt: timestamp("last_refresh_at", { withTimezone: true }),
  lastRefreshError: text("last_refresh_error"),
  // #202, ADR-0022's "Owner-only failures never show as Needs Reauth": the
  // Owner's own unvalidated declaration that Google's Calendar API/People
  // API, or Microsoft Graph's calendar/contacts permissions, are enabled on
  // their Cloud project/app registration — this instance has no way to
  // check that itself. Gates whether a Facet's "+" ever offers a consent
  // flow at all (`routes/oauth-signin.ts`'s `/start`), never how it behaves
  // once started.
  calendarApiEnabled: boolean("calendar_api_enabled").notNull().default(false),
  contactsApiEnabled: boolean("contacts_api_enabled").notNull().default(false),
});
export type ProviderRegistrationRow = typeof providerRegistrations.$inferSelect;

/**
 * Provider Health's per-Facet reading (#205, ADR-0022's "Provider Health
 * gains a per-Facet reading (ever granted, currently honoured, API
 * enabled)") — one row per (Provider, Facet) that ever mattered, keyed
 * `${provider}-${facet}` the same way `connected_account_facets` keys a
 * Facet row to its account. Distinct from `providerRegistrations`'
 * whole-Provider `lastRefreshAt`/`lastRefreshError` above: those stay the
 * Mail Facet's own refresh loop's fact (#118, unchanged by this ticket),
 * this is the per-Facet breakdown `routes/instance.ts#buildProviderHealth`
 * now reports instead of a flat Mail-only pair.
 *
 * `firstGrantedAt` is stamped once, the first time this Facet is ever
 * granted at this Provider — `routes/oauth-signin.ts`'s `signed_in` and
 * `facet_added` outcomes — and never overwritten again, so it answers "has
 * a Grant ever been obtained through this Facet" for good.
 * `lastRefreshAt`/`lastRefreshError` mirror a refresh attempt the same way
 * the whole-Provider pair does; today only the Mail Facet's refresh loop
 * writes them (`mail-accounts/grant-refresh.ts`), so Calendar/Contacts stay
 * null until a sync engine for either exists to attempt one.
 * `apiNotEnabled` is the *runtime-detected* twin of
 * `providerRegistrations.calendarApiEnabled`/`contactsApiEnabled` above —
 * those are the Owner's own unvalidated declaration gating whether a
 * consent flow is even offered; this is "a refresh actually came back
 * 403-not-enabled", cleared the moment the next refresh succeeds, same
 * convention as `lastRefreshError`. Nothing sets it yet — no Facet's sync
 * loop calls the Provider's Calendar/People API today — so it stays `false`
 * until one exists to report a 403 through it.
 */
export const providerFacetHealth = pgTable(
  "provider_facet_health",
  {
    id: text("id").primaryKey(),
    provider: text("provider", { enum: ["google", "microsoft"] }).notNull(),
    facet: text("facet", { enum: ["mail", "calendar", "contacts"] }).notNull(),
    firstGrantedAt: timestamp("first_granted_at", { withTimezone: true }),
    lastRefreshAt: timestamp("last_refresh_at", { withTimezone: true }),
    lastRefreshError: text("last_refresh_error"),
    apiNotEnabled: boolean("api_not_enabled").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("provider_facet_health_provider_facet_key").on(table.provider, table.facet),
  ],
);
export type ProviderFacetHealthRow = typeof providerFacetHealth.$inferSelect;

/**
 * One in-flight "Sign in with Google" (#116, ADR-0021): the state that has
 * to survive the full-page round trip to the Provider and back, and nothing
 * more. Written by `POST /auth/oauth/:provider/start`, consumed — deleted —
 * by `GET /auth/oauth/:provider/callback` the moment its `state` matches, so
 * a replayed callback finds nothing and fails as `invalid_state`.
 *
 * `id` is the SHA-256 of the `state` parameter, the same
 * hash-the-bearer-token convention `sessions`, `claim_tokens` and
 * `login_challenges` already use: the value that travels through the
 * Provider and the browser's URL bar is never what sits in the table.
 * `codeVerifier` is PKCE's own secret and is stored in the clear — it is
 * useless without the matching authorization code, lives for minutes, and is
 * the same tradeoff `totp_credentials.secret` already states plainly.
 *
 * `purpose` is `add_mail_account`, `reauth` (#119: "sign in again", never a
 * password form — and the same door a password account uses to switch to a
 * Grant), or `add_facet` (#202: turning on Calendar or Contacts for an
 * already-connected identity by incremental consent). `mailAccountId` is
 * set only for `reauth`: the account whose credential is replaced when the
 * identity that comes back matches its own address, `ON DELETE CASCADE` so
 * a deleted Mail Account can't leave a dangling attempt behind.
 * `connectedAccountId`/`facet` are set only for `add_facet`, same cascade
 * reasoning — a Connected Account deleted mid-flight leaves nothing to
 * attach the Grant to either way.
 */
export const oauthSignInAttempts = pgTable(
  "oauth_sign_in_attempts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider", { enum: ["google", "microsoft"] }).notNull(),
    codeVerifier: text("code_verifier").notNull(),
    purpose: text("purpose", { enum: ["add_mail_account", "reauth", "add_facet"] }).notNull(),
    mailAccountId: text("mail_account_id").references(() => mailAccounts.id, {
      onDelete: "cascade",
    }),
    connectedAccountId: text("connected_account_id").references(() => connectedAccounts.id, {
      onDelete: "cascade",
    }),
    facet: text("facet", { enum: ["calendar", "contacts"] }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("oauth_sign_in_attempts_user_id_idx").on(table.userId)],
);
export type OAuthSignInAttemptRow = typeof oauthSignInAttempts.$inferSelect;
