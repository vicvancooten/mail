import type { SearchRequest, SearchResponse } from "@mail/shared";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../../auth/AuthContext.js";
import { localCache, openLocalCache } from "../../store/local-cache.js";
import { listQueuedMutations, resolveMutationOutcomes } from "../../store/mutation-queue.js";
import { applyMailAccountDelta, applyThreadDelta } from "../../store/server-writes.js";
import { resetSyncStatus } from "../../sync/sync-loop.js";
import { delta, makeMailAccount, makeThread } from "../../test-support/mail-fixtures.js";
import { jsonResponse } from "../../test-support/mock-fetch.js";
import { MailSection } from "../MailSection.js";

/**
 * End-to-end coverage of #51's acceptance boxes, driven the way
 * `MailSection.test.tsx` and `RollbackToast.test.tsx` already do: a real
 * IndexedDB-backed Local Cache, a stubbed `fetch`, and the real
 * `mutation-queue.ts`/`overlayPendingMutations` mechanism for rollback —
 * never a mocked `useTriage` or `useSearchState`.
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

/** Serves the auth bootstrap normally, hands `/sync` to `never` (never resolves) and `POST /search` to `search` — handed the request's own `init` so a test can inspect the body it sent. */
function stubFetch(search: (init?: RequestInit) => Promise<Response>) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const auth = AUTH_RESPONSES[url];
      if (auth) return Promise.resolve(auth());
      if (url === "/sync") return never();
      if (url === "/search") return search(init);
      throw new Error(`Unexpected fetch: ${url}`);
    }),
  );
}

function emptySearchResponse(): SearchResponse {
  return { results: [], cursor: null, indexWatermark: { coveredSince: null, complete: true } };
}

beforeEach(async () => {
  resetSyncStatus();
  const name = `search-integration-test-${counter++}`;
  names.push(name);
  await openLocalCache({ name, schemaVersion: 1 });
  localStorage.clear();
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  localCache().close();
  for (const name of names.splice(0)) await Dexie.delete(name);
});

async function seedOneThread(): Promise<void> {
  await applyMailAccountDelta(delta({ created: [makeMailAccount("acct-1")] }), { replace: false });
  await applyThreadDelta(
    "acct-1",
    delta({ created: [makeThread("t1", "acct-1", { subject: "Origin thread" })] }),
    { replace: false },
  );
}

function renderMail() {
  return render(
    <AuthProvider>
      <MailSection />
    </AuthProvider>,
  );
}

