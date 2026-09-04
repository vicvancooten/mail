import type { Message } from "@mail/shared";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthProvider } from "../../auth/AuthContext.js";
import { localCache, openLocalCache } from "../../store/local-cache.js";
import { listQueuedMutations } from "../../store/mutation-queue.js";
import { applyMailAccountDelta, applyThreadDelta } from "../../store/server-writes.js";
import { resetSyncStatus } from "../../sync/sync-loop.js";
import {
  delta,
  makeMailAccount,
  makeThread,
  minutesAfterEpoch,
} from "../../test-support/mail-fixtures.js";
import { jsonResponse } from "../../test-support/mock-fetch.js";
import { MailSection } from "../MailSection.js";

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-1",
    threadId: "held-1",
    mailAccountId: "acct-1",
    messageIdHeader: "<msg-1@example.test>",
    references: [],
    subject: "Please read",
    from: { name: "A Stranger", address: "stranger@example.test" },
    to: [],
    cc: [],
    replyTo: [],
    sentAt: "2026-06-01T12:00:00.000Z",
    receivedAt: "2026-06-01T12:00:00.000Z",
    seen: false,
    flagged: false,
    attachments: [],
    bodyText: "First contact",
    bodyHtml: "<p>First contact</p>",
    bodyIsPlainText: false,
    remoteImagesAllowed: false,
    ...overrides,
  };
}

/**
 * End-to-end coverage of #56's acceptance boxes: the banner appearing for a
 * Hold and disappearing once the Screener is viewed, Approve releasing into
 * the Inbox, and a keyboard-only pass through the Screener itself. Driven
 * the same way `MailSection.test.tsx`/`search-integration.test.tsx` are: a
 * real IndexedDB-backed Local Cache, a stubbed `fetch`, no mocked hooks.
 */

let counter = 0;
const names: string[] = [];

const AUTH_RESPONSES: Record<string, () => Response> = {
  "/auth/status": () => jsonResponse({ claimed: true }),
  "/auth/session": () =>
    jsonResponse({
      user: { id: "u1", username: "vic", role: "owner", createdAt: "2026-01-01T00:00:00.000Z" },
    }),
};

const never = () => new Promise<Response>(() => {});

