import type { AttachmentMeta, MailAccount } from "@mail/shared";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listQueuedComposeSaves,
  resolveComposeSaveOutcomes,
  saveComposition,
  toWireComposeSave,
} from "../store/compositions.js";
import { localCache, openLocalCache } from "../store/local-cache.js";
import { listQueuedMutations } from "../store/mutation-queue.js";
import { Composer } from "./Composer.js";

/**
 * #48's own two acceptance lines that need the network mocked to observe:
 * an upload in flight disables Send, and the attached file shows up once it
 * resolves. `attachment-budget.test.ts` and `Attachments.test.tsx` cover the
 * budget math and the row rendering without going through `Composer` at all.
 */
let uploadCalled = false;
let resolveFn: (meta: AttachmentMeta) => void = () => {};
vi.mock("../api/attachments.js", () => ({
  fetchComposeConfig: vi.fn(async () => ({ attachmentBudgetEncodedBytes: 25 * 1024 * 1024 })),
  uploadAttachment: vi.fn(
    () =>
      new Promise<AttachmentMeta>((resolve) => {
        uploadCalled = true;
        resolveFn = resolve;
      }),
  ),
  deleteAttachment: vi.fn(async () => {}),
  attachmentUrl: (compositionId: string, attachmentId: string) =>
    `/compositions/${compositionId}/attachments/${attachmentId}`,
  AttachmentBudgetExceededError: class AttachmentBudgetExceededError extends Error {},
}));

/**
 * The composer's own acceptance lines (compose-spec §Composer surface &
 * keys): a keystroke is durable almost immediately, and `Esc` closes to a
 * Draft — it never discards.
 */

const ACCOUNT: MailAccount = {
  id: "acct-1",
  emailAddress: "vic@example.test",
  imap: { host: "imap.example.test", port: 993, security: "tls" },
  smtp: { host: "smtp.example.test", port: 587, security: "starttls" },
  status: "active",
  sync: { state: "idle", lastProgressAt: null, lastError: null },
  indexWatermark: { coveredSince: null, complete: false },
  signature: null,
  notificationsEnabled: true,
  gatekeeper: { enabled: false, cutoff: null },
  createdAt: "2026-01-01T00:00:00.000Z",
};

let counter = 0;
const names: string[] = [];

beforeEach(async () => {
  const name = `composer-test-${counter++}`;
  names.push(name);
  await openLocalCache({ name, schemaVersion: 1 });
});

afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  localCache().close();
  for (const name of names.splice(0)) await Dexie.delete(name);
});

