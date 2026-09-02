import type { AttachmentDisposition, AttachmentMeta } from "@mail/shared";
import { encodedByteSize } from "@mail/shared";
import { File as FileIcon, RotateCcw, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AttachmentBudgetExceededError,
  attachmentUrl,
  deleteAttachment,
  fetchComposeConfig,
  uploadAttachment,
} from "../api/attachments.js";
import { recordAttachmentRemoved, recordAttachmentUploaded } from "../store/index.js";
import { checkAttachmentBudget } from "./attachment-budget.js";

/** ADR-0012's own default — used only until `fetchComposeConfig` answers, or if it never does. */
const FALLBACK_BUDGET_BYTES = 25 * 1024 * 1024;

interface InFlightUpload {
  localId: string;
  filename: string;
  sizeBytes: number;
  progress: number;
  /** Set on failure — compose-spec's "retry-on-failure". */
  error: string | null;
  disposition: AttachmentDisposition;
  /**
   * Retained across the upload's lifetime so a failed upload's retry can
   * re-attempt with the same bytes — a `File` handle is cheap to hold (it is
   * a reference to the browser's own file, not a copy) and this is what
   * makes `retryUpload` a real re-upload rather than the "re-select the
   * file" fallback compose-spec's "retry-on-failure" would otherwise need.
   */
  file: File;
}

export interface UseAttachmentsResult {
  uploads: InFlightUpload[];
  budgetError: string | null;
  /** compose-spec: "budget bar appears past 50% of the instance limit" — null while under that. */
  budgetFraction: number | null;
  /** compose-spec: "send is disabled while an upload is in flight". */
  uploading: boolean;
  attachFiles: (files: File[], disposition: AttachmentDisposition) => void;
  removeAttachment: (attachmentId: string) => void;
  retryUpload: (localId: string) => void;
}

/**
 * The composer's own attach flow (#48): the live budget check at selection,
 * the upload with progress, retry-on-failure, and the "Send disabled while
 * uploading" flag — everything `Composer.tsx` needs and nothing it has to
 * know about the Blob Store's own HTTP shape.
 */
