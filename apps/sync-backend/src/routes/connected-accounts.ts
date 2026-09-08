import { randomUUID } from "node:crypto";
import {
  addCalDavFacetRequestSchema,
  calDavFacetResponseSchema,
  connectedAccountFacetRemovalPreviewSchema,
  connectedAccountResponseSchema,
  createCalDavAccountRequestSchema,
  reauthConnectedAccountRequestSchema,
  removeConnectedAccountFacetResponseSchema,
} from "@mail/shared";
import type { FastifyInstance } from "fastify";
import {
  deriveCredentialKey,
  sealPasswordCredential,
  unsealPasswordCredential,
  unsealSecret,
} from "../connected-accounts/credential-crypto.js";
import {
  type DavDiscoveryResult,
  discoverDavAccount,
} from "../connected-accounts/dav-discovery.js";
import {
  getConnectedAccountFacetRemovalPreview,
  removeConnectedAccountFacet,
} from "../connected-accounts/removal.js";
import {
  type ConnectedAccountRow,
  connectedAccountHasFacet,
  getConnectedAccountForUser,
  getConnectedAccountForUserByIdentity,
  insertCalDavAccount,
  insertCalDavFacet,
  listConnectedAccountFacets,
  reactivateConnectedAccount,
} from "../connected-accounts/store.js";
import type { Db } from "../db/client.js";
import type { ProviderAdapters } from "../mail-accounts/provider-adapter.js";
import { noopSyncManager, type SyncManager } from "../sync/manager.js";
import { parseFacetKindParam } from "./route-params.js";

export interface ConnectedAccountRoutesOptions {
  db: Db;
  /** `env.MAIL_CREDENTIAL_KEY` — kept as the raw string, hashed to a key per seal/unseal call, same as `mail-accounts.ts`. Also needed to unseal a Google Grant's refresh token for the best-effort revoke call below. */
  mailCredentialKey: string;
  /** Overridable in tests: exercising every discovery outcome against a real CalDAV server isn't something any test wants to set up. */
  discoverDav?: typeof discoverDavAccount;
  providerAdapters?: ProviderAdapters;
  /** Stops the removed Mail Facet's resident sync loop (#35) once its row is gone. Defaults to a no-op — see `app.ts`. */
  syncManager?: SyncManager;
}

/**
 * CalDAV/CardDAV's own add-a-Facet doors (#203): `POST /connected-accounts/caldav`
 * for a brand-new identity (server/email address, username, app password) and
 * `POST /connected-accounts/:id/caldav-facets` for turning on a second Facet
 * on one that already exists — the split the ticket's own acceptance
 * criteria draws ("never asks for the password again"). Both are
 * verify-before-save the same way `mail-accounts.ts`'s `POST /mail-accounts`
 * is: discovery has to succeed before either route writes a row.
 *
 * Neither route starts a sync loop (`syncManager`, `mail-accounts.ts`'s own
 * dependency) — a Calendar/Contacts Facet has nothing to sync yet (#198's own
 * scope note: mirroring is the Calendar/Contacts epics' business, not this
 * ticket's).
 *
 * Turning off a Facet, removing a Connected Account (#206, ADR-0029) lives
 * here too: two routes, the same read-then-write shape `instance.ts`'s
 * Provider Registration removal already uses ("first tells the Owner how
 * many Mail Accounts will stop syncing") — a read-only preview a
 * confirmation dialog opens with, and the confirm itself.
 */
