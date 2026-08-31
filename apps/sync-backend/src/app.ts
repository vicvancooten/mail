import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import authPlugin from "./auth/plugin.js";
import type { Db } from "./db/client.js";
import { authRoutes } from "./routes/auth.js";
import { healthRoutes } from "./routes/health.js";

// Populated by the Docker build (ADR-0009: one image, Client bundle and API
// ship together so a fresh load can never skew). Absent in local dev, where
// the Client runs under its own Vite dev server instead.
const publicDir = fileURLToPath(new URL("../public", import.meta.url));

export interface BuildAppOptions {
  db: Db;
  /** Source of truth for cookie `secure`ness — see ADR-0009 deployment. */
  publicUrl: string;
}

export function buildApp({ db, publicUrl }: BuildAppOptions) {
  const app = Fastify({
    // Vitest sets NODE_ENV=test; quiet request logging there so the growing
    // pile of integration tests doesn't drown its own assertions in output.
    logger: process.env.NODE_ENV !== "test",
    trustProxy: true, // operator brings their own reverse proxy (ADR-0009)
  });

  app.register(authPlugin, { db, publicUrl });
  app.register(healthRoutes);
  app.register(authRoutes, { db, publicUrl });

  if (existsSync(publicDir)) {
    app.register(fastifyStatic, { root: publicDir });
  }

  return app;
}
