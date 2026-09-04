import { ShieldCheck } from "lucide-react";
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
 *
 * Follows Account Scope (#82, #73): the "seen" cursor is per Mail Account
 * (`device-preferences.ts`), so a hold counts as unseen against *its own*
 * account's cursor, not the primary account's — narrowing or widening Scope
 * must never make a still-unseen hold on a non-primary account vanish from
 * the count, nor resurrect one already viewed on the account that holds it.
 */
export function GatekeeperBanner({
  accountScope,
  onOpen,
}: {
  accountScope: readonly string[];
  onOpen: () => void;
}) {
  const accountGroups = useScreenerSenders(accountScope) ?? [];
  const [seenUntil, setSeenUntil] = useState<Record<string, string>>(() =>
    Object.fromEntries(accountScope.map((id) => [id, readScreenerSeenUntil(id)])),
  );

  // Re-read every account's cursor whenever Scope changes — each Mail
  // Account has its own, and widening or narrowing Scope must not carry one
  // account's "seen" state onto another's holds.
  useEffect(() => {
    setSeenUntil(Object.fromEntries(accountScope.map((id) => [id, readScreenerSeenUntil(id)])));
  }, [accountScope]);

  if (accountGroups.length === 0) return null;
  const unseen = accountGroups
    .flatMap((account) => account.senders)
    .filter((group) => group.heldSince > (seenUntil[group.mailAccountId] ?? ""));
  if (unseen.length === 0) return null;

  const names = unseen
    .slice(0, 3)
    .map((group) => group.name ?? group.address)
    .join(", ");
  const overflow = unseen.length > 3 ? ` +${unseen.length - 3} more` : "";

  return (
    <div className="gatekeeper-banner" role="status">
      <ShieldCheck size={15} />
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
