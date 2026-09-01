import { Undo2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { CachedComposition } from "../store/index.js";
import { requestCancelSend, undoSecondsRemaining, usePendingSends } from "../store/index.js";
import { requestSyncNow } from "../sync/sync-loop.js";
import "./compose.css";

/**
 * The Undo Send countdown (#46, ADR-0007). Renders every live Pending Send on
 * the active Mail Account — **not** only the one this tab started, which is
 * the whole reason ADR-0007 puts the pending send in the backend: "visible
 * and cancellable from every device the User has open".
 *
 * The countdown is derived from the server's absolute `submitAfter` on every
 * tick rather than decremented, so a tab that was hidden, throttled or asleep
 * shows the truth on its first frame back instead of resuming a stale count.
 *
 * A send this Client has queued but the Sync Backend has not accepted yet
 * (offline, or mid-round-trip) has no deadline to count from and says so —
 * ADR-0014: "the composer reports 'will send when reconnected' rather than
 * running a timer that is lying about what happens at zero."
 */

export interface PendingSendBarProps {
  mailAccountId: string | null;
  /** Cancelling "restores a Draft and reopens the composer on whichever device cancelled" (ADR-0007). */
  onReopen: (compositionId: string) => void;
}

/**
 * Fast enough that the number on screen is never visibly wrong, and it costs
 * one `Date.now()` per second while a send is pending and nothing at all
 * otherwise.
 */
const TICK_MS = 250;

export function PendingSendBar({ mailAccountId, onReopen }: PendingSendBarProps) {
  const pending = usePendingSends(mailAccountId);
  const [now, setNow] = useState(() => Date.now());

  const hasPending = (pending?.length ?? 0) > 0;
  useEffect(() => {
    if (!hasPending) return;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [hasPending]);

  // While a send is live, poll rather than wait for the ordinary 30s round:
  // the deadline, the claim and a cancel from another device all land inside
  // a window measured in seconds. This is the same seam #52's SSE Sync Hints
  // will drive, at which point this can go.
  useEffect(() => {
    if (!hasPending) return;
    const timer = setInterval(requestSyncNow, 2_000);
    return () => clearInterval(timer);
  }, [hasPending]);

  if (!pending || pending.length === 0 || !mailAccountId) return null;

  return (
    <div className="pending-send-bar">
      {pending.map((row) => (
        <PendingSendRow
          key={row.id}
          row={row}
          now={now}
          mailAccountId={mailAccountId}
          onReopen={onReopen}
        />
      ))}
    </div>
  );
}

function PendingSendRow({
  row,
  now,
  mailAccountId,
  onReopen,
}: {
  row: CachedComposition;
  now: number;
  mailAccountId: string;
  onReopen: (compositionId: string) => void;
}) {
  const remaining = undoSecondsRemaining(row, now);
  // Past the claim there is nothing left to undo — ADR-0007's point of no
  // return is the claim, not the deadline, and offering a button that can
  // only fail would be worse than not offering one.
  const cancellable = row.status === "pending" && row.sendState !== "cancelling";

  // The composer reopens straight away rather than waiting for the cancel to
  // be confirmed: a cancel almost always wins, and ADR-0007 asks for the
  // composer back on the device that cancelled. If it *does* lose, this row
  // says so ("too late") and the reopened composer's autosaves are rejected
  // as `not_a_draft` — visible, not silent.
  const cancel = () => {
    void requestCancelSend(row.id, mailAccountId).then(() => {
      requestSyncNow();
      onReopen(row.id);
    });
  };

  return (
    <div className="pending-send" role="status">
      <span className="pending-send-label">{label(row, remaining)}</span>
      {cancellable && (
        <button type="button" className="pending-send-undo" onClick={cancel}>
          <Undo2 size={13} />
          Undo
        </button>
      )}
    </div>
  );
}

function label(row: CachedComposition, remaining: number | null): string {
  const subject = row.subject.trim().length > 0 ? row.subject.trim() : "(no subject)";
  if (row.sendState === "too_late") return `Too late to undo — “${subject}” is already on its way`;
  if (row.sendState === "cancelling") return `Cancelling “${subject}”…`;
  if (row.status === "submitting") return `Sending “${subject}”…`;
  if (remaining === null) return `“${subject}” will send when reconnected`;
  if (remaining <= 0) return `Sending “${subject}”…`;
  return `Sending “${subject}” in ${remaining}s`;
}
