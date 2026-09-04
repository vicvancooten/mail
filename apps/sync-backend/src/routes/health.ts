import { healthResponseSchema } from "@mail/shared";
import type { FastifyInstance } from "fastify";
import { getAppVersion } from "../instance-info.js";

export async function healthRoutes(app: FastifyInstance) {
  app.get("/healthz", async () => {
    return healthResponseSchema.parse({
      status: "ok",
      version: getAppVersion(),
    });
  });
}
