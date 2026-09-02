import { randomUUID } from "node:crypto";
import {
  authStatusResponseSchema,
  claimRequestSchema,
  loginRequestSchema,
  loginResponseSchema,
  loginTotpRequestSchema,
} from "@mail/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { authMethods, toWireUser } from "../auth/auth-method.js";
import { consumeClaimToken, isClaimed } from "../auth/claim.js";
import { clearSessionCookie, SESSION_COOKIE, setSessionCookie } from "../auth/cookies.js";
import { consumeLoginChallenge } from "../auth/login-challenge.js";
import { completeLogin } from "../auth/login-flow.js";
import { hashPassword } from "../auth/password.js";
import { createSession, revokeSession } from "../auth/sessions.js";
import { verifyTotpCode } from "../auth/totp.js";
import { getConfirmedTotpCredential, recordTotpUse } from "../auth/totp-credentials.js";
import type { Db } from "../db/client.js";
import { users } from "../db/schema.js";

export interface AuthRoutesOptions {
  db: Db;
  publicUrl: string;
}

export async function authRoutes(app: FastifyInstance, { db, publicUrl }: AuthRoutesOptions) {
  // Lets the Client decide first-run wizard vs. login screen before anyone
  // is authenticated.
  app.get("/auth/status", async () => {
    return authStatusResponseSchema.parse({ claimed: await isClaimed(db) });
  });

  // First-run Owner claim (ADR-0009 deployment): consumes the one-time
  // token printed to the logs, creates the Owner, and signs them in.
  app.post("/auth/claim", async (request, reply) => {
    const body = claimRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request", issues: body.error.issues });
    }

    const tokenValid = await consumeClaimToken(db, body.data.token);
    if (!tokenValid) {
      return reply.code(401).send({ error: "invalid_or_expired_token" });
    }

    const [existing] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, body.data.username))
      .limit(1);
    if (existing) {
      return reply.code(409).send({ error: "username_taken" });
    }

    const passwordHash = await hashPassword(body.data.password);
    const [user] = await db
      .insert(users)
      .values({
        id: randomUUID(),
        username: body.data.username,
        passwordHash,
        role: "owner",
      })
      .returning();
    if (!user) {
      throw new Error("Insert of claimed Owner returned no row.");
    }

    const { token, expiresAt } = await createSession(db, user.id);
    setSessionCookie(reply, publicUrl, token, expiresAt);
    return reply.code(201).send({ user: toWireUser(user) });
  });

  app.post("/auth/login", async (request, reply) => {
    const body = loginRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request", issues: body.error.issues });
    }

    const user = await authMethods.password.authenticate(db, body.data);
    if (!user) {
      return reply.code(401).send({ error: "invalid_credentials" });
    }

    // TOTP (#32) is a second factor, not a PrimaryAuthMethod: completeLogin
    // checks for a confirmed enrollment and either mints a session straight
    // away (password login untouched when TOTP isn't enrolled) or hands
    // back a challenge for /auth/login/totp to redeem.
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

  // Redeems the challenge from a /auth/login (or /auth/passkeys/login/verify)
  // response that came back with totpRequired — the second half of the 2FA
  // login, minting the session only once the current code checks out.
  app.post("/auth/login/totp", async (request, reply) => {
    const body = loginTotpRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request", issues: body.error.issues });
    }

    const userId = await consumeLoginChallenge(db, body.data.challengeToken);
    if (!userId) {
      return reply.code(401).send({ error: "invalid_or_expired_challenge" });
    }

    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    const totp = user ? await getConfirmedTotpCredential(db, user.id) : null;
    if (!user || !totp) {
      return reply.code(401).send({ error: "invalid_or_expired_challenge" });
    }

    const result = await verifyTotpCode(
      totp.secret,
      body.data.code,
      totp.lastUsedTimeStep ?? undefined,
    );
    if (!result.valid) {
      return reply.code(401).send({ error: "invalid_code" });
    }
    await recordTotpUse(db, user.id, result.timeStep);

    const { token, expiresAt } = await createSession(db, user.id);
    setSessionCookie(reply, publicUrl, token, expiresAt);
    return loginResponseSchema.parse({ user: toWireUser(user) });
  });

  app.post("/auth/logout", async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) {
      await revokeSession(db, token);
    }
    clearSessionCookie(reply, publicUrl);
    return reply.code(204).send();
  });

  // What an authenticated app shell polls on load / after a 401 to decide
  // whether to show the login prompt — session expiry never wipes Client
  // state, it just stops this from returning 200 (poc-spec.md).
  app.get("/auth/session", { preHandler: app.requireAuth }, async (request, reply) => {
    if (!request.user) {
      // Unreachable: requireAuth already replied 401 in this case. Satisfies
      // the type checker without a non-null assertion.
      return reply.code(401).send({ error: "unauthenticated" });
    }
    return { user: toWireUser(request.user) };
  });
}
