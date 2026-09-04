import { buildApp } from "./app.js";
import { ensureClaimToken } from "./auth/claim.js";
import { startSendLoop } from "./compose/send-loop.js";
import { createDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { loadEnv } from "./env.js";
import { GENERATE_VAPID_KEYS_COMMAND, isSecureContext } from "./instance-info.js";
import type { SendPushFn } from "./notifier/deliver.js";
import { startNotifierDeliverLoop } from "./notifier/deliver-loop.js";
import { createVapidKeyStore } from "./notifier/vapid-keys.js";
import { createWebPushSender } from "./notifier/web-push-sender.js";
import { createSyncHintBroker } from "./realtime/sync-hints.js";
import { startDraftPushLoop } from "./sync/draft-push-loop.js";
import { createSyncManager, startAllMailAccountSyncs } from "./sync/manager.js";
import { startProtocolWriteLoop } from "./sync/protocol-write-loop.js";
import { startSearchIndexRebuildLoop } from "./sync/search-index-loop.js";
import { startSnoozeWakeLoop } from "./sync/snooze-wake-loop.js";

const env = loadEnv();

// Migrations run in the app's own boot path and fail closed (ADR-0009): the
// process does not start serving traffic if a migration fails.
await runMigrations(env.DATABASE_URL, new URL("./db/migrations", import.meta.url).pathname);

const { db, sql } = createDb(env);

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
// unrequested IMAP connection just by calling `buildApp`.
const syncManager = createSyncManager(db, { mailCredentialKey: env.MAIL_CREDENTIAL_KEY });

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
  syncManager,
  attachmentBudgetBytes: env.ATTACHMENT_BUDGET_BYTES,
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

// The `\Seen`/`\Flagged`/archive/trash write-through outbox (#42,
// ADR-0006): a short-lived connection per account with anything queued,
// independent of the resident IDLE sessions above.
const protocolWriteLoop = startProtocolWriteLoop(db, {
  mailCredentialKey: env.MAIL_CREDENTIAL_KEY,
  logger: app.log,
});

// The debounced Composition → IMAP Drafts push (ADR-0012 tier 2, #45): same
// independent-short-lived-connection shape as the outbox above, on its own
// interval so a slow Drafts folder can never stall it either.
const draftPushLoop = startDraftPushLoop(db, {
  mailCredentialKey: env.MAIL_CREDENTIAL_KEY,
  logger: app.log,
});

// The Pending Send sweeper (#46, ADR-0007). Its first tick runs immediately
// rather than after the interval: `submit_after` is absolute, so this boot is
// also the boot-time sweep that submits everything that came due while the
// process was down.
const sendLoop = startSendLoop(db, {
  mailCredentialKey: env.MAIL_CREDENTIAL_KEY,
  logger: app.log,
});

// The Search Index rebuild sweep (#50, ADR-0016): "a bumped index_version
// triggers a background, batched, oldest-version-first rebuild while search
// keeps serving old rows" — never a boot-time migration. Plain Postgres, no
// IMAP connection, so unlike every loop above it isn't scoped to a Mail
// Account or gated on its sync state.
const searchIndexRebuildLoop = startSearchIndexRebuildLoop(db, { logger: app.log });

// The Snooze wake sweep (#76): "a thread returns to the Inbox as new when
// the time passes", independent of any Client being connected (ADR-0003) —
// same independent-of-`sync/manager.ts` shape as the rebuild loop above,
// its first tick catching up on whatever came due while the process was
// down.
const snoozeWakeLoop = startSnoozeWakeLoop(db, { logger: app.log });

// The Notifier's outbox delivery sweep (#53, ADR-0015). Its first tick runs
// immediately, same reasoning as the send sweeper above: whatever the outbox
// held when the process died is exactly what this boot-time tick resumes.
const notifierDeliverLoop = startNotifierDeliverLoop(db, { sendPush, logger: app.log });

// `docs/dev-setup.md`'s production image runs under `tini` "for clean
// SIGTERM for IMAP IDLE connections" — this is the handler that promise
// describes: stop every resident session (a polite IMAP LOGOUT, then close)
// before the process actually exits, rather than yanking the sockets shut.
process.on("SIGTERM", () => {
  void Promise.all([
    syncManager.stopAll(),
    protocolWriteLoop.stop(),
    draftPushLoop.stop(),
    sendLoop.stop(),
    searchIndexRebuildLoop.stop(),
    snoozeWakeLoop.stop(),
    notifierDeliverLoop.stop(),
    syncHints.stop(),
  ])
    .catch((err) => app.log.error({ err }, "error while stopping sync sessions"))
    .finally(() => process.exit(0));
});

await app.listen({ host, port });