export function useAttachments(
  compositionId: string,
  mailAccountId: string,
  attachments: AttachmentMeta[],
  ensureComposition: () => void,
  /** Called only for a successful `inline` upload — a paste is what inserts an image node, not a drop. */
  onInlineUploaded?: (meta: AttachmentMeta) => void,
): UseAttachmentsResult {
  const [uploads, setUploads] = useState<InFlightUpload[]>([]);
  const [budgetError, setBudgetError] = useState<string | null>(null);
  const [budgetBytes, setBudgetBytes] = useState<number>(FALLBACK_BUDGET_BYTES);

  useEffect(() => {
    let cancelled = false;
    void fetchComposeConfig()
      .then((config) => {
        if (!cancelled) setBudgetBytes(config.attachmentBudgetEncodedBytes);
      })
      // The fallback default is close enough to keep the live check working
      // even if this instance's own value never loads.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const startUpload = useCallback(
    (localId: string, file: File, disposition: AttachmentDisposition) => {
      ensureComposition();
      void uploadAttachment({
        compositionId,
        mailAccountId,
        file,
        disposition,
        onProgress: (fraction) => {
          setUploads((current) =>
            current.map((entry) =>
              entry.localId === localId ? { ...entry, progress: fraction } : entry,
            ),
          );
        },
      })
        .then(async (meta) => {
          await recordAttachmentUploaded(compositionId, meta);
          setUploads((current) => current.filter((entry) => entry.localId !== localId));
          if (disposition === "inline") onInlineUploaded?.(meta);
        })
        .catch((err) => {
          const message =
            err instanceof AttachmentBudgetExceededError
              ? "Over the attachment limit — remove something first"
              : "Upload failed";
          setUploads((current) =>
            current.map((entry) =>
              entry.localId === localId ? { ...entry, error: message } : entry,
            ),
          );
        });
    },
    [compositionId, mailAccountId, ensureComposition, onInlineUploaded],
  );

  const attachFiles = useCallback(
    (files: File[], disposition: AttachmentDisposition) => {
      if (files.length === 0) return;
      setBudgetError(null);

      const alreadyInFlight = uploads.map((entry) => ({ sizeBytes: entry.sizeBytes }));
      const verdict = checkAttachmentBudget(
        [...attachments, ...alreadyInFlight],
        files.map((file) => ({ size: file.size })),
        budgetBytes,
      );
      if (verdict.kind === "over_budget") {
        setBudgetError(verdict.message);
        return;
      }

      const placeholders: InFlightUpload[] = files.map((file) => ({
        localId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        filename: file.name,
        sizeBytes: file.size,
        progress: 0,
        error: null,
        disposition,
        file,
      }));
      setUploads((current) => [...current, ...placeholders]);
      for (const [index, placeholder] of placeholders.entries()) {
        startUpload(placeholder.localId, files[index] as File, disposition);
      }
    },
    [attachments, uploads, budgetBytes, startUpload],
  );

  /**
   * compose-spec's "retry-on-failure": re-attempts a failed upload with the
   * same `File` its placeholder retained, through the exact same
   * `startUpload` the initial attempt uses — resetting `progress`/`error`
   * first so the row goes back to showing a fresh attempt rather than the
   * old failure while the retry is in flight.
   */
  const retryUpload = useCallback(
    (localId: string) => {
      const target = uploads.find((entry) => entry.localId === localId);
      if (!target) return;
      setUploads((current) =>
        current.map((entry) =>
          entry.localId === localId ? { ...entry, error: null, progress: 0 } : entry,
        ),
      );
      startUpload(localId, target.file, target.disposition);
    },
    [uploads, startUpload],
  );

  const removeAttachment = useCallback(
    (attachmentId: string) => {
      void deleteAttachment(compositionId, attachmentId).then(() =>
        recordAttachmentRemoved(compositionId, attachmentId),
      );
    },
    [compositionId],
  );

  const usedBytes = useMemo(
    () => attachments.reduce((total, entry) => total + encodedByteSize(entry.sizeBytes), 0),
    [attachments],
  );
  const budgetFraction = usedBytes / budgetBytes > 0.5 ? usedBytes / budgetBytes : null;

  return {
    uploads,
    budgetError,
    budgetFraction,
    uploading: uploads.some((entry) => entry.error === null),
    attachFiles,
    removeAttachment,
    retryUpload,
  };
}

export interface AttachmentsPanelProps {
  compositionId: string;
  attachments: AttachmentMeta[];
  uploads: InFlightUpload[];
  budgetError: string | null;
  budgetFraction: number | null;
  onRemove: (attachmentId: string) => void;
  onRetry: (localId: string) => void;
}

export function AttachmentsPanel({
  compositionId,
  attachments,
  uploads,
  budgetError,
  budgetFraction,
  onRemove,
  onRetry,
}: AttachmentsPanelProps) {
  if (attachments.length === 0 && uploads.length === 0 && !budgetError) return null;

  return (
    <div className="attachments-panel">
      {budgetError && <div className="attachments-budget-error">{budgetError}</div>}
      {budgetFraction !== null && (
        <div className="attachments-budget-bar" aria-hidden="true">
          <div
            className="attachments-budget-bar-fill"
            style={{ width: `${Math.min(100, budgetFraction * 100)}%` }}
          />
        </div>
      )}
      {attachments.map((attachment) => (
        <div className="attachment-row" key={attachment.id}>
          <FileIcon size={14} />
          <a
            className="attachment-row-name"
            href={attachmentUrl(compositionId, attachment.id)}
            target="_blank"
            rel="noreferrer"
          >
            {attachment.filename}
          </a>
          <span className="attachment-row-size">{formatBytes(attachment.sizeBytes)}</span>
          <button
            type="button"
            aria-label={`Remove ${attachment.filename}`}
            onClick={() => onRemove(attachment.id)}
          >
            <X size={13} />
          </button>
        </div>
      ))}
      {uploads.map((upload) => (
        <div className="attachment-row attachment-row-uploading" key={upload.localId}>
          <FileIcon size={14} />
          <span className="attachment-row-name">{upload.filename}</span>
          {upload.error ? (
            <>
              <span className="attachment-row-error">{upload.error}</span>
              <button
                type="button"
                aria-label={`Retry ${upload.filename}`}
                onClick={() => onRetry(upload.localId)}
              >
                <RotateCcw size={13} />
              </button>
            </>
          ) : (
            <span className="attachment-row-progress">{Math.round(upload.progress * 100)}%</span>
          )}
        </div>
      ))}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
