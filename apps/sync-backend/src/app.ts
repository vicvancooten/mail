import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import authPlugin from "./auth/plugin.js";
import type { Db } from "./db/client.js";
import type { discoverMailAccount } from "./mail-accounts/autodiscover.js";
import type { verifyMailAccountCredentials } from "./mail-accounts/verify.js";
import { authRoutes } from "./routes/auth.js";
import { healthRoutes } from "./routes/health.js";
import { mailAccountRoutes } from "./routes/mail-accounts.js";
import { passkeyRoutes } from "./routes/passkeys.js";
import { totpRoutes } from "./routes/totp.js";

// Populated by the Docker build (ADR-0009: one image, Client bundle and API
// ship together so a fresh load can never skew). Absent in local dev, where
// the Client runs under its own Vite dev server instead.
const publicDir = fileURLToPath(new URL("../public", import.meta.url));

export interface BuildAppOptions {
  db: Db;
  /** Source of truth for cookie `secure`ness — see ADR-0009 deployment. */
  publicUrl: string;
  /**
   * `env.MAIL_CREDENTIAL_KEY` (ADR-0003) — the instance-held key Mail
   * Account credentials are sealed/unsealed under. Required by every real
   * caller (`main.ts` refuses to boot without it, per `env.ts`); tests that
   * never touch `/mail-accounts` can pass any 32+ char string.
   */
  mailCredentialKey: string;
  /**
   * Overridable only in tests: GreenMail (docs/dev-setup.md) accepts any
   * password over IMAP/SMTP, so exercising a rejected-credential path needs
   * a stub rather than a real server. Real callers never pass these —
   * `verifyMailAccountCredentials`/`discoverMailAccount` are the defaults.
   */
  mailAccountVerify?: typeof verifyMailAccountCredentials;
  mailAccountDiscover?: typeof discoverMailAccount;
}

export function buildApp({
  db,
  publicUrl,
  mailCredentialKey,
  mailAccountVerify,
  mailAccountDiscover,
}: BuildAppOptions) {
  const app = Fastify({
    // Vitest sets NODE_ENV=test; quiet request logging there so the growing
    // pile of integration tests doesn't drown its own assertions in output.
    logger: process.env.NODE_ENV !== "test",
    trustProxy: true, // operator brings their own reverse proxy (ADR-0009)
  });

  app.register(authPlugin, { db, publicUrl });
  app.register(healthRoutes);
  app.register(authRoutes, { db, publicUrl });
  app.register(totpRoutes, { db });
  app.register(passkeyRoutes, { db, publicUrl });
  app.register(mailAccountRoutes, {
    db,
    mailCredentialKey,
    verify: mailAccountVerify,
    discover: mailAccountDiscover,
  });

  if (existsSync(publicDir)) {
    app.register(fastifyStatic, { root: publicDir });
  }

  return app;
}
