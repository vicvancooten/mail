import { buildApp } from "./app.js";
import { ensureClaimToken } from "./auth/claim.js";
import { createDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { loadEnv } from "./env.js";
import { createSyncManager, startAllMailAccountSyncs } from "./sync/manager.js";
import { startProtocolWriteLoop } from "./sync/protocol-write-loop.js";

const env = loadEnv();

// Migrations run in the app's own boot path and fail closed (ADR-0009): the
// process does not start serving traffic if a migration fails.
await runMigrations(env.DATABASE_URL, new URL("./db/migrations", import.meta.url).pathname);

const { db } = createDb(env);

const [host, portStr] = env.MAIL_BIND.split(":");
const port = Number(portStr);
if (!host || Number.isNaN(port)) {
  throw new Error(`MAIL_BIND must be "host:port", got "${env.MAIL_BIND}"`);
}

// One resident sync loop per Mail Account (#35) — the real implementation
// `app.ts` otherwise defaults to a no-op for, so no test opens an
// unrequested IMAP connection just by calling `buildApp`.
const syncManager = createSyncManager(db, { mailCredentialKey: env.MAIL_CREDENTIAL_KEY });

const app = buildApp({
  db,
  publicUrl: env.PUBLIC_URL,
  mailCredentialKey: env.MAIL_CREDENTIAL_KEY,
  syncManager,
});

// One-time first-run claim token, printed to the logs (ADR-0009 deployment).
// A no-op once an Owner already exists.
await ensureClaimToken(db, app.log, env.PUBLIC_URL);

await startAllMailAccountSyncs(db, syncManager);

// The `\Seen`/`\Flagged`/archive/trash write-through outbox (#42,
// ADR-0006): a short-lived connection per account with anything queued,
// independent of the resident IDLE sessions above.
const protocolWriteLoop = startProtocolWriteLoop(db, {
  mailCredentialKey: env.MAIL_CREDENTIAL_KEY,
  logger: app.log,
});

// `docs/dev-setup.md`'s production image runs under `tini` "for clean
// SIGTERM for IMAP IDLE connections" — this is the handler that promise
// describes: stop every resident session (a polite IMAP LOGOUT, then close)
// before the process actually exits, rather than yanking the sockets shut.
process.on("SIGTERM", () => {
  void Promise.all([syncManager.stopAll(), protocolWriteLoop.stop()])
    .catch((err) => app.log.error({ err }, "error while stopping sync sessions"))
    .finally(() => process.exit(0));
});

await app.listen({ host, port });
