import { healthResponseSchema } from "@mail/shared";
import type { FastifyInstance } from "fastify";

export async function healthRoutes(app: FastifyInstance) {
  app.get("/healthz", async () => {
    return healthResponseSchema.parse({
      status: "ok",
      version: process.env.npm_package_version ?? "0.0.0",
    });
  });
}
