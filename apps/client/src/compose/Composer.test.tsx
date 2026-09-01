import type { AttachmentMeta, MailAccount } from "@mail/shared";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
});
