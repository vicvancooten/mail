import { randomUUID } from "node:crypto";
import {
  addCalDavFacetRequestSchema,
  calDavFacetResponseSchema,
  createCalDavAccountRequestSchema,
} from "@mail/shared";
import type { FastifyInstance } from "fastify";
import {
  deriveCredentialKey,
  sealPasswordCredential,
  unsealPasswordCredential,
} from "../connected-accounts/credential-crypto.js";
import {
  type DavDiscoveryResult,
  discoverDavAccount,
} from "../connected-accounts/dav-discovery.js";
import {
  connectedAccountHasFacet,
  getConnectedAccountForUser,
  getConnectedAccountForUserByIdentity,
  insertCalDavAccount,
  insertCalDavFacet,
} from "../connected-accounts/store.js";
import type { Db } from "../db/client.js";

export interface ConnectedAccountRoutesOptions {
  db: Db;
  /** `env.MAIL_CREDENTIAL_KEY` — kept as the raw string, hashed to a key per seal/unseal call, same as `mail-accounts.ts`. */
  mailCredentialKey: string;
  /** Overridable in tests: exercising every discovery outcome against a real CalDAV server isn't something any test wants to set up. */
  discoverDav?: typeof discoverDavAccount;
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
 */
export async function connectedAccountRoutes(
  app: FastifyInstance,
  { db, mailCredentialKey, discoverDav = discoverDavAccount }: ConnectedAccountRoutesOptions,
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
      // Invariant, not user input: every `caldav_carddav` row carries both
      // (`insertCalDavAccount` never writes one without them) — a mismatch
      // means the row itself is corrupt, not that the request was bad.
      if (account.serverAddress === null || account.daveUsername === null) {
        throw new Error(
          `Connected Account ${id} is caldav_carddav but missing serverAddress/daveUsername.`,
        );
      }
      if (await connectedAccountHasFacet(db, id, facet)) {
        return reply.code(409).send({ error: "facet_already_exists" });
      }

      // "Turning on the second Facet ... never asks for the password again"
      // (#203's own acceptance criterion): the stored credential, unsealed,
      // is what discovery runs against — nothing from the request body.
      const password = unsealPasswordCredential(account.credential, account.id, key);
      const result = await discoverDav({
        serverAddress: account.serverAddress,
        username: account.daveUsername,
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
