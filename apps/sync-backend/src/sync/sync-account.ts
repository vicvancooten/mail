import type { Db } from "../db/client.js";
import { deriveCredentialKey } from "../mail-accounts/credential-crypto.js";
import type { MailAccountRow } from "../mail-accounts/store.js";
import { discoverFolders, type FolderRole, type FolderRow, persistFolders } from "./folders.js";
import { withMailAccountConnection } from "./imap-connection.js";
import { type IngestFolderResult, ingestFolder } from "./ingest.js";

/**
 * The sync engine's original entry point (#34): connect one Mail Account,
 * discover its folders, ingest headers newest-first.
 *
 * ADR-0005 asks for the sync engine to be "a self-contained module (talks
 * only to Postgres and IMAP) so it can be lifted into its own service" —
 * that is what `src/sync/` is, and this file was meant as its front door. It
 * takes a `Db` and a Mail Account row and returns a report; it knows
 * nothing about Fastify, sessions, or the wire contract.
 *
 * #35 replaced the one-shot pass with the resident IDLE/QRESYNC loop
 * `live-session.ts` runs, and #36 replaced the bounded ingest with full
 * backfill (`backfill.ts`'s `establishFolderBaseline`/`runAccountBackfill`)
 * — the live wiring (`app.ts`/`manager.ts`) calls those directly and never
 * this function. What's left for `syncMailAccount` is the test suite's own
 * one-shot sync harness: a single call that connects, discovers folders and
 * ingests, which every GreenMail-backed test in `sync/` and `gatekeeper/`
 * uses to get a Mail Account into a known synced state before exercising
 * the thing it actually wants to test. Not dead code — just no longer the
 * production path its docstring originally described.
 */

export interface SyncMailAccountOptions {
  /** `env.MAIL_CREDENTIAL_KEY`, raw — hashed here so callers never hold a key buffer. */
  mailCredentialKey: string;
  /** Restrict the pass to these folder roles. Omit to sync every selectable folder. */
  roles?: FolderRole[];
  /** Newest N messages per folder. Omit for the whole folder (#36 owns making that resumable). */
  limitPerFolder?: number;
  /** Fetch bodies inline instead of leaving them to #36's sweep. */
  fetchBodies?: boolean;
  batchSize?: number;
}

export type SyncMailAccountResult =
  | { status: "needs_reauth"; mailAccountId: string }
  | {
      status: "synced";
      mailAccountId: string;
      folders: FolderRow[];
      ingest: IngestFolderResult[];
    };

export async function syncMailAccount(
  db: Db,
  account: MailAccountRow,
  options: SyncMailAccountOptions,
): Promise<SyncMailAccountResult> {
  // A Mail Account in Needs Reauth is not retried — CONTEXT.md: "syncing
  // stops until the User supplies new credentials". Re-entering credentials
  // clears the status (`mail-accounts/store.ts`), and that is the only thing
  // that restarts this.
  if (account.status === "needs_reauth") {
    return { status: "needs_reauth", mailAccountId: account.id };
  }

  const credentialKey = deriveCredentialKey(options.mailCredentialKey);

  return withMailAccountConnection(db, account, { credentialKey }, async (client) => {
    const live = await persistFolders(db, account.id, await discoverFolders(client));
    const targets = selectFolders(live, options.roles);

    const ingest: IngestFolderResult[] = [];
    for (const folder of targets) {
      ingest.push(
        await ingestFolder(db, client, folder, {
          limit: options.limitPerFolder,
          fetchBodies: options.fetchBodies,
          batchSize: options.batchSize,
        }),
      );
    }

    return { status: "synced", mailAccountId: account.id, folders: live, ingest };
  });
}

/**
 * `persistFolders` already returns folders in sync priority (Inbox first);
 * this only drops the ones that cannot hold messages and, when asked,
 * narrows to specific roles.
 */
function selectFolders(live: FolderRow[], roles: FolderRole[] | undefined): FolderRow[] {
  const wanted = roles ? new Set(roles) : null;
  return live.filter(
    (folder) => folder.selectable && (!wanted || (folder.role !== null && wanted.has(folder.role))),
  );
}
