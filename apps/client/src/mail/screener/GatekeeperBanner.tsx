import { ShieldAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { useScreenerSenders } from "../../store/index.js";
import { readScreenerSeenUntil } from "../device-preferences.js";

/**
 * The non-dismissible Inbox banner (#56, poc-spec.md §Gatekeeper v1: "A
 * non-dismissible Inbox banner keys to *unseen* holds"). "Non-dismissible"
 * means there is no close button — the only way this banner goes away is the
 * one the spec names: viewing the Screener (`writeScreenerViewed`, called by
 * `MailSection` the instant it opens, not by anything in here).
 *
 * "Unseen" is the load-bearing word: this does not track "does any hold
 * exist", it tracks "does any hold exist that arrived after the last time
 * the Screener was opened" (`device-preferences.ts#readScreenerSeenUntil`).
 * That is what makes "Hold → banner appears until the Screener is viewed"
 * true *and* lets it reappear for a fresh stranger who wrote in after the
 * User already cleared the last batch — a plain `groups.length > 0` gate
 * would wrongly suppress that second appearance.
 */
export function GatekeeperBanner({
  mailAccountId,
  onOpen,
}: {
  mailAccountId: string | null;
  onOpen: () => void;
}) {
  const groups = useScreenerSenders(mailAccountId) ?? [];
  const [seenUntil, setSeenUntil] = useState(() =>
    mailAccountId ? readScreenerSeenUntil(mailAccountId) : "",
  );

  // Re-read the cursor whenever the account changes — each Mail Account has
  // its own, and switching accounts must not carry one's "seen" state onto
  // another's holds.
  useEffect(() => {
    setSeenUntil(mailAccountId ? readScreenerSeenUntil(mailAccountId) : "");
  }, [mailAccountId]);

  if (!mailAccountId || groups.length === 0) return null;
  const unseen = groups.filter((group) => group.heldSince > seenUntil);
  if (unseen.length === 0) return null;

  const names = unseen
    .slice(0, 3)
    .map((group) => group.name ?? group.address)
    .join(", ");
  const overflow = unseen.length > 3 ? ` +${unseen.length - 3} more` : "";

  return (
    <div className="gatekeeper-banner" role="status">
      <ShieldAlert size={15} />
      <span>
        {unseen.length} sender{unseen.length === 1 ? "" : "s"} waiting in the Screener — {names}
        {overflow}
      </span>
      <button type="button" onClick={onOpen}>
        Review
      </button>
    </div>
  );
}
