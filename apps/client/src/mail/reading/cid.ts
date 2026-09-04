import type { Message, MessageAttachment } from "@mail/shared";
import { attachmentUrl } from "../../api/messages.js";

/**
 * `cid:` inline image resolution (#41, `docs/research/0005` §4, RFC 2392).
 * The backend leaves `cid:` references exactly as the sender wrote them —
 * only the Client, which alone holds the decoded attachment bytes, can turn
 * one into something the sandboxed body can actually render.
 */

/** Every `cid:` reference in a body — brackets never appear here, only the RFC 2392 percent-decoded Content-ID text. */
export function findCidReferences(html: string): string[] {
  const ids = new Set<string>();
  const pattern = /cid:([^"'()\s>]+)/gi;
  for (const match of html.matchAll(pattern)) {
    const raw = match[1];
    if (!raw) continue;
    try {
      ids.add(decodeURIComponent(raw));
    } catch {
      ids.add(raw); // a malformed %-escape — keep the raw text rather than losing the reference
    }
  }
  return [...ids];
}

/** Strips the `cid:` prefix and percent-decodes, per RFC 2392's own conversion rule. */
export function decodeCidReference(src: string): string {
  const raw = src.slice("cid:".length);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export interface CidBlob {
  contentId: string;
  /** A `data:` URI carrying the attachment's own bytes — never a `blob:`
   * URL (see the doc comment on `resolveCidBlobs` below for why). */
  blobUrl: string;
}

/**
 * Fetches every `cid:`-referenced inline attachment's bytes (fetch-through,
 * same authenticated same-origin route real downloads use — see
 * `api/messages.ts`) and turns each into a `data:` URI. A reference with no
 * matching attachment, or whose fetch fails, is simply absent from the
 * result — the body renders with a broken-image placeholder for that one
 * image rather than failing the whole render.
 *
 * Deliberately a `data:` URI, not a `blob:` URL from `URL.createObjectURL()`
 * (docs/research/0005 §4 names both as options): the reader body renders
 * inside an iframe that's `sandbox="allow-scripts"` with no
 * `allow-same-origin` (`MessageBody.tsx`'s own doc comment, ADR-0018) —
 * deliberately, so sender-authored script can't reach the app's real
 * origin. That gives the frame's document an *opaque* origin on every
 * render. A `blob:` URL can only be dereferenced by a document whose origin
 * matches the origin that created it (the Fetch/File API's own "same origin
 * as the blob URL's creator" rule); an opaque origin never matches any real
 * origin, so every `<img src="blob:...">` substituted into that frame fails
 * to load unconditionally — every inline image, every message, no
 * exception. A `data:` URI carries its own bytes and needs no origin check
 * at fetch time, so it loads unconditionally inside the same sandboxed
 * frame. The CSP `buildMessageCsp` already sets on that frame
 * (`sandbox-document.ts`) allows `data:` in `img-src` for exactly this.
 */
export async function resolveCidBlobs(
  messageId: string,
  contentIds: readonly string[],
  attachments: readonly MessageAttachment[],
): Promise<CidBlob[]> {
  const byContentId = new Map(
    attachments.filter((a) => a.contentId !== null).map((a) => [a.contentId as string, a]),
  );
  const resolved = await Promise.all(
    contentIds.map(async (contentId): Promise<CidBlob | null> => {
      const attachment = byContentId.get(contentId);
      if (!attachment) return null;
      try {
        const response = await fetch(attachmentUrl(messageId, attachment.part), {
          credentials: "include",
        });
        if (!response.ok) return null;
        const buffer = await response.arrayBuffer();
        return { contentId, blobUrl: toDataUri(buffer, attachment.mimeType) };
      } catch {
        return null;
      }
    }),
  );
  return resolved.filter((entry): entry is CidBlob => entry !== null);
}

/** Base64-encodes a byte at a time rather than via `String.fromCharCode(...bytes)` — the spread form blows the call stack on a large enough image (tens of thousands of args to one call). */
function toDataUri(buffer: ArrayBuffer, mimeType: string): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i] as number);
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

/** `data:` URIs need no release — kept as a real call (rather than dropped
 * from `MessageBody.tsx`'s unmount/re-resolve effect) only so a future
 * switch back to `blob:` URLs has one place to resume revoking from. */
export function revokeCidBlobs(_blobs: readonly CidBlob[]): void {}

/** Whether a message's downloadable-file panel should show this attachment — a `cid:`-only inline part never does. */
export function isRealAttachment(attachment: MessageAttachment): boolean {
  return !attachment.inline || attachment.contentId === null;
}

/** Every attachment that has at least one real, non-inline `Message` — a thin re-export point for the panel component. */
export function realAttachments(message: Pick<Message, "attachments">): MessageAttachment[] {
  return message.attachments.filter(isRealAttachment);
}
