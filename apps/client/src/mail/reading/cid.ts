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
  blobUrl: string;
}

/**
 * Fetches every `cid:`-referenced inline attachment's bytes (fetch-through,
 * same authenticated same-origin route real downloads use — see
 * `api/messages.ts`) and turns each into a `blob:` URL via
 * `URL.createObjectURL()`. A reference with no matching attachment, or whose
 * fetch fails, is simply absent from the result — the body renders with a
 * broken-image placeholder for that one image rather than failing the whole
 * render.
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
        const blob = await response.blob();
        return { contentId, blobUrl: URL.createObjectURL(blob) };
      } catch {
        return null;
      }
    }),
  );
  return resolved.filter((entry): entry is CidBlob => entry !== null);
}

/** Releases every blob URL `resolveCidBlobs` minted — call on unmount/re-resolve, or they leak for the tab's lifetime. */
export function revokeCidBlobs(blobs: readonly CidBlob[]): void {
  for (const blob of blobs) URL.revokeObjectURL(blob.blobUrl);
}

/** Whether a message's downloadable-file panel should show this attachment — a `cid:`-only inline part never does. */
export function isRealAttachment(attachment: MessageAttachment): boolean {
  return !attachment.inline || attachment.contentId === null;
}

/** Every attachment that has at least one real, non-inline `Message` — a thin re-export point for the panel component. */
export function realAttachments(message: Pick<Message, "attachments">): MessageAttachment[] {
  return message.attachments.filter(isRealAttachment);
}
