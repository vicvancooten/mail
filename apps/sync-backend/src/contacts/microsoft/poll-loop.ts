import type { FastifyBaseLogger } from "fastify";
import {
  deriveCredentialKey,
  facetOAuthAudience,
  unsealOAuthAccessToken,
} from "../../connected-accounts/credential-crypto.js";
import { listActiveConnectedAccountsWithFacet } from "../../connected-accounts/store.js";
import type { Db } from "../../db/client.js";
import { type PollLoopHandle, startPollLoop } from "../../sync/poll-loop.js";
import { createMicrosoftContactsClient, type MicrosoftContactsClient } from "./client.js";
import { syncMicrosoftContactsForAccount } from "./contacts-sync.js";

/**
 * The scheduler for `contacts-sync.ts` (#227): every Microsoft Connected
 * Account with an `active` Contacts Facet, mirrored on its own schedule, on
 * the shared `poll-loop.ts` helper — `contacts/google/poll-loop.ts`'s own
 * shape, generalized to Microsoft's own `"graph"` oauth audience
 * (`credential-crypto.ts#facetOAuthAudience`: "Calendar/Contacts share
 * `graph` — the same Graph API answers both", unlike Google's shared
 * `"default"` audience). `main.ts` starts it once at boot and stops it on
 * `SIGTERM` through the shared `pollLoops` registry, the same as every
 * other loop there.
 *
 * **The first tick runs immediately** — same reasoning as
 * `grant-refresh-loop.ts`'s/`google/poll-loop.ts`'s own: an account whose
 * sync fell behind while the process was down shouldn't wait out a full
 * interval before its next pull.
 */

/** The same 15-minute cadence `google/poll-loop.ts` uses — Graph's own contact folders have nothing analogous to Google's 7-day sync-token floor to pace around, so there is no shorter reason to poll more often. */
const DEFAULT_INTERVAL_MS = 15 * 60_000;

export interface MicrosoftContactsSyncLoopOptions {
  /** `env.MAIL_CREDENTIAL_KEY`, raw — hashed once here, the same as every other loop that takes it. */
  mailCredentialKey: string;
  client?: MicrosoftContactsClient;
  intervalMs?: number;
  logger?: FastifyBaseLogger;
}

export type MicrosoftContactsSyncLoopHandle = PollLoopHandle;

export function startMicrosoftContactsSyncLoop(
  db: Db,
  options: MicrosoftContactsSyncLoopOptions,
): MicrosoftContactsSyncLoopHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const logger = options.logger;
  const credentialKey = deriveCredentialKey(options.mailCredentialKey);
  const client = options.client ?? createMicrosoftContactsClient();
  const audience = facetOAuthAudience("microsoft", "contacts");

  return startPollLoop({
    label: "microsoft contacts sync loop",
    intervalMs,
    logger,
    async tick({ isStopped }) {
      const accounts = await listActiveConnectedAccountsWithFacet(db, "microsoft", "contacts");
      for (const account of accounts) {
        if (isStopped()) return;
        if (account.credential.kind !== "oauth") continue; // the store query already filters; narrows for TS

        try {
          const accessToken = unsealOAuthAccessToken(
            account.credential,
            audience,
            account.connectedAccountId,
            credentialKey,
          );
          await syncMicrosoftContactsForAccount(db, client, {
            userId: account.userId,
            connectedAccountId: account.connectedAccountId,
            accessToken,
          });
        } catch (err) {
          // One account's failure never stops the rest of this tick's
          // accounts — `google/poll-loop.ts`'s own per-account isolation.
          logger?.error(
            { err, connectedAccountId: account.connectedAccountId },
            "microsoft contacts sync loop: sync failed for one account",
          );
        }
      }
    },
  });
}
