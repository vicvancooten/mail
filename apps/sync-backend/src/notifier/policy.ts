import type { FolderRow } from "../sync/folders.js";

/**
 * The Notifier's pure policy (#53, ADR-0015): what makes an event
 * push-worthy, kept free of any database or IMAP dependency so it is
 * testable as plain functions. Everything *stateful* about a decision
 * (dedup, the burst cap, actually sending) lives in `outbox.ts`/`deliver.ts`.
 */

/**
 * "New mail from an Approved Sender landing in the Inbox" (ADR-0015) —
 * simulated until Gatekeeper (#12) ships a real Verdict to read: there is no
 * Gatekeeper column anywhere in this schema yet (`db/schema.ts`), so every
 * Inbox message is treated as Approved-Sender for now. `docs/poc-scope.md`'s
 * Gatekeeper section is where a real check plugs in — this function is the
 * one call site that will need to grow an `AND verdict = 'approved'` clause.
 */
export function isSimulatedApprovedSenderMail(folder: Pick<FolderRow, "role">): boolean {
  return folder.role === "inbox";
}

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
