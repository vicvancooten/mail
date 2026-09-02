import type { EventSourceLike, HintChannel } from "../sync/sse.js";

/**
 * A test double for `EventSource` narrow enough for `sse.ts`'s
 * `connectSyncHints`: something to call `.fireHint()` on rather than a real
 * `GET /events` connection.
 */
export interface FakeEventSource extends EventSourceLike {
  fireHint(): void;
  closed: boolean;
}

export interface FakeEventSourceFactory {
  createEventSource: () => FakeEventSource;
  /** Every instance ever created, in creation order — "exactly one" is an assertion on this. */
  instances: FakeEventSource[];
}

export function createFakeEventSourceFactory(): FakeEventSourceFactory {
  const instances: FakeEventSource[] = [];
  return {
    instances,
    createEventSource(): FakeEventSource {
      let hintListener: (() => void) | null = null;
      const instance: FakeEventSource = {
        closed: false,
        addEventListener(type, listener) {
          if (type === "hint") hintListener = listener;
        },
        close() {
          instance.closed = true;
        },
        fireHint() {
          hintListener?.();
        },
      };
      instances.push(instance);
      return instance;
    },
  };
}

/**
 * A test double for `BroadcastChannel` narrow enough for `sse.ts`. Mirrors
 * the real spec property that matters here: `postMessage` reaches every
 * *other* open instance of the same channel name, never the sender's own.
 */
export interface FakeHintChannelFactory {
  createChannel: (name: string) => HintChannel;
  /** Every instance ever created, in creation order. */
  instances: HintChannel[];
}

interface Registered {
  name: string;
  closed: boolean;
  listeners: Set<() => void>;
}

export function createFakeHintChannelFactory(): FakeHintChannelFactory {
  const instances: HintChannel[] = [];
  const registry: Registered[] = [];

  return {
    instances,
    createChannel(name: string): HintChannel {
      const registered: Registered = { name, closed: false, listeners: new Set() };
      registry.push(registered);

      const instance: HintChannel = {
        postMessage() {
          for (const other of registry) {
            if (other !== registered && other.name === name && !other.closed) {
              for (const listener of other.listeners) listener();
            }
          }
        },
        addEventListener(_type, listener) {
          registered.listeners.add(listener);
        },
        removeEventListener(_type, listener) {
          registered.listeners.delete(listener);
        },
        close() {
          registered.closed = true;
        },
      };
      instances.push(instance);
      return instance;
    },
  };
}
