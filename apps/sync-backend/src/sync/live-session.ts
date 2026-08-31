import type { ExistsEvent, ExpungeEvent, FlagsEvent, ImapFlow } from "imapflow";
import type { Db } from "../db/client.js";
import { deriveCredentialKey } from "../mail-accounts/credential-crypto.js";
import { getMailAccountById, type MailAccountRow, setSyncStatus } from "../mail-accounts/store.js";
import { applyFolderDelta, getFolderById } from "./delta.js";
import {
  discoverFolders,
  type FolderRow,
  listSelectableFolders,
  persistFolders,
} from "./folders.js";
import { connectMailAccount, MailAccountNeedsReauthError } from "./imap-connection.js";
import { ingestFolder } from "./ingest.js";
import { attemptQresyncCatchup } from "./qresync-catchup.js";

/**
 * The resident per-account sync loop (#35): one long-lived IMAP connection
 * that holds IDLE on INBOX and polls every other folder, self-restarting
 * with backoff on any drop. This is what `sync/sync-account.ts`'s own module
 * comment named as its replacement — that one-shot pass is still what runs
 * inside here for a folder's very first sync (and for a UIDVALIDITY
 * rebuild), so #34's tested ingest path never forks into a second copy.
 *
 * One `startLiveSyncSession` call owns one connection for one Mail Account,
 * matching ADR-0005's "one IMAP connection per Mail Account". Everything
 * about *which* accounts get a session (start on create, restart on reauth,
 * stop on shutdown) is `sync/manager.ts`'s job, not this module's — this
 * file knows nothing about how many accounts exist.
 */

const DEFAULT_POLL_INTERVAL_MS = 5 * 60_000;
const DEFAULT_WAKE_DEBOUNCE_MS = 300;
const DEFAULT_BACKOFF_INITIAL_MS = 1_000;
const DEFAULT_BACKOFF_MAX_MS = 30_000;
const DEFAULT_AUTO_IDLE_DELAY_MS = 1_000;
/** A session that stayed up at least this long before dying is treated as a fresh failure, not a repeat. */
const HEALTHY_RUN_RESET_MS = 60_000;

export interface LiveSyncSessionOptions {
  /** `env.MAIL_CREDENTIAL_KEY`, raw. */
  mailCredentialKey: string;
  /** How often non-INBOX folders are polled. Default 5 minutes. */
  pollIntervalMs?: number;
  /** How long an IDLE wake debounces before applying a delta — collapses a burst of events into one pass. */
  idleWakeDebounceMs?: number;
  backoffInitialMs?: number;
  backoffMaxMs?: number;
  /** ImapFlow's own inactivity threshold before auto-IDLE arms. Default 1s — see `ImapConnectionOptions`. */
  autoIdleDelayMs?: number;
  /**
   * Test-only observability hook: called with each connection this session
   * opens, right after it authenticates. Production code has no use for
   * it — it exists so a test can grab the live `ImapFlow` and force a
   * failure (`client.close()`) to prove the self-restart path without
   * guessing at real-socket timing.
   */
  onClientReady?: (client: ImapFlow) => void;
}

export interface LiveSyncSessionHandle {
  /** Stops the loop and closes the connection. Idempotent; resolves once the current pass has unwound. */
  stop(): Promise<void>;
}

/** Thrown internally to unwind `runSession` without touching the account's status — it may no longer have a row. */
class AccountGoneError extends Error {}

/** A tiny deferred: resolved once, from wherever the loop's next stop point should come from. */
function createSignal(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function sleep(ms: number, stopSignal: Promise<void>): Promise<void> {
  return Promise.race([
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    }),
    stopSignal,
  ]);
}

