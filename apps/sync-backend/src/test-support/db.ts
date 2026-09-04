import { fileURLToPath } from "node:url";
import { createDb, type Db } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import {
  appliedMutations,
  attachmentBlobs,
  bulkTriageBatches,
  claimTokens,
  composeSaveLedger,
  compositions,
  correspondents,
  folders,
  gatekeeperVerdicts,
  labels,
  loginChallenges,
  mailAccounts,
  messageSearch,
  messages,
  notifierOutbox,
  passkeyCredentials,
  protocolWrites,
  pushSubscriptions,
  sessions,
  syncTombstones,
  threadMessageIds,
  threads,
  totpCredentials,
  users,
  vapidKeys,
  webauthnChallenges,
} from "../db/schema.js";

/**
 * Matches `.env.example` / `compose.dev.yaml` — tests run against the same
 * dev Postgres the rest of the local workflow uses (`docs/dev-setup.md`),
 * not a mock. Override with `DATABASE_URL` for a different target.
 */
export const TEST_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://mail:mail@localhost:5432/mail";

/** Satisfies `env.ts`'s 32-byte minimum; not a real secret, only ever used in tests. */
export const TEST_MAIL_CREDENTIAL_KEY = "test-only-mail-credential-key-not-real-32b";

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

/**
 * Clears every table. Call between tests so cases don't bleed into each
 * other. Ordered children-first: the FKs cascade, but deleting in this order
 * keeps the intent readable and survives a future FK losing its cascade.
 */
export async function resetTestDb(db: Db): Promise<void> {
  await db.delete(vapidKeys);
  await db.delete(notifierOutbox);
  await db.delete(pushSubscriptions);
  await db.delete(bulkTriageBatches);
  await db.delete(appliedMutations);
  await db.delete(composeSaveLedger);
  await db.delete(attachmentBlobs);
  await db.delete(compositions);
  await db.delete(protocolWrites);
  await db.delete(gatekeeperVerdicts);
  await db.delete(messageSearch);
  await db.delete(messages);
  await db.delete(threadMessageIds);
  await db.delete(syncTombstones);
  await db.delete(correspondents);
  await db.delete(labels);
  await db.delete(threads);
  await db.delete(folders);
  await db.delete(sessions);
  await db.delete(claimTokens);
  await db.delete(loginChallenges);
  await db.delete(webauthnChallenges);
  await db.delete(totpCredentials);
  await db.delete(passkeyCredentials);
  await db.delete(mailAccounts);
  await db.delete(users);
}
