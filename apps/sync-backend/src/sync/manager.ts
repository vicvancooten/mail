import type { Db } from "../db/client.js";
import type { MailAccountRow } from "../mail-accounts/store.js";
import { getMailAccountById, listAllMailAccounts } from "../mail-accounts/store.js";
import {
  type LiveSyncSessionHandle,
  type LiveSyncSessionOptions,
  startLiveSyncSession,
} from "./live-session.js";

/**
 * Registry of resident sync sessions (#35), one per Mail Account. This is
 * the seam `app.ts`/`main.ts` and the Mail Account routes hold instead of
 * calling `startLiveSyncSession` directly, so there is exactly one session
 * per account id at any time regardless of how many places want one running.
 */
export interface SyncManager {
  /** Starts a session for this Mail Account if one isn't already running. */
  start(account: MailAccountRow): void;
  /** Stops any running session and starts a fresh one from the account's current row — the reauth path's hook. */
  restart(accountId: string): Promise<void>;
  /** Stops every running session. Awaited from `main.ts`'s `SIGTERM` handler so IDLE connections close cleanly. */
  stopAll(): Promise<void>;
}

export function createSyncManager(
  db: Db,
  options: Pick<
    LiveSyncSessionOptions,
    "mailCredentialKey" | "pollIntervalMs" | "idleWakeDebounceMs" | "providerAdapters"
  >,
): SyncManager {
  const sessions = new Map<string, LiveSyncSessionHandle>();

  return {
    start(account) {
      if (sessions.has(account.id)) return;
      const handle = startLiveSyncSession(db, account, options);
      sessions.set(account.id, handle);
    },

    async restart(accountId) {
      const existing = sessions.get(accountId);
      sessions.delete(accountId);
      await existing?.stop();

      const account = await getMailAccountById(db, accountId);
      if (!account) return; // deleted between the reauth write and this call
      const handle = startLiveSyncSession(db, account, options);
      sessions.set(accountId, handle);
    },

    async stopAll() {
      const handles = [...sessions.values()];
      sessions.clear();
      await Promise.all(handles.map((handle) => handle.stop()));
    },
  };
}

/** Starts every existing Mail Account's session — `main.ts`'s boot-time call. */
export async function startAllMailAccountSyncs(db: Db, manager: SyncManager): Promise<void> {
  const accounts = await listAllMailAccounts(db);
  for (const account of accounts) manager.start(account);
}

/** A `SyncManager` that does nothing — `buildApp`'s default so tests never open a real IMAP connection unasked. */
export const noopSyncManager: SyncManager = {
  start() {},
  async restart() {},
  async stopAll() {},
};
