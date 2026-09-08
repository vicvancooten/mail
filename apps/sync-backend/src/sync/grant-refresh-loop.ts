import type { FastifyBaseLogger } from "fastify";
import { deriveCredentialKey } from "../connected-accounts/credential-crypto.js";
import type { Db } from "../db/client.js";
import {
  GRANT_REFRESH_SAFETY_MARGIN_MS,
  needsGrantRefresh,
  refreshMailAccountGrant,
} from "../mail-accounts/grant-refresh.js";
import type { ProviderAdapters } from "../mail-accounts/provider-adapter.js";
import { listActiveOAuthMailAccounts } from "../mail-accounts/store.js";
import { type PollLoopHandle, startPollLoop } from "./poll-loop.js";

/**
 * The scheduler for `mail-accounts/grant-refresh.ts` (#118, ADR-0021): the
 * same "plain Postgres background loop, no IMAP connection, keeps running
 * for an account sitting in Needs Reauth" shape `search-index-loop.ts` and
 * `snooze-wake-loop.ts` already have — this is what "keeps Grants warm even
 * while the resident connection is down" actually means: a Grant nearing
 * expiry gets refreshed on its own schedule, independent of whether
 * `sync/manager.ts` currently has a live session open for that account.
 * `main.ts` starts it once at boot, independent of `sync/manager.ts`'s
 * per-account sessions, and stops it on `SIGTERM`. A thin wrapper over
 * `poll-loop.ts`'s shared shape (#188).
 *
 * **The first tick runs immediately**, same reasoning as `snooze-wake-
 * loop.ts`'s own boot-time sweep: a Grant that came due while the process
 * was down shouldn't wait out a full interval before its first refresh.
 */

/**
 * Tight enough relative to `GRANT_REFRESH_SAFETY_MARGIN_MS` (10 minutes)
 * that a Grant entering the safety margin gets picked up on the very next
 * tick or the one after, never waiting most of the margin away doing
 * nothing.
 */
const DEFAULT_INTERVAL_MS = 5 * 60_000;

export interface GrantRefreshLoopOptions {
  /** `env.MAIL_CREDENTIAL_KEY`, raw — hashed once here, the same as every other loop that takes it. */
  mailCredentialKey: string;
  providerAdapters: ProviderAdapters;
  intervalMs?: number;
  safetyMarginMs?: number;
  now?: () => Date;
  logger?: FastifyBaseLogger;
}

export type GrantRefreshLoopHandle = PollLoopHandle;

export function startGrantRefreshLoop(
  db: Db,
  options: GrantRefreshLoopOptions,
): GrantRefreshLoopHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const safetyMarginMs = options.safetyMarginMs ?? GRANT_REFRESH_SAFETY_MARGIN_MS;
  const now = options.now ?? (() => new Date());
  const logger = options.logger;
  const credentialKey = deriveCredentialKey(options.mailCredentialKey);
  const adapters = options.providerAdapters;

  return startPollLoop({
    label: "grant refresh loop",
    intervalMs,
    logger,
    async tick({ isStopped }) {
      const accounts = await listActiveOAuthMailAccounts(db);
      for (const account of accounts) {
        if (isStopped()) return;
        if (account.credential.kind !== "oauth") continue; // the store query already filters; narrows for TS
        if (!needsGrantRefresh(account.credential, now(), safetyMarginMs)) continue;

        const outcome = await refreshMailAccountGrant(db, account, { credentialKey, adapters });
        if (outcome.result === "transient" || outcome.result === "withdrawn") {
          logger?.warn(
            { mailAccountId: account.id, provider: account.credential.provider, outcome },
            "grant refresh loop: refresh did not succeed",
          );
        }
      }
    },
  });
}