describe("Composer", () => {
  it("autosaves the subject a short debounce after typing, durable in the Local Cache", async () => {
    const onClose = vi.fn();
    render(
      <Composer
        compositionId="comp-1"
        mailAccounts={[ACCOUNT]}
        defaultMailAccountId="acct-1"
        onClose={onClose}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("Subject"), { target: { value: "Dinner plans" } });

    await waitFor(
      async () => {
        const row = await localCache().compositions.get("comp-1");
        expect(row?.subject).toBe("Dinner plans");
      },
      { timeout: 3000 },
    );
  });

  it("Esc closes without discarding — the typed subject survives, never sent to trash", async () => {
    const onClose = vi.fn();
    render(
      <Composer
        compositionId="comp-1"
        mailAccounts={[ACCOUNT]}
        defaultMailAccountId="acct-1"
        onClose={onClose}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("Subject"), {
      target: { value: "Do not lose this" },
    });
    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(
      async () => {
        const row = await localCache().compositions.get("comp-1");
        expect(row?.subject).toBe("Do not lose this");
        expect(row?.status).toBe("draft");
      },
      { timeout: 3000 },
    );
  });

  it("leaves nothing behind for a composer opened and closed with no content typed", async () => {
    const onClose = vi.fn();
    render(
      <Composer
        compositionId="comp-1"
        mailAccounts={[ACCOUNT]}
        defaultMailAccountId="acct-1"
        onClose={onClose}
      />,
    );

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(await localCache().compositions.get("comp-1")).toBeUndefined();
  });

  it("adds a recipient chip from typed text on Enter", async () => {
    render(
      <Composer
        compositionId="comp-1"
        mailAccounts={[ACCOUNT]}
        defaultMailAccountId="acct-1"
        onClose={vi.fn()}
      />,
    );

    const toInput = screen.getByLabelText("To recipients");
    fireEvent.change(toInput, { target: { value: "Alice <alice@example.test>" } });
    fireEvent.keyDown(toInput, { key: "Enter" });

    expect(await screen.findByText("Alice")).not.toBeNull();
    await waitFor(
      async () => {
        const row = await localCache().compositions.get("comp-1");
        expect(row?.to).toEqual([{ name: "Alice", address: "alice@example.test" }]);
      },
      { timeout: 3000 },
    );
  });

  it("blocks Send until there is a plausible recipient (compose-spec: blocking validation)", async () => {
    render(
      <Composer
        compositionId="comp-1"
        mailAccounts={[ACCOUNT]}
        defaultMailAccountId="acct-1"
        onClose={vi.fn()}
      />,
    );

    const sendButton = screen.getByRole("button", { name: /Send/ });
    expect((sendButton as HTMLButtonElement).disabled).toBe(true);

    const toInput = screen.getByLabelText("To recipients");
    fireEvent.change(toInput, { target: { value: "ada@example.test" } });
    fireEvent.keyDown(toInput, { key: "Enter" });

    await waitFor(() => {
      expect((screen.getByRole("button", { name: /send/i }) as HTMLButtonElement).disabled).toBe(
        false,
      );
    });
  });

  /**
   * The version-conflict banner (finding #1, ADR-0012/ADR-0014): a rejected
   * save must never auto-retry with stale content, and the composer is what
   * turns `subscribeComposeConflicts` into a real choice. `resolveComposeSaveOutcomes`
   * itself is `compositions.test.ts`'s; this is only the UI wiring.
   */
  describe("version conflict", () => {
    async function typeAndConflict(subject: string, version: number) {
      const toInput = screen.getByLabelText("To recipients");
      fireEvent.change(toInput, { target: { value: "ada@example.test" } });
      fireEvent.keyDown(toInput, { key: "Enter" });
      fireEvent.change(screen.getByPlaceholderText("Subject"), { target: { value: subject } });
      await waitFor(async () => {
        expect((await localCache().compositions.get("comp-1"))?.subject).toBe(subject);
      });

      const [queued] = await listQueuedComposeSaves("acct-1");
      if (!queued) throw new Error("expected a queued save");
      const save = await toWireComposeSave(queued);
      await resolveComposeSaveOutcomes(
        "acct-1",
        [save],
        [{ id: save.id, saveId: save.saveId, status: "conflict", version }],
      );
      await screen.findByText("This draft changed on another device.");
    }

    it("shows the banner on a rejected save and blocks Send until resolved", async () => {
      render(
        <Composer
          compositionId="comp-1"
          mailAccounts={[ACCOUNT]}
          defaultMailAccountId="acct-1"
          onClose={vi.fn()}
        />,
      );

      await typeAndConflict("my unsaved edit", 5);

      const sendButton = screen.getByRole("button", { name: /Send/ }) as HTMLButtonElement;
      expect(sendButton.disabled).toBe(true);
      expect(sendButton.title).toBe("Resolve the conflict above before sending");
    });

    it("'Keep mine' saves the local edit against the corrected version and dismisses the banner", async () => {
      render(
        <Composer
          compositionId="comp-1"
          mailAccounts={[ACCOUNT]}
          defaultMailAccountId="acct-1"
          onClose={vi.fn()}
        />,
      );

      await typeAndConflict("my unsaved edit", 5);
      fireEvent.click(screen.getByRole("button", { name: "Keep mine" }));

      expect(screen.queryByText("This draft changed on another device.")).toBeNull();
      await waitFor(async () => {
        const [requeued] = await listQueuedComposeSaves("acct-1");
        if (!requeued) throw new Error("expected the explicit re-save to be queued");
        expect(requeued.subject).toBe("my unsaved edit");
        expect((await toWireComposeSave(requeued)).version).toBe(5);
      });
    });

    it("'Use theirs' stops writing the local edit and adopts the server's content once it lands", async () => {
      render(
        <Composer
          compositionId="comp-1"
          mailAccounts={[ACCOUNT]}
          defaultMailAccountId="acct-1"
          onClose={vi.fn()}
        />,
      );

      await typeAndConflict("my unsaved edit", 5);
      fireEvent.click(screen.getByRole("button", { name: "Use theirs" }));

      expect(screen.queryByText("This draft changed on another device.")).toBeNull();
      // Nothing is re-queued behind "Use theirs" — the point is to stop
      // writing the stale content, not to write it differently.
      expect(await listQueuedComposeSaves("acct-1")).toEqual([]);
      // The composer's own subject field still shows the local edit — no
      // server content has actually arrived yet.
      expect((screen.getByPlaceholderText("Subject") as HTMLInputElement).value).toBe(
        "my unsaved edit",
      );

      // Simulates the next ordinary sync round landing the other device's
      // content (`server-writes.ts#mergeComposition` adopts the wire copy
      // once no unflushed edit is queued, which is already true here) — a
      // fresh `updatedAt` is what the composer's own effect watches for.
      const row = await localCache().compositions.get("comp-1");
      if (!row) throw new Error("expected the row to still exist");
      await localCache().compositions.put({
        ...row,
        subject: "their subject",
        updatedAt: "2099-01-01T00:00:00.000Z",
      });

      await waitFor(() => {
        expect((screen.getByPlaceholderText("Subject") as HTMLInputElement).value).toBe(
          "their subject",
        );
      });
    });
  });

  it("warns once about an empty subject, then sends and closes to a Pending Send", async () => {
    const onClose = vi.fn();
    render(
      <Composer
        compositionId="comp-1"
        mailAccounts={[ACCOUNT]}
        defaultMailAccountId="acct-1"
        onClose={onClose}
      />,
    );

    const toInput = screen.getByLabelText("To recipients");
    fireEvent.change(toInput, { target: { value: "ada@example.test" } });
    fireEvent.keyDown(toInput, { key: "Enter" });

    // First press: the warning, not a send (compose-spec's "warn once, then send").
    fireEvent.click(await waitFor(() => screen.getByRole("button", { name: /send/i })));
    expect(onClose).not.toHaveBeenCalled();
    const warned = await waitFor(() => screen.getByRole("button", { name: /Send anyway/ }));

    fireEvent.click(warned);
    expect(onClose).toHaveBeenCalledTimes(1);

    await waitFor(async () => {
      expect((await listQueuedMutations("acct-1")).map((mutation) => mutation.intent)).toEqual([
        { type: "sendComposition", compositionId: "comp-1" },
      ]);
    });
    // The composer closed, but nothing is "sent" locally: the countdown is
    // the Sync Backend's to report (ADR-0014).
    const row = await localCache().compositions.get("comp-1");
    expect(row?.sendState).toBe("queued");
    expect(row?.submitAfter).toBeNull();
  });

  it("sends on Cmd/Ctrl+Enter through the same validation as the button", async () => {
    const onClose = vi.fn();
    render(
      <Composer
        compositionId="comp-1"
        mailAccounts={[ACCOUNT]}
        defaultMailAccountId="acct-1"
        onClose={onClose}
      />,
    );

    // Blocked: no recipient yet, so the shortcut must do nothing at all.
    fireEvent.keyDown(window, { key: "Enter", metaKey: true });
    expect(onClose).not.toHaveBeenCalled();

    const toInput = screen.getByLabelText("To recipients");
    fireEvent.change(toInput, { target: { value: "ada@example.test" } });
    fireEvent.keyDown(toInput, { key: "Enter" });
    fireEvent.change(screen.getByPlaceholderText("Subject"), { target: { value: "Lunch" } });

    // Still an empty body, so the first shortcut press warns like the button.
    await waitFor(() => screen.getByRole("button", { name: /send/i }));
    fireEvent.keyDown(window, { key: "Enter", metaKey: true });
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "Enter", metaKey: true });
    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
    // Waited on so the send's fire-and-forget write settles before this
    // test's `afterEach` closes the cache under it.
    await waitFor(async () => {
      expect(await listQueuedMutations("acct-1")).toHaveLength(1);
    });
  });

  it("shows the sending Mail Account in the header", () => {
    render(
      <Composer
        compositionId="comp-1"
        mailAccounts={[ACCOUNT]}
        defaultMailAccountId="acct-1"
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTitle("vic@example.test")).not.toBeNull();
  });

  it("disables Send while a dropped file is uploading, and re-enables once it resolves (#48)", async () => {
    uploadCalled = false;
    render(
      <Composer
        compositionId="comp-1"
        mailAccounts={[ACCOUNT]}
        defaultMailAccountId="acct-1"
        onClose={vi.fn()}
      />,
    );

    const toInput = screen.getByLabelText("To recipients");
    fireEvent.change(toInput, { target: { value: "ada@example.test" } });
    fireEvent.keyDown(toInput, { key: "Enter" });
    await waitFor(() => screen.getByRole("button", { name: /send/i }));

    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    fireEvent.drop(screen.getByRole("dialog", { name: "New message" }), {
      dataTransfer: { files: [file] },
    });

    await waitFor(() => {
      const button = screen.getByRole("button", { name: /^send$/i }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(button.title).toBe("Uploading…");
    });

    expect(uploadCalled).toBe(true);
    resolveFn({
      id: "att-1",
      filename: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
      disposition: "attachment",
      contentId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    // Once the upload resolves `uploading` clears, but this composer still
    // has an empty subject and body, so the verdict becomes `warn` rather
    // than `ready` — the button's own label changes with it. What matters
    // here is only that it is no longer disabled for the uploading reason.
    await waitFor(() => {
      const button = document.querySelector(".composer-send-button") as HTMLButtonElement;
      expect(button.disabled).toBe(false);
    });
  });

  describe("reply/forward (#47)", () => {
    it("hydrates a pre-seeded reply Composition and round-trips the quoted HTML byte-identically", async () => {
      const quotedHtml = '<p>Weird &amp; <b>bold</b> "quoted" text.</p>';
      await saveComposition(
        "comp-1",
        "acct-1",
        {
          subject: "Re: Lunch plans",
          document: {
            type: "doc",
            content: [{ type: "paragraph" }, { type: "mailQuote", attrs: { html: quotedHtml } }],
          },
          to: [{ name: "Ada", address: "ada@example.test" }],
          cc: [],
          bcc: [],
          inReplyTo: "original@example.test",
          references: ["root@example.test", "original@example.test"],
        },
        { force: true },
      );

      render(
        <Composer
          compositionId="comp-1"
          mailAccounts={[ACCOUNT]}
          defaultMailAccountId="acct-1"
          onClose={vi.fn()}
        />,
      );

      await waitFor(() => {
        expect((screen.getByPlaceholderText("Subject") as HTMLInputElement).value).toBe(
          "Re: Lunch plans",
        );
      });

      // The hydrated editor round-trips through one more (no-op) edit and
      // autosave — the quote's `html` attr must still be exactly what it was
      // seeded with, and the threading headers must have survived untouched.
      fireEvent.change(screen.getByPlaceholderText("Subject"), {
        target: { value: "Re: Lunch plans " },
      });
      fireEvent.change(screen.getByPlaceholderText("Subject"), {
        target: { value: "Re: Lunch plans" },
      });

      await waitFor(
        async () => {
          const row = await localCache().compositions.get("comp-1");
          const quote = row?.document.content.find((node) => node.type === "mailQuote");
          expect(quote?.attrs?.html).toBe(quotedHtml);
          expect(row?.inReplyTo).toBe("original@example.test");
          expect(row?.references).toEqual(["root@example.test", "original@example.test"]);
        },
        { timeout: 3000 },
      );
    });

    it("a signed account's signature opens above the (empty) body on new mail too", async () => {
      const signed = { ...ACCOUNT, signature: "Ada Lovelace" };
      render(
        <Composer
          compositionId="comp-1"
          mailAccounts={[signed]}
          defaultMailAccountId="acct-1"
          onClose={vi.fn()}
        />,
      );

      expect(await screen.findByText("Ada Lovelace")).not.toBeNull();
    });
  });
});
