import type { Message } from "@mail/shared";
import { AttachmentList } from "./AttachmentList.js";
import { MessageBody } from "./MessageBody.js";

/** Every Message in an opened Thread, oldest first — the reading pane's actual content (#41). */
export function MessageList({ messages }: { messages: readonly Message[] }) {
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
        </article>
      ))}
    </div>
  );
}
