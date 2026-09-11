import {
  type ConnectedAccountCredential,
  facetOAuthAudience,
  unsealOAuthAccessToken,
} from "../../connected-accounts/credential-crypto.js";
import {
  getConnectedAccountById,
  getConnectedAccountFacet,
} from "../../connected-accounts/store.js";
import type { Db } from "../../db/client.js";
import type { GoogleCalendarCredentialProvider } from "./poll-loop.js";

/**
 * The real `GoogleCalendarCredentialProvider` (#237) — `poll-loop.ts`'s own
 * doc comment named this as the seam #199/#200/#202 would eventually fill;
 * that Connected Account / Facet / Grant model has since landed on this
 * branch, so this is that provider.
 *
 * Reads, never mints: Google's own access token is one token good for every
 * granted scope regardless of which Facet asked
 * (`credential-crypto.ts#facetOAuthAudience`: every Facet shares the
 * `"default"` audience), and `mail-accounts/grant-refresh.ts`'s own sweep
 * already keeps that one token warm for the Mail Facet — so the Calendar
 * Facet's own token is simply whatever is already sealed under that same
 * audience, no refresh of its own to trigger here. `null` covers every
 * reason there is nothing usable right now: no such Connected Account, it
 * isn't Google, its Calendar Facet doesn't exist or isn't `active` (parked —
 * Needs Reauth), or somehow no `oauth` credential at all — the caller
 * (`outbox-loop.ts`) treats every one of these identically: hold the row,
 * touch nothing.
 */
export function createGoogleCalendarCredentialProvider(
  db: Db,
  credentialKey: Buffer,
): GoogleCalendarCredentialProvider {
  return {
    async getAccessToken(connectedAccountId: string): Promise<string | null> {
      const account = await getConnectedAccountById(db, connectedAccountId);
      if (!account || account.provider !== "google") return null;

      const facet = await getConnectedAccountFacet(db, connectedAccountId, "calendar");
      if (!facet || facet.status !== "active") return null;

      const credential: ConnectedAccountCredential = account.credential;
      if (credential.kind !== "oauth") return null;

      const audience = facetOAuthAudience("google", "calendar");
      if (!credential.accessTokens[audience]) return null;

      try {
        return unsealOAuthAccessToken(credential, audience, connectedAccountId, credentialKey);
      } catch {
        return null;
      }
    },
  };
}
