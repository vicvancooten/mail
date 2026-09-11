import type { FastifyBaseLogger } from "fastify";
import {
  deriveCredentialKey,
  unsealOAuthAccessToken,
} from "../../connected-accounts/credential-crypto.js";
import { listActiveConnectedAccountsWithFacet } from "../../connected-accounts/store.js";
import type { Db } from "../../db/client.js";
import { type PollLoopHandle, startPollLoop } from "../../sync/poll-loop.js";
import { createGooglePeopleClient, type GooglePeopleClient } from "./client.js";
import { syncGoogleContactsForAccount } from "./people-sync.js";

/**
 * The scheduler for `people-sync.ts` (#214): every Google Connected Account
 * with an `active` Contacts Facet, mirrored on its own schedule, on the
 * shared `poll-loop.ts` helper (#188) rather than an eighth hand-rolled
 * loop — this ticket's own acceptance line. Independent of
 * `sync/manager.ts`'s per-account IMAP sessions, the same "keeps running
 * for an account with no live connection" shape `grant-refresh-loop.ts`
 * already has; `main.ts` starts it once at boot and stops it on `SIGTERM`
 * through the shared `pollLoops` registry.
 *
 * Google's Contacts Facet always shares its account's `"default"` oauth
 * audience with Mail (`credential-crypto.ts#facetOAuthAudience`: "Google
 * mints one token good for every scope on the Grant"), and every Google
 * Connected Account with a Contacts Facet also has a Mail Facet (#202:
 * Contacts is only ever turned on for an already-signed-in-for-Mail
 * account) — so the existing Mail-triggered `grant-refresh-loop.ts` already
 * keeps this audience's access token warm; this loop only ever reads it,
 * never refreshes it itself.
 *
 * **The first tick runs immediately**, same reasoning as
 * `grant-refresh-loop.ts`'s own: an account whose sync fell behind while
 * the process was down shouldn't wait out a full interval before its next
 * pull.
 */

/** The acceptance line's own number: "Poll every 15 minutes on the shared loop helper". */
const DEFAULT_INTERVAL_MS = 15 * 60_000;

export interface GoogleContactsSyncLoopOptions {
  /** `env.MAIL_CREDENTIAL_KEY`, raw — hashed once here, the same as every other loop that takes it. */
  mailCredentialKey: string;
  client?: GooglePeopleClient;
  intervalMs?: number;
  now?: () => Date;
  logger?: FastifyBaseLogger;
}

export type GoogleContactsSyncLoopHandle = PollLoopHandle;

export function startGoogleContactsSyncLoop(
  db: Db,
  options: GoogleContactsSyncLoopOptions,
): GoogleContactsSyncLoopHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const now = options.now ?? (() => new Date());
  const logger = options.logger;
  const credentialKey = deriveCredentialKey(options.mailCredentialKey);
  const client = options.client ?? createGooglePeopleClient();

  return startPollLoop({
    label: "google contacts sync loop",
    intervalMs,
    logger,
    async tick({ isStopped }) {
      const accounts = await listActiveConnectedAccountsWithFacet(db, "google", "contacts");
      for (const account of accounts) {
        if (isStopped()) return;
        if (account.credential.kind !== "oauth") continue; // the store query already filters; narrows for TS

        try {
          const accessToken = unsealOAuthAccessToken(
            account.credential,
            "default",
            account.connectedAccountId,
            credentialKey,
          );
          await syncGoogleContactsForAccount(
            db,
            client,
            {
              userId: account.userId,
              connectedAccountId: account.connectedAccountId,
              accessToken,
            },
            now(),
          );
        } catch (err) {
          // One account's failure (a transient network error, an
          // unexpectedly-expired access token) never stops the rest of
          // this tick's accounts — the same per-account isolation
          // `grant-refresh-loop.ts`'s own tick already gives each Mail
          // Account.
          logger?.error(
            { err, connectedAccountId: account.connectedAccountId },
            "google contacts sync loop: sync failed for one account",
          );
        }
      }
    },
  });
}
