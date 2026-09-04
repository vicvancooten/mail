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
    references: [],
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
    bodyIsPlainText: false,
    remoteImagesAllowed: false,
    ...overrides,
  };
}

/** A body whose only remote reference is an already-proxy-rewritten `<img src>` (`sync/image-proxy.ts`). */
const PROXIED_IMAGE_HTML =
  '<img src="/messages/msg-1/image-proxy?url=https%3A%2F%2Fsender.example%2Ft.gif&sig=abc">';

const noop = () => {};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MessageBody", () => {
  it("renders a sandboxed iframe with no allow-same-origin/allow-forms/allow-popups", () => {
    render(<MessageBody message={makeMessage()} onMailtoLink={noop} />);
    const iframe = document.querySelector("iframe");
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe?.getAttribute("srcdoc")).toContain("<p>hi</p>");
  });

  it("shows no 'Load remote images' button for a body with nothing to proxy", () => {
    render(
      <MessageBody
        message={makeMessage({ bodyHtml: "<p>plain text only</p>" })}
        onMailtoLink={noop}
      />,
    );
    expect(screen.queryByRole("button", { name: /load remote images/i })).toBeNull();
  });

  it("loads remote images straight away for an Approved Sender (#55)", () => {
    render(
      <MessageBody
        message={makeMessage({ bodyHtml: PROXIED_IMAGE_HTML, remoteImagesAllowed: true })}
        onMailtoLink={noop}
      />,
    );
    expect(screen.queryByRole("button", { name: /load remote images/i })).toBeNull();
  });

  it("blocks a proxied remote image until the User clicks 'Load remote images'", async () => {
    const user = userEvent.setup();
    const message = makeMessage({ bodyHtml: PROXIED_IMAGE_HTML });
    render(<MessageBody message={message} onMailtoLink={noop} />);

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
    render(<MessageBody message={makeMessage()} onMailtoLink={noop} />);
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
    const { rerender } = render(
      <MessageBody key="msg-1" message={makeMessage({ id: "msg-1" })} onMailtoLink={noop} />,
    );
    let iframe = document.querySelector("iframe") as HTMLIFrameElement;
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "mail-body-resize", height: 500 },
        source: iframe.contentWindow,
      }),
    );

    rerender(
      <MessageBody
        key="msg-2"
        message={makeMessage({ id: "msg-2", bodyHtml: "<p>next</p>" })}
        onMailtoLink={noop}
      />,
    );
    iframe = document.querySelector("iframe") as HTMLIFrameElement;
    expect(iframe.getAttribute("srcdoc")).toContain("<p>next</p>");
  });

  it("applies the plain-text width class only when the message carries no native HTML", () => {
    render(<MessageBody message={makeMessage({ bodyIsPlainText: true })} onMailtoLink={noop} />);
    const iframe = document.querySelector("iframe") as HTMLIFrameElement;
    expect(iframe.className).toContain("message-body-frame-plain");
  });

  it("never adds the plain-text width class for real sender HTML", () => {
    render(<MessageBody message={makeMessage()} onMailtoLink={noop} />);
    const iframe = document.querySelector("iframe") as HTMLIFrameElement;
    expect(iframe.className).not.toContain("message-body-frame-plain");
  });

  describe("the click bridge (ADR-0018)", () => {
    it("opens an http(s) link in a new tab with noopener, never noreferrer's opener", async () => {
      const openSpy = vi.fn();
      vi.stubGlobal("open", openSpy);
      render(<MessageBody message={makeMessage()} onMailtoLink={noop} />);
      const iframe = document.querySelector("iframe") as HTMLIFrameElement;

      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "mail-link-click", href: "https://sender.example/page" },
          source: iframe.contentWindow,
        }),
      );

      await waitFor(() => {
        expect(openSpy).toHaveBeenCalledWith("https://sender.example/page", "_blank", "noopener");
      });
    });

    it("routes a mailto: link to onMailtoLink instead of window.open", async () => {
      const openSpy = vi.fn();
      vi.stubGlobal("open", openSpy);
      const onMailtoLink = vi.fn();
      render(<MessageBody message={makeMessage()} onMailtoLink={onMailtoLink} />);
      const iframe = document.querySelector("iframe") as HTMLIFrameElement;

      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "mail-link-click", href: "mailto:jane@example.com?subject=Hi" },
          source: iframe.contentWindow,
        }),
      );

      await waitFor(() => {
        expect(onMailtoLink).toHaveBeenCalledWith({
          to: [{ address: "jane@example.com", name: null }],
          subject: "Hi",
          body: null,
        });
      });
      expect(openSpy).not.toHaveBeenCalled();
    });

    it("ignores a link click from an unrelated window", async () => {
      const openSpy = vi.fn();
      vi.stubGlobal("open", openSpy);
      render(<MessageBody message={makeMessage()} onMailtoLink={noop} />);

      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "mail-link-click", href: "https://sender.example/page" },
          source: window,
        }),
      );

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(openSpy).not.toHaveBeenCalled();
    });

    it("ignores a non-http(s), non-mailto scheme", async () => {
      const openSpy = vi.fn();
      vi.stubGlobal("open", openSpy);
      const onMailtoLink = vi.fn();
      render(<MessageBody message={makeMessage()} onMailtoLink={onMailtoLink} />);
      const iframe = document.querySelector("iframe") as HTMLIFrameElement;

      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "mail-link-click", href: "tel:+15551234567" },
          source: iframe.contentWindow,
        }),
      );

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(openSpy).not.toHaveBeenCalled();
      expect(onMailtoLink).not.toHaveBeenCalled();
    });
  });

  describe("interactive={false} (#102, the Screener's View dialog)", () => {
    it("never seeds images loaded and never offers 'Load remote images', even for an Approved sender's message", () => {
      render(
        <MessageBody
          message={makeMessage({ bodyHtml: PROXIED_IMAGE_HTML, remoteImagesAllowed: true })}
          interactive={false}
        />,
      );
      expect(screen.queryByRole("button", { name: "Load remote images" })).toBeNull();
    });

    it("never wires the click bridge — a link click reaches no handler at all", async () => {
      const openSpy = vi.fn();
      vi.stubGlobal("open", openSpy);
      render(<MessageBody message={makeMessage()} interactive={false} />);
      const iframe = document.querySelector("iframe") as HTMLIFrameElement;
      expect(iframe.srcdoc).not.toContain("mail-link-click");

      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "mail-link-click", href: "https://sender.example/page" },
          source: iframe.contentWindow,
        }),
      );

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(openSpy).not.toHaveBeenCalled();
    });

    it("still sizes itself and still shows a failed-image error — only the bridge and the images opt-in are dropped", () => {
      render(<MessageBody message={makeMessage()} interactive={false} />);
      const iframe = document.querySelector("iframe") as HTMLIFrameElement;
      expect(iframe.srcdoc).toContain("ResizeObserver");
      expect(iframe.srcdoc).toContain("mail-image-error");
    });
  });
});
