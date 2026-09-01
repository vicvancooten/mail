import type { Message, MessageAttachment } from "@mail/shared";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AttachmentList } from "./AttachmentList.js";

function makeMessage(attachments: MessageAttachment[]): Message {
  return {
    id: "msg-1",
    threadId: "thread-1",
    mailAccountId: "acct-1",
    messageIdHeader: null,
    subject: "Hello",
    from: { name: "Ada", address: "ada@example.test" },
    to: [],
    cc: [],
    replyTo: [],
    sentAt: "2026-06-01T12:00:00.000Z",
    receivedAt: "2026-06-01T12:00:00.000Z",
    seen: true,
    flagged: false,
    attachments,
    bodyText: "hi",
    bodyHtml: "<p>hi</p>",
  };
}

function attachment(overrides: Partial<MessageAttachment> = {}): MessageAttachment {
  return {
    part: "2",
    filename: "photo.png",
    mimeType: "image/png",
    sizeBytes: 2048,
    contentId: null,
    inline: false,
    ...overrides,
  };
}

afterEach(cleanup);

describe("AttachmentList", () => {
  it("renders nothing when there are no real attachments", () => {
    const { container } = render(
      <AttachmentList
        message={makeMessage([attachment({ inline: true, contentId: "logo@example" })])}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("previews an image attachment via a plain <img>, never object/iframe/embed", () => {
    render(
      <AttachmentList message={makeMessage([attachment({ part: "2", mimeType: "image/png" })])} />,
    );
    const img = screen.getByRole("img");
    expect(img.tagName).toBe("IMG");
    expect(img.getAttribute("src")).toBe("/messages/msg-1/attachments/2");
    expect(document.querySelector("object,embed")).toBeNull();
  });

  it("shows a download link with the filename for every real attachment", () => {
    render(
      <AttachmentList
        message={makeMessage([
          attachment({ part: "2", filename: "notes.txt", mimeType: "text/plain" }),
        ])}
      />,
    );
    const link = screen.getByRole("link", { name: /download/i });
    expect(link.getAttribute("href")).toBe("/messages/msg-1/attachments/2");
    expect(link.getAttribute("download")).toBe("notes.txt");
    expect(screen.getByText("notes.txt")).toBeTruthy();
  });

  it("shows a PDF preview frame (not the browser's native viewer) for a pdf attachment", () => {
    render(
      <AttachmentList
        message={makeMessage([
          attachment({ part: "2", filename: "invoice.pdf", mimeType: "application/pdf" }),
        ])}
      />,
    );
    const iframe = document.querySelector("iframe.attachment-pdf-preview");
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute("sandbox")).toBe("allow-scripts");
  });

  it("filters a cid:-only inline part out of the panel, keeping a real inline (no Content-ID) attachment", () => {
    render(
      <AttachmentList
        message={makeMessage([
          attachment({ part: "2", filename: "cid-only.png", inline: true, contentId: "x@example" }),
          attachment({ part: "3", filename: "dropped-in-body.png", inline: true, contentId: null }),
        ])}
      />,
    );
    expect(screen.queryByText("cid-only.png")).toBeNull();
    expect(screen.getByText("dropped-in-body.png")).toBeTruthy();
  });

  it("formats sizes in human-readable units", () => {
    render(
      <AttachmentList
        message={makeMessage([
          attachment({ part: "2", filename: "big.zip", sizeBytes: 3 * 1024 * 1024 }),
        ])}
      />,
    );
    expect(screen.getByText("3.0 MB")).toBeTruthy();
  });
});
