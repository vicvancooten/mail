import {
  type ConnectedAccountCredential,
  facetOAuthAudience,
  mailOAuthAudience,
  reAuthenticateOAuthCredential,
  unsealSecret,
} from "../connected-accounts/credential-crypto.js";
import {
  listConnectedAccountFacets,
  markConnectedAccountFacetNeedsReauth,
  markConnectedAccountNeedsReauth,
  updateConnectedAccountCredential,
} from "../connected-accounts/store.js";
import type { Db } from "../db/client.js";
import { recordNeedsReauthNotification } from "../notifier/record.js";
import {
  getProviderRegistration,
  recordProviderRefreshOutcome,
} from "../provider-registrations/store.js";
import type { ProviderAdapter, ProviderAdapters } from "./provider-adapter.js";
import type { MailAccountRow } from "./store.js";

/**
 * #118's single seam for "refresh this Mail Account's Grant" — the resident
 * connection (`sync/imap-connection.ts`, proactively and on an auth failure)
 * and the standalone background loop (`sync/grant-refresh-loop.ts`) are its
 * only two callers, so the "withdrawn is Needs Reauth, transient is a
 * Provider Health fact" split (ADR-0021) lives in exactly one place.
 *
 * Refreshes the Mail Facet's own audience only (ADR-0022: "a Grant refresh
 * refreshes one audience and leaves the others alone") — turning on a second
 * Facet and refreshing *its* audience is a later ticket's own seam.
 *
 * A successful refresh also runs #204's scope diff: the returned `scope` is
 * "the scope set that comes back on every Grant refresh" ADR-0022 names as
 * the *only* mechanism for "the User revoked one permission upstream" — an
 * active Facet whose scope is no longer in it is parked, Facet-level, right
 * here, never by polling the Provider. Only ever checked for a Facet sharing
 * this refresh's own audience (`credential-crypto.ts#facetOAuthAudience`):
 * Google mints one token for every Facet, so its Mail refresh's `scope`
 * speaks for Calendar and Contacts too; Microsoft mints Graph's token
 * separately from IMAP's, so a Mail-only refresh here says nothing about a
 * Microsoft Calendar/Contacts Facet's scope — refreshing *that* audience is
 * the same later seam the paragraph above already defers.
 */

/**
 * How long before expiry a Grant is refreshed proactively. Ten minutes: long
 * enough that a refresh attempt (network round trip plus the write) always
 * lands before the access token actually dies, short enough that the
 * standalone loop's tick (`GRANT_REFRESH_LOOP_INTERVAL_MS`) catches it with
 * room to spare.
 */
export const GRANT_REFRESH_SAFETY_MARGIN_MS = 10 * 60_000;

