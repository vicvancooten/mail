import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db/client.js";
import { deriveCredentialKey } from "../mail-accounts/credential-crypto.js";
import {
  GRANT_REFRESH_SAFETY_MARGIN_MS,
  needsGrantRefresh,
  refreshMailAccountGrant,
} from "../mail-accounts/grant-refresh.js";
import type { ProviderAdapters } from "../mail-accounts/provider-adapter.js";
import { listActiveOAuthMailAccounts } from "../mail-accounts/store.js";

/**
 * The scheduler for `mail-accounts/grant-refresh.ts` (#118, ADR-0021): the
 * same "plain Postgres background loop, no IMAP connection, keeps running
 * for an account sitting in Needs Reauth" shape `search-index-loop.ts` and
 * `snooze-wake-loop.ts` already have — this is what "keeps Grants warm even
 * while the resident connection is down" actually means: a Grant nearing
 * expiry gets refreshed on its own schedule, independent of whether
 * `sync/manager.ts` currently has a live session open for that account.
 * `main.ts` starts it once at boot, independent of `sync/manager.ts`'s
 * per-account sessions, and stops it on `SIGTERM`.
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

export interface GrantRefreshLoopHandle {
  stop(): Promise<void>;
}

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

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = async () => {
    if (stopped) return;
    try {
      const accounts = await listActiveOAuthMailAccounts(db);
      for (const account of accounts) {
        if (stopped) return;
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
    } catch (err) {
      logger?.error({ err }, "grant refresh loop: tick failed");
    }
  };

  // Mirrors `snooze-wake-loop.ts`'s own "runs to completion before the next
  // tick is scheduled" — two ticks overlapping would still be correct (every
  // write here is a plain conditional/keyed update), just a wasted Provider
  // round trip.
  let running: Promise<void> = tick().finally(scheduleNext);

  function scheduleNext(): void {
    if (stopped) return;
    timer = setTimeout(() => {
      running = tick().finally(scheduleNext);
    }, intervalMs);
    timer.unref?.();
  }

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await running;
    },
  };
}
