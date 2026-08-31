import {
  loginResponseSchema,
  type Passkey,
  passkeyListResponseSchema,
  passkeyLoginVerifyRequestSchema,
  passkeyRegisterVerifyRequestSchema,
} from "@mail/shared";
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { verifyRegistrationResponse } from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import type { FastifyInstance } from "fastify";
import { authMethods, toWireUser } from "../auth/auth-method.js";
import { setSessionCookie } from "../auth/cookies.js";
import { completeLogin } from "../auth/login-flow.js";
import {
  deletePasskeyForUser,
  insertPasskey,
  listPasskeysForUser,
  type PasskeyCredentialRow,
} from "../auth/passkey-credentials.js";
import {
  buildAuthenticationOptions,
  buildRegistrationOptions,
  originFromPublicUrl,
  rpIdFromPublicUrl,
} from "../auth/webauthn.js";
import {
  clearChallengeCookie,
  popChallenge,
  readChallengeCookie,
  setChallengeCookie,
  stashChallenge,
} from "../auth/webauthn-challenges.js";
import type { Db } from "../db/client.js";

export interface PasskeyRoutesOptions {
  db: Db;
  publicUrl: string;
}

function toWirePasskey(row: PasskeyCredentialRow): Passkey {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
  };
}

/**
 * Passkey enrollment (authenticated) and passkey login (no session yet) —
 * beside `passwordAuthMethod` and `authMethods.passkey` in
 * `auth/auth-method.ts`, which is where the actual signature verification
 * lives. Registration is a management action, not a login, so it doesn't
 * touch `authMethods` at all; login calls `authMethods.passkey.authenticate`
 * the same way `/auth/login` calls `authMethods.password.authenticate`.
 */
export async function passkeyRoutes(app: FastifyInstance, { db, publicUrl }: PasskeyRoutesOptions) {
  app.get("/auth/passkeys", { preHandler: app.requireAuth }, async (request) => {
    const user = request.user;
    if (!user) {
      throw new Error("requireAuth did not populate request.user");
    }
    const rows = await listPasskeysForUser(db, user.id);
    return passkeyListResponseSchema.parse({ passkeys: rows.map(toWirePasskey) });
  });

  app.delete("/auth/passkeys/:id", { preHandler: app.requireAuth }, async (request, reply) => {
    const user = request.user;
    if (!user) {
      throw new Error("requireAuth did not populate request.user");
    }
    const { id } = request.params as { id: string };
    const deleted = await deletePasskeyForUser(db, user.id, id);
    if (!deleted) {
      return reply.code(404).send({ error: "not_found" });
    }
    return reply.code(204).send();
  });

  app.post(
    "/auth/passkeys/register/options",
    { preHandler: app.requireAuth },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        throw new Error("requireAuth did not populate request.user");
      }

      const existing = await listPasskeysForUser(db, user.id);
      const options = await buildRegistrationOptions(
        publicUrl,
        user,
        existing.map((row) => ({
          id: row.id,
          // Round-tripped from the AuthenticatorTransportFuture[] a prior
          // registration wrote (`insertPasskey`); the column is untyped text[].
          transports: (row.transports ?? undefined) as AuthenticatorTransportFuture[] | undefined,
        })),
      );

      const token = await stashChallenge(db, options.challenge, user.id);
      setChallengeCookie(reply, publicUrl, token);
      return options;
    },
  );

  app.post(
    "/auth/passkeys/register/verify",
    { preHandler: app.requireAuth },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        throw new Error("requireAuth did not populate request.user");
      }

      const body = passkeyRegisterVerifyRequestSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: "invalid_request", issues: body.error.issues });
      }

      const token = readChallengeCookie(request);
      if (!token) {
        return reply.code(400).send({ error: "missing_challenge" });
      }
      const pending = await popChallenge(db, token);
      clearChallengeCookie(reply, publicUrl);
      if (!pending || pending.userId !== user.id) {
        return reply.code(400).send({ error: "invalid_or_expired_challenge" });
      }

      let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
      try {
        verification = await verifyRegistrationResponse({
          // The wire schema only asserts `id`; @simplewebauthn validates the
          // rest of the WebAuthn ceremony shape itself and throws on anything malformed.
          response: body.data.response as unknown as RegistrationResponseJSON,
          expectedChallenge: pending.challenge,
          expectedOrigin: originFromPublicUrl(publicUrl),
          expectedRPID: rpIdFromPublicUrl(publicUrl),
        });
      } catch {
        return reply.code(400).send({ error: "verification_failed" });
      }
      if (!verification.verified) {
        return reply.code(400).send({ error: "verification_failed" });
      }

      const { credential, credentialDeviceType, credentialBackedUp } =
        verification.registrationInfo;
      await insertPasskey(db, {
        id: credential.id,
        userId: user.id,
        publicKey: isoBase64URL.fromBuffer(credential.publicKey),
        counter: credential.counter,
        deviceType: credentialDeviceType,
        backedUp: credentialBackedUp,
        transports: credential.transports ?? null,
      });

      return reply.code(201).send();
    },
  );

  app.post("/auth/passkeys/login/options", async (_request, reply) => {
    const options = await buildAuthenticationOptions(publicUrl);
    const token = await stashChallenge(db, options.challenge, null);
    setChallengeCookie(reply, publicUrl, token);
    return options;
  });

  app.post("/auth/passkeys/login/verify", async (request, reply) => {
    const body = passkeyLoginVerifyRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request", issues: body.error.issues });
    }

    const token = readChallengeCookie(request);
    if (!token) {
      return reply.code(401).send({ error: "missing_challenge" });
    }
    const pending = await popChallenge(db, token);
    clearChallengeCookie(reply, publicUrl);
    if (!pending) {
      return reply.code(401).send({ error: "invalid_or_expired_challenge" });
    }

    const user = await authMethods.passkey.authenticate(db, {
      // Same pass-through-then-let-the-library-validate story as registration, above.
      response: body.data.response as unknown as AuthenticationResponseJSON,
      expectedChallenge: pending.challenge,
      expectedOrigin: originFromPublicUrl(publicUrl),
      expectedRPID: rpIdFromPublicUrl(publicUrl),
    });
    if (!user) {
      return reply.code(401).send({ error: "invalid_credentials" });
    }

    const result = await completeLogin(db, user);
    if (result.kind === "totp_required") {
      return loginResponseSchema.parse({
        totpRequired: true,
        challengeToken: result.challengeToken,
      });
    }
    setSessionCookie(reply, publicUrl, result.token, result.expiresAt);
    return loginResponseSchema.parse({ user: toWireUser(user) });
  });
}
