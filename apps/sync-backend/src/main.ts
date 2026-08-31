import { buildApp } from "./app.js";
import { runMigrations } from "./db/migrate.js";
import { loadEnv } from "./env.js";

const env = loadEnv();

// Migrations run in the app's own boot path and fail closed (ADR-0009): the
// process does not start serving traffic if a migration fails.
await runMigrations(env.DATABASE_URL, new URL("./db/migrations", import.meta.url).pathname);

const [host, portStr] = env.MAIL_BIND.split(":");
const port = Number(portStr);
if (!host || Number.isNaN(port)) {
  throw new Error(`MAIL_BIND must be "host:port", got "${env.MAIL_BIND}"`);
}

const app = buildApp();
await app.listen({ host, port });
