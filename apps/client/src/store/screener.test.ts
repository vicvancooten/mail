import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { delta, makeThread, minutesAfterEpoch } from "../test-support/mail-fixtures.js";
import { localCache, openLocalCache } from "./local-cache.js";
import { enqueueMutation } from "./mutation-queue.js";
import { readScreenerSenders, readThreadWindow } from "./reads.js";
import { applyThreadDelta } from "./server-writes.js";

/**
 * The Screener's own grouping logic (#56, poc-spec.md §Gatekeeper v1) and
 * the Inbox's exclusion of held Threads (#55's `heldSender`, ADR-0008).
 */

const ACCOUNT = "acct-1";
let counter = 0;
const names: string[] = [];

beforeEach(async () => {
  const name = `screener-test-${counter++}`;
  names.push(name);
  await openLocalCache({ name, schemaVersion: 1 });
});

afterEach(async () => {
  localCache().close();
  for (const name of names.splice(0)) await Dexie.delete(name);
});

describe("readThreadWindow", () => {
  it("excludes a held Thread from the Inbox even though inInbox stays true", async () => {
    await applyThreadDelta(
      ACCOUNT,
      delta({
        created: [
          makeThread("free", ACCOUNT, { subject: "Ordinary mail" }),
          makeThread("held", ACCOUNT, {
            subject: "Stranger's mail",
            heldSender: "stranger@example.test",
          }),
        ],
      }),
      { replace: false },
    );

    const page = await readThreadWindow(ACCOUNT);
    expect(page.threads.map((t) => t.id)).toEqual(["free"]);
  });
});

describe("readScreenerSenders", () => {
  it("groups held Threads by sender, oldest hold first", async () => {
    await applyThreadDelta(
      ACCOUNT,
      delta({
        created: [
          makeThread("t-b", ACCOUNT, {
            subject: "From B",
            heldSender: "b@example.test",
            participants: [{ name: "Bea", address: "b@example.test" }],
            lastMessageAt: minutesAfterEpoch(5),
          }),
          makeThread("t-a", ACCOUNT, {
            subject: "From A",
            heldSender: "a@example.test",
            participants: [{ name: "Ann", address: "a@example.test" }],
            lastMessageAt: minutesAfterEpoch(1),
          }),
        ],
      }),
      { replace: false },
    );

    const groups = await readScreenerSenders(ACCOUNT);
    expect(groups.map((g) => g.address)).toEqual(["a@example.test", "b@example.test"]);
    expect(groups[0]?.name).toBe("Ann");
  });

  it("collapses a sender's several held Threads into one row, peeking the most recent", async () => {
    await applyThreadDelta(
      ACCOUNT,
      delta({
        created: [
          makeThread("t-old", ACCOUNT, {
            subject: "First message",
            snippet: "Hi there",
            heldSender: "s@example.test",
            lastMessageAt: minutesAfterEpoch(1),
          }),
          makeThread("t-new", ACCOUNT, {
            subject: "Second message",
            snippet: "Following up",
            heldSender: "s@example.test",
            lastMessageAt: minutesAfterEpoch(5),
          }),
        ],
      }),
      { replace: false },
    );

    const groups = await readScreenerSenders(ACCOUNT);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.threadCount).toBe(2);
    expect(groups[0]?.subject).toBe("Second message");
    expect(groups[0]?.heldSince).toBe(minutesAfterEpoch(1));
  });

  it("drops a sender's row the instant a decision is queued for them", async () => {
    await applyThreadDelta(
      ACCOUNT,
      delta({
        created: [makeThread("t1", ACCOUNT, { heldSender: "s@example.test" })],
      }),
      { replace: false },
    );
    expect(await readScreenerSenders(ACCOUNT)).toHaveLength(1);

    await enqueueMutation(
      { type: "approveSender", sender: { scope: "address", value: "s@example.test" } },
      ACCOUNT,
    );

    expect(await readScreenerSenders(ACCOUNT)).toHaveLength(0);
  });

  it("a domain decision clears every held address under that domain", async () => {
    await applyThreadDelta(
      ACCOUNT,
      delta({
        created: [
          makeThread("t1", ACCOUNT, { heldSender: "one@lists.example.test" }),
          makeThread("t2", ACCOUNT, { heldSender: "two@lists.example.test" }),
          makeThread("t3", ACCOUNT, { heldSender: "unrelated@other.test" }),
        ],
      }),
      { replace: false },
    );

    await enqueueMutation(
      { type: "blockSender", sender: { scope: "domain", value: "lists.example.test" } },
      ACCOUNT,
    );

    const groups = await readScreenerSenders(ACCOUNT);
    expect(groups.map((g) => g.address)).toEqual(["unrelated@other.test"]);
  });
});
