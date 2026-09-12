import type { Message } from "@mail/shared";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageList } from "./MessageList.js";

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-1",
    threadId: "thread-1",
    mailAccountId: "acct-1",
    messageIdHeader: null,
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
    snippet: "A short preview.",
    bodyText: "hi",
    bodyHtml: "<p>hi</p>",
    bodyIsPlainText: false,
    remoteImagesAllowed: false,
    ...overrides,
  };
}

const noop = () => {};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MessageList (#291)", () => {
  it("collapses every read message but the latest to sender, date and Snippet", () => {
    const messages = [1, 2, 3, 4, 5].map((n) =>
      makeMessage({
        id: `msg-${n}`,
        from: { name: `Sender ${n}`, address: `s${n}@example.test` },
        snippet: `Preview ${n}`,
        seen: true,
      }),
    );
    render(
      <MessageList
        messages={messages}
        onReply={noop}
        onMailtoLink={noop}
        onOpenMessageChange={noop}
      />,
    );

    // Four collapsed rows (all but the last/newest), each showing sender + snippet as a button.
    for (const n of [1, 2, 3, 4]) {
      const row = screen.getByRole("button", { name: new RegExp(`Sender ${n}`) });
      expect(row.textContent).toContain(`Preview ${n}`);
    }
    expect(screen.queryByRole("button", { name: /Sender 5/ })).toBeNull();

    // Only the latest Message's body actually rendered (one sandboxed iframe).
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
  });

  it("expands an unread older message even though it isn't the latest", () => {
    const messages = [
      makeMessage({ id: "msg-1", seen: false }),
      makeMessage({ id: "msg-2", seen: true }),
      makeMessage({ id: "msg-3", seen: true }),
    ];
    render(
      <MessageList
        messages={messages}
        onReply={noop}
        onMailtoLink={noop}
        onOpenMessageChange={noop}
      />,
    );

    // msg-1 (unread) and msg-3 (latest) are expanded; msg-2 is collapsed.
    expect(document.querySelectorAll("iframe")).toHaveLength(2);
    expect(document.getElementById("message-msg-2")?.querySelector("iframe")).toBeNull();
  });

  it("expands a collapsed message on click", async () => {
    const user = userEvent.setup();
    const messages = [
      makeMessage({ id: "msg-1", seen: true, from: { name: "Older Sender", address: "o@x.test" } }),
      makeMessage({ id: "msg-2", seen: true }),
    ];
    render(
      <MessageList
        messages={messages}
        onReply={noop}
        onMailtoLink={noop}
        onOpenMessageChange={noop}
      />,
    );

    expect(document.getElementById("message-msg-1")?.querySelector("iframe")).toBeNull();
    await user.click(screen.getByRole("button", { name: /Older Sender/ }));
    expect(document.getElementById("message-msg-1")?.querySelector("iframe")).not.toBeNull();
  });

  it("expands whichever message focusMessageId names, even if it would otherwise collapse", () => {
    const messages = [
      makeMessage({ id: "msg-1", seen: true }),
      makeMessage({ id: "msg-2", seen: true }),
      makeMessage({ id: "msg-3", seen: true }),
    ];
    render(
      <MessageList
        messages={messages}
        onReply={noop}
        onMailtoLink={noop}
        onOpenMessageChange={noop}
        focusMessageId="msg-2"
      />,
    );
    expect(document.getElementById("message-msg-2")?.querySelector("iframe")).not.toBeNull();
  });
});
