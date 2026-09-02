import { describe, expect, it } from "vitest";
import {
  createFakeEventSourceFactory,
  createFakeHintChannelFactory,
} from "../test-support/fake-sync-hints.js";
import { connectSyncHints, subscribeSyncHints } from "./sse.js";

/**
 * ADR-0015's leader relay in isolation — `sync-loop.test.ts` covers it
 * wired into the leader election; this covers the module's own contract.
 */

describe("connectSyncHints", () => {
  it("opens exactly one EventSource and relays a hint frame to onHint and the channel", () => {
    const es = createFakeEventSourceFactory();
    const channel = createFakeHintChannelFactory();
    const hints: number[] = [];
    const controller = new AbortController();

    connectSyncHints(() => hints.push(1), controller.signal, {
      createEventSource: es.createEventSource,
      createChannel: channel.createChannel,
    });

    expect(es.instances).toHaveLength(1);

    // A sibling tab's channel instance is what receives the relay —
    // `BroadcastChannel` never delivers back to its own sender.
    const sibling: number[] = [];
    channel.createChannel("mail:sync-hints").addEventListener("message", () => sibling.push(1));

    es.instances[0]?.fireHint();

    expect(hints).toEqual([1]);
    expect(sibling).toEqual([1]);
  });

  it("closes the EventSource and its channel when the signal aborts", () => {
    const es = createFakeEventSourceFactory();
    const channel = createFakeHintChannelFactory();
    const controller = new AbortController();

    connectSyncHints(() => {}, controller.signal, {
      createEventSource: es.createEventSource,
      createChannel: channel.createChannel,
    });
    controller.abort();

    expect(es.instances[0]?.closed).toBe(true);
  });

  it("does nothing when the signal is already aborted", () => {
    const es = createFakeEventSourceFactory();
    const controller = new AbortController();
    controller.abort();

    connectSyncHints(() => {}, controller.signal, { createEventSource: es.createEventSource });

    expect(es.instances).toHaveLength(0);
  });

  it("degrades to no connection when the host has no EventSource, without throwing", () => {
    const controller = new AbortController();
    expect(() =>
      connectSyncHints(() => {}, controller.signal, { createEventSource: () => null }),
    ).not.toThrow();
  });
});

describe("subscribeSyncHints", () => {
  it("fires when another tab relays a hint over the same channel", () => {
    const channel = createFakeHintChannelFactory();
    const received: number[] = [];

    const unsubscribe = subscribeSyncHints(() => received.push(1), {
      createChannel: channel.createChannel,
    });

    channel.createChannel("mail:sync-hints").postMessage({ type: "hint" });
    expect(received).toEqual([1]);

    unsubscribe();
  });

  it("stops firing once unsubscribed", () => {
    const channel = createFakeHintChannelFactory();
    const received: number[] = [];

    const unsubscribe = subscribeSyncHints(() => received.push(1), {
      createChannel: channel.createChannel,
    });
    unsubscribe();

    channel.createChannel("mail:sync-hints").postMessage({ type: "hint" });
    expect(received).toEqual([]);
  });

  it("is a no-op when the host has no BroadcastChannel", () => {
    expect(() => subscribeSyncHints(() => {}, { createChannel: () => null })()).not.toThrow();
  });
});
