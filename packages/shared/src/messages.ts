import { z } from "zod";
import { threadParticipantSchema } from "./sync.js";

/**
 * The wire projection of a Message (#41, `docs/research/0005`, poc-spec.md
 * §Reading & rendering). `Thread` (`sync.ts`) stays the list-row summary;
 * this is the body a reading pane actually renders, fetched on demand
 * per-Thread rather than through `POST /sync` — a Message has no delta
 * protocol of its own at PoC scope (`routes/messages.ts`'s
 * `GET /threads/:threadId/messages` is a plain fetch-through read, not an
 * ADR-0011 collection).
 *
 * `bodyHtml` has been through **both** of the two sanitize passes' first
 * half by the time it reaches this shape: ingest-time (`sync/sanitize.ts`)
 * plus this ticket's render-time remote-image-proxy rewrite
 * (`sync/image-proxy.ts`). The Client still re-sanitizes a third time
 * (DOMPurify, immediately before DOM insertion) — that pass is what makes a
 * future sanitizer CVE fix retroactively protect the cached corpus, and is
 * never skipped just because the server already cleaned this body.
 */
export const messageAttachmentSchema = z.object({
  /** IMAP body part id (e.g. `2.1`) — what `GET /messages/:id/attachments/:part` fetch-through downloads. */
  part: z.string(),
  filename: z.string().nullable(),
  mimeType: z.string(),
  sizeBytes: z.int().nullable(),
  /** `Content-ID` with brackets stripped (RFC 2392) — how a `cid:` body reference resolves to this part. */
  contentId: z.string().nullable(),
  inline: z.boolean(),
});
export type MessageAttachment = z.infer<typeof messageAttachmentSchema>;

export const messageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  mailAccountId: z.string(),
  messageIdHeader: z.string().nullable(),
  /**
   * This message's own `References` chain (ancestors only, own id not
   * included), stripped of angle brackets — #47's reply threading reads it
   * to build a reply's own `References` (compose-spec §Threading headers:
   * "its `References` + its `Message-ID`") entirely client-side, no round
   * trip needed, keeping reply-composition offline (ADR-0014).
   */
  references: z.array(z.string()),
  subject: z.string(),
  from: threadParticipantSchema.nullable(),
  to: z.array(threadParticipantSchema),
  cc: z.array(threadParticipantSchema),
  replyTo: z.array(threadParticipantSchema),
  sentAt: z.iso.datetime(),
  receivedAt: z.iso.datetime(),
  seen: z.boolean(),
  flagged: z.boolean(),
  /**
   * Every attachment on the message, `cid:`-only inline parts included: the
   * Client needs a `part` id for every Content-ID the body might reference
   * (`docs/research/0005` §4) to resolve it to a `blob:` URL, not only the
   * ones worth a download entry. Filtering to real, User-facing files
   * (`sync/body-structure.ts#isRealAttachment`'s per-attachment test) is the
   * attachment panel's job, not this schema's — a `cid:`-only part never
   * shows there as a file.
   */
  attachments: z.array(messageAttachmentSchema),
  bodyText: z.string().nullable(),
  /**
   * Sanitized HTML, remote images already rewritten to signed
   * `/messages/:id/image-proxy` URLs (`sync/image-proxy.ts`). `cid:`
   * references are left exactly as the sender wrote them — the Client
   * resolves those itself against `attachments`, per
   * `docs/research/0005` §4. Null for a message with no HTML alternative.
   */
  bodyHtml: z.string().nullable(),
  /**
   * `true` when `bodyHtml` has no native HTML alternative behind it — the
   * server synthesized it from `bodyText` (`plainTextToHtml`,
   * `sync/bodies.ts`) because the sender only sent plain text. The Width
   * decision (#98, ADR-0018, `apps/client/DESIGN.md`): the reading pane
   * lets an HTML body fill the pane — the sender's own document decides its
   * width — but centers a plain-text one at the same readable column the
   * Snippet and reading header use. `false` for a body fetched before this
   * field existed (`routes/messages.ts` reads a `null` column as `false`),
   * which is the same "fills the pane" behavior those messages already had.
   */
  bodyIsPlainText: z.boolean(),
  /**
   * Whether this message's remote images should load without asking (#55,
   * poc-scope.md: "Remote images blocked by default and loaded automatically
   * for Approved Senders — the Gatekeeper verdict *is* the image-loading
   * permission"). True exactly when the `From` address resolves to an
   * Approved Verdict on this Mail Account.
   *
   * This is the **default** the reading pane opens with, not an
   * authorization: the per-message "Load remote images" override
   * (`MessageBody.tsx`) still works for an Unscreened or Blocked sender, and
   * `/messages/:id/image-proxy` still serves any validly-signed request —
   * the proxy's job is hiding the viewer's IP and refusing to be an open
   * relay, and making it refuse on a verdict would break the override
   * without protecting anything the User has not already chosen to see.
   */
  remoteImagesAllowed: z.boolean(),
});
export type Message = z.infer<typeof messageSchema>;

export const threadMessagesResponseSchema = z.object({
  messages: z.array(messageSchema),
});
export type ThreadMessagesResponse = z.infer<typeof threadMessagesResponseSchema>;
