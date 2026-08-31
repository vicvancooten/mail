import { buildApp } from "./app.js";
import { ensureClaimToken } from "./auth/claim.js";
import { createDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { loadEnv } from "./env.js";

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

const app = buildApp({ db, publicUrl: env.PUBLIC_URL, mailCredentialKey: env.MAIL_CREDENTIAL_KEY });

// One-time first-run claim token, printed to the logs (ADR-0009 deployment).
// A no-op once an Owner already exists.
await ensureClaimToken(db, app.log, env.PUBLIC_URL);

await app.listen({ host, port });
