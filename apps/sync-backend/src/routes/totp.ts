import {
  totpConfirmRequestSchema,
  totpDisableRequestSchema,
  totpEnrollResponseSchema,
  totpStatusResponseSchema,
} from "@mail/shared";
import type { FastifyInstance } from "fastify";
import { generateTotpSecret, totpAuthUri, verifyTotpCode } from "../auth/totp.js";
import {
  confirmTotpEnrollment,
  deleteTotpCredential,
  getConfirmedTotpCredential,
  getTotpCredential,
  startTotpEnrollment,
} from "../auth/totp-credentials.js";
import type { Db } from "../db/client.js";

export interface TotpRoutesOptions {
  db: Db;
}

/**
 * TOTP enrollment/disable management (#32) — the second-factor login
 * challenge itself lives on `/auth/login` and `/auth/login/totp` in
 * `routes/auth.ts`, alongside the other session-issuing endpoints.
 */
export async function totpRoutes(app: FastifyInstance, { db }: TotpRoutesOptions) {
  app.get("/auth/totp/status", { preHandler: app.requireAuth }, async (request) => {
    const user = request.user;
    if (!user) {
      throw new Error("requireAuth did not populate request.user");
    }
    const totp = await getConfirmedTotpCredential(db, user.id);
    return totpStatusResponseSchema.parse({ enabled: totp !== null });
  });

  // Starts (or restarts) enrollment: generates a fresh secret, holds it
  // unconfirmed until /auth/totp/confirm proves it was saved correctly.
  app.post("/auth/totp/enroll", { preHandler: app.requireAuth }, async (request, reply) => {
    const user = request.user;
    if (!user) {
      throw new Error("requireAuth did not populate request.user");
    }

    const existing = await getConfirmedTotpCredential(db, user.id);
    if (existing) {
      return reply.code(409).send({ error: "totp_already_enabled" });
    }

    const secret = generateTotpSecret();
    await startTotpEnrollment(db, user.id, secret);

    return totpEnrollResponseSchema.parse({
      secret,
      otpauthUrl: totpAuthUri(user.username, secret),
    });
  });

  app.post("/auth/totp/confirm", { preHandler: app.requireAuth }, async (request, reply) => {
    const user = request.user;
    if (!user) {
      throw new Error("requireAuth did not populate request.user");
    }

    const body = totpConfirmRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request", issues: body.error.issues });
    }

    const pending = await getTotpCredential(db, user.id);
    if (!pending || pending.confirmed) {
      return reply.code(409).send({ error: "no_pending_enrollment" });
    }

    const result = await verifyTotpCode(pending.secret, body.data.code);
    if (!result.valid) {
      return reply.code(401).send({ error: "invalid_code" });
    }

    await confirmTotpEnrollment(db, user.id, result.timeStep);
    return { enabled: true };
  });

  // Requires the current code, not just a session, so a hijacked session
  // alone can't strip 2FA off the account.
  app.post("/auth/totp/disable", { preHandler: app.requireAuth }, async (request, reply) => {
    const user = request.user;
    if (!user) {
      throw new Error("requireAuth did not populate request.user");
    }

    const body = totpDisableRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request", issues: body.error.issues });
    }

    const totp = await getConfirmedTotpCredential(db, user.id);
    if (!totp) {
      return reply.code(409).send({ error: "totp_not_enabled" });
    }

    const result = await verifyTotpCode(
      totp.secret,
      body.data.code,
      totp.lastUsedTimeStep ?? undefined,
    );
    if (!result.valid) {
      return reply.code(401).send({ error: "invalid_code" });
    }

    await deleteTotpCredential(db, user.id);
    return reply.code(204).send();
  });
}
