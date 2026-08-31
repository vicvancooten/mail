import { randomUUID } from "node:crypto";
import { authStatusResponseSchema, claimRequestSchema, loginRequestSchema } from "@mail/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { authMethods, toWireUser } from "../auth/auth-method.js";
import { consumeClaimToken, isClaimed } from "../auth/claim.js";
import { clearSessionCookie, SESSION_COOKIE, setSessionCookie } from "../auth/cookies.js";
import { hashPassword } from "../auth/password.js";
import { createSession, revokeSession } from "../auth/sessions.js";
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

    const method = authMethods.password;
    if (!method) {
      throw new Error("Password AuthMethod is not registered.");
    }
    const user = await method.authenticate(db, body.data);
    if (!user) {
      return reply.code(401).send({ error: "invalid_credentials" });
    }

    const { token, expiresAt } = await createSession(db, user.id);
    setSessionCookie(reply, publicUrl, token, expiresAt);
    return reply.send({ user: toWireUser(user) });
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
