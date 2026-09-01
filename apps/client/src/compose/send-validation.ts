import type { Recipient } from "@mail/shared";
import { isSyntacticallyValidAddress } from "./recipients.js";

/**
 * Send-time validation (compose-spec §Send-time validation & failure), as a
 * pure function so the button and `Cmd/Ctrl+Enter` cannot drift into
 * disagreeing about what is sendable.
 *
 * Two kinds, and the distinction matters:
 *
 * - **Blocking**: no syntactically valid recipient. (Over-budget is the other
 *   blocking case; attachments and their budget are #48's.)
 * - **Warn once, then send**: an empty subject or an empty body. The verdict
 *   says only that something is missing; the caller holds the "the User has
 *   seen this" bit and decides that the second press goes through.
 *
 * Validation stays syntactic only — compose-spec: "no MX probe, no SMTP
 * callout. The send is the verification and the bounce is the answer."
 */

export interface SendCandidate {
  to: Recipient[];
  cc: Recipient[];
  bcc: Recipient[];
  subject: string;
  bodyIsEmpty: boolean;
}

export type SendVerdict =
  | { kind: "blocked"; reason: string }
  | { kind: "warn"; reason: string }
  | { kind: "ready" };

export function validateSend(candidate: SendCandidate): SendVerdict {
  const recipients = [...candidate.to, ...candidate.cc, ...candidate.bcc];
  if (!recipients.some((recipient) => isSyntacticallyValidAddress(recipient.address))) {
    return { kind: "blocked", reason: "Add a recipient first" };
  }

  const noSubject = candidate.subject.trim().length === 0;
  if (noSubject && candidate.bodyIsEmpty) {
    return { kind: "warn", reason: "No subject or body — send?" };
  }
  if (noSubject) return { kind: "warn", reason: "No subject — send?" };
  if (candidate.bodyIsEmpty) return { kind: "warn", reason: "Empty body — send?" };
  return { kind: "ready" };
}
