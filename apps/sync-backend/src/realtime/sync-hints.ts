import type { Sql } from "postgres";

/**
 * ADR-0015's SSE fanout: Postgres `LISTEN/NOTIFY` (migration 0016's
 * `notify_sync_hint` trigger, fired inside the writing transaction) turned
 * into hints for `routes/events.ts`'s `GET /events` connections.
 *
 * Coalescing to "~1 hint/500ms per User" happens *here*, not in the
 * trigger: the trigger fires once per transaction (Postgres folds repeated
 * same-channel-same-payload NOTIFYs from one transaction together), but a
 * burst of separate transactions — a multi-message IDLE batch ingested one
 * message at a time — would otherwise NOTIFY once per message. This is a
 * leading-plus-trailing throttle per User: the first NOTIFY in a quiet
 * period dispatches immediately (so a lone new message still reaches an
 * open Client in ~1s), further NOTIFYs land inside the following cooldown
 * window and are collapsed into exactly one trailing dispatch at its end —
 * never silently dropped, never one dispatch per row.
 */

const DEFAULT_COALESCE_MS = 500;

export interface SyncHintBroker {
  /** Registers `onHint` for `userId`'s coalesced hints; call the returned function to stop. */
  subscribe(userId: string, onHint: () => void): () => void;
  /** Releases the dedicated LISTEN connection and any pending cooldown timers. */
  stop(): Promise<void>;
}

export interface CreateSyncHintBrokerOptions {
  coalesceMs?: number;
}

interface Cooldown {
  timer: ReturnType<typeof setTimeout>;
  trailing: boolean;
}

/**
 * Default for `buildApp` (mirrors `sync/manager.ts`'s `noopSyncManager`):
 * opening a dedicated Postgres LISTEN connection is not something any test
 * asks for just by calling `buildApp`. `main.ts` is the only real caller
 * that wires in `createSyncHintBroker`'s live one.
 */
export const noopSyncHintBroker: SyncHintBroker = {
  subscribe() {
    return () => {};
  },
  async stop() {},
};

export function createSyncHintBroker(
  sql: Sql,
  { coalesceMs = DEFAULT_COALESCE_MS }: CreateSyncHintBrokerOptions = {},
): SyncHintBroker {
  const subscribers = new Map<string, Set<() => void>>();
  const cooldowns = new Map<string, Cooldown>();

  function dispatch(userId: string): void {
    const listeners = subscribers.get(userId);
    if (!listeners) return;
    for (const listener of listeners) listener();
  }

  function onNotify(userId: string): void {
    // No open Client for this User — nothing to wake, and nothing worth
    // holding a cooldown timer open for.
    if (!subscribers.get(userId)?.size) return;

    const existing = cooldowns.get(userId);
    if (existing) {
      existing.trailing = true;
      return;
    }

    dispatch(userId);
    const cooldown: Cooldown = { trailing: false, timer: undefined as never };
    cooldown.timer = setTimeout(() => {
      cooldowns.delete(userId);
      // Something arrived mid-cooldown: dispatch it now rather than waiting
      // for the *next* NOTIFY to notice, and open a fresh cooldown behind it.
      if (cooldown.trailing) onNotify(userId);
    }, coalesceMs);
    cooldowns.set(userId, cooldown);
  }

  // `postgres`'s `sql.listen` owns its own dedicated connection (never the
  // pooled one queries run on) and reconnects/resubscribes on its own —
  // exactly the shape ADR-0015 wants, with none of that bookkeeping here.
  const listening = sql.listen("mail_sync_hint", onNotify);

  return {
    subscribe(userId, onHint) {
      let set = subscribers.get(userId);
      if (!set) {
        set = new Set();
        subscribers.set(userId, set);
      }
      set.add(onHint);
      return () => {
        set?.delete(onHint);
        if (set?.size === 0) subscribers.delete(userId);
      };
    },
    async stop() {
      for (const cooldown of cooldowns.values()) clearTimeout(cooldown.timer);
      cooldowns.clear();
      const { unlisten } = await listening;
      await unlisten();
    },
  };
}
