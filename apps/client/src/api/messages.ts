import { type Message, threadMessagesResponseSchema } from "@mail/shared";
import { getJson } from "./auth.js";

/**
 * Per-Thread and per-attachment reads for the reading pane (#41). Not part
 * of the `POST /sync` delta protocol (ADR-0011) — a Message has no state
 * token at PoC scope, so this is a plain authenticated `GET`, cached only by
 * `useThreadMessages`'s own in-memory map for the life of the tab.
 */
export function fetchThreadMessages(threadId: string): Promise<Message[]> {
  return getJson(`/threads/${encodeURIComponent(threadId)}/messages`, (data) => {
    return threadMessagesResponseSchema.parse(data).messages;
  });
}

/**
 * The same-origin URL for one attachment's bytes — fetch-through from IMAP,
 * never cached server-side (poc-spec.md §Compose's "no received-attachment
 * caching" applies here too). A plain `<img src>`/`<a href>` to this URL
 * carries the session cookie like any other same-origin request; no
 * separate authenticated fetch + `blob:` dance is needed for it.
 */
export function attachmentUrl(messageId: string, part: string): string {
  return `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(part)}`;
}
