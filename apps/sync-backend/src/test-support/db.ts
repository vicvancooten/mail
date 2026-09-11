import { fileURLToPath } from "node:url";
import { createDb, type Db } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import {
  addressBooks,
  appliedMutations,
  attachmentBlobs,
  bulkTriageBatches,
  calendarMirrorSyncState,
  calendars,
  calendarWatchChannels,
  claimTokens,
  composeSaveLedger,
  compositions,
  connectedAccountFacets,
  connectedAccounts,
  contactCarddavWriteBacks,
  contactLinks,
  contactPhotoBlobs,
  contacts,
  correspondents,
  events,
  folders,
  gatekeeperVerdicts,
  gmailLabels,
  imipReplies,
  imipRequests,
  invitations,
  labels,
  loginChallenges,
  mailAccounts,
  messageSearch,
  messages,
  microsoftContactWrites,
  notes,
  notifierOutbox,
  oauthSignInAttempts,
  passkeyCredentials,
  protocolWrites,
  providerFacetHealth,
  providerRegistrations,
  pushSubscriptions,
  reminderDue,
  repairs,
  rollbacks,
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
  // #284: no FK to anything — a bare completion record, cleared the same
  // reason `vapidKeys` above is.
  await db.delete(repairs);
  // No FK to `users`/`mailAccounts` — nothing else cascades these away.
  await db.delete(calendarWatchChannels);
  await db.delete(calendarMirrorSyncState);
  await db.delete(reminderDue);
  await db.delete(imipReplies);
  await db.delete(imipRequests);
  await db.delete(events);
  await db.delete(calendars);
  await db.delete(rollbacks);
  await db.delete(notes);
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
  await db.delete(invitations);
  await db.delete(messages);
  await db.delete(threadMessageIds);
  await db.delete(syncTombstones);
  await db.delete(correspondents);
  await db.delete(labels);
  await db.delete(gmailLabels);
  await db.delete(threads);
  await db.delete(folders);
  await db.delete(sessions);
  await db.delete(claimTokens);
  await db.delete(loginChallenges);
  await db.delete(webauthnChallenges);
  await db.delete(totpCredentials);
  await db.delete(passkeyCredentials);
  await db.delete(oauthSignInAttempts);
  await db.delete(mailAccounts);
  // #222: `contact_links` names Contacts through a `text[]` with no foreign
  // key (`db/schema.ts`), so nothing cascades it — cleared ahead of the
  // Contacts it names, the same reason `contactPhotoBlobs` below needs its
  // own delete.
  await db.delete(contactLinks);
  // #214: missing from this sweep since #209 first added these tables —
  // both cascade from `connected_accounts`/`users` but need their own
  // `delete` before those to keep a test run idempotent without relying on
  // cascades this function doesn't otherwise exercise.
  await db.delete(microsoftContactWrites); // #227 — cascades from `contacts`/`address_books`, deleted first for the same reason.
  await db.delete(contactCarddavWriteBacks); // #226 — same reason, cascades from `contacts`/`address_books`.
  await db.delete(contacts);
  await db.delete(addressBooks);
  // #213: content-addressed, no FK to `contacts` at all (`db/schema.ts`'s
  // own doc comment) — never cascades from anything, so this delete is the
  // only thing that ever clears it between tests.
  await db.delete(contactPhotoBlobs);
  await db.delete(connectedAccountFacets);
  await db.delete(connectedAccounts);
  await db.delete(providerRegistrations);
  await db.delete(providerFacetHealth);
  await db.delete(users);
}
