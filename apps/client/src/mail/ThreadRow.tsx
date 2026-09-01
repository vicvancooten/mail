import type { ThreadParticipant } from "@mail/shared";
import { labelNameFromId } from "@mail/shared";
import { Pin, Star } from "lucide-react";
import type { CSSProperties } from "react";
import type { CachedThread } from "../store/index.js";
import { Avatar } from "./Avatar.js";
import { formatRowTime } from "./time-groups.js";

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
 */
export function ThreadRow({
  thread,
  selected,
  onSelect,
  index = 0,
}: {
  thread: CachedThread;
  selected: boolean;
  onSelect: () => void;
  /** Position within the visible page — drives the one-shot list-load stagger. */
  index?: number;
}) {
  const unread = thread.unreadCount > 0;
  const participantLabel = thread.participants.map(describeParticipant).join(", ") || "(no sender)";
  const visibleLabelIds = thread.labelIds.slice(0, MAX_ROW_LABEL_CHIPS);
  const overflowLabelCount = thread.labelIds.length - visibleLabelIds.length;

  return (
    <button
      type="button"
      className={`thread-row${unread ? " unread" : ""}${selected ? " selected" : ""}${thread.pinned ? " pinned" : ""}`}
      style={{ "--i": Math.min(index, MAX_STAGGER) } as CSSProperties}
      onClick={onSelect}
      role="option"
      aria-selected={selected}
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
}
