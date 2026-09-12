import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localCache, openLocalCache } from "../store/local-cache.js";
import { applyMailAccountDelta, applyThreadDelta } from "../store/server-writes.js";
import { delta, makeMailAccount, makeThread } from "../test-support/mail-fixtures.js";
import { NOOP_TRIAGE } from "./actions/types.js";
import { ThreadDetailPane } from "./ThreadDetailPane.js";

/**
 * A held Thread never appears in `MailSection`'s own row list — its
 * `!thread.heldSender` filter feeds `useThreadWindow`, which is what
 * `activeSelectedThread` reads from — so `MailSection.test.tsx`'s own render
 * seam has no route to open one in the Reader. This file mounts the Reader
 * pane directly instead (no `ActionsProvider` above it, the standalone
 * context path its own doc comment describes), the more precise render seam
 * for the Mail group overflow's own gating rule (#289).
 */

const names: string[] = [];
let counter = 0;

beforeEach(async () => {
  const name = `thread-detail-pane-test-${counter++}`;
  names.push(name);
  await openLocalCache({ name, schemaVersion: 1 });
});

afterEach(async () => {
  cleanup();
  localCache().close();
  for (const name of names.splice(0)) await Dexie.delete(name);
});

describe("Approve in the Mail group's overflow (#289)", () => {
  it("is absent for an ordinary Inbox Thread", async () => {
    await applyMailAccountDelta(delta({ created: [makeMailAccount("acct-1")] }), {
      replace: false,
    });
    const wireThread = makeThread("t1", "acct-1", {
      subject: "Ordinary thread",
      heldSender: null,
    });
    await applyThreadDelta("acct-1", delta({ created: [wireThread] }), { replace: false });
    const thread = { ...wireThread, sortKey: "t1" };

    render(
      <ThreadDetailPane
        thread={thread}
        triage={NOOP_TRIAGE}
        onReply={vi.fn()}
        onMailtoLink={vi.fn()}
        onOpenTask={vi.fn()}
      />,
    );

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /More actions for "Ordinary/ }));
    expect(screen.queryByRole("menuitem", { name: "Approve" })).toBeNull();
  });

  it("shows up once the Thread is under Screening Hold", async () => {
    await applyMailAccountDelta(delta({ created: [makeMailAccount("acct-1")] }), {
      replace: false,
    });
    const wireThread = makeThread("t1", "acct-1", {
      subject: "Held thread",
      heldSender: "stranger@example.test",
    });
    await applyThreadDelta("acct-1", delta({ created: [wireThread] }), { replace: false });
    const thread = { ...wireThread, sortKey: "t1" };

    render(
      <ThreadDetailPane
        thread={thread}
        triage={NOOP_TRIAGE}
        onReply={vi.fn()}
        onMailtoLink={vi.fn()}
        onOpenTask={vi.fn()}
      />,
    );

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /More actions for "Held/ }));
    expect(await screen.findByRole("menuitem", { name: "Approve" })).toBeDefined();
  });
});
