import type { FolderRow } from "../sync/folders.js";

/**
 * The Notifier's pure policy (#53, ADR-0015): what makes an event
 * push-worthy, kept free of any database or IMAP dependency so it is
 * testable as plain functions. Everything *stateful* about a decision
 * (dedup, the burst cap, actually sending) lives in `outbox.ts`/`deliver.ts`.
 */

/**
 * "New mail from an Approved Sender landing in the Inbox" (ADR-0015), the
 * half of that sentence this module can answer on its own: is it in the
 * Inbox at all? A Sent self-copy, a Junk delivery and anything a server-side
 * rule already filed elsewhere are not what the User is being interrupted
 * for.
 *
 * The **sender** half now lives upstream, in `gatekeeper/screening.ts` (#55):
 * `sync/arrivals.ts` screens a batch first and hands `record.ts` only the
 * message ids that were neither held nor blocked. Deliberately one gate, not
 * two — a second `AND verdict = 'approved'` check here would eventually
 * disagree with the one that decided whether the mail is visible at all, and
 * the disagreement would show up as either a silent Inbox or a push about
 * mail the User cannot see.
 *
 * Note what that means for a Mail Account with Gatekeeper switched off, and
 * for an Unscreened sender replying into an ongoing Thread: both reach the
 * Inbox, so both push. That is the right reading of ADR-0015 — mail the
 * Screener let through is mail the User is expected to see, and mail landing
 * silently in the Inbox is the failure mode worth avoiding.
 */
export function isInboxArrival(folder: Pick<FolderRow, "role">): boolean {
  return folder.role === "inbox";
}

/**
 * The coalesced Gatekeeper digest's silence window (poc-scope.md: "one
 * coalesced Gatekeeper notification naming the senders ... on the first
 * hold, then suppressed for 4 hours"). Strangers arriving is precisely the
 * category of event that is worth knowing about once and never worth being
 * interrupted by twice.
 */
export const GATEKEEPER_DIGEST_SILENCE_MS = 4 * 60 * 60 * 1000;

/** How many senders a digest names before it stops listing them — the Screener holds the real list. */
export const GATEKEEPER_DIGEST_SENDER_CAP = 3;

/**
 * Past this many individual `new_mail` pushes pending for one Mail Account,
 * `deliver.ts` collapses them into a single "N new messages" push instead
 * (poc-scope.md: "past ~5 pushes in a short window, collapse"). "In a short
 * window" has no ADR-given number; this codebase has no rolling-window
 * bookkeeping to spend on one, so the window is defined structurally instead
 * — however many `new_mail` outbox rows are still undelivered the moment a
 * delivery tick runs. A genuine 50-message IDLE burst accumulates every one
 * of its rows before the (short, ~2s) delivery interval's next tick, so this
 * still collapses exactly the case the ADR names.
 */
export const NEW_MAIL_BURST_CAP = 5;
