import type { AttachmentMeta } from "@mail/shared";
import { encodedByteSize } from "@mail/shared";

/**
 * The live budget check (compose-spec: "oversize is refused at *selection*
 * time, showing the math ... not a bare 'too big'"), as a pure function so
 * the drop handler and the paste handler can never drift into disagreeing
 * about what's over. The Sync Backend runs the identical `encodedByteSize`
 * formula as its own re-check (`compose/blob-store.ts#putBlob`) — this is
 * purely so a rejection never has to make a round trip to happen.
 */

export type BudgetVerdict =
  | { kind: "ok" }
  | { kind: "over_budget"; message: string; remainingBytes: number };

export function checkAttachmentBudget(
  existing: Pick<AttachmentMeta, "sizeBytes">[],
  newFiles: { size: number }[],
  budgetEncodedBytes: number,
): BudgetVerdict {
  const usedBytes = existing.reduce((total, entry) => total + encodedByteSize(entry.sizeBytes), 0);
  const addedBytes = newFiles.reduce((total, file) => total + encodedByteSize(file.size), 0);
  const remainingBytes = budgetEncodedBytes - usedBytes;

  if (addedBytes <= remainingBytes) return { kind: "ok" };

  return {
    kind: "over_budget",
    remainingBytes: Math.max(0, remainingBytes),
    message: budgetExceededMessage(addedBytes, remainingBytes, budgetEncodedBytes),
  };
}

/** compose-spec: "showing the math — 25MB encoded ≈ 18MB of files — not a bare 'too big'." */
export function budgetExceededMessage(
  addedEncodedBytes: number,
  remainingEncodedBytes: number,
  budgetEncodedBytes: number,
): string {
  return (
    `This would add ${formatMB(addedEncodedBytes)} encoded, but only ` +
    `${formatMB(Math.max(0, remainingEncodedBytes))} is left of the ${formatMB(budgetEncodedBytes)} limit.`
  );
}

function formatMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
