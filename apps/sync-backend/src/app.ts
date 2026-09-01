import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import authPlugin from "./auth/plugin.js";
import type { Db } from "./db/client.js";
import type { discoverMailAccount } from "./mail-accounts/autodiscover.js";
import type { verifyMailAccountCredentials } from "./mail-accounts/verify.js";
import { attachmentRoutes } from "./routes/attachments.js";
import { authRoutes } from "./routes/auth.js";
import { composeConfigRoutes } from "./routes/compose-config.js";
import { correspondentRoutes } from "./routes/correspondents.js";
import { healthRoutes } from "./routes/health.js";
import { mailAccountRoutes } from "./routes/mail-accounts.js";
import { messageRoutes } from "./routes/messages.js";
import { passkeyRoutes } from "./routes/passkeys.js";
import { searchRoutes } from "./routes/search.js";
import { sendSettingsRoutes } from "./routes/send-settings.js";
import { syncRoutes } from "./routes/sync.js";
import { totpRoutes } from "./routes/totp.js";
import { noopSyncManager, type SyncManager } from "./sync/manager.js";

/** ADR-0012's default: 25MB of encoded message size, matching `env.ts`'s own default. */
const DEFAULT_ATTACHMENT_BUDGET_BYTES = 25 * 1024 * 1024;

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
  /**
   * Starts/restarts a Mail Account's resident sync loop (#35) on create and
   * reauth. Defaults to a no-op: opening a real IMAP connection is not
   * something any test asks for just by calling `buildApp`, and `main.ts` is
   * the only real caller that wires in `createSyncManager`'s live one.
   */
  syncManager?: SyncManager;
  /** ADR-0012's instance-level attachment budget, in encoded bytes. Defaults for tests that never touch #48. */
  attachmentBudgetBytes?: number;
}

export function buildApp({
  db,
  publicUrl,
  mailCredentialKey,
  mailAccountVerify,
  mailAccountDiscover,
  syncManager = noopSyncManager,
  attachmentBudgetBytes = DEFAULT_ATTACHMENT_BUDGET_BYTES,
}: BuildAppOptions) {
  const app = Fastify({
    // Vitest sets NODE_ENV=test; quiet request logging there so the growing
    // pile of integration tests doesn't drown its own assertions in output.
    logger: process.env.NODE_ENV !== "test",
    trustProxy: true, // operator brings their own reverse proxy (ADR-0009)
  });

  // An attachment upload (`routes/attachments.ts`) is raw bytes of whatever
  // mime type the file is, not JSON — the one route on this app that isn't.
  // Fastify's built-in JSON/text parsers still win on an exact
  // Content-Type match, so this only ever catches what nothing else claims.
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_request, payload, done) => {
    done(null, payload);
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
    syncManager,
  });
  app.register(syncRoutes, { db });
  app.register(correspondentRoutes, { db });
  app.register(searchRoutes, { db });
  app.register(sendSettingsRoutes, { db });
  app.register(messageRoutes, { db, mailCredentialKey });
  app.register(composeConfigRoutes, { attachmentBudgetBytes });
  app.register(attachmentRoutes, { db, attachmentBudgetBytes });

  if (existsSync(publicDir)) {
    app.register(fastifyStatic, { root: publicDir });
  }

  return app;
}
