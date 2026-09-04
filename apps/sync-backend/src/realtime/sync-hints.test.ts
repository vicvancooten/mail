import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { createDb, Db } from "../db/client.js";
import { mailAccounts, threads } from "../db/schema.js";
import { createTestDb, resetTestDb } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import { createSyncHintBroker, type SyncHintBroker } from "./sync-hints.js";

/**
 * ADR-0015's fanout, exercised against a real Postgres `LISTEN/NOTIFY` — the
 * whole point is that migration 0016's trigger fires the moment a
 * transaction commits, which no mock of `sql.listen` would prove.
 */

let created: Awaited<ReturnType<typeof createDb>>;
let db: Db;
let broker: SyncHintBroker;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForBrokerReady(currentBroker: SyncHintBroker): Promise<void> {
  const account = await createTestMailAccount(db);
  let ready = false;
  const unsubscribe = currentBroker.subscribe(account.userId, () => {
    ready = true;
  });
  const deadline = Date.now() + 2_000;
  while (!ready && Date.now() < deadline) {
    await db.insert(threads).values({ id: randomUUID(), mailAccountId: account.id });
    await wait(50);
  }
  unsubscribe();
  await resetTestDb(db);
  if (!ready) throw new Error("sync hint broker never observed a LISTEN/NOTIFY round trip");
}

beforeEach(async () => {
  created = await createTestDb();
  db = created.db;
  await resetTestDb(db);
  broker = createSyncHintBroker(created.sql, { coalesceMs: 30 });
  await waitForBrokerReady(broker);
});

afterEach(async () => {
  await broker.stop();
});

afterAll(async () => {
  await created.sql.end();
});

/** Resolves the next time `fn` is called, or rejects after `timeoutMs`. */
function waitForCall(timeoutMs = 2_000): { fn: () => void; promise: Promise<void> } {
  let resolve!: () => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    setTimeout(() => rej(new Error(`no hint within ${timeoutMs}ms`)), timeoutMs);
  });
  return { fn: () => resolve(), promise };
}

describe("createSyncHintBroker", () => {
  it("dispatches a hint to a subscribed User when a Thread row changes", async () => {
    const account = await createTestMailAccount(db);
    const { fn, promise } = waitForCall();
    const unsubscribe = broker.subscribe(account.userId, fn);

    await db.insert(threads).values({ id: randomUUID(), mailAccountId: account.id });

    await promise;
    unsubscribe();
  });

  it("never dispatches to a User with no subscriber", async () => {
    const account = await createTestMailAccount(db);
    let called = false;
    const other = randomUUID();
    const unsubscribe = broker.subscribe(other, () => {
      called = true;
    });

    await db.insert(threads).values({ id: randomUUID(), mailAccountId: account.id });
    // Give the real LISTEN connection a moment to have delivered it, if it
    // were (wrongly) going to.
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(called).toBe(false);
    unsubscribe();
  });

  it("stops delivering once unsubscribed", async () => {
    const account = await createTestMailAccount(db);
    let calls = 0;
    const unsubscribe = broker.subscribe(account.userId, () => {
      calls++;
    });
    unsubscribe();

    await db.insert(threads).values({ id: randomUUID(), mailAccountId: account.id });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(calls).toBe(0);
  });

  it("coalesces a burst of separate transactions to a leading dispatch plus one trailing one", async () => {
    await broker.stop();
    broker = createSyncHintBroker(created.sql, { coalesceMs: 200 });
    await waitForBrokerReady(broker);

    const account = await createTestMailAccount(db);
    const calls: number[] = [];
    const unsubscribe = broker.subscribe(account.userId, () => {
      calls.push(Date.now());
    });

    // Five separate transactions, well inside the 200ms coalescing window —
    // even on slower shared CI runners.
    for (let i = 0; i < 5; i++) {
      await db.insert(threads).values({ id: randomUUID(), mailAccountId: account.id });
    }

    // Wait past two cooldown windows: the leading dispatch, then the one
    // trailing dispatch the mid-window notifies collapse into.
    await wait(500);

    expect(calls.length).toBe(2);
    unsubscribe();
  });

  it("delivers one NOTIFY for a transaction that touches several sync-tracked rows for the same User", async () => {
    // A generously long cooldown, so any *second* delivery within it can
    // only be Postgres itself failing to fold the two same-channel,
    // same-payload NOTIFYs together — not this broker's own app-level
    // coalescing kicking in and masking the difference.
    const longCoalesceBroker = createSyncHintBroker(created.sql, { coalesceMs: 500 });
    await waitForBrokerReady(longCoalesceBroker);
    const account = await createTestMailAccount(db);
    let calls = 0;
    const unsubscribe = longCoalesceBroker.subscribe(account.userId, () => {
      calls++;
    });

    await db.transaction(async (tx) => {
      await tx.insert(threads).values({ id: randomUUID(), mailAccountId: account.id });
      await tx.update(mailAccounts).set({ signature: "hi" }).where(eq(mailAccounts.id, account.id));
    });

    // Long enough to prove a second delivery never lands, short enough to
    // stay well inside the 500ms cooldown the leading dispatch just opened.
    await wait(250);

    expect(calls).toBe(1);
    unsubscribe();
    await longCoalesceBroker.stop();
  });
});
