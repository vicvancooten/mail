/**
 * ADR-0015's leader relay: the Web Locks leader tab owns the **one** `GET
 * /events` connection for the whole User, and relays each Sync Hint to
 * every tab over a `BroadcastChannel` — including itself, since a
 * `BroadcastChannel` never delivers a message back to its own sender, so
 * `connectSyncHints` (the leader-only half, run from inside `sync-loop.ts`'s
 * leader task) calls its own `onHint` directly *and* broadcasts.
 *
 * Every tab — leader and followers alike — subscribes with
 * `subscribeSyncHints`, so there is exactly one reaction to a hint to keep
 * correct rather than a leader path and a separate follower path. A
 * follower's reaction (`sync-loop.ts`'s `requestSync`) is a harmless no-op:
 * nothing is listening for its wake-up until this tab actually becomes the
 * leader, at which point the cold-boot `syncRequested` flag already covers
 * it regardless.
 */

export const SYNC_HINT_CHANNEL = "mail:sync-hints";

/** The slice of `BroadcastChannel` this needs — narrowed so a test double beats casting a fake. */
export interface HintChannel {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: () => void): void;
  removeEventListener(type: "message", listener: () => void): void;
  close(): void;
}

function defaultCreateChannel(name: string): HintChannel | null {
  const Ctor = globalThis.BroadcastChannel;
  return Ctor ? new Ctor(name) : null;
}

export interface SubscribeSyncHintsOptions {
  channelName?: string;
  /** `null` states "this host has none" (an old browser, a non-DOM test host) — the subscription is then a no-op. */
  createChannel?: (name: string) => HintChannel | null;
}

/**
 * Every tab calls this once. Fires whenever any tab (including a past
 * instance of this one, across a leadership handover) relays a hint.
 */
export function subscribeSyncHints(
  listener: () => void,
  {
    channelName = SYNC_HINT_CHANNEL,
    createChannel = defaultCreateChannel,
  }: SubscribeSyncHintsOptions = {},
): () => void {
  const channel = createChannel(channelName);
  if (!channel) return () => {};

  channel.addEventListener("message", listener);
  return () => {
    channel.removeEventListener("message", listener);
    channel.close();
  };
}

/** The slice of `EventSource` this needs. */
export interface EventSourceLike {
  addEventListener(type: "hint", listener: () => void): void;
  close(): void;
}

function defaultCreateEventSource(): EventSourceLike | null {
  // `null` states "this host has none" (an old browser, a non-DOM test
  // host) exactly like `leader.ts`'s Web Locks fallback: no realtime hint
  // channel is a degrade, not a crash — the 30s poll is still the floor.
  const Ctor = globalThis.EventSource;
  if (!Ctor) return null;
  // Auth is the ordinary httpOnly session cookie (ADR-0015) — never a token
  // in the query string, which is what `EventSource` otherwise tempts you
  // into. Same-origin per ADR-0009's single-image deployment, so cookies
  // ride along regardless; `withCredentials` just states that on purpose.
  return new Ctor("/events", { withCredentials: true });
}

export interface ConnectSyncHintsOptions extends SubscribeSyncHintsOptions {
  createEventSource?: () => EventSourceLike | null;
}

/**
 * The leader-only half — call from inside the Web Locks leader task
 * (`sync-loop.ts`), never per-tab. Opens the one `EventSource`, and on
 * every `hint` frame calls `onHint` directly (this tab won't hear its own
 * broadcast) and relays to every tab over `BroadcastChannel`.
 *
 * Mirrors `leader.ts`'s `LeaderTask` shape: does its cleanup on `signal`
 * abort rather than returning a handle of its own.
 */
export function connectSyncHints(
  onHint: () => void,
  signal: AbortSignal,
  {
    channelName = SYNC_HINT_CHANNEL,
    createChannel = defaultCreateChannel,
    createEventSource = defaultCreateEventSource,
  }: ConnectSyncHintsOptions = {},
): void {
  if (signal.aborted) return;

  const channel = createChannel(channelName);
  const source = createEventSource();
  if (!source) {
    channel?.close();
    return;
  }

  source.addEventListener("hint", () => {
    onHint();
    channel?.postMessage({ type: "hint" });
  });

  signal.addEventListener(
    "abort",
    () => {
      source.close();
      channel?.close();
    },
    { once: true },
  );
}
