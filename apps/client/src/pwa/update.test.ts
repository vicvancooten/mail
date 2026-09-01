import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyPendingUpdate,
  hasPendingUpdate,
  registerServiceWorker,
  resetPendingUpdate,
  type ServiceWorkerHost,
  type ServiceWorkerLike,
  type ServiceWorkerRegistrationLike,
  subscribePendingUpdate,
} from "./update.js";

/** A minimal `ServiceWorkerLike` double: state plus a listener list `statechange` can drive by hand. */
function createFakeWorker(): ServiceWorkerLike & { fireStateChange(state: string): void } {
  const listeners: (() => void)[] = [];
  let state = "installing";
  return {
    get state() {
      return state;
    },
    postMessage: vi.fn(),
    addEventListener: (_type, listener) => listeners.push(listener),
    fireStateChange(next: string) {
      state = next;
      for (const listener of listeners) listener();
    },
  };
}

describe("registerServiceWorker / update flow", () => {
  beforeEach(() => resetPendingUpdate());

  it("does nothing when there is no navigator.serviceWorker to register against", () => {
    // The default-arg path (`vite dev`, jsdom): must not throw.
    expect(() => registerServiceWorker(undefined)).not.toThrow();
    expect(hasPendingUpdate()).toBe(false);
  });

  it("marks an update pending once an installed worker appears with an existing controller", async () => {
    const worker = createFakeWorker();
    const updateFoundListeners: (() => void)[] = [];
    const registration: ServiceWorkerRegistrationLike = {
      waiting: null,
      installing: worker,
      addEventListener: (_type, listener) => updateFoundListeners.push(listener),
    };
    const sw: ServiceWorkerHost = {
      register: vi.fn().mockResolvedValue(registration),
      addEventListener: vi.fn(),
      controller: {}, // a controller already exists: this is an update, not a first install
    };

    registerServiceWorker(sw);
    await flushMicrotasks();
    for (const listener of updateFoundListeners) listener();

    expect(hasPendingUpdate()).toBe(false); // still installing
    worker.fireStateChange("installed");
    expect(hasPendingUpdate()).toBe(true);
  });

  it("does not treat a worker reaching installed as an update on a first-ever install (no controller yet)", async () => {
    const worker = createFakeWorker();
    const updateFoundListeners: (() => void)[] = [];
    const registration: ServiceWorkerRegistrationLike = {
      waiting: null,
      installing: worker,
      addEventListener: (_type, listener) => updateFoundListeners.push(listener),
    };
    const sw: ServiceWorkerHost = {
      register: vi.fn().mockResolvedValue(registration),
      addEventListener: vi.fn(),
      controller: null, // nothing controlling this page yet — first install
    };

    registerServiceWorker(sw);
    await flushMicrotasks();
    for (const listener of updateFoundListeners) listener();
    worker.fireStateChange("installed");

    expect(hasPendingUpdate()).toBe(false);
  });

  it("picks up a worker already waiting at registration time", async () => {
    const waiting = createFakeWorker();
    const registration: ServiceWorkerRegistrationLike = {
      waiting,
      installing: null,
      addEventListener: vi.fn(),
    };
    const sw: ServiceWorkerHost = {
      register: vi.fn().mockResolvedValue(registration),
      addEventListener: vi.fn(),
      controller: {},
    };

    registerServiceWorker(sw);
    await flushMicrotasks();

    expect(hasPendingUpdate()).toBe(true);
  });

  it("notifies subscribers exactly when pending-update state changes", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribePendingUpdate(listener);

    const waiting = createFakeWorker();
    const registration: ServiceWorkerRegistrationLike = {
      waiting,
      installing: null,
      addEventListener: vi.fn(),
    };
    const sw: ServiceWorkerHost = {
      register: vi.fn().mockResolvedValue(registration),
      addEventListener: vi.fn(),
      controller: {},
    };

    registerServiceWorker(sw);
    await flushMicrotasks();

    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("posts SKIP_WAITING to the waiting worker and reloads exactly once controllerchange fires", async () => {
    const waiting = createFakeWorker();
    const registration: ServiceWorkerRegistrationLike = {
      waiting,
      installing: null,
      addEventListener: vi.fn(),
    };
    let controllerChangeListener: (() => void) | undefined;
    const sw: ServiceWorkerHost = {
      register: vi.fn().mockResolvedValue(registration),
      addEventListener: (type, listener) => {
        if (type === "controllerchange") controllerChangeListener = listener;
      },
      controller: {},
    };

    registerServiceWorker(sw);
    await flushMicrotasks();
    expect(hasPendingUpdate()).toBe(true);

    const reload = vi.fn();
    applyPendingUpdate(sw, reload);

    expect(waiting.postMessage).toHaveBeenCalledWith("SKIP_WAITING");
    expect(reload).not.toHaveBeenCalled();

    controllerChangeListener?.();
    controllerChangeListener?.(); // a second firing must not reload twice
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("applyPendingUpdate is a no-op when nothing is waiting", () => {
    const reload = vi.fn();
    const sw: ServiceWorkerHost = {
      register: vi.fn(),
      addEventListener: vi.fn(),
      controller: {},
    };
    applyPendingUpdate(sw, reload);
    expect(reload).not.toHaveBeenCalled();
  });
});

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
