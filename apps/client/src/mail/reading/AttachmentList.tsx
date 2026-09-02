import type { Message, MessageAttachment } from "@mail/shared";
import { attachmentUrl } from "../../api/messages.js";
import { realAttachments } from "./cid.js";
import { PdfAttachmentPreview } from "./PdfAttachmentPreview.js";

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * The attachment panel (#41): every real (non-`cid:`-only) attachment, with
 * inline preview for images and PDFs plus a download link for everything.
 *
 * Image preview is a plain `<img src>` in the app's own DOM — deliberately
 * *not* routed through the sandboxed iframe. These bytes are the app's own
 * (an authenticated fetch-through from *our* backend, never the sender's
 * server), so none of the sender-content threat model applies, and MDN's
 * own guidance (`docs/research/0005` §7) is that `<img>` is already the
 * script-inert way to render an attached SVG — `<object>`/`<iframe>`/
 * `<embed>` are the ones that aren't.
 */
export function AttachmentList({ message }: { message: Message }) {
  const attachments = realAttachments(message);
  if (attachments.length === 0) return null;

  return (
    <div className="attachment-list">
      {attachments.map((attachment) => (
        <AttachmentItem key={attachment.part} messageId={message.id} attachment={attachment} />
      ))}
    </div>
  );
}

function AttachmentItem({
  messageId,
  attachment,
}: {
  messageId: string;
  attachment: MessageAttachment;
}) {
  const url = attachmentUrl(messageId, attachment.part);
  const filename = attachment.filename ?? "attachment";

  return (
    <div className="attachment-item">
      {attachment.mimeType.startsWith("image/") ? (
        <img src={url} alt={filename} loading="lazy" className="attachment-preview-image" />
      ) : attachment.mimeType === "application/pdf" ? (
        <PdfAttachmentPreview src={url} filename={filename} />
      ) : null}
      <div className="attachment-meta">
        <span className="attachment-filename" title={filename}>
          {filename}
        </span>
        <span className="attachment-size">{formatBytes(attachment.sizeBytes)}</span>
        <a href={url} download={filename} className="attachment-download">
          Download
        </a>
      </div>
    </div>
  );
}
