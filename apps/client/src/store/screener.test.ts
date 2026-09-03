import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  delta,
  makeMailAccount,
  makeThread,
  minutesAfterEpoch,
} from "../test-support/mail-fixtures.js";
import { localCache, openLocalCache } from "./local-cache.js";
import { enqueueMutation } from "./mutation-queue.js";
import { readScreenerSenders, readThreadWindow } from "./reads.js";
import { applyMailAccountDelta, applyThreadDelta } from "./server-writes.js";

/** `readScreenerSenders` groups by account (#82); most tests here only ever
 * populate one, so this is the shorthand for "that one account's rows". */
async function screenerSenders(mailAccountId: string) {
  const groups = await readScreenerSenders([mailAccountId]);
  return groups.find((group) => group.mailAccountId === mailAccountId)?.senders ?? [];
}

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

    const groups = await screenerSenders(ACCOUNT);
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

    const groups = await screenerSenders(ACCOUNT);
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
    expect(await screenerSenders(ACCOUNT)).toHaveLength(1);

    await enqueueMutation(
      { type: "approveSender", sender: { scope: "address", value: "s@example.test" } },
      ACCOUNT,
    );

    expect(await screenerSenders(ACCOUNT)).toHaveLength(0);
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

    const groups = await screenerSenders(ACCOUNT);
    expect(groups.map((g) => g.address)).toEqual(["unrelated@other.test"]);
  });

  it("groups held senders by Mail Account across Scope, in Scope order (#82)", async () => {
    await applyMailAccountDelta(
      delta({
        created: [makeMailAccount("acct-1"), makeMailAccount("acct-2")],
      }),
      { replace: false },
    );
    await applyThreadDelta(
      "acct-1",
      delta({
        created: [
          makeThread("t1", "acct-1", {
            heldSender: "a@example.test",
            participants: [{ name: "Ann", address: "a@example.test" }],
          }),
        ],
      }),
      { replace: false },
    );
    await applyThreadDelta(
      "acct-2",
      delta({
        created: [
          makeThread("t2", "acct-2", {
            heldSender: "b@example.test",
            participants: [{ name: "Bea", address: "b@example.test" }],
          }),
        ],
      }),
      { replace: false },
    );

    const groups = await readScreenerSenders(["acct-1", "acct-2"]);
    expect(groups.map((group) => group.mailAccountId)).toEqual(["acct-1", "acct-2"]);
    expect(groups[0]?.accountEmail).toBe("acct-1@example.test");
    expect(groups[0]?.senders.map((sender) => sender.address)).toEqual(["a@example.test"]);
    expect(groups[1]?.senders.map((sender) => sender.address)).toEqual(["b@example.test"]);

    // A decision on one account's sender never touches the other's.
    await enqueueMutation(
      { type: "approveSender", sender: { scope: "address", value: "a@example.test" } },
      "acct-1",
    );
    const afterDecision = await readScreenerSenders(["acct-1", "acct-2"]);
    // acct-1 has nothing left, so it drops out of the result entirely —
    // there is no empty section to show.
    expect(afterDecision.map((group) => group.mailAccountId)).toEqual(["acct-2"]);
  });
});
