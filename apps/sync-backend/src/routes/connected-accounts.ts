import {
  connectedAccountFacetRemovalPreviewSchema,
  removeConnectedAccountFacetResponseSchema,
} from "@mail/shared";
import type { FastifyInstance } from "fastify";
import { deriveCredentialKey, unsealSecret } from "../connected-accounts/credential-crypto.js";
import {
  getConnectedAccountFacetRemovalPreview,
  removeConnectedAccountFacet,
} from "../connected-accounts/removal.js";
import type { Db } from "../db/client.js";
import type { ProviderAdapters } from "../mail-accounts/provider-adapter.js";
import { noopSyncManager, type SyncManager } from "../sync/manager.js";
import { parseFacetKindParam } from "./route-params.js";

export interface ConnectedAccountRoutesOptions {
  db: Db;
  /** `env.MAIL_CREDENTIAL_KEY` — needed to unseal a Google Grant's refresh token for the best-effort revoke call below. */
  mailCredentialKey: string;
  providerAdapters?: ProviderAdapters;
  /** Stops the removed Mail Facet's resident sync loop (#35) once its row is gone. Defaults to a no-op — see `app.ts`. */
  syncManager?: SyncManager;
}

/**
 * Turning off a Facet, removing a Connected Account (#206, ADR-0029). Two
 * routes, the same read-then-write shape `instance.ts`'s Provider
 * Registration removal already uses ("first tells the Owner how many Mail
 * Accounts will stop syncing"): a read-only preview a confirmation dialog
 * opens with, and the confirm itself.
 */
export async function connectedAccountRoutes(
  app: FastifyInstance,
  {
    db,
    mailCredentialKey,
    providerAdapters = {},
    syncManager = noopSyncManager,
  }: ConnectedAccountRoutesOptions,
) {
  const key = deriveCredentialKey(mailCredentialKey);

  app.get(
    "/connected-accounts/:id/facets/:kind/removal-preview",
    { preHandler: app.requireAuth },
    async (request, reply) => {
      const kind = parseFacetKindParam(request, reply);
      if (!kind) return reply;
      const { id } = request.params as { id: string };

      const preview = await getConnectedAccountFacetRemovalPreview(
        db,
        requireUser(request).id,
        id,
        kind,
      );
      if (!preview) return reply.code(404).send({ error: "not_found" });
      return connectedAccountFacetRemovalPreviewSchema.parse(preview);
    },
  );

  // The confirm (#206): a pending send still inside its Undo Send window
  // blocks a Mail Facet's removal (409); otherwise the row and credential go
  // synchronously and every device — this one included — learns through the
  // ConnectedAccount/MailAccount collections' own next delta (this route's
  // own doc comment on `removal.ts#removeConnectedAccountFacet`).
  app.delete(
    "/connected-accounts/:id/facets/:kind",
    { preHandler: app.requireAuth },
    async (request, reply) => {
      const kind = parseFacetKindParam(request, reply);
      if (!kind) return reply;
      const { id } = request.params as { id: string };

      const result = await removeConnectedAccountFacet(db, {
        userId: requireUser(request).id,
        connectedAccountId: id,
        kind,
      });

      if (result.status === "not_found") {
        return reply.code(404).send({ error: "not_found" });
      }
      if (result.status === "blocked_pending_send") {
        return reply
          .code(409)
          .send({ error: "pending_send", secondsRemaining: result.secondsRemaining });
      }

      // Closes the IDLE connection before anything else notices the Mail
      // Account row is gone (#35) — `sync/manager.ts#restart`'s own
      // "deleted between the reauth write and this call" comment already
      // documents that a vanished row is a tolerated race, so this runs
      // after commit rather than gating the removal on it.
      if (result.removedMailAccountId) {
        await syncManager.stop(result.removedMailAccountId);
      }

      // Best-effort Grant revocation (#206, ADR-0029): only when the whole
      // account went, and only for a Provider whose adapter implements it
      // (Google; Microsoft's own removal UX is a link to the account page
      // instead, entirely client-side). Never fails the removal, already
      // committed above.
      const revokedCredential = result.revokedCredential;
      if (revokedCredential && revokedCredential.kind === "oauth") {
        const adapter = providerAdapters[revokedCredential.provider];
        if (adapter?.revoke) {
          try {
            const refreshToken = unsealSecret(revokedCredential.refreshToken, id, key);
            await adapter.revoke(refreshToken);
          } catch {
            // Best-effort: an unreachable Provider or an already-withdrawn
            // Grant is not this route's problem to surface.
          }
        }
      }

      return removeConnectedAccountFacetResponseSchema.parse({
        accountRemoved: result.accountRemoved,
      });
    },
  );
}

function requireUser(request: { user: { id: string } | null }): { id: string } {
  if (!request.user) {
    throw new Error("requireAuth did not populate request.user");
  }
  return request.user;
}
