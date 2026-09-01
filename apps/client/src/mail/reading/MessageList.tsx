import type { Message } from "@mail/shared";
import { Forward, Reply, ReplyAll } from "lucide-react";
import type { OnReply } from "../ThreadDetailPane.js";
import { AttachmentList } from "./AttachmentList.js";
import { MessageBody } from "./MessageBody.js";

/**
 * Every Message in an opened Thread, oldest first — the reading pane's
 * actual content (#41). Each Message's own Reply/Reply All/Forward row
 * (#47) is what reaches "the specific message the User had open" (compose-
 * spec §Threading headers) for anything but the newest — `r`/`a`/`f`
 * (`../ThreadDetailPane.js`) always mean the newest, same as every
 * mainstream client's keyboard shortcut.
 */
export function MessageList({
  messages,
  onReply,
}: {
  messages: readonly Message[];
  onReply: OnReply;
}) {
  return (
    <div className="message-list">
      {messages.map((message) => (
        <article className="message-item" key={message.id}>
          <header className="message-item-header">
            <span className="message-item-sender">
              {message.from?.name ?? message.from?.address ?? "(unknown sender)"}
            </span>
            <time className="message-item-date" dateTime={message.sentAt}>
              {new Date(message.sentAt).toLocaleString()}
            </time>
          </header>
          <MessageBody key={message.id} message={message} />
          <AttachmentList message={message} />
          <div className="message-item-reply-actions">
            <button type="button" onClick={() => onReply(message, "reply")} title="Reply (r)">
              <Reply size={13} /> Reply
            </button>
            <button
              type="button"
              onClick={() => onReply(message, "replyAll")}
              title="Reply all (a)"
            >
              <ReplyAll size={13} /> Reply all
            </button>
            <button type="button" onClick={() => onReply(message, "forward")} title="Forward (f)">
              <Forward size={13} /> Forward
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}