export function startLiveSyncSession(
  db: Db,
  account: MailAccountRow,
  options: LiveSyncSessionOptions,
): LiveSyncSessionHandle {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const wakeDebounceMs = options.idleWakeDebounceMs ?? DEFAULT_WAKE_DEBOUNCE_MS;
  const backoffInitialMs = options.backoffInitialMs ?? DEFAULT_BACKOFF_INITIAL_MS;
  const backoffMaxMs = options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
  const autoIdleDelayMs = options.autoIdleDelayMs ?? DEFAULT_AUTO_IDLE_DELAY_MS;

  const stop = createSignal();
  let stopped = false;
  let restartCount = 0;

  const loop = (async () => {
    while (!stopped) {
      const startedAt = Date.now();
      try {
        await runSession(db, account.id, {
          mailCredentialKey: options.mailCredentialKey,
          pollIntervalMs,
          wakeDebounceMs,
          stopSignal: stop.promise,
          isStopped: () => stopped,
          onClientReady: options.onClientReady,
          autoIdleDelayMs,
        });
        // Only returns without throwing when `stop()` was requested.
        return;
      } catch (err) {
        if (stopped) return;
        if (err instanceof AccountGoneError) return;
        if (err instanceof MailAccountNeedsReauthError) {
          // CONTEXT.md: "syncing stops until the User supplies new
          // credentials" — no self-restart. `sync/manager.ts`'s reauth path
          // is what starts a fresh session once that happens.
          await setSyncStatus(db, account.id, { state: "stopped" }).catch(() => undefined);
          return;
        }

        const message = err instanceof Error ? err.message : String(err);
        await setSyncStatus(db, account.id, { state: "error", error: message }).catch(
          () => undefined,
        );

        restartCount = Date.now() - startedAt > HEALTHY_RUN_RESET_MS ? 1 : restartCount + 1;
        const delay = Math.min(backoffMaxMs, backoffInitialMs * 2 ** (restartCount - 1));
        await sleep(delay, stop.promise);
      }
    }
  })();

  return {
    async stop() {
      if (!stopped) {
        stopped = true;
        stop.resolve();
      }
      await loop;
    },
  };
}

interface RunSessionContext {
  mailCredentialKey: string;
  pollIntervalMs: number;
  wakeDebounceMs: number;
  stopSignal: Promise<void>;
  isStopped: () => boolean;
  onClientReady?: (client: ImapFlow) => void;
  autoIdleDelayMs: number;
}

/**
 * One connection's lifecycle, start to close. Resolves cleanly only when
 * `stopSignal` fired; any other exit — a dropped socket, a failed delta
 * apply, a `close`/`error` event — throws, and `startLiveSyncSession`'s loop
 * is what decides whether that means a backoff-and-retry or a hard stop.
 */
async function runSession(db: Db, accountId: string, ctx: RunSessionContext): Promise<void> {
  const account = await getMailAccountById(db, accountId);
  if (!account) throw new AccountGoneError();
  if (account.status === "needs_reauth") {
    throw new MailAccountNeedsReauthError(accountId, "parked in Needs Reauth");
  }

  await setSyncStatus(db, accountId, { state: "connecting" });
  const credentialKey = deriveCredentialKey(ctx.mailCredentialKey);
  const client = await connectMailAccount(db, account, {
    credentialKey,
    qresync: true,
    autoIdleDelay: ctx.autoIdleDelayMs,
  });
  ctx.onClientReady?.(client);

  try {
    await setSyncStatus(db, accountId, { state: "syncing" });
    const live = await persistFolders(db, accountId, await discoverFolders(client));
    const inbox = live.find((folder) => folder.role === "inbox" && folder.selectable);
    if (!inbox) {
      throw new Error(`Mail Account ${accountId} has no selectable INBOX`);
    }

    // First ever sync of this folder: a full newest-first header ingest
    // (#34) establishes the baseline a delta can resume from. Anything after
    // that is `attemptQresyncCatchup`'s job, falling back to the UID-diff
    // `applyFolderDelta`.
    if (inbox.lastSyncedAt === null) {
      await ingestFolder(db, client, inbox);
    } else if (!(await attemptQresyncCatchup(db, client, inbox))) {
      await applyFolderDelta(db, client, inbox);
    }
    await setSyncStatus(db, accountId, { state: "idle", touchProgress: true });

    await residentLoop(db, client, accountId, inbox, ctx);
  } finally {
    await client.logout().catch(() => undefined);
    client.close();
  }
}

