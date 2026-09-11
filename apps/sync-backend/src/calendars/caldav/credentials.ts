import {
  type ConnectedAccountCredential,
  unsealPasswordCredential,
} from "../../connected-accounts/credential-crypto.js";
import {
  getConnectedAccountById,
  getConnectedAccountFacet,
} from "../../connected-accounts/store.js";
import type { Db } from "../../db/client.js";
import type { CaldavAuth } from "./client.js";

/**
 * The real CalDAV credential provider (#247) — `google/credentials.ts`'s own
 * shape, reading Basic auth (username, the app password `connected_accounts
 * .password`-kind credential) rather than an OAuth access token: CalDAV/
 * CardDAV never mints one (ADR-0022, `dav-discovery.ts`'s own auth header).
 * `null` for anything but an active CalDAV/CardDAV Calendar Facet — the
 * mirror/outbox loops simply skip a row this returns `null` for, the same
 * "holds indefinitely, no state of its own" Needs Reauth shape every other
 * provider's credential provider already gives.
 */
export interface CaldavCredentialProvider {
  getAuth(connectedAccountId: string): Promise<CaldavAuth | null>;
}

export function createCaldavCredentialProvider(
  db: Db,
  credentialKey: Buffer,
): CaldavCredentialProvider {
  return {
    async getAuth(connectedAccountId: string): Promise<CaldavAuth | null> {
      const account = await getConnectedAccountById(db, connectedAccountId);
      if (account?.provider !== "caldav_carddav") return null;
      if (!account.davUsername) return null;

      const facet = await getConnectedAccountFacet(db, connectedAccountId, "calendar");
      if (facet?.status !== "active") return null;

      const credential: ConnectedAccountCredential = account.credential;
      if (credential.kind !== "password") return null;

      try {
        const password = unsealPasswordCredential(credential, connectedAccountId, credentialKey);
        return { username: account.davUsername, password };
      } catch {
        return null;
      }
    },
  };
}