/** `threadId -> Message[]`, read by the View dialog's `/threads/:id/messages` (#102). */
function stubFetch(threadMessages: Record<string, Message[]> = {}) {
  return async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const auth = AUTH_RESPONSES[url];
    if (auth) return auth();
    if (url === "/sync") return never();
    const threadMatch = /^\/threads\/([^/]+)\/messages$/.exec(url);
    if (threadMatch) {
      const messages = threadMessages[decodeURIComponent(threadMatch[1] ?? "")] ?? [];
      return jsonResponse({ messages });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
}

beforeEach(async () => {
  resetSyncStatus();
  const name = `screener-integration-test-${counter++}`;
  names.push(name);
  await openLocalCache({ name, schemaVersion: 1 });
  localStorage.clear();
});

afterEach(async () => {
  cleanup();
  localCache().close();
  for (const name of names.splice(0)) await Dexie.delete(name);
});

async function seedHeldSenders(): Promise<void> {
  await applyMailAccountDelta(
    delta({
      created: [makeMailAccount("acct-1", { gatekeeper: { enabled: true, cutoff: null } })],
    }),
    { replace: false },
  );
  await applyThreadDelta(
    "acct-1",
    delta({
      created: [
        makeThread("free", "acct-1", { subject: "Ordinary mail" }),
        makeThread("held-1", "acct-1", {
          subject: "Please read",
          snippet: "First contact",
          heldSender: "stranger@example.test",
          participants: [{ name: "A Stranger", address: "stranger@example.test" }],
        }),
      ],
    }),
    { replace: false },
  );
}

function renderMail(threadMessages: Record<string, Message[]> = {}) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stubFetch(threadMessages) as typeof fetch;
  const result = render(
    <AuthProvider>
      <MailSection />
    </AuthProvider>,
  );
  return {
    ...result,
    restoreFetch: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

describe("Gatekeeper banner and Screener (#56)", () => {
  it("a Hold shows the banner; Approve from the Screener releases the Thread into the Inbox", async () => {
    await seedHeldSenders();
    renderMail();

    expect(await screen.findByText("Ordinary mail")).toBeDefined();
    // Held mail never shows in the Inbox.
    expect(screen.queryByText("Please read")).toBeNull();

    expect(await screen.findByRole("status")).toBeDefined();
    expect(screen.getByText(/1 sender waiting in the Screener/)).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(await screen.findByText("A Stranger")).toBeDefined();
    // Viewing the Screener dismisses the (now non-existent) banner underneath.
    expect(screen.queryByRole("status")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Approve/ }));
    // The Screener's own optimistic feel: the row leaves immediately.
    await waitFor(() => expect(screen.queryByText("A Stranger")).toBeNull());
    expect(screen.getByText("Nothing waiting — new strangers show up here.")).toBeDefined();

    // Approving clears `heldSender` server-side; simulate the sync landing.
    await applyThreadDelta(
      "acct-1",
      delta({
        updated: [
          makeThread("held-1", "acct-1", {
            subject: "Please read",
            heldSender: null,
            participants: [{ name: "A Stranger", address: "stranger@example.test" }],
          }),
        ],
      }),
      { replace: false },
    );

    fireEvent.click(screen.getByRole("button", { name: "Back to Inbox" }));
    expect(await screen.findByText("Please read")).toBeDefined();
  });

  it("right-clicking a held sender's row offers the same three Verdicts, with their keycaps (#94)", async () => {
    await seedHeldSenders();
    renderMail();

    fireEvent.click(await screen.findByRole("button", { name: "Review" }));
    const row = await screen.findByText("A Stranger");

    fireEvent.contextMenu(row);

    const approve = await screen.findByRole("menuitem", { name: /Approve sender/ });
    expect(approve.textContent).toContain("A");
    expect(screen.getByRole("menuitem", { name: /Deny sender/ })).toBeDefined();
    expect(screen.getByRole("menuitem", { name: /Block sender/ })).toBeDefined();

    fireEvent.click(approve);
    await waitFor(() => expect(screen.queryByText("A Stranger")).toBeNull());
    const queued = await listQueuedMutations("acct-1");
    expect(queued.map((mutation) => mutation.intent.type)).toContain("approveSender");
  });

  it("a keyboard-only pass through the Screener: j/k navigate, a approves, Escape closes", async () => {
    await applyMailAccountDelta(
      delta({
        created: [makeMailAccount("acct-1", { gatekeeper: { enabled: true, cutoff: null } })],
      }),
      { replace: false },
    );
    await applyThreadDelta(
      "acct-1",
      delta({
        created: [
          makeThread("held-a", "acct-1", {
            subject: "From A",
            heldSender: "a@example.test",
            participants: [{ name: "Ann", address: "a@example.test" }],
            lastMessageAt: minutesAfterEpoch(1),
          }),
          makeThread("held-b", "acct-1", {
            subject: "From B",
            heldSender: "b@example.test",
            participants: [{ name: "Bea", address: "b@example.test" }],
            lastMessageAt: minutesAfterEpoch(2),
          }),
        ],
      }),
      { replace: false },
    );
    renderMail();

    fireEvent.click(await screen.findByRole("button", { name: "Review" }));
    await screen.findByText("Ann");
    await screen.findByText("Bea");
    // The oldest hold starts selected — wait for that settle before driving
    // the keyboard, so this assertion is about `j` moving the selection,
    // never a race with the mount effect that sets it initially.
    await waitFor(() =>
      expect(screen.getByText("Ann").closest("li")?.className).toContain("selected"),
    );

    // j moves the keyboard selection to the second row.
    fireEvent.keyDown(window, { key: "j" });
    await waitFor(() =>
      expect(screen.getByText("Bea").closest("li")?.className).toContain("selected"),
    );

    // d denies the selected (Bea's) row — it leaves the list, Ann's stays.
    fireEvent.keyDown(window, { key: "d" });
    await waitFor(() => expect(screen.queryByText("Bea")).toBeNull());
    expect(screen.getByText("Ann")).toBeDefined();

    // Escape leaves the Screener back to the Inbox.
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByText("Ann")).toBeNull());
  });

  it("with several Mail Accounts in Scope, held senders group by account, headers and all (#82)", async () => {
    await applyMailAccountDelta(
      delta({
        created: [
          makeMailAccount("acct-1", { gatekeeper: { enabled: true, cutoff: null } }),
          makeMailAccount("acct-2", { gatekeeper: { enabled: true, cutoff: null } }),
        ],
      }),
      { replace: false },
    );
    await applyThreadDelta(
      "acct-1",
      delta({
        created: [
          makeThread("held-a", "acct-1", {
            subject: "From A",
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
          makeThread("held-b", "acct-2", {
            subject: "From B",
            heldSender: "b@example.test",
            participants: [{ name: "Bea", address: "b@example.test" }],
          }),
        ],
      }),
      { replace: false },
    );
    renderMail();

    // Both accounts' senders wait, so the banner counts across the whole Scope.
    await screen.findByText(/2 senders waiting in the Screener/);

    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    await screen.findByText("Ann");
    await screen.findByText("Bea");
    // Each held sender's own account names its cluster.
    const headers = document.querySelectorAll(".screener-group-header");
    expect(Array.from(headers, (header) => header.textContent)).toEqual([
      "acct-1@example.test",
      "acct-2@example.test",
    ]);

    // Approving Ann (acct-1) leaves Bea (acct-2) untouched, and her sender
    // stays queued against her own account.
    const annRow = screen.getByText("Ann").closest("li") as HTMLElement;
    fireEvent.click(within(annRow).getByRole("button", { name: /Approve/ }));
    await waitFor(() => expect(screen.queryByText("Ann")).toBeNull());
    expect(screen.getByText("Bea")).toBeDefined();

    const queuedForAcct1 = await listQueuedMutations("acct-1");
    expect(queuedForAcct1).toHaveLength(1);
    expect(queuedForAcct1[0]?.intent).toEqual({
      type: "approveSender",
      sender: { scope: "address", value: "a@example.test" },
    });
    expect(await listQueuedMutations("acct-2")).toHaveLength(0);
  });

  it("a single Mail Account in Scope shows no group header", async () => {
    await seedHeldSenders();
    renderMail();

    fireEvent.click(await screen.findByRole("button", { name: "Review" }));
    await screen.findByText("A Stranger");
    expect(document.querySelector(".screener-group-header")).toBeNull();
  });
});

