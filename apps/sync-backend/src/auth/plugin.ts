import cookie from "@fastify/cookie";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import type { Db } from "../db/client.js";
import type { UserRow } from "./auth-method.js";
import { SESSION_COOKIE, setSessionCookie } from "./cookies.js";
import { validateSession } from "./sessions.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Set on every request by the auth plugin's preHandler; `null` when unauthenticated. */
    user: UserRow | null;
  }
  interface FastifyInstance {
    /**
     * The session seam every authenticated route bolts onto: add as a
     * `preHandler` and read `request.user` (non-null past this point).
     */
    requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void>;
    /**
     * `requireAuth` plus a role check (#104): the Instance page's route is
     * the first thing in this repo an ordinary Member must not reach at
     * all, not just see a User-scoped slice of — CONTEXT.md's Owner is
     * "the only role that can... change instance settings".
     */
    requireOwner(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  }
}

export interface AuthPluginOptions {
  db: Db;
  publicUrl: string;
}

/**
 * Wired with `fastify-plugin` so `request.user` and `app.requireAuth` are
 * visible to every route file registered on `app`, not just siblings inside
 * this plugin's own encapsulation context — this is meant to be depended on
 * repo-wide.
 */
async function authPlugin(app: FastifyInstance, opts: AuthPluginOptions) {
  await app.register(cookie);

  app.decorateRequest("user", null);

  // Resolves the session cookie into `request.user` on every request (not
  // just ones behind `requireAuth`) so routes like GET /auth/session can
  // report "logged in as X" without duplicating the lookup.
  app.addHook("preHandler", async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) {
      return;
    }

    const result = await validateSession(opts.db, token);
    if (!result) {
      return;
    }

    request.user = result.user;
    if (result.renewed) {
      setSessionCookie(reply, opts.publicUrl, token, result.expiresAt);
    }
  });

  app.decorate("requireAuth", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      await reply.code(401).send({ error: "unauthenticated" });
    }
  });

  app.decorate("requireOwner", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      await reply.code(401).send({ error: "unauthenticated" });
      return;
    }
    if (request.user.role !== "owner") {
      await reply.code(403).send({ error: "forbidden" });
      return;
    }
  });
}

export default fp(authPlugin, { name: "auth" });
