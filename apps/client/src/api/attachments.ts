import {
  type AttachmentDisposition,
  type AttachmentMeta,
  attachmentMetaSchema,
  type ComposeConfig,
  composeConfigSchema,
} from "@mail/shared";
import { ApiError, deleteRequest, getJson } from "./auth.js";

/**
 * The Blob Store's HTTP surface (#48): upload (with live progress), download
 * (the composer's own inline-image preview) and delete. Not `postJson`'s
 * shape — an attachment is raw bytes, not a JSON body — so this is the one
 * place in `api/` that builds its own `XMLHttpRequest` rather than going
 * through `fetch`: `fetch` has no upload-progress event, and "per-attachment
 * row with progress" (compose-spec) needs one.
 */

export class AttachmentBudgetExceededError extends Error {
  remainingBytes: number;
  budgetBytes: number;
  constructor(remainingBytes: number, budgetBytes: number) {
    super("attachment_budget_exceeded");
    this.remainingBytes = remainingBytes;
    this.budgetBytes = budgetBytes;
  }
}

export interface UploadAttachmentInput {
  compositionId: string;
  mailAccountId: string;
  file: File;
  disposition: AttachmentDisposition;
  onProgress?: (fraction: number) => void;
}

/**
 * Uploads one file's bytes, resolving to its stored metadata. Rejects with
 * `AttachmentBudgetExceededError` for the backend's own 413 (defense in
 * depth — the Client is expected to have already refused the file before
 * calling this at all, via `budgetErrorMessage` below), or `ApiError`
 * otherwise.
 */
export function uploadAttachment({
  compositionId,
  mailAccountId,
  file,
  disposition,
  onProgress,
}: UploadAttachmentInput): Promise<AttachmentMeta> {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      mailAccountId,
      filename: file.name,
      mimeType: file.type || "application/octet-stream",
      disposition,
    });
    const xhr = new XMLHttpRequest();
    xhr.open(
      "POST",
      `/compositions/${encodeURIComponent(compositionId)}/attachments?${params.toString()}`,
    );
    xhr.withCredentials = true;
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total);
    };
    xhr.onerror = () => reject(new ApiError(0, "network_error"));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(attachmentMetaSchema.parse(JSON.parse(xhr.responseText)));
        } catch {
          reject(new ApiError(xhr.status, "invalid_response"));
        }
        return;
      }
      if (xhr.status === 413) {
        try {
          const body = JSON.parse(xhr.responseText) as {
            remainingBytes: number;
            budgetBytes: number;
          };
          reject(new AttachmentBudgetExceededError(body.remainingBytes, body.budgetBytes));
          return;
        } catch {
          // fall through to the generic error below
        }
      }
      reject(new ApiError(xhr.status, errorCodeFromXhr(xhr)));
    };
    xhr.send(file);
  });
}

function errorCodeFromXhr(xhr: XMLHttpRequest): string {
  try {
    const body = JSON.parse(xhr.responseText) as { error?: string };
    return body.error ?? `http_${xhr.status}`;
  } catch {
    return `http_${xhr.status}`;
  }
}

export function deleteAttachment(compositionId: string, attachmentId: string): Promise<void> {
  return deleteRequest(
    `/compositions/${encodeURIComponent(compositionId)}/attachments/${encodeURIComponent(attachmentId)}`,
  );
}

/** The composer's own preview/download URL for one attachment — same-origin, carries the session cookie. */
export function attachmentUrl(compositionId: string, attachmentId: string): string {
  return `/compositions/${encodeURIComponent(compositionId)}/attachments/${encodeURIComponent(attachmentId)}`;
}

let cachedConfig: Promise<ComposeConfig> | null = null;

/**
 * The instance-level attachment budget (ADR-0012), fetched once and cached
 * for the life of the tab — it cannot change without a restart, and the
 * composer needs it synchronously enough that a network round trip per
 * dropped file would be a real drag on "enforced live at selection".
 */
export function fetchComposeConfig(): Promise<ComposeConfig> {
  cachedConfig ??= getJson("/compose-config", (data) => composeConfigSchema.parse(data)).catch(
    (err) => {
      cachedConfig = null;
      throw err;
    },
  );
  return cachedConfig;
}
