import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * A User signed in to this instance (CONTEXT.md). Exactly one Owner is
 * created by the first-run claim; Member invites are not built yet
 * (poc-scope.md), but the column exists from day one per ADR-0004.
 *
 * `passwordHash` is the only credential column at PoC. TOTP and passkeys
 * (#32) add their own tables keyed to `users.id` rather than widening this
 * row — the `AuthMethod` seam lives in code (`src/auth/auth-method.ts`), not
 * as a single polymorphic table.
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
