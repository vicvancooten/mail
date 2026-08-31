import { boolean, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("mail_accounts_user_id_idx").on(table.userId)],
);
