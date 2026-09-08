import { eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { connectedAccountFacets, connectedAccounts, mailAccounts } from "../db/schema.js";
import {
  type ConnectedAccountCredential,
  deriveCredentialKey,
  mailOAuthAudience,
  type SealedSecret,
  sealOAuthCredential,
  sealPasswordCredential,
  unsealSecret,
} from "./credential-crypto.js";

/**
 * The pre-#199 `mail_accounts.credential` shape (ADR-0003), before ADR-0022
 * widened it into `ConnectedAccountCredential` — one access token, not one
 * per audience. What the boot upgrade reads back out of the physical
 * `credential` column migration 0041 deliberately left in place.
 */
type LegacyMailAccountCredential =
  | { kind: "password"; secret: SealedSecret }
  | {
      kind: "oauth";
      provider: "google" | "microsoft";
      accessToken: SealedSecret;
      refreshToken: SealedSecret;
      expiresAt: string;
      scope: string[];
    };

/**
 * The boot-time upgrade #199 (ADR-0022) requires: every pre-existing Mail
 * Account gets a Connected Account and a single Mail Facet, and the
 * credential — sealed under the Mail Account's own id until now — is
 * re-sealed under its new parent's id. Runs once, right after
 * `runMigrations()` and before anything else touches the database (`main.ts`):
 * migration 0041 only *adds* the new tables and a nullable
 * `mail_accounts.connected_account_id` (drizzle-kit can't run this part
 * itself — reading the old `credential` column back out to reseal it under a
 * fresh id needs the instance's own `MAIL_CREDENTIAL_KEY`, which lives here,
 * not in a `.sql` file), and this function is what tightens the schema the
 * rest of the way to what `db/schema.ts` already declares (`NOT NULL UNIQUE`,
 * `credential`/`status` gone from `mail_accounts` for good).
 *
 * Idempotent across a crashed or repeated boot:
 * - A no-op the moment `mail_accounts.credential` is gone (the guard at the
 *   top) — the tightening step's own completion is what this checks for,
 *   since a completed upgrade leaves nothing else to detect it by.
 * - The backfill loop only ever selects rows still missing
 *   `connected_account_id`, so a completed row is never revisited and never
 *   double-sealed. Each row's three writes (the Connected Account, its Mail
 *   Facet, the `mail_accounts` update) commit in one transaction, so a crash
 *   mid-row rolls all three back together — the next boot sees that row as
 *   still unmigrated and starts it fresh, sealing under the same
 *   deterministic id (see below) rather than leaving an orphaned partial row.
 * - The Connected Account's id is the Mail Account's own id — not a fresh
 *   random one. Two different rows sharing an id string across two
 *   different tables is harmless (ids are opaque and table-scoped), and it
 *   is what makes a retry deterministic without a separate mapping table:
 *   the same Mail Account always upgrades to the same Connected Account id,
 *   so `onConflictDoNothing()` is a genuine no-op replay guard, not a race.
 * - The tightening statements below are themselves idempotent (`DROP COLUMN
 *   IF EXISTS`, a harmless re-`SET NOT NULL`, a constraint guarded against
 *   "already exists"), so running this function again on an already-upgraded
 *   instance touches nothing.
 *
 * Fails closed (ADR-0009): a credential this build's `MAIL_CREDENTIAL_KEY`
 * cannot unseal throws here, same as everywhere else ADR-0003's key is used,
 * and the process does not start serving traffic.
 */
export async function upgradeMailAccountsToConnectedAccounts(
  db: Db,
  mailCredentialKey: string,
): Promise<void> {
  // The idempotency check the tightening step itself can't be, since it's
  // the tightening step that removes the very column this checks for: once
  // `mail_accounts.credential` is gone, this whole upgrade already ran to
  // completion (backfill and tightening both), and re-running it would
  // `SELECT` a column that no longer exists rather than find zero pending
  // rows.
  const columnCheck = await db.execute<{ hasLegacyColumn: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'mail_accounts' AND column_name = 'credential'
    ) AS "hasLegacyColumn"
  `);
  if (!columnCheck[0]?.hasLegacyColumn) return;

  const key = deriveCredentialKey(mailCredentialKey);

  const pending = await db
    .select({
      id: mailAccounts.id,
      userId: mailAccounts.userId,
      emailAddress: mailAccounts.emailAddress,
      // Not declared on `mailAccounts` any more (`db/schema.ts`) — migration
      // 0041 deliberately left the physical columns in place so this can
      // still read them, dropped only once every row is done (below).
      credential: sql<LegacyMailAccountCredential>`mail_accounts.credential`,
      status: sql<"active" | "needs_reauth">`mail_accounts.status`,
    })
    .from(mailAccounts)
    .where(isNull(mailAccounts.connectedAccountId));

  for (const row of pending) {
    const connectedAccountId = row.id;
    const provider = row.credential.kind === "oauth" ? row.credential.provider : "other_imap";
    const resealedCredential = reseal(row.credential, row.id, connectedAccountId, key);

    await db.transaction(async (tx) => {
      await tx
        .insert(connectedAccounts)
        .values({
          id: connectedAccountId,
          userId: row.userId,
          provider,
          identity: row.emailAddress,
          credential: resealedCredential,
          status: row.status,
        })
        .onConflictDoNothing();
      await tx
        .insert(connectedAccountFacets)
        .values({
          id: `${connectedAccountId}-mail`,
          connectedAccountId,
          kind: "mail",
          status: row.status,
        })
        .onConflictDoNothing();
      await tx.update(mailAccounts).set({ connectedAccountId }).where(eq(mailAccounts.id, row.id));
    });
  }

  await db.transaction(async (tx) => {
    await tx.execute(sql`ALTER TABLE mail_accounts ALTER COLUMN connected_account_id SET NOT NULL`);
    await tx.execute(sql`
      DO $$ BEGIN
        ALTER TABLE mail_accounts ADD CONSTRAINT mail_accounts_connected_account_id_unique UNIQUE (connected_account_id);
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);
    await tx.execute(sql`ALTER TABLE mail_accounts DROP COLUMN IF EXISTS credential`);
    await tx.execute(sql`ALTER TABLE mail_accounts DROP COLUMN IF EXISTS status`);
  });
}

/** Unseals under the old (Mail Account) id, reseals under the new (Connected Account) id — ADR-0022's "re-sealed under the Connected Account id" — through the same public sealing seam every other writer uses. */
function reseal(
  credential: LegacyMailAccountCredential,
  mailAccountId: string,
  connectedAccountId: string,
  key: Buffer,
): ConnectedAccountCredential {
  if (credential.kind === "password") {
    const password = unsealSecret(credential.secret, mailAccountId, key);
    return sealPasswordCredential(password, connectedAccountId, key);
  }
  const accessToken = unsealSecret(credential.accessToken, mailAccountId, key);
  const refreshToken = unsealSecret(credential.refreshToken, mailAccountId, key);
  return sealOAuthCredential(
    {
      provider: credential.provider,
      accessToken,
      refreshToken,
      expiresAt: credential.expiresAt,
      scope: credential.scope,
    },
    mailOAuthAudience(credential.provider),
    connectedAccountId,
    key,
  );
}
