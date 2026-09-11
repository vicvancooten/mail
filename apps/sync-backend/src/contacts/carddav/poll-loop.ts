import type { FastifyBaseLogger } from "fastify";
import {
  deriveCredentialKey,
  unsealPasswordCredential,
} from "../../connected-accounts/credential-crypto.js";
import { listActiveConnectedAccountsWithFacet } from "../../connected-accounts/store.js";
import type { Db } from "../../db/client.js";
import { type PollLoopHandle, startPollLoop } from "../../sync/poll-loop.js";
import { type CarddavClient, createCarddavClient } from "./client.js";
import { syncCarddavContactsForAccount } from "./contacts-sync.js";

/**
 * The scheduler for `contacts-sync.ts` (#226): every CalDAV/CardDAV
 * Connected Account with an `active` Contacts Facet, mirrored on its own
 * schedule — `contacts/microsoft/poll-loop.ts`'s own shape, generalized to
 * a `password` credential (RFC 6352 has no OAuth of its own, ADR-0003's
 * "`password` covers Other IMAP and CalDAV/CardDAV alike") and to a Facet
 * that may legitimately have no `davHomeSetUrl` yet recorded — this ticket's
 * own tolerance for a discovery that hasn't landed. `main.ts` starts it once
 * at boot and stops it on `SIGTERM` through the shared `pollLoops` registry,
 * the same as every other loop there.
 *
 * **The first tick runs immediately** — same reasoning as every other loop
 * `poll-loop.ts` builds on.
 */

/** The same 15-minute cadence `google/poll-loop.ts`/`microsoft/poll-loop.ts` use — CardDAV has no minted-at expiry floor of its own to pace around either (RFC 6578 leaves token lifetime entirely up to the server). */
const DEFAULT_INTERVAL_MS = 15 * 60_000;

export interface CarddavContactsSyncLoopOptions {
  /** `env.MAIL_CREDENTIAL_KEY`, raw — hashed once here, the same as every other loop that takes it. */
  mailCredentialKey: string;
  client?: CarddavClient;
  intervalMs?: number;
  logger?: FastifyBaseLogger;
}

export type CarddavContactsSyncLoopHandle = PollLoopHandle;

export function startCarddavContactsSyncLoop(
  db: Db,
  options: CarddavContactsSyncLoopOptions,
): CarddavContactsSyncLoopHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const logger = options.logger;
  const credentialKey = deriveCredentialKey(options.mailCredentialKey);
  const client = options.client ?? createCarddavClient();

  return startPollLoop({
    label: "carddav contacts sync loop",
    intervalMs,
    logger,
    async tick({ isStopped }) {
      const accounts = await listActiveConnectedAccountsWithFacet(db, "caldav_carddav", "contacts");
      for (const account of accounts) {
        if (isStopped()) return;
        if (
          account.credential.kind !== "password" ||
          !account.davUsername ||
          !account.davHomeSetUrl
        ) {
          continue; // discovery hasn't recorded this Facet's home-set yet, or a credential shape this Provider never takes
        }

        try {
          const password = unsealPasswordCredential(
            account.credential,
            account.connectedAccountId,
            credentialKey,
          );
          await syncCarddavContactsForAccount(db, client, {
            userId: account.userId,
            connectedAccountId: account.connectedAccountId,
            homeSetUrl: account.davHomeSetUrl,
            credentials: { username: account.davUsername, password },
          });
        } catch (err) {
          // One account's failure never stops the rest of this tick's
          // accounts — `google/poll-loop.ts`'s own per-account isolation.
          logger?.error(
            { err, connectedAccountId: account.connectedAccountId },
            "carddav contacts sync loop: sync failed for one account",
          );
        }
      }
    },
  });
}
