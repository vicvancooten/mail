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
import type { GraphCalendarCredentialProvider } from "./poll-loop.js";

/**
 * The real Graph Calendar credential provider (#248) — `google/credentials.ts`'s
 * own shape, reading the `"graph"` audience (`credential-crypto.ts
 * #facetOAuthAudience("microsoft", "calendar")`) rather than Google's shared
 * `"default"` one.
 *
 * **Reads, never refreshes** — unlike Google's own provider, this is a real
 * gap, not a restated one: Microsoft mints the Graph audience's access token
 * *separately* from the Mail Facet's own IMAP one
 * (`credential-crypto.ts#facetOAuthAudience`'s own doc comment), and nothing
 * on this branch's ancestry refreshes it — `mail-accounts/grant-refresh.ts`'s
 * own doc comment already names this as "a later ticket's own seam" and
 * `microsoftProviderAdapter.refresh()` only ever requests `MICROSOFT_SCOPES`
 * (the Mail Facet's own scope). Building that per-audience refresh here would
 * mean touching `microsoft-adapter.ts`/`grant-refresh.ts` for a mechanism
 * with its own subtle correctness questions (whether refreshing the Graph
 * audience rotates the one shared refresh token out from under a concurrent
 * IMAP refresh) — real, separate work this ticket's closing comment defers
 * rather than guesses at. Concretely: the Calendar Facet's Graph token mints
 * once, at consent, and simply goes stale — every mirror/outbox tick after
 * that reads whatever is sealed, unrefreshed, until a live account confirms
 * how that should actually work. Once it expires, Graph itself answers `401`
 * mid-flight, which every call site here already treats as Needs Reauth
 * (`client.ts#classifyWriteStatus`) — so the failure mode is "the mirror goes
 * quiet, not a crash", never silent data loss.
 */
export function createGraphCalendarCredentialProvider(
  db: Db,
  credentialKey: Buffer,
): GraphCalendarCredentialProvider {
  return {
    async getAccessToken(connectedAccountId: string): Promise<string | null> {
      const account = await getConnectedAccountById(db, connectedAccountId);
      if (account?.provider !== "microsoft") return null;

      const facet = await getConnectedAccountFacet(db, connectedAccountId, "calendar");
      if (facet?.status !== "active") return null;

      const credential: ConnectedAccountCredential = account.credential;
      if (credential.kind !== "oauth") return null;

      const audience = facetOAuthAudience("microsoft", "calendar");
      if (!credential.accessTokens[audience]) return null;

      try {
        return unsealOAuthAccessToken(credential, audience, connectedAccountId, credentialKey);
      } catch {
        return null;
      }
    },
  };
}