/**
 * The steady state once the baseline is established: IDLE reactions on
 * INBOX and a polling ticker for everything else, both funnelled through one
 * failure signal so either kind of trouble tears the whole session down the
 * same way.
 */
async function residentLoop(
  db: Db,
  client: ImapFlow,
  accountId: string,
  inbox: FolderRow,
  ctx: RunSessionContext,
): Promise<void> {
  const failure = createSignal();
  let failed: unknown;
  const fail = (err: unknown) => {
    if (failed !== undefined) return;
    failed = err ?? new Error("live sync session failed");
    failure.resolve();
  };

  let wakeTimer: ReturnType<typeof setTimeout> | null = null;
  let wakeInFlight = false;
  let wakeQueued = false;

  const runWake = async () => {
    if (wakeInFlight) {
      wakeQueued = true;
      return;
    }
    wakeInFlight = true;
    try {
      const fresh = await getFolderById(db, inbox.id);
      if (fresh) await applyFolderDelta(db, client, fresh);
      await setSyncStatus(db, accountId, { state: "idle", touchProgress: true });
    } catch (err) {
      fail(err);
    } finally {
      wakeInFlight = false;
      if (wakeQueued) {
        wakeQueued = false;
        scheduleWake();
      }
    }
  };

  const scheduleWake = () => {
    if (wakeTimer) return;
    wakeTimer = setTimeout(() => {
      wakeTimer = null;
      void runWake();
    }, ctx.wakeDebounceMs);
    wakeTimer.unref?.();
  };

  // Any of these three can mean "something changed" without saying exactly
  // what (a plain EXPUNGE doesn't carry a UID) — `applyFolderDelta`'s
  // UID-diff is what actually finds out, so every one of them just wakes it.
  const onExists = (event: ExistsEvent) => {
    if (event.path === inbox.path) scheduleWake();
  };
  const onFlags = (event: FlagsEvent) => {
    if (event.path === inbox.path) scheduleWake();
  };
  const onExpunge = (event: ExpungeEvent) => {
    if (event.path === inbox.path) scheduleWake();
  };
  const onClose = () => fail(new Error("IMAP connection closed"));
  const onError = (err: Error) => fail(err);

  client.on("exists", onExists);
  client.on("flags", onFlags);
  client.on("expunge", onExpunge);
  client.on("close", onClose);
  client.on("error", onError);

  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  const runPoll = async () => {
    try {
      const current = await listSelectableFolders(db, accountId);
      for (const folder of current) {
        if (folder.role === "inbox") continue;
        if (ctx.isStopped() || failed !== undefined) return;
        if (!(await attemptQresyncCatchup(db, client, folder))) {
          await applyFolderDelta(db, client, folder);
        }
      }
      // Re-select INBOX so auto-IDLE arms there rather than on whatever
      // folder was polled last — the fast path makes this a no-op once it
      // already is.
      const lock = await client.getMailboxLock(inbox.path, { readOnly: true });
      lock.release();
      await setSyncStatus(db, accountId, { state: "idle", touchProgress: true });
    } catch (err) {
      fail(err);
      return;
    }
    if (failed === undefined && !ctx.isStopped()) {
      pollTimer = setTimeout(() => void runPoll(), ctx.pollIntervalMs);
      pollTimer.unref?.();
    }
  };
  // Runs once immediately — other folders shouldn't wait a full interval for
  // their first pass after a fresh connect — then reschedules itself.
  void runPoll();

  try {
    await Promise.race([failure.promise, ctx.stopSignal]);
  } finally {
    if (wakeTimer) clearTimeout(wakeTimer);
    if (pollTimer) clearTimeout(pollTimer);
    client.off("exists", onExists);
    client.off("flags", onFlags);
    client.off("expunge", onExpunge);
    client.off("close", onClose);
    client.off("error", onError);
  }

  if (failed !== undefined && !ctx.isStopped()) {
    throw failed;
  }
}