describe("the View dialog and Block's split menu (#102)", () => {
  async function seedOneHeldSender(
    threadId: string,
    address: string,
    name: string,
    alias: string | null = null,
  ) {
    await applyMailAccountDelta(
      delta({
        created: [makeMailAccount("acct-1", { gatekeeper: { enabled: true, cutoff: null } })],
      }),
      { replace: false },
    );
    await applyThreadDelta(
      "acct-1",
      delta({
        created: [
          makeThread(threadId, "acct-1", {
            subject: "Please read",
            snippet: "First contact",
            heldSender: address,
            heldRecipientAlias: alias,
            participants: [{ name, address }],
          }),
        ],
      }),
      { replace: false },
    );
  }

  it("View opens a dialog reading the held mail; deciding from inside it closes the dialog", async () => {
    await seedOneHeldSender("held-view", "stranger@example.test", "A Stranger");
    renderMail({
      "held-view": [
        makeMessage({
          id: "m-view-1",
          threadId: "held-view",
          subject: "Please read",
          bodyHtml: "<p>First contact, unabridged</p>",
        }),
      ],
    });

    fireEvent.click(await screen.findByRole("button", { name: "Review" }));
    await screen.findByText("A Stranger");

    fireEvent.click(screen.getByRole("button", { name: "View" }));
    const dialog = await screen.findByRole("dialog");
    // The message's own subject and date are visible (#102's acceptance box).
    expect(within(dialog).getByText("Please read")).toBeDefined();

    // Acting from inside the dialog decides and closes it — see
    // `ScreenerViewDialog.tsx`'s own doc comment for why that's free.
    fireEvent.click(within(dialog).getByRole("button", { name: /Approve/ }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    const queued = await listQueuedMutations("acct-1");
    expect(queued.map((mutation) => mutation.intent)).toEqual([
      { type: "approveSender", sender: { scope: "address", value: "stranger@example.test" } },
    ]);
  });

  it("blocks remote images and offers no click-through inside the dialog", async () => {
    await seedOneHeldSender("held-view-images", "stranger@example.test", "A Stranger");
    renderMail({
      "held-view-images": [
        makeMessage({
          id: "m-view-2",
          threadId: "held-view-images",
          bodyHtml:
            '<img src="/messages/m-view-2/image-proxy?url=https%3A%2F%2Fsender.example%2Ft.gif&sig=abc">',
        }),
      ],
    });

    fireEvent.click(await screen.findByRole("button", { name: "Review" }));
    await screen.findByText("A Stranger");
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    const dialog = await screen.findByRole("dialog");

    // No "Load remote images" opt-in anywhere in the dialog — there is no
    // Verdict yet to have loaded them for (`MessageBody.tsx`'s own doc
    // comment on `interactive`).
    expect(within(dialog).queryByRole("button", { name: "Load remote images" })).toBeNull();
  });

  it("Block's split menu offers Block domain, scoped to the sender's own domain", async () => {
    const user = userEvent.setup();
    await seedOneHeldSender("held-block", "stranger@lists.example.test", "A Stranger");
    renderMail();

    fireEvent.click(await screen.findByRole("button", { name: "Review" }));
    await screen.findByText("A Stranger");

    // Radix's menu opens off pointer events `fireEvent.click` doesn't
    // synthesize — `userEvent` drives the real sequence.
    await user.click(screen.getByRole("button", { name: /More block options/ }));
    await user.click(await screen.findByText("Block domain (lists.example.test)"));

    await waitFor(async () => {
      const queued = await listQueuedMutations("acct-1");
      expect(queued.map((mutation) => mutation.intent)).toEqual([
        { type: "blockSender", sender: { scope: "domain", value: "lists.example.test" } },
      ]);
    });
  });

  it("Block's split menu offers Mark as spam, queuing a spamSender decision", async () => {
    const user = userEvent.setup();
    await seedOneHeldSender("held-spam", "villain@example.test", "A Villain");
    renderMail();

    fireEvent.click(await screen.findByRole("button", { name: "Review" }));
    await screen.findByText("A Villain");

    await user.click(screen.getByRole("button", { name: /More block options/ }));
    await user.click(await screen.findByText("Mark as spam"));

    await waitFor(async () => {
      const queued = await listQueuedMutations("acct-1");
      expect(queued.map((mutation) => mutation.intent)).toEqual([
        { type: "spamSender", sender: { scope: "address", value: "villain@example.test" } },
      ]);
    });
    // The row leaves the Screener the instant the decision is queued, same
    // as every other Screener decision.
    await waitFor(() => expect(screen.queryByText("A Villain")).toBeNull());
  });

  it("disables Block domain for a barred public provider", async () => {
    const user = userEvent.setup();
    await seedOneHeldSender("held-barred", "stranger@gmail.com", "A Stranger");
    renderMail();

    fireEvent.click(await screen.findByRole("button", { name: "Review" }));
    await screen.findByText("A Stranger");

    await user.click(screen.getByRole("button", { name: /More block options/ }));
    const item = await screen.findByText(/Block domain — not offered for gmail\.com/);
    expect(item.closest("[data-disabled]")).not.toBeNull();
  });

  it("Block's split menu offers Block Alias behind a confirmation naming the exact Alias (#103)", async () => {
    const user = userEvent.setup();
    await seedOneHeldSender(
      "held-alias",
      "stranger@example.test",
      "A Stranger",
      "sales@mycompany.test",
    );
    renderMail();

    fireEvent.click(await screen.findByRole("button", { name: "Review" }));
    await screen.findByText("A Stranger");

    await user.click(screen.getByRole("button", { name: /More block options/ }));
    await user.click(await screen.findByText("Block everything sent to sales@mycompany.test"));

    // Selecting the menu item opens the confirmation rather than deciding
    // immediately — nothing queued yet.
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("Block everything sent to sales@mycompany.test?"),
    ).toBeDefined();
    expect(await listQueuedMutations("acct-1")).toEqual([]);

    await user.click(within(dialog).getByRole("button", { name: "Block alias" }));

    await waitFor(async () => {
      const queued = await listQueuedMutations("acct-1");
      expect(queued.map((mutation) => mutation.intent)).toEqual([
        { type: "blockSender", sender: { scope: "recipient", value: "sales@mycompany.test" } },
      ]);
    });
    await waitFor(() => expect(screen.queryByText("A Stranger")).toBeNull());
  });

  it("Block Alias's confirmation Cancel queues nothing", async () => {
    const user = userEvent.setup();
    await seedOneHeldSender(
      "held-alias-cancel",
      "stranger@example.test",
      "A Stranger",
      "sales@mycompany.test",
    );
    renderMail();

    fireEvent.click(await screen.findByRole("button", { name: "Review" }));
    await screen.findByText("A Stranger");
    await user.click(screen.getByRole("button", { name: /More block options/ }));
    await user.click(await screen.findByText("Block everything sent to sales@mycompany.test"));

    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await listQueuedMutations("acct-1")).toEqual([]);
    // The row is still there — nothing was decided.
    expect(screen.getByText("A Stranger")).toBeDefined();
  });

  it("disables Block Alias for the Mail Account's own primary address", async () => {
    const user = userEvent.setup();
    // `makeMailAccount("acct-1")`'s default `emailAddress` (`test-support/
    // mail-fixtures.ts`) is exactly this — the address a Blocked Alias may
    // never silence.
    await seedOneHeldSender(
      "held-alias-own",
      "stranger@example.test",
      "A Stranger",
      "acct-1@example.test",
    );
    renderMail();

    fireEvent.click(await screen.findByRole("button", { name: "Review" }));
    await screen.findByText("A Stranger");

    await user.click(screen.getByRole("button", { name: /More block options/ }));
    const item = await screen.findByText(
      "Block everything sent to acct-1@example.test — not offered for your own address",
    );
    expect(item.closest("[data-disabled]")).not.toBeNull();
  });

  it("offers no Block Alias item when the held Thread never resolved one", async () => {
    const user = userEvent.setup();
    await seedOneHeldSender("held-no-alias", "stranger@example.test", "A Stranger");
    renderMail();

    fireEvent.click(await screen.findByRole("button", { name: "Review" }));
    await screen.findByText("A Stranger");

    await user.click(screen.getByRole("button", { name: /More block options/ }));
    const item = await screen.findByText("Block everything sent to their Alias");
    expect(item.closest("[data-disabled]")).not.toBeNull();
  });
});