/** Whether the Mail Facet's oauth access token is due for a proactive refresh — `false` for anything else. */
export function needsGrantRefresh(
  credential: ConnectedAccountCredential,
  now: Date,
  safetyMarginMs: number = GRANT_REFRESH_SAFETY_MARGIN_MS,
): boolean {
  if (credential.kind !== "oauth") return false;
  const audience = mailOAuthAudience(credential.provider);
  const entry = credential.accessTokens[audience];
  if (!entry) return false;
  return new Date(entry.expiresAt).getTime() - now.getTime() <= safetyMarginMs;
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
 * - `ok: true` reseals the new tokens onto the Connected Account, records a
 *   success on the Provider Registration, and runs #204's scope diff (this
 *   function's own doc comment).
 * - `withdrawn` is account-level, unconditionally (ADR-0022: "on the
 *   Connected Account when ... the Grant withdrawn") — the whole refresh
 *   token is dead, not one Facet's own scope, so this takes
 *   `markConnectedAccountNeedsReauth`'s atomic transition directly rather
 *   than `mail-accounts/store.ts#markNeedsReauth`'s Facet-scoped default —
 *   notifying exactly once, same as a rejected password (ADR-0021) — and
 *   touches nothing on the Registration.
 * - `transient` leaves the Connected Account exactly as it was and records
 *   the failure on the Registration, for Provider Health's Failing state.
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
  const refreshToken = unsealSecret(
    credential.refreshToken,
    account.connectedAccountId,
    credentialKey,
  );

  const result = await adapter.refresh({
    clientId: registration.clientId,
    clientSecret,
    refreshToken,
  });

  if (result.ok) {
    const audience = mailOAuthAudience(provider);
    const refreshed = reAuthenticateOAuthCredential(
      credential,
      {
        provider,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresAt: result.expiresAt,
        scope: result.scope,
      },
      audience,
      account.connectedAccountId,
      credentialKey,
    );
    await updateConnectedAccountCredential(db, account.connectedAccountId, refreshed);
    await recordProviderRefreshOutcome(db, provider, null);
    await parkFacetsMissingScope(db, account, provider, adapter, audience, result.scope);
    return { result: "refreshed" };
  }

  if (result.reason === "withdrawn") {
    const transitioned = await markConnectedAccountNeedsReauth(db, account.connectedAccountId);
    if (transitioned) {
      await recordNeedsReauthNotification(db, {
        userId: transitioned.userId,
        connectedAccountId: transitioned.id,
        // Every Facet stopped, but the notification still names Mail as the
        // deep-link's own anchor — Mail is the one Facet every oauth
        // Connected Account is guaranteed to carry, and a withdrawn Grant is
        // one event, not one push per Facet it happened to stop.
        facet: "mail",
        identity: transitioned.identity,
        mailAccountId: account.id,
        updatedAt: transitioned.updatedAt,
      });
    }
    return { result: "withdrawn", detail: result.detail };
  }

  await recordProviderRefreshOutcome(db, provider, result.detail);
  return { result: "transient", detail: result.detail };
}

/**
 * #204's scope diff, run after every successful refresh: every `active`
 * Facet sharing the just-refreshed audience whose own required scope isn't
 * in what the Provider actually returned gets parked, alone — never the
 * account, never a Facet on a *different* audience (this function's own
 * caller already only calls it for the audience that was actually
 * refreshed; see `refreshMailAccountGrant`'s own doc comment for why
 * Microsoft's Calendar/Contacts Facets never reach here from a Mail
 * refresh).
 *
 * A Facet's "own required scope" is `facetGrantScopes(kind).coreScope` for
 * Calendar/Contacts (#202's own "one scope string whose absence means the
 * User partly declined") and, for Mail, `adapter.scopes[0]` — every adapter
 * lists its resource-defining scope first, `offline_access`/`openid`/`email`
 * after (`google-adapter.ts#GOOGLE_SCOPES`, `microsoft-adapter.ts#MICROSOFT_SCOPES`),
 * the same convention `facetGrantScopes` follows for its own `coreScope`.
 */
async function parkFacetsMissingScope(
  db: Db,
  account: MailAccountRow,
  provider: "google" | "microsoft",
  adapter: ProviderAdapter,
  refreshedAudience: ReturnType<typeof mailOAuthAudience>,
  scope: string[],
): Promise<void> {
  const granted = new Set(scope);
  const facets = await listConnectedAccountFacets(db, account.connectedAccountId);
  for (const facet of facets) {
    if (facet.status !== "active") continue;
    if (facetOAuthAudience(provider, facet.kind) !== refreshedAudience) continue;
    const requiredScope =
      facet.kind === "mail" ? adapter.scopes[0] : adapter.facetGrantScopes?.(facet.kind)?.coreScope;
    if (!requiredScope || granted.has(requiredScope)) continue;

    const parked = await markConnectedAccountFacetNeedsReauth(
      db,
      account.connectedAccountId,
      facet.kind,
    );
    if (!parked) continue;
    await recordNeedsReauthNotification(db, {
      userId: account.userId,
      connectedAccountId: account.connectedAccountId,
      facet: facet.kind,
      identity: account.emailAddress,
      mailAccountId: facet.kind === "mail" ? account.id : null,
      updatedAt: parked.updatedAt,
    });
  }
}
