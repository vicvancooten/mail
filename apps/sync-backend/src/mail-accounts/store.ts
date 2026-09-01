import type { MailAccount, MailAccountConnection } from "@mail/shared";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { mailAccounts } from "../db/schema.js";
import type { MailAccountCredential } from "./credential-crypto.js";

export type MailAccountRow = typeof mailAccounts.$inferSelect;

/** Never includes `credential` — write-only across the API (ADR-0003). */
export function toWireMailAccount(row: MailAccountRow): MailAccount {
  return {
    id: row.id,
    emailAddress: row.emailAddress,
    imap: { host: row.imapHost, port: row.imapPort, security: row.imapSecurity },
    smtp: { host: row.smtpHost, port: row.smtpPort, security: row.smtpSecurity },
    status: row.status,
    sync: {
      state: row.syncState,
      lastProgressAt: row.lastProgressAt?.toISOString() ?? null,
      lastError: row.lastSyncError,
    },
    indexWatermark: {
      coveredSince: row.bodyWatermark?.toISOString() ?? null,
      complete: row.bodySweepComplete,
    },
    signature: row.signature,
    notificationsEnabled: row.notificationsEnabled,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface InsertMailAccountInput {
  id: string;
  userId: string;
  emailAddress: string;
  imap: MailAccountConnection;
  smtp: MailAccountConnection;
  username: string;
  credential: MailAccountCredential;
}

export async function insertMailAccount(
  db: Db,
  input: InsertMailAccountInput,
): Promise<MailAccountRow> {
  const [row] = await db
    .insert(mailAccounts)
    .values({
      id: input.id,
      userId: input.userId,
      emailAddress: input.emailAddress,
      imapHost: input.imap.host,
      imapPort: input.imap.port,
      imapSecurity: input.imap.security,
      smtpHost: input.smtp.host,
      smtpPort: input.smtp.port,
      smtpSecurity: input.smtp.security,
      username: input.username,
      credential: input.credential,
      status: "active",
    })
    .returning();
  if (!row) {
    throw new Error("Insert of Mail Account returned no row.");
  }
  return row;
}

/** Scoped by User — ownership is the only authorization primitive (ADR-0004). */
export async function listMailAccountsForUser(db: Db, userId: string): Promise<MailAccountRow[]> {
  return db.select().from(mailAccounts).where(eq(mailAccounts.userId, userId));
}

export async function getMailAccountForUser(
  db: Db,
  userId: string,
  id: string,
): Promise<MailAccountRow | null> {
  const [row] = await db
    .select()
    .from(mailAccounts)
    .where(and(eq(mailAccounts.id, id), eq(mailAccounts.userId, userId)))
    .limit(1);
  return row ?? null;
}

/**
 * Unscoped by User — for the sync engine (#35), which runs per Mail Account
 * regardless of who owns it, and needs the freshest credential/status row on
 * every reconnect rather than whatever was in memory when the loop started.
 */
export async function getMailAccountById(db: Db, id: string): Promise<MailAccountRow | null> {
  const [row] = await db.select().from(mailAccounts).where(eq(mailAccounts.id, id)).limit(1);
  return row ?? null;
}

/** Every Mail Account on the instance — what boot uses to start a sync loop per account (#35). */
export async function listAllMailAccounts(db: Db): Promise<MailAccountRow[]> {
  return db.select().from(mailAccounts);
}

/**
 * The seam a sync engine (#9) calls when the mail server rejects the stored
 * credential: stops syncing and holds queued Optimistic Actions by parking
 * the account in Needs Reauth (CONTEXT.md). Nothing in this ticket's own
 * flows calls this outside tests — it exists for #9 to bolt onto without
 * reshaping this table.
 */
export async function markNeedsReauth(db: Db, id: string): Promise<void> {
  await db
    .update(mailAccounts)
    .set({ status: "needs_reauth", updatedAt: new Date() })
    .where(eq(mailAccounts.id, id));
}

/**
 * The resident sync loop's (#35) only write path onto the liveness columns.
 * `lastProgressAt` is left untouched unless `touchProgress` is set — a
 * transition into `connecting` or `error` is not progress, but a completed
 * IDLE keepalive or poll is. `lastSyncError` is cleared on every non-`error`
 * transition so a stale message never outlives the failure it described.
 */
export async function setSyncStatus(
  db: Db,
  id: string,
  update: { state: MailAccountRow["syncState"]; error?: string; touchProgress?: boolean },
): Promise<void> {
  await db
    .update(mailAccounts)
    .set({
      syncState: update.state,
      lastSyncError: update.state === "error" ? (update.error ?? null) : null,
      ...(update.touchProgress ? { lastProgressAt: new Date() } : {}),
      updatedAt: new Date(),
    })
    .where(eq(mailAccounts.id, id));
}

/**
 * `PATCH /mail-accounts/:id/signature` (#47, compose-spec §Signature) — the
 * inline column #54's Mail-Account-scoped preference collection eventually
 * grows out of, same posture as `send-settings.ts`'s Undo Send delay.
 */
export async function updateMailAccountSignature(
  db: Db,
  id: string,
  signature: string | null,
): Promise<void> {
  await db
    .update(mailAccounts)
    .set({ signature, updatedAt: new Date() })
    .where(eq(mailAccounts.id, id));
}

/** The notification on/off toggle's write path (#54) — `setNotificationsEnabled`'s handler in `sync/mutations.ts`. */
export async function updateMailAccountNotificationsEnabled(
  db: Db,
  id: string,
  enabled: boolean,
): Promise<void> {
  await db
    .update(mailAccounts)
    .set({ notificationsEnabled: enabled, updatedAt: new Date() })
    .where(eq(mailAccounts.id, id));
}

/** Re-entering credentials (CONTEXT.md's Needs Reauth flow) resumes: sets `username`+`credential`, clears the status. */
export async function replaceMailAccountCredential(
  db: Db,
  id: string,
  username: string,
  credential: MailAccountCredential,
): Promise<void> {
  await db
    .update(mailAccounts)
    .set({ username, credential, status: "active", updatedAt: new Date() })
    .where(eq(mailAccounts.id, id));
}
