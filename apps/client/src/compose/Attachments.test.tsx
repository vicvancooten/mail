import type { AttachmentMeta } from "@mail/shared";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttachmentsPanel, useAttachments } from "./Attachments.js";

/** `AttachmentsPanel`'s own rendering rules — the hook's budget math is `attachment-budget.test.ts`'s. */

const uploadAttachment = vi.fn();
vi.mock("../api/attachments.js", () => ({
  fetchComposeConfig: vi.fn(async () => ({ attachmentBudgetEncodedBytes: 25 * 1024 * 1024 })),
  uploadAttachment: (...args: unknown[]) => uploadAttachment(...args),
  deleteAttachment: vi.fn(async () => {}),
  attachmentUrl: () => "",
  AttachmentBudgetExceededError: class AttachmentBudgetExceededError extends Error {},
}));
vi.mock("../store/index.js", () => ({
  recordAttachmentUploaded: vi.fn(async () => {}),
  recordAttachmentRemoved: vi.fn(async () => {}),
}));

afterEach(cleanup);

const ATTACHMENT: AttachmentMeta = {
  id: "att-1",
  filename: "report.pdf",
  mimeType: "application/pdf",
  sizeBytes: 2048,
  disposition: "attachment",
  contentId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("AttachmentsPanel", () => {
  it("renders nothing with no attachments, no uploads, and no budget error", () => {
    const { container } = render(
      <AttachmentsPanel
        compositionId="comp-1"
        attachments={[]}
        uploads={[]}
        budgetError={null}
        budgetFraction={null}
        onRemove={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("lists an attached file with its size, and Remove fires the callback", () => {
    const onRemove = vi.fn();
    render(
      <AttachmentsPanel
        compositionId="comp-1"
        attachments={[ATTACHMENT]}
        uploads={[]}
        budgetError={null}
        budgetFraction={null}
        onRemove={onRemove}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByText("report.pdf")).not.toBeNull();
    expect(screen.getByText("2.0 KB")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Remove report.pdf" }));
    expect(onRemove).toHaveBeenCalledWith("att-1");
  });

  it("shows the budget-exceeded message when present", () => {
    render(
      <AttachmentsPanel
        compositionId="comp-1"
        attachments={[]}
        uploads={[]}
        budgetError="This would add 30.0MB encoded, but only 2.0MB is left of the 25.0MB limit."
        budgetFraction={null}
        onRemove={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByText(/only 2\.0MB is left/)).not.toBeNull();
  });

  it("shows a running upload's progress, not a Remove button", () => {
    render(
      <AttachmentsPanel
        compositionId="comp-1"
        attachments={[]}
        uploads={[
          {
            localId: "u1",
            filename: "photo.png",
            sizeBytes: 500,
            progress: 0.42,
            error: null,
            disposition: "attachment",
            file: new File(["x"], "photo.png"),
          },
        ]}
        budgetError={null}
        budgetFraction={null}
        onRemove={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByText("photo.png")).not.toBeNull();
    expect(screen.getByText("42%")).not.toBeNull();
  });

  it("shows a failed upload's error and a working Retry button", () => {
    const onRetry = vi.fn();
    render(
      <AttachmentsPanel
        compositionId="comp-1"
        attachments={[]}
        uploads={[
          {
            localId: "u1",
            filename: "photo.png",
            sizeBytes: 500,
            progress: 0,
            error: "Upload failed",
            disposition: "attachment",
            file: new File(["x"], "photo.png"),
          },
        ]}
        budgetError={null}
        budgetFraction={null}
        onRemove={vi.fn()}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText("Upload failed")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry photo.png" }));
    expect(onRetry).toHaveBeenCalledWith("u1");
  });

  it("renders the budget bar past 50%, sized to the fraction", () => {
    const { container } = render(
      <AttachmentsPanel
        compositionId="comp-1"
        attachments={[ATTACHMENT]}
        uploads={[]}
        budgetError={null}
        budgetFraction={0.7}
        onRemove={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    const fill = container.querySelector(".attachments-budget-bar-fill") as HTMLElement | null;
    expect(fill?.style.width).toBe("70%");
  });
});

/**
 * `retryUpload`'s own acceptance line (compose-spec's "retry-on-failure",
 * ticket #59): a failed upload's placeholder retains its `File`, and a
 * retry is a real re-attempt through the same `uploadAttachment` path the
 * first try used — not the no-op stub this fixes.
 */
describe("useAttachments — retryUpload", () => {
  afterEach(() => {
    uploadAttachment.mockReset();
  });

  it("re-attempts a failed upload with the same File, and clears the error on success", async () => {
    uploadAttachment.mockRejectedValueOnce(new Error("network blip"));
    const meta: AttachmentMeta = {
      id: "att-1",
      filename: "photo.png",
      mimeType: "image/png",
      sizeBytes: 3,
      disposition: "attachment",
      contentId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    uploadAttachment.mockResolvedValueOnce(meta);

    const { result } = renderHook(() => useAttachments("comp-1", "acct-1", [], vi.fn()));
    const file = new File(["abc"], "photo.png", { type: "image/png" });

    act(() => {
      result.current.attachFiles([file], "attachment");
    });
    await waitFor(() => expect(result.current.uploads[0]?.error).toBe("Upload failed"));
    expect(uploadAttachment).toHaveBeenCalledTimes(1);

    const localId = result.current.uploads[0]?.localId;
    if (!localId) throw new Error("expected a queued upload");
    act(() => {
      result.current.retryUpload(localId);
    });

    // The retry clears the stale error immediately, before the re-attempt resolves.
    expect(result.current.uploads[0]?.error).toBeNull();
    await waitFor(() => expect(result.current.uploads).toHaveLength(0));

    expect(uploadAttachment).toHaveBeenCalledTimes(2);
    const secondCallOptions = uploadAttachment.mock.calls[1]?.[0] as { file: File };
    expect(secondCallOptions.file).toBe(file); // the exact same File, not a re-select
  });

  it("does nothing for a localId with no matching upload", () => {
    const { result } = renderHook(() => useAttachments("comp-1", "acct-1", [], vi.fn()));
    act(() => {
      result.current.retryUpload("no-such-upload");
    });
    expect(uploadAttachment).not.toHaveBeenCalled();
  });
});
