import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import { isApiPath } from "@mail/shared";
import Fastify from "fastify";
import authPlugin from "./auth/plugin.js";
import type { Db } from "./db/client.js";
import type { discoverMailAccount } from "./mail-accounts/autodiscover.js";
import type { verifyMailAccountCredentials } from "./mail-accounts/verify.js";
import { disabledVapidKeyStore, type VapidKeyStore } from "./notifier/vapid-keys.js";
import { noopSyncHintBroker, type SyncHintBroker } from "./realtime/sync-hints.js";
import { attachmentRoutes } from "./routes/attachments.js";
import { authRoutes } from "./routes/auth.js";
import { bulkTriageRoutes } from "./routes/bulk-triage.js";
import { composeConfigRoutes } from "./routes/compose-config.js";
import { correspondentRoutes } from "./routes/correspondents.js";
import { eventsRoutes } from "./routes/events.js";
import { gatekeeperRoutes } from "./routes/gatekeeper.js";
import { healthRoutes } from "./routes/health.js";
import { instanceRoutes } from "./routes/instance.js";
import { mailAccountRoutes } from "./routes/mail-accounts.js";
import { messageRoutes } from "./routes/messages.js";
import { passkeyRoutes } from "./routes/passkeys.js";
import { pushRoutes } from "./routes/push.js";
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
const defaultPublicDir = fileURLToPath(new URL("../public", import.meta.url));

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
  /**
   * The instance's Web Push keypair (#53, ADR-0015 as amended): the store
   * `routes/push.ts`, `routes/instance.ts` and the Notifier all read
   * through, so there is one answer to "is Web Push configured" rather than
   * three. Defaults to a store that has no keypair and cannot generate one —
   * Web Push off, which is what every test that never touches it wants.
   */
  vapidKeys?: VapidKeyStore;
  /** `env.MAIL_VERSION` (#104) — the Instance page's image-tag fact. Defaults to `"dev"`, the same default `env.ts` gives outside Docker. */
  imageTag?: string;
  /**
   * `GET /events`'s Sync Hint fanout (#52, ADR-0015). Defaults to a no-op:
   * opening a dedicated `LISTEN` connection is not something any test asks
   * for just by calling `buildApp` — `main.ts` wires in the live one.
   */
  syncHints?: SyncHintBroker;
  /** Test seam for `GET /events`'s heartbeat cadence — see `routes/events.ts`. */
  eventsHeartbeatMs?: number;
  /**
   * Test seam for the SPA fallback (#92): the built image's `public/` sits
   * next to this file (see `publicDir` below), which no test checkout has —
   * tests that want to exercise the static/fallback routes point this at a
   * fixture directory instead. Real callers never pass it.
   */
  publicDir?: string;
}

export function buildApp({
  db,
  publicUrl,
  mailCredentialKey,
  mailAccountVerify,
  mailAccountDiscover,
  syncManager = noopSyncManager,
  attachmentBudgetBytes = DEFAULT_ATTACHMENT_BUDGET_BYTES,
  syncHints = noopSyncHintBroker,
  eventsHeartbeatMs,
  vapidKeys = disabledVapidKeyStore,
  imageTag = "dev",
  publicDir = defaultPublicDir,
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
  app.register(bulkTriageRoutes, { db });
  app.register(eventsRoutes, { hints: syncHints, heartbeatMs: eventsHeartbeatMs });
  app.register(pushRoutes, { db, readVapidPublicKey: () => vapidKeys.readPublicKey() });
  app.register(instanceRoutes, { publicUrl, vapidKeys, imageTag });
  app.register(correspondentRoutes, { db });
  app.register(searchRoutes, { db });
  app.register(sendSettingsRoutes, { db });
  app.register(gatekeeperRoutes, { db });
  app.register(messageRoutes, { db, mailCredentialKey });
  app.register(composeConfigRoutes, { attachmentBudgetBytes });
  app.register(attachmentRoutes, { db, attachmentBudgetBytes });

  if (existsSync(publicDir)) {
    app.register(fastifyStatic, { root: publicDir });

    // SPA fallback (#92): fastify-static only answers exact file matches, so
    // a cold load/reload of a client-side route (`/mail`, `/settings`,
    // `/contacts`, …) has no matching file and no matching API route either
    // — it would otherwise fall through to Fastify's bare JSON 404. Vite's
    // dev server has this fallback built in, which is why the gap only ever
    // showed up in the built image. Only html-accepting GET/HEAD navigations
    // outside the API surface (`isApiPath`, shared with the service worker's
    // own routing boundary) get the shell; a genuine miss under an API
    // prefix — `/sync/nope` — still 404s as JSON, and the service worker is
    // deliberately left alone (its network-first navigate branch already
    // falls back to the cached shell when offline; masking a 404 there would
    // hide this exact bug rather than fix it).
    app.setNotFoundHandler((request, reply) => {
      const pathname = request.url.split("?")[0] ?? request.url;
      const isHtmlNavigation =
        (request.method === "GET" || request.method === "HEAD") &&
        (request.headers.accept ?? "").includes("text/html") &&
        !isApiPath(pathname);
      if (isHtmlNavigation) {
        reply.type("text/html").sendFile("index.html");
        return;
      }
      reply.code(404).send({ error: "Not Found" });
    });
  }

  return app;
}
