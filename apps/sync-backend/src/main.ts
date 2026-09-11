import { buildApp } from "./app.js";
import { ensureClaimToken } from "./auth/claim.js";
import { createCaldavCalendarClient } from "./calendars/caldav/client.js";
import { createCaldavCredentialProvider } from "./calendars/caldav/credentials.js";
import { startCaldavCalendarMirrorLoop } from "./calendars/caldav/poll-loop.js";
import { createGoogleCalendarClient } from "./calendars/google/client.js";
import { createGoogleCalendarCredentialProvider } from "./calendars/google/credentials.js";
import { startCalendarMirrorLoop } from "./calendars/google/poll-loop.js";
import { createGraphCalendarClient } from "./calendars/graph/client.js";
import { createGraphCalendarCredentialProvider } from "./calendars/graph/credentials.js";
import { startGraphCalendarMirrorLoop } from "./calendars/graph/poll-loop.js";
import { startMaterialiseLoop } from "./calendars/materialise-loop.js";
import { startCalendarOutboxLoop } from "./calendars/outbox-loop.js";
import { startReminderLoop } from "./calendars/reminder-loop.js";
import { startRollbackPurgeLoop } from "./calendars/rollback-purge-loop.js";
import { startSeriesPurgeLoop } from "./calendars/series-purge-loop.js";
import { startSendLoop } from "./compose/send-loop.js";
import { upgradeMailAccountsToConnectedAccounts } from "./connected-accounts/boot-upgrade.js";
import { deriveCredentialKey } from "./connected-accounts/credential-crypto.js";
import { startCarddavContactsSyncLoop } from "./contacts/carddav/poll-loop.js";
import { startCarddavContactsWriteBackLoop } from "./contacts/carddav/write-back-loop.js";
import { startGoogleContactsSyncLoop } from "./contacts/google/poll-loop.js";
import { startGoogleContactsWriteBackLoop } from "./contacts/google/write-back-loop.js";
import { startMicrosoftContactsSyncLoop } from "./contacts/microsoft/poll-loop.js";
import { repairDemotedAddresses } from "./contacts/repair-demoted-addresses.js";
import { createDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { loadEnv } from "./env.js";
import { GENERATE_VAPID_KEYS_COMMAND, isSecureContext } from "./instance-info.js";
import { startReplySendLoop } from "./invitations/reply-send-loop.js";
import { startRequestSendLoop } from "./invitations/request-send-loop.js";
import type { SendPushFn } from "./notifier/deliver.js";
import { startNotifierDeliverLoop } from "./notifier/deliver-loop.js";
import { createVapidKeyStore } from "./notifier/vapid-keys.js";
import { createWebPushSender } from "./notifier/web-push-sender.js";
import { createSyncHintBroker } from "./realtime/sync-hints.js";
import { runRepairs } from "./repairs/runner.js";
import { defaultProviderAdapters } from "./routes/oauth-signin.js";
import { startContactPurgeLoop } from "./sync/contact-purge-loop.js";
import { startDraftPushLoop } from "./sync/draft-push-loop.js";
import { startGrantRefreshLoop } from "./sync/grant-refresh-loop.js";
import { createSyncManager, startAllMailAccountSyncs } from "./sync/manager.js";
import type { PollLoopHandle } from "./sync/poll-loop.js";
import { startProtocolWriteLoop } from "./sync/protocol-write-loop.js";
import { startSearchIndexRebuildLoop } from "./sync/search-index-loop.js";
import { startSnoozeWakeLoop } from "./sync/snooze-wake-loop.js";
import { startTrashPurgeLoop } from "./sync/trash-purge-loop.js";

const env = loadEnv();

// Migrations run in the app's own boot path and fail closed (ADR-0009): the
// process does not start serving traffic if a migration fails.
await runMigrations(env.DATABASE_URL, new URL("./db/migrations", import.meta.url).pathname);

const { db, sql } = createDb(env);

// Connected Accounts own the credential (#199, ADR-0022): the rest of this
// boot's own upgrade, right after the schema migration above and before
// anything else touches `mail_accounts` — see the function's own doc
// comment for why this can't be a `.sql` migration file. Fails closed
// (ADR-0009), same as `runMigrations` itself.
await upgradeMailAccountsToConnectedAccounts(db, env.MAIL_CREDENTIAL_KEY);

// The Sync Backend's one-off Data Repairs (#284): each runs at most once per
// instance, right after the schema migrations and the boot upgrade above,
// and records its own completion (`repairs/runner.ts`) so a later boot never
// re-runs one that already landed.
await runRepairs(db, [repairDemotedAddresses]);

// ADR-0015's fanout: a dedicated `LISTEN` connection (never the pooled one
// queries run on) turning `migration 0016`'s `pg_notify` into `GET
// /events` hints.
const syncHints = createSyncHintBroker(sql);

const [host, portStr] = env.MAIL_BIND.split(":");
const port = Number(portStr);
if (!host || Number.isNaN(port)) {
  throw new Error(`MAIL_BIND must be "host:port", got "${env.MAIL_BIND}"`);
}

// One resident sync loop per Mail Account (#35) — the real implementation
// `app.ts` otherwise defaults to a no-op for, so no test opens an
// unrequested IMAP connection just by calling `buildApp`. `providerAdapters`
// is what makes an oauth account's connection refresh its Grant rather than
// landing straight in Needs Reauth on a rejected token (#118) — the same
// instance `buildApp` and the refresh loop below share, so a Registration
// change never has to be wired into more than one place.
const providerAdapters = defaultProviderAdapters;
const syncManager = createSyncManager(db, {
  mailCredentialKey: env.MAIL_CREDENTIAL_KEY,
  providerAdapters,
});

// Web Push (#53, ADR-0015): optional as a pair (`env.ts` refuses to boot on
// a mismatched pair) — an instance that never ran `generate-vapid-keys`
// simply never offers it. `sendPush` is only ever reachable when a
// subscription row exists, and a subscription can only ever be created
// while `vapidPublicKey` is non-null (the Client reads it from
// `GET /push/config` before ever calling `pushManager.subscribe`) — the
// disabled branch below is therefore a safety net for an operator who
// *removes* previously-configured keys, not the ordinary path.
const vapidKeys = createVapidKeyStore(db, {
  mailCredentialKey: env.MAIL_CREDENTIAL_KEY,
  envKeypair:
    env.MAIL_VAPID_PUBLIC_KEY && env.MAIL_VAPID_PRIVATE_KEY
      ? { publicKey: env.MAIL_VAPID_PUBLIC_KEY, privateKey: env.MAIL_VAPID_PRIVATE_KEY }
      : null,
  onUnsealFailure: () =>
    app.log.warn(
      "This instance's stored Web Push keypair cannot be unsealed with the current MAIL_CREDENTIAL_KEY. Web Push stays off until the Owner generates a new keypair from Settings → Instance; every device will then have to re-enable notifications.",
    ),
});
const sendPush: SendPushFn = createWebPushSender({
  readKeypair: () => vapidKeys.read(),
  contact: env.MAIL_VAPID_CONTACT,
});

const app = buildApp({
  db,
  publicUrl: env.PUBLIC_URL,
  mailCredentialKey: env.MAIL_CREDENTIAL_KEY,
  providerAdapters,
  syncManager,
  attachmentBudgetBytes: env.ATTACHMENT_BUDGET_BYTES,
  contactPhotoMaxBytes: env.CONTACT_PHOTO_BUDGET_BYTES,
  syncHints,
  vapidKeys,
  imageTag: env.MAIL_VERSION,
});

// Web Push's keypair (#53, ADR-0015 as amended): minted here on the first
// boot of an instance whose operator hasn't pinned
// `MAIL_VAPID_PUBLIC_KEY`/`_PRIVATE_KEY`, a no-op on every boot after that
// and on an env-pinned instance. Push therefore works out of the box rather
// than waiting on a CLI command and a hand-edited `.env`; the command still
// exists (`cli.ts`) for an operator who wants to own the keypair in their
// environment instead.
//
// `null` here means the one case generation refuses to touch: a stored
// keypair this build cannot unseal, which `onUnsealFailure` above has
// already logged in the Owner's own terms. Deliberately not fatal — every
// other feature works fine without push.
const vapidKeypair = await vapidKeys.ensure();
if (!vapidKeypair) {
  app.log.warn(
    `Web Push disabled: this instance has no usable VAPID keypair. Generate one from Settings → Instance, or set MAIL_VAPID_PUBLIC_KEY/MAIL_VAPID_PRIVATE_KEY from \`${GENERATE_VAPID_KEYS_COMMAND}\`.`,
  );
}

// The other way Web Push (and passkeys) can end up silently absent (#104,
// grill Q21/Q32) — the Owner's other way to learn these facts, alongside the
// Instance page's own `GET /instance/health` (`routes/instance.js`), which
// states them in the same words rather than requiring a log dig.
if (!isSecureContext(env.PUBLIC_URL)) {
  app.log.warn(
    "PUBLIC_URL is not a secure context (http:// on a non-localhost host): push and passkeys will not work from other devices.",
  );
}

// One-time first-run claim token, printed to the logs (ADR-0009 deployment).
// A no-op once an Owner already exists.
await ensureClaimToken(db, app.log, env.PUBLIC_URL);

await startAllMailAccountSyncs(db, syncManager);

// Every poll loop's handle (#188), registered once as it starts so `SIGTERM`
// below can stop all of them through this one registry instead of naming
// each handle again.
const pollLoops: PollLoopHandle[] = [];

// The `\Seen`/`\Flagged`/archive/trash write-through outbox (#42,
// ADR-0006): a short-lived connection per account with anything queued,
// independent of the resident IDLE sessions above.
pollLoops.push(
  startProtocolWriteLoop(db, {
    mailCredentialKey: env.MAIL_CREDENTIAL_KEY,
    logger: app.log,
  }),
);

// The debounced Composition → IMAP Drafts push (ADR-0012 tier 2, #45): same
// independent-short-lived-connection shape as the outbox above, on its own
// interval so a slow Drafts folder can never stall it either.
pollLoops.push(
  startDraftPushLoop(db, {
    mailCredentialKey: env.MAIL_CREDENTIAL_KEY,
    logger: app.log,
  }),
);

// The Pending Send sweeper (#46, ADR-0007). Its first tick runs immediately
// rather than after the interval: `submit_after` is absolute, so this boot is
// also the boot-time sweep that submits everything that came due while the
// process was down.
pollLoops.push(
  startSendLoop(db, {
    mailCredentialKey: env.MAIL_CREDENTIAL_KEY,
    logger: app.log,
  }),
);

// The iMIP `REPLY` sweeper (#241, ADR-0027, ADR-0007) — the Local-fallback
// Answer's own Pending Send, held for the same Undo Send delay a
// Composition's send is, but never one itself.
pollLoops.push(
  startReplySendLoop(db, {
    mailCredentialKey: env.MAIL_CREDENTIAL_KEY,
    logger: app.log,
  }),
);

// The organiser-side iMIP `REQUEST`/`CANCEL` sweeper (#242, ADR-0027) — the
// mirror image of the Reply sweeper above: a self-scheduled Calendar's own
// scheduling mail, sent at once rather than held for an Undo Send delay.
pollLoops.push(
  startRequestSendLoop(db, {
    mailCredentialKey: env.MAIL_CREDENTIAL_KEY,
    logger: app.log,
  }),
);

// The Search Index rebuild sweep (#50, ADR-0016): "a bumped index_version
// triggers a background, batched, oldest-version-first rebuild while search
// keeps serving old rows" — never a boot-time migration. Plain Postgres, no
// IMAP connection, so unlike every loop above it isn't scoped to a Mail
// Account or gated on its sync state.
pollLoops.push(startSearchIndexRebuildLoop(db, { logger: app.log }));

// The Snooze wake sweep (#76): "a thread returns to the Inbox as new when
// the time passes", independent of any Client being connected (ADR-0003) —
// same independent-of-`sync/manager.ts` shape as the rebuild loop above,
// its first tick catching up on whatever came due while the process was
// down.
pollLoops.push(startSnoozeWakeLoop(db, { logger: app.log }));

// The Recently Deleted purge sweep (#194, generalised by #257 to cover
// `Note`, `TaskList` and `Task`): "purged for good 30 days after deletion" —
// same independent-of-`sync/manager.ts` shape as the snooze wake loop above,
// since purging a soft-deleted row only ever touches columns already stored
// on its own retention-bearing table (`sync/collection-registry.ts`).
pollLoops.push(startTrashPurgeLoop(db, { logger: app.log }));

// A Contact's own Recently Deleted purge sweep (#224) — `startNotePurgeLoop`'s
// own shape, one row per soft-deleted collection rather than one loop trying
// to cover both.
pollLoops.push(startContactPurgeLoop(db, { logger: app.log }));

// The Materialisation Window's daily roll (#230, ADR-0025): re-materialises
// every Series' Occurrence rows against the current window on every tick,
// same "first tick runs immediately, boot-time catch-up" shape as the note
// purge sweep above.
pollLoops.push(startMaterialiseLoop(db, { logger: app.log }));

// Delete-a-Series' own 24-hour snapshot purge (#233): `series-purge-loop.ts`'s
// own doc comment for why this ticks far more often than the Note sweep above.
pollLoops.push(startSeriesPurgeLoop(db, { logger: app.log }));

// The Notifier's outbox delivery sweep (#53, ADR-0015). Its first tick runs
// immediately, same reasoning as the send sweeper above: whatever the outbox
// held when the process died is exactly what this boot-time tick resumes.
pollLoops.push(startNotifierDeliverLoop(db, { sendPush, logger: app.log }));

// The reminder loop (#245, ADR-0028): the shared loop helper's first new
// caller — 15 seconds, first tick at boot, so whatever came due while this
// process was down rings the moment it's back (`reminder-loop.ts`'s own
// doc comment).
pollLoops.push(startReminderLoop(db, { logger: app.log }));

// The Grant refresh sweep (#118, ADR-0021): "keeps Grants warm even while
// the resident connection is down" — same independent-of-`sync/manager.ts`
// shape as the rebuild and snooze loops above, refreshing any oauth Mail
// Account nearing its access token's expiry regardless of whether that
// account's own resident session is currently connected.
pollLoops.push(
  startGrantRefreshLoop(db, {
    mailCredentialKey: env.MAIL_CREDENTIAL_KEY,
    providerAdapters,
    logger: app.log,
  }),
);

// Google People mirrors an Address Book (#214): every Google Connected
// Account with an active Contacts Facet, on its own 15-minute schedule,
// independent of `sync/manager.ts` the same way the loops above are.
pollLoops.push(
  startGoogleContactsSyncLoop(db, {
    mailCredentialKey: env.MAIL_CREDENTIAL_KEY,
    logger: app.log,
  }),
);

// Write-back to Google, with upstream-wins rollback (#216): the outbox's own
// short-interval drain, independent of the 15-minute read-side loop above.
pollLoops.push(
  startGoogleContactsWriteBackLoop(db, {
    mailCredentialKey: env.MAIL_CREDENTIAL_KEY,
    logger: app.log,
  }),
);

// Microsoft Graph mirrors an Address Book per contact folder (#227) —
// `startGoogleContactsSyncLoop`'s own sibling, Microsoft's own `"graph"`
// oauth audience.
pollLoops.push(
  startMicrosoftContactsSyncLoop(db, {
    mailCredentialKey: env.MAIL_CREDENTIAL_KEY,
    logger: app.log,
  }),
);

// CardDAV mirrors an Address Book per discovered collection (#226) —
// `startGoogleContactsSyncLoop`'s own sibling, a `password` credential
// rather than an oauth one (RFC 6352 has no OAuth of its own).
pollLoops.push(
  startCarddavContactsSyncLoop(db, {
    mailCredentialKey: env.MAIL_CREDENTIAL_KEY,
    logger: app.log,
  }),
);

// Write-back to CardDAV, with upstream-wins rollback (#226): the outbox's
// own short-interval drain, independent of the 15-minute read-side loop
// above — `startGoogleContactsWriteBackLoop`'s own sibling.
pollLoops.push(
  startCarddavContactsWriteBackLoop(db, {
    mailCredentialKey: env.MAIL_CREDENTIAL_KEY,
    logger: app.log,
  }),
);

// The real Google Calendar credential provider (#237): reads whatever
// access token the Mail Facet's own Grant refresh already keeps warm under
// Google's shared `"default"` audience (`calendars/google/credentials.ts`'s
// own doc comment) — replacing the always-`null` placeholder #234 shipped
// before the Connected Account / Grant model (#199/#200/#202) landed on
// this branch.
const googleCalendarCredentials = createGoogleCalendarCredentialProvider(
  db,
  deriveCredentialKey(env.MAIL_CREDENTIAL_KEY),
);
const googleCalendarClient = createGoogleCalendarClient();

// The real Graph Calendar credential provider (#248) — reads whatever
// access token the Calendar Facet's own consent round sealed under
// Microsoft's `"graph"` audience (`calendars/graph/credentials.ts`'s own
// doc comment — including the real gap that doc comment names: nothing on
// this branch's ancestry refreshes that audience once it expires).
const graphCalendarCredentials = createGraphCalendarCredentialProvider(
  db,
  deriveCredentialKey(env.MAIL_CREDENTIAL_KEY),
);
const graphCalendarClient = createGraphCalendarClient();

// The real CalDAV credential provider (#247) — Basic auth from the
// `password`-kind credential #203's discovery already sealed, gated on the
// Calendar Facet's own `active` status (`calendars/caldav/credentials.ts`'s
// own doc comment).
const caldavCalendarCredentials = createCaldavCredentialProvider(
  db,
  deriveCredentialKey(env.MAIL_CREDENTIAL_KEY),
);
const caldavCalendarClient = createCaldavCalendarClient();

// Google Calendar mirroring (#234): calendar-list-then-Events on the shared
// loop helper, exactly as ADR-0025's own `poll-loop.ts` doc comment
// anticipates.
pollLoops.push(
  startCalendarMirrorLoop(db, {
    client: googleCalendarClient,
    credentials: googleCalendarCredentials,
    logger: app.log,
  }),
);

// Microsoft Graph Calendar mirroring (#248): `calendarView/delta` per
// Calendar plus the 15-minute `changeKey`-diffed list, on the same shared
// loop helper as Google's own.
pollLoops.push(
  startGraphCalendarMirrorLoop(db, {
    client: graphCalendarClient,
    credentials: graphCalendarCredentials,
    logger: app.log,
  }),
);

// CalDAV Calendar mirroring (#247): home-set enumeration plus per-Calendar
// `sync-collection`/`calendar-multiget` on the same shared loop helper as
// Google's and Graph's own.
pollLoops.push(
  startCaldavCalendarMirrorLoop(db, {
    client: caldavCalendarClient,
    credentials: caldavCalendarCredentials,
    logger: app.log,
  }),
);

// The write-back outbox's own sweep (#237/#248/#247, ADR-0025): store-first
// Series edits on a mirrored, writable Calendar ride this independent short
// interval, never the mutation flush itself — one shared sweep, dispatching
// per row to Google's, Graph's or CalDAV's own push by the owning Connected
// Account's provider (`outbox-loop.ts`'s own doc comment).
pollLoops.push(
  startCalendarOutboxLoop(db, {
    google: { client: googleCalendarClient, credentials: googleCalendarCredentials },
    graph: { client: graphCalendarClient, credentials: graphCalendarCredentials },
    caldav: { client: caldavCalendarClient, credentials: caldavCalendarCredentials },
    logger: app.log,
  }),
);

// The `Rollback` collection's own 7-day tombstone sweep (#237, ADR-0025).
pollLoops.push(startRollbackPurgeLoop(db, { logger: app.log }));

// `docs/dev-setup.md`'s production image runs under `tini` "for clean
// SIGTERM for IMAP IDLE connections" — this is the handler that promise
// describes: stop every resident session (a polite IMAP LOGOUT, then close)
// before the process actually exits, rather than yanking the sockets shut.
process.on("SIGTERM", () => {
  void Promise.all([
    syncManager.stopAll(),
    ...pollLoops.map((loop) => loop.stop()),
    syncHints.stop(),
  ])
    .catch((err) => app.log.error({ err }, "error while stopping sync sessions"))
    .finally(() => process.exit(0));
});

await app.listen({ host, port });