describe("search (#51)", () => {
  it("`/` opens search and focuses the field; typing renders results from POST /search", async () => {
    await seedOneThread();
    const searchResponse: SearchResponse = {
      results: [
        {
          thread: makeThread("t-remote", "acct-1", { subject: "Invoice March" }),
          matchedMessageId: "t-remote-msg",
          headline: "please see the \x01invoice\x02 attached",
          folder: { id: "f1", name: "Archive", role: "archive" },
          gatekeeper: null,
        },
      ],
      cursor: null,
      indexWatermark: { coveredSince: null, complete: true },
    };
    stubFetch(() => Promise.resolve(jsonResponse(searchResponse)));

    renderMail();
    await screen.findByText("Origin thread");

    fireEvent.keyDown(window, { key: "/" });
    const field = await screen.findByLabelText<HTMLInputElement>("Search mail");
    expect(document.activeElement).toBe(field);

    fireEvent.change(field, { target: { value: "invoice" } });

    // The server round trip replaces the list with its own result — the
    // folder pill and the `ts_headline` fragment are both server-only, so
    // their presence proves this came from `POST /search`, not the prefilter.
    expect(await screen.findByText("Invoice March")).toBeDefined();
    expect(await screen.findByText("Archive", { selector: ".folder-pill" })).toBeDefined();
    expect(screen.getByText("invoice", { selector: "mark" })).toBeDefined();
  });

  it("offline: the prefilter result set renders labeled as such, with no Load older affordance", async () => {
    await seedOneThread();
    stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));

    renderMail();
    await screen.findByText("Origin thread");

    fireEvent.keyDown(window, { key: "/" });
    const field = await screen.findByLabelText<HTMLInputElement>("Search mail");
    fireEvent.change(field, { target: { value: "origin" } });

    // The Local Cache prefilter *is* the result set offline (search-ux-
    // spec.md §Degraded states) — the seeded Thread still renders.
    expect(await screen.findByText("Origin thread")).toBeDefined();
    expect(await screen.findByText(/Offline/)).toBeDefined();
    expect(screen.queryByText("Load older results")).toBeNull();
  });

  it("Needs Reauth: the reconnect banner names the account and persists even with zero results", async () => {
    await applyMailAccountDelta(
      delta({ created: [makeMailAccount("acct-1", { status: "needs_reauth" })] }),
      { replace: false },
    );
    // Deliberately no seeded Thread — the banner must render even when the
    // Local Cache prefilter itself comes back empty (search-ux-spec.md
    // §Offline/degraded states: "a persistent strip").
    stubFetch(() => Promise.resolve(jsonResponse(emptySearchResponse())));

    renderMail();
    // No Thread to wait for (deliberately none seeded) — wait for the top
    // bar itself to settle instead, or `/` can fire before `searchInputRef`
    // is attached to anything and land on nothing.
    await screen.findByRole("button", { name: "Compose" });
    fireEvent.keyDown(window, { key: "/" });
    const field = await screen.findByLabelText<HTMLInputElement>("Search mail");
    fireEvent.change(field, { target: { value: "nothing matches this" } });

    expect(
      await screen.findByText("Reconnect acct-1@example.test to search all mail"),
    ).toBeDefined();
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeDefined();
  });

  it("Esc on an empty field leaves search and restores the origin's selection", async () => {
    await seedOneThread();
    stubFetch(() => Promise.resolve(jsonResponse(emptySearchResponse())));

    renderMail();
    const row = await screen.findByText("Origin thread");
    fireEvent.click(row); // select it in the origin (Split) view

    fireEvent.keyDown(window, { key: "/" });
    const field = await screen.findByLabelText<HTMLInputElement>("Search mail");
    expect(field).toBeDefined();

    // Esc on an empty field leaves outright — no text to clear first.
    fireEvent.keyDown(field, { key: "Escape" });

    // Back in the origin view (the chip row is search-only) — still on the
    // same Thread — `.thread-detail` rather than the row text alone, since
    // the row also renders it.
    await waitFor(() => expect(document.querySelector(".search-chip-row")).toBeNull());
    const detail = await screen.findByText("Origin thread", { selector: ".reading-subject" });
    expect(detail).toBeDefined();
  });

  it("the results view's own Close restores the origin, same as Esc (#100)", async () => {
    await seedOneThread();
    stubFetch(() => Promise.resolve(jsonResponse(emptySearchResponse())));

    renderMail();
    const row = await screen.findByText("Origin thread");
    fireEvent.click(row);

    fireEvent.keyDown(window, { key: "/" });
    const field = await screen.findByLabelText<HTMLInputElement>("Search mail");
    fireEvent.change(field, { target: { value: "nothing" } });
    expect(document.querySelector(".search-chip-row")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Close search results" }));

    await waitFor(() => expect(document.querySelector(".search-chip-row")).toBeNull());
    expect(
      await screen.findByText("Origin thread", { selector: ".reading-subject" }),
    ).toBeDefined();
  });

  it("archiving a result row: it stays, visibly changed, and a rejection rolls it back", async () => {
    await seedOneThread();
    const remoteThread = makeThread("t-remote", "acct-1", {
      subject: "Remote result",
      inInbox: true,
    });
    const searchResponse: SearchResponse = {
      results: [
        {
          thread: remoteThread,
          matchedMessageId: "t-remote-msg",
          headline: null,
          folder: { id: "f1", name: "Inbox", role: "inbox" },
          gatekeeper: null,
        },
      ],
      cursor: null,
      indexWatermark: { coveredSince: null, complete: true },
    };
    stubFetch(() => Promise.resolve(jsonResponse(searchResponse)));

    renderMail();
    await screen.findByText("Origin thread");

    fireEvent.keyDown(window, { key: "/" });
    const field = await screen.findByLabelText<HTMLInputElement>("Search mail");
    fireEvent.change(field, { target: { value: "remote" } });
    await screen.findByText("Remote result");

    // Split mode: selecting a result opens it in the reading pane without
    // leaving the results list (search-ux-spec.md §The surface) — its
    // Archive button is triage's real mouse affordance today.
    fireEvent.click(screen.getByText("Remote result"));
    // The reading pane's own Done control, named in full — the result rows
    // behind it each carry a Done control too (`Mark "…" Done`), and the
    // sidebar (#74) has an "Archive" nav entry, so only this accessible name
    // picks out exactly one button.
    const archiveButton = await screen.findByRole("button", {
      name: "Done — archive this thread",
    });
    fireEvent.click(archiveButton);

    // The row stays — still in the results list — but visibly changed.
    await waitFor(() => expect(screen.getByText("Removed")).toBeDefined());
    expect(screen.getAllByText("Remote result").length).toBeGreaterThan(0);
    expect(await localCache().threads.get("t-remote")).toBeDefined(); // materialized

    // Reject the queued mutation the same way `RollbackToast.test.tsx` does
    // — the real `mutation-queue.ts` mechanism, not a mock.
    const queued = await listQueuedMutations("acct-1");
    expect(queued).toHaveLength(1);
    const [mutation] = queued;
    if (!mutation) throw new Error("expected a queued mutation");
    await resolveMutationOutcomes(
      "acct-1",
      [{ id: mutation.id, intent: mutation.intent }],
      [{ id: mutation.id, status: "rejected", reason: "thread_not_found" }],
    );

    await waitFor(() => expect(screen.queryByText("Removed")).toBeNull());
    expect(screen.getAllByText("Remote result").length).toBeGreaterThan(0);
  });

  it("badges Held and Blocked results (#56, poc-spec.md: 'search returns held and blocked mail badged')", async () => {
    await seedOneThread();
    const searchResponse: SearchResponse = {
      results: [
        {
          thread: makeThread("t-held", "acct-1", { subject: "Held result" }),
          matchedMessageId: "t-held-msg",
          headline: null,
          folder: { id: "f1", name: "Inbox", role: "inbox" },
          gatekeeper: "held",
        },
        {
          thread: makeThread("t-blocked", "acct-1", { subject: "Blocked result" }),
          matchedMessageId: "t-blocked-msg",
          headline: null,
          folder: { id: "f2", name: "Trash", role: "trash" },
          gatekeeper: "blocked",
        },
      ],
      cursor: null,
      indexWatermark: { coveredSince: null, complete: true },
    };
    stubFetch(() => Promise.resolve(jsonResponse(searchResponse)));

    renderMail();
    await screen.findByText("Origin thread");

    fireEvent.keyDown(window, { key: "/" });
    const field = await screen.findByLabelText<HTMLInputElement>("Search mail");
    fireEvent.change(field, { target: { value: "result" } });

    const heldRow = (await screen.findByText("Held result")).closest(".thread-row");
    const blockedRow = (await screen.findByText("Blocked result")).closest(".thread-row");
    expect(heldRow?.querySelector(".gatekeeper-badge-held")?.textContent).toBe("Held");
    expect(blockedRow?.querySelector(".gatekeeper-badge-blocked")?.textContent).toBe("Blocked");
  });
});

