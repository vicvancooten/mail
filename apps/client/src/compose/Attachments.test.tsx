import type { AttachmentMeta } from "@mail/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttachmentsPanel } from "./Attachments.js";

/** `AttachmentsPanel`'s own rendering rules — the hook's network/budget logic is `attachment-budget.test.ts`'s. */

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
