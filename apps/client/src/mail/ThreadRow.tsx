import type { ThreadParticipant } from "@mail/shared";
import { Star } from "lucide-react";
import type { CSSProperties } from "react";
import type { CachedThread } from "../store/index.js";
import { Avatar } from "./Avatar.js";
import { formatRowTime } from "./time-groups.js";

const MAX_STAGGER = 8; // caps the list-load stagger at 8 * --stagger-row (see index.css)

function describeParticipant(participant: ThreadParticipant): string {
  return participant.name ?? participant.address;
}

/**
 * Shared row markup for the Split and List views (Stream mode doesn't use a
 * list row at all — the point of that mode is not having a list). Adopted
 * from `prototype/triage-loop-ui`'s `ThreadRow`, adjusted to the real wire
 * `Thread` shape: no `sender` string, a `participants` array; no `pinned`
 * (that is #43's App Feature, not this ticket's).
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

  return (
    <button
      type="button"
      className={`thread-row${unread ? " unread" : ""}${selected ? " selected" : ""}`}
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
      </span>
      {thread.starred ? <Star size={13} className="star" fill="currentColor" /> : null}
      <span className="time">{formatRowTime(thread.lastMessageAt)}</span>
    </button>
  );
}