export async function connectedAccountRoutes(
  app: FastifyInstance,
  {
    db,
    mailCredentialKey,
    discoverDav = discoverDavAccount,
    providerAdapters = {},
    syncManager = noopSyncManager,
  }: ConnectedAccountRoutesOptions,
) {
  const key = deriveCredentialKey(mailCredentialKey);

  app.post(
    "/connected-accounts/caldav",
    { preHandler: app.requireAuth },
    async (request, reply) => {
      const body = createCalDavAccountRequestSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: "invalid_request", issues: body.error.issues });
      }
      const { serverAddress, username, password, facet } = body.data;
      const userId = requireUser(request).id;

      // Unique per User, Provider and identity (ADR-0022) — the same
      // duplicate check `oauth-signin.ts` runs before minting a fresh account.
      // Re-adding this username belongs to the attach route below, which never
      // re-asks for the password; this route always mints a fresh identity.
      const existing = await getConnectedAccountForUserByIdentity(
        db,
        userId,
        "caldav_carddav",
        username,
      );
      if (existing) {
        return reply.code(409).send({ error: "duplicate_identity" });
      }

      const result = await discoverDav({ serverAddress, username, password, facet });
      if (!result.ok) {
        return reply.code(discoveryStatusCode(result)).send({ error: result.reason });
      }

      const id = randomUUID();
      await insertCalDavAccount(db, {
        id,
        userId,
        serverAddress,
        username,
        credential: sealPasswordCredential(password, id, key),
        facet,
        discovery: result,
      });

      return reply.code(201).send(toResponse(id, facet, result));
    },
  );

  app.post(
    "/connected-accounts/:id/caldav-facets",
    { preHandler: app.requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = addCalDavFacetRequestSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: "invalid_request", issues: body.error.issues });
      }
      const { facet } = body.data;
      const userId = requireUser(request).id;

      const account = await getConnectedAccountForUser(db, userId, id);
      if (!account || account.provider !== "caldav_carddav") {
        return reply.code(404).send({ error: "not_found" });
      }
      const { serverAddress, davUsername } = requireCalDavIdentity(account, id);
      if (await connectedAccountHasFacet(db, id, facet)) {
        return reply.code(409).send({ error: "facet_already_exists" });
      }

      // "Turning on the second Facet ... never asks for the password again"
      // (#203's own acceptance criterion): the stored credential, unsealed,
      // is what discovery runs against — nothing from the request body.
      const password = unsealPasswordCredential(account.credential, account.id, key);
      const result = await discoverDav({
        serverAddress,
        username: davUsername,
        password,
        facet,
      });
      if (!result.ok) {
        return reply.code(discoveryStatusCode(result)).send({ error: result.reason });
      }

      await insertCalDavFacet(db, id, facet, result);
      return reply.send(toResponse(id, facet, result));
    },
  );

  // The CalDAV/CardDAV half of #204's Fix flow: account-level only
  // (ADR-0022: "a CalDAV/CardDAV 401 is always the account level, since both
  // Facets share the password"), so this asks for the app password alone —
  // never a username, which is this account's own unchanging identity — and
  // verifies it by discovery against whichever Facet the account already
  // carries before resuming the whole account. Mirrors `mail-accounts.ts`'s
  // `POST /mail-accounts/:id/reauth`: verify-before-save, then
  // `reactivateConnectedAccount`.
  app.post(
    "/connected-accounts/:id/reauth",
    { preHandler: app.requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const userId = requireUser(request).id;
      const account = await getConnectedAccountForUser(db, userId, id);
      if (!account || account.provider !== "caldav_carddav") {
        return reply.code(404).send({ error: "not_found" });
      }
      const { serverAddress, davUsername } = requireCalDavIdentity(account, id);

      const body = reauthConnectedAccountRequestSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: "invalid_request", issues: body.error.issues });
      }
      const { password } = body.data;

      const facets = await listConnectedAccountFacets(db, id);
      const anyFacet = facets[0];
      if (!anyFacet) {
        throw new Error(`Connected Account ${id} has no Facets to verify a reauth against.`);
      }
      const result = await discoverDav({
        serverAddress,
        username: davUsername,
        password,
        facet: anyFacet.kind as "calendar" | "contacts",
      });
      if (!result.ok) {
        return reply.code(discoveryStatusCode(result)).send({ error: result.reason });
      }

      await reactivateConnectedAccount(
        db,
        id,
        "caldav_carddav",
        sealPasswordCredential(password, id, key),
      );

      const updated = await getConnectedAccountForUser(db, userId, id);
      if (!updated) {
        throw new Error("Connected Account disappeared between reauth update and re-read.");
      }
      return connectedAccountResponseSchema.parse({
        connectedAccount: {
          id: updated.id,
          userId: updated.userId,
          provider: updated.provider,
          identity: updated.identity,
          status: updated.status,
          facets: facets.map((facet) => ({ kind: facet.kind, status: "active" as const })),
          createdAt: updated.createdAt.toISOString(),
        },
      });
    },
  );

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

/**
 * Every `caldav_carddav` row carries both `serverAddress` and `davUsername`
 * (`insertCalDavAccount` never writes one without them) — a mismatch means
 * the row itself is corrupt, not that the request was bad, so this throws
 * rather than returning an error response. Shared by the `caldav-facets`
 * and `reauth` routes above, which both need the pair narrowed past `null`
 * before running discovery against it.
 */
function requireCalDavIdentity(
  account: ConnectedAccountRow,
  connectedAccountId: string,
): { serverAddress: string; davUsername: string } {
  if (account.serverAddress === null || account.davUsername === null) {
    throw new Error(
      `Connected Account ${connectedAccountId} is caldav_carddav but missing serverAddress/davUsername.`,
    );
  }
  return { serverAddress: account.serverAddress, davUsername: account.davUsername };
}

/** `credentials_rejected`/`no_home_set` are definitive negative answers from a real server (422, like `mail-accounts.ts`'s own `credentials_rejected`); `unreachable` is transient (502). */
function discoveryStatusCode(result: Extract<DavDiscoveryResult, { ok: false }>): number {
  return result.reason === "unreachable" ? 502 : 422;
}

function toResponse(
  connectedAccountId: string,
  facet: "calendar" | "contacts",
  result: Extract<DavDiscoveryResult, { ok: true }>,
) {
  return calDavFacetResponseSchema.parse({
    connectedAccountId,
    facet,
    discovered: result.collections,
    supportsScheduling: result.supportsScheduling,
  });
}

function requireUser(request: { user: { id: string } | null }): { id: string } {
  if (!request.user) {
    throw new Error("requireAuth did not populate request.user");
  }
  return request.user;
}
