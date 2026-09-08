import type { MailAccount, MailAccountConnection, Provider } from "@mail/shared";
import { and, eq, getTableColumns, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { ConnectedAccountCredential } from "../connected-accounts/credential-crypto.js";
import {
  markConnectedAccountNeedsReauth,
  reactivateConnectedAccount,
} from "../connected-accounts/store.js";
import type { Db, Tx } from "../db/client.js";
import { connectedAccountFacets, connectedAccounts, mailAccounts } from "../db/schema.js";
import type { DetectedMailAccountServerKind, MailAccountServerKind } from "./server-kind.js";

/**
 * The Mail Facet, joined back to its owning Connected Account's `credential`
 * and its own Facet-level `status` (#199, ADR-0022): the shape every
 * pre-#199 caller of this module already expects, kept stable across the
 * credential's move up a level rather than pushed out to every consumer.
 * `connectedAccountId` is new — the AAD a caller now unseals `credential`
 * under, and the id every write path below actually updates.
 */
export type MailAccountRow = typeof mailAccounts.$inferSelect & {
  credential: ConnectedAccountCredential;
  status: "active" | "needs_reauth";
};

/** Every physical `mail_accounts` column, reused by every joined query below so a new column never has to be re-listed by hand. */
const mailAccountColumns = getTableColumns(mailAccounts);

/**
 * The one join every read in this module shares: a Mail Account's own row,
 * its parent Connected Account's `credential`, and its own Mail Facet row's
 * `status` — the projection ADR-0022 asks for ("`status` projected from the
 * Mail Facet's row"). `inner` on both: a Mail Account's `connectedAccountId`
 * is `NOT NULL UNIQUE` and its Mail Facet is created in the same transaction
 * as the Mail Account itself (`insertMailAccount` below), so neither join
 * ever misses.
 *
 * Exported so a caller needing its own filter/order/paging on top of the
 * same row shape (`sync/collection-sync.ts#syncMailAccountCollection`, the
 * User-scoped delta page) extends this query rather than re-deriving the
 * join.
 */
export function mailAccountRowsQuery(db: Db | Tx) {
  return db
    .select({
      ...mailAccountColumns,
      credential: connectedAccounts.credential,
      status: connectedAccountFacets.status,
    })
    .from(mailAccounts)
    .innerJoin(connectedAccounts, eq(mailAccounts.connectedAccountId, connectedAccounts.id))
    .innerJoin(
      connectedAccountFacets,
      and(
        eq(connectedAccountFacets.connectedAccountId, connectedAccounts.id),
        eq(connectedAccountFacets.kind, "mail"),
      ),
    );
}

/**
 * The wire-safe half of `ConnectedAccountCredential.kind` (#119): which door
 * re-authentication goes through, never the credential itself.
 */
function toWireAuthKind(credential: ConnectedAccountCredential): MailAccount["authKind"] {
  return credential.kind === "oauth"
    ? { kind: "oauth", provider: credential.provider }
    : { kind: "password" };
}

/** Never includes `credential` — write-only across the API (ADR-0003). */
export function toWireMailAccount(row: MailAccountRow): MailAccount {
  return {
    id: row.id,
    // #200: the join a Client makes onto `ConnectedAccount` for its
    // `identity`/`provider`/`facets` — every other field here is unchanged.
    connectedAccountId: row.connectedAccountId,
    emailAddress: row.emailAddress,
    imap: { host: row.imapHost, port: row.imapPort, security: row.imapSecurity },
    smtp: { host: row.smtpHost, port: row.smtpPort, security: row.smtpSecurity },
    status: row.status,
    authKind: toWireAuthKind(row.credential),
    serverKind: row.serverKind,
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
    gatekeeper: {
      enabled: row.gatekeeperEnabled,
      cutoff: row.gatekeeperCutoff?.toISOString() ?? null,
    },
    createdAt: row.createdAt.toISOString(),
  };
}

export interface InsertMailAccountInput {
  id: string;
  /** The new parent Connected Account's id (#199, ADR-0022) — minted by the caller, since it's also the AAD the credential was sealed under. */
  connectedAccountId: string;
  userId: string;
  /** The glossary's four-value Provider this Connected Account is at — derived by the caller from how the credential was obtained (password ⇒ Other IMAP, a Grant ⇒ its own Provider). */
  provider: Provider;
  emailAddress: string;
  imap: MailAccountConnection;
  smtp: MailAccountConnection;
  username: string;
  /** Sealed under `connectedAccountId`, not `id` — the Connected Account owns the credential now. */
  credential: ConnectedAccountCredential;
  /** Detected by `mail-accounts/verify.ts` in the same live check that authorized this insert (#121) — `null` only ever models a pre-#121 row in a test. */
  serverKind: DetectedMailAccountServerKind | null;
}

/**
 * Creates a Connected Account, its one Mail Facet, and the Mail Account
 * itself, atomically (#199, ADR-0022) — every existing caller (add a Mail
 * Account by password, sign in with a Provider) is adding a brand-new
 * identity today, so every one of these three rows is new every time this is
 * called; there is no "attach a Mail Facet to an existing Connected Account"
 * path yet (that's turning on a Facet, #202, for Google/Microsoft already
 * connected for Calendar or Contacts first).
 */
export async function insertMailAccount(
  db: Db,
  input: InsertMailAccountInput,
): Promise<MailAccountRow> {
  return db.transaction(async (tx) => {
    await tx.insert(connectedAccounts).values({
      id: input.connectedAccountId,
      userId: input.userId,
      provider: input.provider,
      identity: input.emailAddress,
      credential: input.credential,
      status: "active",
    });
    await tx.insert(connectedAccountFacets).values({
      id: `${input.connectedAccountId}-mail`,
      connectedAccountId: input.connectedAccountId,
      kind: "mail",
      status: "active",
    });
    const [row] = await tx
      .insert(mailAccounts)
      .values({
        id: input.id,
        userId: input.userId,
        connectedAccountId: input.connectedAccountId,
        emailAddress: input.emailAddress,
        imapHost: input.imap.host,
        imapPort: input.imap.port,
        imapSecurity: input.imap.security,
        smtpHost: input.smtp.host,
        smtpPort: input.smtp.port,
        smtpSecurity: input.smtp.security,
        username: input.username,
        serverKind: input.serverKind,
      })
      .returning();
    if (!row) {
      throw new Error("Insert of Mail Account returned no row.");
    }
    return { ...row, credential: input.credential, status: "active" as const };
  });
}

/** Scoped by User — ownership is the only authorization primitive (ADR-0004). */
export async function listMailAccountsForUser(db: Db, userId: string): Promise<MailAccountRow[]> {
  return mailAccountRowsQuery(db).where(eq(mailAccounts.userId, userId));
}

export async function getMailAccountForUser(
  db: Db,
  userId: string,
  id: string,
): Promise<MailAccountRow | null> {
  const [row] = await mailAccountRowsQuery(db).where(
    and(eq(mailAccounts.id, id), eq(mailAccounts.userId, userId)),
  );
  return row ?? null;
}

/**
 * Scoped by User, matched on the mailbox address (#116): "signing in as an
 * address already among the User's Mail Accounts is refused". Scoped by User
 * and not instance-wide on purpose — two Users on one instance may each hold
 * a Mail Account on the same shared address (ADR-0004: ownership is the only
 * authorization primitive), and neither is a duplicate of the other.
 */
export async function getMailAccountForUserByAddress(
  db: Db,
  userId: string,
  emailAddress: string,
): Promise<MailAccountRow | null> {
  const [row] = await mailAccountRowsQuery(db).where(
    and(eq(mailAccounts.userId, userId), eq(mailAccounts.emailAddress, emailAddress)),
  );
  return row ?? null;
}

/**
 * Scoped by User, batched (#68) — the Account Scope's ownership check:
 * every id in `ids` that this User actually owns comes back, silently
 * dropping the rest, so a caller can tell "some of these aren't mine" from
 * `result.length !== ids.length` the same way `getMailAccountForUser`'s
 * single-id form is checked with `=== null`.
 */
export async function getMailAccountsForUser(
  db: Db,
  userId: string,
  ids: string[],
): Promise<MailAccountRow[]> {
  if (ids.length === 0) return [];
  return mailAccountRowsQuery(db).where(
    and(eq(mailAccounts.userId, userId), inArray(mailAccounts.id, ids)),
  );
}

/**
 * Unscoped by User — for the sync engine (#35), which runs per Mail Account
 * regardless of who owns it, and needs the freshest credential/status row on
 * every reconnect rather than whatever was in memory when the loop started.
 */
export async function getMailAccountById(db: Db, id: string): Promise<MailAccountRow | null> {
  const [row] = await mailAccountRowsQuery(db).where(eq(mailAccounts.id, id));
  return row ?? null;
}

/** Every Mail Account on the instance — what boot uses to start a sync loop per account (#35). */
export async function listAllMailAccounts(db: Db): Promise<MailAccountRow[]> {
  return mailAccountRowsQuery(db);
}

/**
 * The User a Mail Account belongs to (ADR-0004: exactly one), `null` for an
 * id with no row. `sync/mutations.ts` resolves it once per flush because
 * `applyLabel`/`removeLabel` derive a **User-scoped** `Label` id (#186) from
 * it, while the queue being drained names only the Mail Account.
 */
export async function getMailAccountOwnerId(db: Db | Tx, id: string): Promise<string | null> {
  const [row] = await db
    .select({ userId: mailAccounts.userId })
    .from(mailAccounts)
    .where(eq(mailAccounts.id, id))
    .limit(1);
  return row?.userId ?? null;
}

export async function getMailAccountServerKind(
  db: Db | Tx,
  id: string,
): Promise<MailAccountServerKind> {
  const [row] = await db
    .select({ serverKind: mailAccounts.serverKind })
    .from(mailAccounts)
    .where(eq(mailAccounts.id, id))
    .limit(1);
  return row?.serverKind ?? null;
}

/**
 * Bumps a Mail Account's Thread rebuild epoch (`db/schema.ts`'s
 * `threadsEpoch`) — the trigger `sync/collection-sync.ts#syncThreadCollection`
 * checks a Client's token against, so the next Thread sync for this account
 * answers `reset: true` regardless of how far behind that token actually is.
 * Two callers: `sync/ingest.ts#applyUidValidity` (a UIDVALIDITY rebuild) and
 * `routes/bulk-triage.ts` (#67, a batch past `BULK_TRIAGE_RESET_THRESHOLD`)
 * — both are "the underlying state was rebuilt" in ADR-0011's sense, just
 * from different causes, so both drive the one mechanism rather than each
 * growing its own reset signal.
 */
export async function bumpThreadsEpoch(db: Db, id: string): Promise<void> {
  await db
    .update(mailAccounts)
    .set({ threadsEpoch: sql`${mailAccounts.threadsEpoch} + 1` })
    .where(eq(mailAccounts.id, id));
}

/**
 * The seam a sync engine (#9) calls when the mail server rejects the stored
 * credential: stops syncing and holds queued Optimistic Actions by parking
 * the account's Connected Account and Mail Facet in Needs Reauth (#199,
 * ADR-0022) — `id` here is still the **Mail Account's** id, the same
 * parameter every pre-#199 caller already passes; this resolves its
 * `connectedAccountId` and delegates to
 * `connected-accounts/store.ts#markConnectedAccountNeedsReauth`.
 *
 * Returns the updated `MailAccountRow` only on a genuine transition, `null`
 * when the account was already parked — the distinction #53's Notifier hook
 * needs ("notifies once on entry and not again until reauth clears it",
 * ADR-0015).
 */
export async function markNeedsReauth(db: Db, id: string): Promise<MailAccountRow | null> {
  const account = await getMailAccountById(db, id);
  if (!account) return null;
  const transitioned = await markConnectedAccountNeedsReauth(db, account.connectedAccountId);
  if (!transitioned) return null;
  return { ...account, status: "needs_reauth" };
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

/**
 * Re-entering credentials (CONTEXT.md's Needs Reauth flow) resumes: sets
 * `username`+`serverKind` on the Mail Account and reseals the fresh
 * credential onto its Connected Account, resuming both it and every Facet it
 * holds (#199, ADR-0022 — account-level Needs Reauth stopped all of them, so
 * clearing it resumes all of them; delegates to
 * `connected-accounts/store.ts#reactivateConnectedAccount`). Reauth
 * re-verifies live (`routes/mail-accounts.ts`), so it also carries the
 * freshly detected server kind (#121) — the same rule
 * `updateMailAccountServerKind` applies for a plain reconnect.
 */
export async function replaceMailAccountCredential(
  db: Db,
  id: string,
  connectedAccountId: string,
  username: string,
  credential: ConnectedAccountCredential,
  serverKind: DetectedMailAccountServerKind,
): Promise<void> {
  await db
    .update(mailAccounts)
    .set({ username, serverKind, updatedAt: new Date() })
    .where(eq(mailAccounts.id, id));
  // A reauth's own credential is authoritative for the Provider (ADR-0022:
  // "the Other IMAP to Google switch survives") — a password stays Other
  // IMAP, an oauth Grant names its own Provider, Google or Microsoft.
  const provider = credential.kind === "oauth" ? credential.provider : "other_imap";
  await reactivateConnectedAccount(db, connectedAccountId, provider, credential);
}

/**
 * Every `active` Mail Account whose credential is an `oauth` Grant (#118) —
 * what the refresh loop sweeps each tick. Scoped to `active`: a Mail Account
 * already parked in Needs Reauth has nothing a token refresh can fix, so
 * refreshing it would just be a wasted Provider round trip.
 */
export async function listActiveOAuthMailAccounts(db: Db): Promise<MailAccountRow[]> {
  return mailAccountRowsQuery(db).where(
    and(
      eq(connectedAccountFacets.status, "active"),
      sql`${connectedAccounts.credential}->>'kind' = 'oauth'`,
    ),
  );
}

/**
 * Every Mail Account whose Connected Account is at this Provider (#199,
 * ADR-0022) — the delete-preview count and the delete transition's own
 * target set for `routes/instance.ts`'s Provider Registration removal
 * (ADR-0021: "first tells the Owner how many Mail Accounts will stop
 * syncing"). The Provider moved off `mail_accounts` onto `connected_accounts`
 * with the credential, so this reads it there rather than off a
 * `mail_accounts.provider` column that no longer exists.
 */
export async function listMailAccountsForProvider(
  db: Db,
  provider: Provider,
): Promise<MailAccountRow[]> {
  return mailAccountRowsQuery(db).where(eq(connectedAccounts.provider, provider));
}

/**
 * The sync engine's "on connect" half of #121 (ADR-0020): a Mail Account
 * added before this column existed, or whose server changed, picks up the
 * detected kind on its next successful IMAP connect
 * (`sync/imap-connection.ts#connectMailAccount`) rather than needing a
 * migration backfill. Guarded to a no-op when the stored kind already
 * matches, so a resident sync loop's routine reconnects don't bump
 * `syncRev` (`db/schema.ts`'s delta-sync trigger) for nothing.
 */
export async function updateMailAccountServerKind(
  db: Db,
  id: string,
  serverKind: DetectedMailAccountServerKind,
): Promise<void> {
  await db
    .update(mailAccounts)
    .set({ serverKind, updatedAt: new Date() })
    .where(
      and(
        eq(mailAccounts.id, id),
        or(isNull(mailAccounts.serverKind), ne(mailAccounts.serverKind, serverKind)),
      ),
    );
}
