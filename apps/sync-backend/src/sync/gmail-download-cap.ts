/**
 * Gmail's roughly 2.5 GB/day IMAP download cap (#127, ADR-0020's final
 * consequence): once a Gmail account's body sweep trips it, Gmail keeps
 * rejecting FETCHes on that connection until its own daily quota rolls over.
 * Gmail gives this no error code of its own (unlike, say, imapflow's
 * Microsoft-365 `ETHROTTLE` case) — only wording tacked onto an otherwise
 * generic tagged `NO`, so detection is by matching that text.
 */

/**
 * Matches Gmail's own wording for the daily bandwidth/download cap. Gmail's
 * "command or bandwidth limits" phrasing is deliberately not a second
 * alternative here — `bandwidth limit` already matches inside it, so it
 * would only ever be a dead branch.
 */
const DOWNLOAD_CAP_PATTERN = /bandwidth limit/i;

/** How long a paused sweep waits before trying again — Gmail's cap is a rolling daily one. */
export const GMAIL_DOWNLOAD_CAP_RESUME_MS = 24 * 60 * 60_000;

/**
 * True when `err` looks like Gmail's IMAP download-cap response rather than
 * an ordinary connection or protocol failure. Only meaningful for a Gmail
 * account (`isGmailAccount`; `body-sweep.ts`'s only caller already gates on
 * that) — the same wording is neither expected nor specially handled from
 * any other server (ADR-0020).
 */
export function isGmailDownloadCapError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const candidate = err as { responseText?: unknown; response?: unknown; message?: unknown };
  const text = [candidate.responseText, candidate.response, candidate.message]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  return DOWNLOAD_CAP_PATTERN.test(text);
}
