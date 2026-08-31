import { fileURLToPath } from "node:url";
import { createDb, type Db } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import {
  claimTokens,
  loginChallenges,
  passkeyCredentials,
  sessions,
  totpCredentials,
  users,
  webauthnChallenges,
} from "../db/schema.js";

/**
 * Matches `.env.example` / `compose.dev.yaml` — tests run against the same
 * dev Postgres the rest of the local workflow uses (`docs/dev-setup.md`),
 * not a mock. Override with `DATABASE_URL` for a different target.
 */
export const TEST_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://mail:mail@localhost:5432/mail";

let migrated: Promise<void> | undefined;

/**
 * Runs migrations at most once per test process, then hands back a live
 * `Db` plus its underlying `postgres` client — close the latter in
 * `afterAll` or `vitest run` hangs waiting for the socket.
 */
export async function createTestDb(): Promise<ReturnType<typeof createDb>> {
  migrated ??= runMigrations(
    TEST_DATABASE_URL,
    fileURLToPath(new URL("../db/migrations", import.meta.url)),
  );
  await migrated;

  return createDb({ DATABASE_URL: TEST_DATABASE_URL });
}

/** Clears every auth table. Call between tests so cases don't bleed into each other. */
export async function resetTestDb(db: Db): Promise<void> {
  await db.delete(sessions);
  await db.delete(claimTokens);
  await db.delete(loginChallenges);
  await db.delete(webauthnChallenges);
  await db.delete(totpCredentials);
  await db.delete(passkeyCredentials);
  await db.delete(users);
}
