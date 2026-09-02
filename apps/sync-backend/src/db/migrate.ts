import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { loadEnv } from "../env.js";

// Arbitrary fixed key for the session-level advisory lock guarding migrations
// (within Number.MAX_SAFE_INTEGER, cast to bigint in SQL). Any two processes
// racing to migrate the same database serialise on this; pg_advisory_unlock
// releases it (or the session ending does, on crash).
const MIGRATION_LOCK_KEY = 8_732_910_442;

/**
 * Forward-only, fail-closed migration runner (ADR-0009). Serialised by a
 * Postgres advisory lock so concurrent boots of the `app` container never
 * race the schema. Meant to run from the app's own boot path, not as a
 * separate operator step.
 */
export async function runMigrations(databaseUrl: string, migrationsFolder: string) {
  const sql = postgres(databaseUrl, { max: 1 });
  const db = drizzle(sql);

  // Blocks until the lock is acquired; no return value to check.
  await sql`select pg_advisory_lock(${MIGRATION_LOCK_KEY}::bigint)`;

  try {
    await migrate(db, { migrationsFolder });
  } finally {
    await sql`select pg_advisory_unlock(${MIGRATION_LOCK_KEY}::bigint)`;
    await sql.end();
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const env = loadEnv();
  await runMigrations(env.DATABASE_URL, "./src/db/migrations");
  console.log("Migrations complete.");
}