/** #80's own acceptance boxes: search covers the whole Account Scope, not just the primary account. */
describe("search across Account Scope (#80)", () => {
  async function seedTwoAccounts(): Promise<void> {
    await applyMailAccountDelta(
      delta({ created: [makeMailAccount("acct-1"), makeMailAccount("acct-2")] }),
      { replace: false },
    );
    await applyThreadDelta(
      "acct-1",
      delta({ created: [makeThread("t1", "acct-1", { subject: "Origin thread" })] }),
      { replace: false },
    );
  }

  function twoAccountSearchResponse(): SearchResponse {
    return {
      results: [
        {
          thread: makeThread("t-a1", "acct-1", { subject: "From account one" }),
          matchedMessageId: "t-a1-msg",
          headline: null,
          folder: { id: "f1", name: "Inbox", role: "inbox" },
          gatekeeper: null,
        },
        {
          thread: makeThread("t-a2", "acct-2", { subject: "From account two" }),
          matchedMessageId: "t-a2-msg",
          headline: null,
          folder: { id: "f2", name: "Inbox", role: "inbox" },
          gatekeeper: null,
        },
      ],
      cursor: null,
      // Weakest across the two: `acct-1`'s own watermark (`makeMailAccount`'s
      // default) is already incomplete, and the response is the whole Scope's
      // — the Client renders exactly what it's handed, not a re-derived min.
      indexWatermark: { coveredSince: null, complete: false },
    };
  }

  it("carries the whole Account Scope on the request; results from every account merge, each row named by its own account, weakest watermark shown", async () => {
    await seedTwoAccounts();
    const bodies: SearchRequest[] = [];
    stubFetch((init) => {
      if (init?.body) bodies.push(JSON.parse(init.body as string));
      return Promise.resolve(jsonResponse(twoAccountSearchResponse()));
    });

    renderMail();
    await screen.findByText("Origin thread");

    fireEvent.keyDown(window, { key: "/" });
    const field = await screen.findByLabelText<HTMLInputElement>("Search mail");
    fireEvent.change(field, { target: { value: "account" } });

    await screen.findByText("From account one");
    await screen.findByText("From account two");

    const [request] = bodies;
    expect(request?.mailAccountId).toBe("acct-1");
    expect(request?.additionalMailAccountIds).toEqual(["acct-2"]);

    const rowOne = screen.getByText("From account one").closest(".thread-row");
    const rowTwo = screen.getByText("From account two").closest(".thread-row");
    expect(rowOne?.querySelector(".account-badge")?.textContent).toBe("acct-1@example.test");
    expect(rowTwo?.querySelector(".account-badge")?.textContent).toBe("acct-2@example.test");

    expect(
      await screen.findByText(
        "Still indexing this account — older mail matches on sender and subject only.",
      ),
    ).toBeDefined();
  });

  it("changing Scope while a search is active re-runs it", async () => {
    await seedTwoAccounts();
    const bodies: SearchRequest[] = [];
    stubFetch((init) => {
      if (init?.body) bodies.push(JSON.parse(init.body as string));
      return Promise.resolve(jsonResponse(twoAccountSearchResponse()));
    });

    renderMail();
    await screen.findByText("Origin thread");

    fireEvent.keyDown(window, { key: "/" });
    const field = await screen.findByLabelText<HTMLInputElement>("Search mail");
    fireEvent.change(field, { target: { value: "account" } });
    await screen.findByText("From account one");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.additionalMailAccountIds).toEqual(["acct-2"]);

    // Narrow Scope to just `acct-1` via the real control (`AccountScope.tsx`) — not by
    // reaching into `useAccountScope` directly, so this exercises the same
    // path a User's own click does.
    fireEvent.click(screen.getByTitle("Account Scope"));
    fireEvent.click(screen.getByLabelText(/acct-2@example\.test/));

    await waitFor(() => expect(bodies.length).toBeGreaterThan(1));
    const rerun = bodies.at(-1);
    expect(rerun?.mailAccountId).toBe("acct-1");
    expect(rerun?.additionalMailAccountIds).toBeUndefined();
  });

  it("triage from a cross-account result acts on the right Mail Account", async () => {
    await seedTwoAccounts();
    stubFetch(() => Promise.resolve(jsonResponse(twoAccountSearchResponse())));

    renderMail();
    await screen.findByText("Origin thread");

    fireEvent.keyDown(window, { key: "/" });
    const field = await screen.findByLabelText<HTMLInputElement>("Search mail");
    fireEvent.change(field, { target: { value: "account" } });
    await screen.findByText("From account two");

    fireEvent.click(screen.getByText("From account two"));
    const archiveButton = await screen.findByRole("button", {
      name: "Done — archive this thread",
    });
    fireEvent.click(archiveButton);

    await waitFor(async () => expect(await listQueuedMutations("acct-2")).toHaveLength(1));
    expect(await listQueuedMutations("acct-1")).toHaveLength(0);
  });
});
