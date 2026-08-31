import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { healthRoutes } from "./routes/health.js";

// Populated by the Docker build (ADR-0009: one image, Client bundle and API
// ship together so a fresh load can never skew). Absent in local dev, where
// the Client runs under its own Vite dev server instead.
const publicDir = fileURLToPath(new URL("../public", import.meta.url));

export function buildApp() {
  const app = Fastify({
    logger: true,
    trustProxy: true, // operator brings their own reverse proxy (ADR-0009)
  });

  app.register(healthRoutes);

  if (existsSync(publicDir)) {
    app.register(fastifyStatic, { root: publicDir });
  }

  return app;
}
