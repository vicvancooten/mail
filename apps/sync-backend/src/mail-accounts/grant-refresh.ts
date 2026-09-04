import type { Db } from "../db/client.js";
import { recordNeedsReauthNotification } from "../notifier/record.js";
import {
  getProviderRegistration,
  recordProviderRefreshOutcome,
} from "../provider-registrations/store.js";
import {
  type MailAccountCredential,
  sealOAuthCredential,
  unsealSecret,
} from "./credential-crypto.js";
import type { ProviderAdapters } from "./provider-adapter.js";
import { type MailAccountRow, markNeedsReauth, updateMailAccountGrant } from "./store.js";

/**
 * #118's single seam for "refresh this Mail Account's Grant" — the resident
 * connection (`sync/imap-connection.ts`, proactively and on an auth failure)
 * and the standalone background loop (`sync/grant-refresh-loop.ts`) are its
 * only two callers, so the "withdrawn is Needs Reauth, transient is a
 * Provider Health fact" split (ADR-0021) lives in exactly one place.
 */

/**
 * How long before expiry a Grant is refreshed proactively. Ten minutes: long
 * enough that a refresh attempt (network round trip plus the write) always
 * lands before the access token actually dies, short enough that the
 * standalone loop's tick (`GRANT_REFRESH_LOOP_INTERVAL_MS`) catches it with
 * room to spare.
 */
export const GRANT_REFRESH_SAFETY_MARGIN_MS = 10 * 60_000;

/** Whether an oauth credential is due for a proactive refresh — `false` for anything else. */
export function needsGrantRefresh(
  credential: MailAccountCredential,
  now: Date,
  safetyMarginMs: number = GRANT_REFRESH_SAFETY_MARGIN_MS,
): boolean {
  if (credential.kind !== "oauth") return false;
  return new Date(credential.expiresAt).getTime() - now.getTime() <= safetyMarginMs;
}

export type GrantRefreshOutcome =
  | { result: "refreshed" }
  | { result: "withdrawn"; detail: string }
  | { result: "transient"; detail: string }
  /** Not an oauth credential, or nothing to refresh against (no adapter/Registration) — never itself an error. */
  | { result: "skipped"; reason: string };

export interface GrantRefreshOptions {
  /** `deriveCredentialKey(env.MAIL_CREDENTIAL_KEY)` — unseals the refresh token and the Registration's client secret alike. */
  credentialKey: Buffer;
  adapters: ProviderAdapters;
}

/**
 * Refreshes one Mail Account's Grant, unconditionally — callers decide
 * *when* (`needsGrantRefresh`'s near-expiry check, or "the mail server just
 * rejected the current token") and this decides *what happens next*:
 *
 * - `ok: true` reseals the new tokens onto the Mail Account and records a
 *   success on the Provider Registration.
 * - `withdrawn` takes the existing atomic `markNeedsReauth` transition —
 *   notifying exactly once, same as a rejected password (ADR-0021) — and
 *   touches nothing on the Registration.
 * - `transient` leaves the Mail Account exactly as it was and records the
 *   failure on the Registration, for Provider Health's Failing state.
 */
export async function refreshMailAccountGrant(
  db: Db,
  account: MailAccountRow,
  { credentialKey, adapters }: GrantRefreshOptions,
): Promise<GrantRefreshOutcome> {
  const credential = account.credential;
  if (credential.kind !== "oauth") {
    return { result: "skipped", reason: "not an oauth credential" };
  }

  const provider = credential.provider;
  const adapter = adapters[provider];
  const registration = await getProviderRegistration(db, provider);
  if (!adapter) return { result: "skipped", reason: `no adapter registered for ${provider}` };
  if (!registration)
    return { result: "skipped", reason: `no Provider Registration for ${provider}` };

  const clientSecret = unsealSecret(registration.clientSecret, provider, credentialKey);
  const refreshToken = unsealSecret(credential.refreshToken, account.id, credentialKey);

  const result = await adapter.refresh({
    clientId: registration.clientId,
    clientSecret,
    refreshToken,
  });

  if (result.ok) {
    const refreshed = sealOAuthCredential(
      {
        provider,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresAt: result.expiresAt,
        scope: result.scope,
      },
      account.id,
      credentialKey,
    );
    await updateMailAccountGrant(db, account.id, refreshed);
    await recordProviderRefreshOutcome(db, provider, null);
    return { result: "refreshed" };
  }

  if (result.reason === "withdrawn") {
    const transitioned = await markNeedsReauth(db, account.id);
    if (transitioned) await recordNeedsReauthNotification(db, transitioned);
    return { result: "withdrawn", detail: result.detail };
  }

  await recordProviderRefreshOutcome(db, provider, result.detail);
  return { result: "transient", detail: result.detail };
}
