import type { Message } from "@mail/shared";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageBody } from "./MessageBody.js";

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-1",
    threadId: "thread-1",
    mailAccountId: "acct-1",
    messageIdHeader: "<msg-1@example.test>",
    subject: "Hello",
    from: { name: "Ada", address: "ada@example.test" },
    to: [],
    cc: [],
    replyTo: [],
    sentAt: "2026-06-01T12:00:00.000Z",
    receivedAt: "2026-06-01T12:00:00.000Z",
    seen: true,
    flagged: false,
    attachments: [],
    bodyText: "hi",
    bodyHtml: "<p>hi</p>",
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MessageBody", () => {
  it("renders a sandboxed iframe with no allow-same-origin/allow-forms/allow-popups", () => {
    render(<MessageBody message={makeMessage()} />);
    const iframe = document.querySelector("iframe");
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe?.getAttribute("srcdoc")).toContain("<p>hi</p>");
  });

  it("shows no 'Load remote images' button for a body with nothing to proxy", () => {
    render(<MessageBody message={makeMessage({ bodyHtml: "<p>plain text only</p>" })} />);
    expect(screen.queryByRole("button", { name: /load remote images/i })).toBeNull();
  });

  it("blocks a proxied remote image until the User clicks 'Load remote images'", async () => {
    const user = userEvent.setup();
    const message = makeMessage({
      bodyHtml:
        '<img src="/messages/msg-1/image-proxy?url=https%3A%2F%2Fsender.example%2Ft.gif&sig=abc">',
    });
    render(<MessageBody message={message} />);

    const iframe = document.querySelector("iframe") as HTMLIFrameElement;
    expect(iframe.getAttribute("srcdoc")).not.toContain("image-proxy");

    const button = screen.getByRole("button", { name: /load remote images/i });
    await user.click(button);

    await waitFor(() => {
      expect(iframe.getAttribute("srcdoc")).toContain("image-proxy");
    });
    expect(screen.queryByRole("button", { name: /load remote images/i })).toBeNull();
  });

  it("clamps and applies a height posted from the frame, ignoring one from an unrelated window", async () => {
    render(<MessageBody message={makeMessage()} />);
    const iframe = document.querySelector("iframe") as HTMLIFrameElement;

    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "mail-body-resize", height: 9999999 },
        source: window, // not the iframe's contentWindow — must be ignored
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(iframe.style.height).toBe("120px");

    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "mail-body-resize", height: 9999999 },
        source: iframe.contentWindow,
      }),
    );
    await waitFor(() => expect(iframe.style.height).toBe("20000px")); // clamped to MAX_HEIGHT

    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "mail-body-resize", height: 300 },
        source: iframe.contentWindow,
      }),
    );
    await waitFor(() => expect(iframe.style.height).toBe("300px"));
  });

  it("resets to a fresh mount's defaults when given a new key — the caller's key={message.id} contract", () => {
    const { rerender } = render(<MessageBody key="msg-1" message={makeMessage({ id: "msg-1" })} />);
    let iframe = document.querySelector("iframe") as HTMLIFrameElement;
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "mail-body-resize", height: 500 },
        source: iframe.contentWindow,
      }),
    );

    rerender(
      <MessageBody key="msg-2" message={makeMessage({ id: "msg-2", bodyHtml: "<p>next</p>" })} />,
    );
    iframe = document.querySelector("iframe") as HTMLIFrameElement;
    expect(iframe.getAttribute("srcdoc")).toContain("<p>next</p>");
  });
});
