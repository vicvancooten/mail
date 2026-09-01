import type { ThreadParticipant } from "@mail/shared";
import { labelNameFromId } from "@mail/shared";
import { Archive, Pin, Star, Trash2 } from "lucide-react";
import type { CSSProperties } from "react";
import type { CachedThread } from "../store/index.js";
import { Avatar } from "./Avatar.js";
import { formatRowTime } from "./time-groups.js";
import { SWIPE_COMMIT_THRESHOLD_PX, useSwipeToTriage } from "./useSwipeToTriage.js";

const MAX_STAGGER = 8; // caps the list-load stagger at 8 * --stagger-row (see index.css)
/** How many Label chips a row shows before collapsing the rest into a "+N" — keeps a heavily-labeled Thread's row one line. */
const MAX_ROW_LABEL_CHIPS = 2;

function describeParticipant(participant: ThreadParticipant): string {
  return participant.name ?? participant.address;
}

/**
 * Shared row markup for the Split and List views (Stream mode doesn't use a
 * list row at all — the point of that mode is not having a list). Adopted
 * from `prototype/triage-loop-ui`'s `ThreadRow`, adjusted to the real wire
 * `Thread` shape: no `sender` string, a `participants` array. `pinned`/
 * `labelIds` (#43) render as a Pin icon and a couple of chips — label names
 * come straight off `labelNameFromId`, no `Label` collection lookup needed
 * for a row to render correctly the instant an offline apply lands.
 *
 * `onArchive`/`onTrash` (#44, `poc-scope.md` §Clients & notifications) wire
 * the row into `useSwipeToTriage` — optional because `VirtualizedThreadList`
 * has one non-triage caller path in tests, and because the hook itself is
 * already a no-op for anything but a touch pointer, so wiring it
 * unconditionally would cost nothing either way; optional just avoids
 * threading two unused callbacks through call sites that truly have none.
 */
export function ThreadRow({
  thread,
  selected,
  onSelect,
  onArchive,
  onTrash,
  index = 0,
}: {
  thread: CachedThread;
  selected: boolean;
  onSelect: () => void;
  onArchive?: () => void;
  onTrash?: () => void;
  /** Position within the visible page — drives the one-shot list-load stagger. */
  index?: number;
}) {
  const unread = thread.unreadCount > 0;
  const participantLabel = thread.participants.map(describeParticipant).join(", ") || "(no sender)";
  const visibleLabelIds = thread.labelIds.slice(0, MAX_ROW_LABEL_CHIPS);
  const overflowLabelCount = thread.labelIds.length - visibleLabelIds.length;

  const swipe = useSwipeToTriage({
    onArchive: onArchive ?? (() => {}),
    onTrash: onTrash ?? (() => {}),
  });
  const revealStrength = Math.min(Math.abs(swipe.offsetX) / SWIPE_COMMIT_THRESHOLD_PX, 1);

  const row = (
    <button
      type="button"
      className={`thread-row${unread ? " unread" : ""}${selected ? " selected" : ""}${thread.pinned ? " pinned" : ""}`}
      style={
        {
          "--i": Math.min(index, MAX_STAGGER),
          transform: swipe.offsetX ? `translateX(${swipe.offsetX}px)` : undefined,
          transition: swipe.settling ? undefined : "none",
        } as CSSProperties
      }
      onClick={onSelect}
      role="option"
      aria-selected={selected}
      {...swipe.handlers}
    >
      <span className={`unread-dot${unread ? "" : " hidden"}`} />
      <Avatar name={participantLabel} />
      <span className="sender">{participantLabel}</span>
      <span className="subject-line">
        <span className="subject">{thread.subject || "(no subject)"}</span>
        {thread.snippet ? <span className="snippet">{thread.snippet}</span> : null}
        {visibleLabelIds.length > 0 ? (
          <span className="row-labels">
            {visibleLabelIds.map((id) => (
              <span key={id} className="label-chip">
                {labelNameFromId(thread.mailAccountId, id)}
              </span>
            ))}
            {overflowLabelCount > 0 ? (
              <span className="label-chip overflow">+{overflowLabelCount}</span>
            ) : null}
          </span>
        ) : null}
      </span>
      {thread.pinned ? <Pin size={13} className="pin" fill="currentColor" /> : null}
      {thread.starred ? <Star size={13} className="star" fill="currentColor" /> : null}
      <span className="time">{formatRowTime(thread.lastMessageAt)}</span>
    </button>
  );

  if (!onArchive && !onTrash) return row; // no swipe wiring: skip the reveal wrapper entirely

  return (
    <div className="thread-row-swipe">
      <div
        className={`swipe-reveal ${swipe.revealing ?? ""}`}
        style={{ opacity: revealStrength } as CSSProperties}
        aria-hidden="true"
      >
        {swipe.revealing === "trash" ? (
          <span className="swipe-reveal-trash">
            <Trash2 size={16} /> Trash
          </span>
        ) : (
          <span className="swipe-reveal-archive">
            <Archive size={16} /> Archive
          </span>
        )}
      </div>
      {row}
    </div>
  );
}
