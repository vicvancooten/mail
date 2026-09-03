import { TriangleAlert } from "lucide-react";
import { useFailedSends } from "../store/index.js";
import "./compose.css";

/**
 * The persistent send-failure banner (compose-spec §Send-time validation &
 * failure): a permanent rejection returns the Composition to a Draft badged
 * **Send failed** with the SMTP rejection text **verbatim**, plus "a
 * persistent in-app banner until resolved". Not a toast, and not
 * dismissible — "a mail you believe you sent and didn't is the highest-stakes
 * silent failure in the product", so it stays until the User does something
 * about it.
 *
 * "Resolved" is a real event, not a dismissal: sending again clears
 * `sendError` server-side (`compose/pending-send.ts#acceptSend`), and the row
 * drops out of `useFailedSends` on the next sync round.
 *
 * The third leg compose-spec asks for — a Web Push so the failure reaches the
 * User with no Client open — is #53's, which lists this ticket among the
 * transitions it pushes on.
 */

export interface SendFailureBannerProps {
  mailAccountId: string | null;
  /** Opens the badged Draft so the User can fix the address and send again. */
  onOpen: (compositionId: string) => void;
}

export function SendFailureBanner({ mailAccountId, onOpen }: SendFailureBannerProps) {
  const failed = useFailedSends(mailAccountId);
  if (!failed || failed.length === 0) return null;

  return (
    <div className="send-failure-banner" role="alert">
      {failed.map((row) => (
        <div key={row.id} className="send-failure">
          <TriangleAlert size={14} />
          <div className="send-failure-text">
            <strong>Send failed</strong>
            <span className="send-failure-subject">
              {row.subject.trim().length > 0 ? row.subject.trim() : "(no subject)"}
            </span>
            {/* Verbatim, never summarised: `550 5.7.1 relay denied` is what
                makes this actionable (compose-spec). */}
            <code className="send-failure-detail">{row.sendError}</code>
          </div>
          <button type="button" className="send-failure-open" onClick={() => onOpen(row.id)}>
            Open draft
          </button>
        </div>
      ))}
    </div>
  );
}
