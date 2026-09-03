import type { ThreadParticipant } from "@mail/shared";
import { labelNameFromId } from "@mail/shared";
import { type CSSProperties, useState } from "react";
import { Pictogram } from "../brand/Pictogram.js";
import type { CachedThread } from "../store/index.js";
import { Avatar } from "./Avatar.js";
import { SnoozeMenu } from "./SnoozeMenu.js";
import { parseHeadline } from "./search/headline.js";
import { defaultSwipeSnoozeUntil } from "./snooze-presets.js";
import { formatRowTime, type TimeGroupTier } from "./time-groups.js";
import { SWIPE_COMMIT_THRESHOLD_PX, useSwipeToTriage } from "./useSwipeToTriage.js";

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
 * The outer element is a `<div role="option">`, not a `<button>` (#75): the
 * row's own **Done** / **Snooze** controls (below) are real, independently
 * focusable `<button>`s, and a button cannot legally nest inside another
 * interactive element. Selecting the row is still one click anywhere on it
 * — the click bubbles to `onSelect` the same way it always has — and
 * keyboard selection has never gone through per-row focus here anyway
 * (`j`/`k`, one window listener in `VirtualizedThreadList`), so nothing
 * about that path changes.
 *
 * `onArchive`/`onSnooze` (#44, #76, `poc-scope.md` §Clients & notifications)
 * wire the row into `useSwipeToTriage` *and* their own row cluster controls
 * below — optional because `VirtualizedThreadList` has one non-triage
 * caller path in tests, and because the swipe hook is already a no-op for
 * anything but a touch pointer, so wiring it unconditionally would cost
 * nothing either way; optional just avoids threading unused callbacks
 * through call sites that truly have none. There is deliberately no
 * `onTrash` here: Trash stays one keystroke away (`useTriage.ts`'s own
 * `#`/Backspace/Delete binding), but per #66's own row-cluster/swipe design
 * ("swipe right marks Done, swipe left snoozes") it has no row-level mouse
 * or swipe control of its own.
 *
 * `headline`/`folderPill`/`actionBadge` are search's own additions (#51,
 * `docs/search-ux-spec.md` §The row: "Built on ADR-0011's `Thread` list-row
 * projection, which search reuses unchanged, plus...") — the row markup
 * itself is untouched, these just decorate it. `headline` replaces the
 * Snippet only when given; a subject-only match has no headline and the
 * row falls back to the ordinary Snippet, "so a row never looks broken."
 */
export function ThreadRow({
  thread,
  selected,
  onSelect,
  onArchive,
  onSnooze,
  headline = null,
  folderPill = null,
  actionBadge = null,
  gatekeeperBadge = null,
  tier = null,
  height,
  previewArmed = false,
}: {
  thread: CachedThread;
  selected: boolean;
  onSelect: () => void;
  onArchive?: () => void;
  /** #76: `until` is an ISO datetime — the row cluster's Snooze button opens `SnoozeMenu` for a preset/custom pick, and a bare swipe left commits `snooze-presets.ts`'s `defaultSwipeSnoozeUntil` with no picker in reach. */
  onSnooze?: (until: string) => void;
  /** The `ts_headline` fragment (search-ux-spec.md §The row), pre-parsed for `<mark>` rendering. `null`/`undefined`: keep the ordinary Snippet. */
  headline?: string | null;
  /** The non-Inbox folder pill (search-ux-spec.md: "Search crosses folders, and 'where did this end up' is half the question"). */
  folderPill?: string | null;
  /** "The row stays in place, visibly changed" (search-ux-spec.md §Acting on a result) once a triage action has been taken on a result row that isn't in the Inbox any more. */
  actionBadge?: string | null;
  /** Held/Blocked (#56, poc-spec.md: "search returns held and blocked mail badged") — search results only. */
  gatekeeperBadge?: "held" | "blocked" | null;
  /** This row's taper tier (#75, `taper.ts`) — `null` for an ungrouped (search) list, which carries no taper. Exposed as `data-tier` for `mail.css`'s header/row/avatar/ink scale. */
  tier?: TimeGroupTier | null;
  /** This row's own height, computed once by `VirtualizedThreadList` from `taper.ts` — the single number the virtualizer and this row's rendered box both use, never a second one guessed in `mail.css` (#75). */
  height?: number;
  /** True while the User hovers this row's own group header checkmark (#66, #77's "hovering the header checkmark previews... every row's Done action") — forces the same reveal hover/focus/selected already give the row's Done control, without claiming this row is itself hovered, focused or selected. */
  previewArmed?: boolean;
}) {
  const unread = thread.unreadCount > 0;
  const participantLabel = thread.participants.map(describeParticipant).join(", ") || "(no sender)";
  const visibleLabelIds = thread.labelIds.slice(0, MAX_ROW_LABEL_CHIPS);
  const overflowLabelCount = thread.labelIds.length - visibleLabelIds.length;
  const headlineSegments = headline ? parseHeadline(headline) : null;
  const subjectLabel = thread.subject || "(no subject)";

  const swipe = useSwipeToTriage({
    onArchive: onArchive ?? (() => {}),
    onSnooze: onSnooze ? () => onSnooze(defaultSwipeSnoozeUntil().toISOString()) : () => {},
  });
  const revealStrength = Math.min(Math.abs(swipe.offsetX) / SWIPE_COMMIT_THRESHOLD_PX, 1);

  // The row cluster's armed state (#66, #75: "every armed state is real
  // component state, not a CSS-only trick"). Hover and focus are tracked
  // here rather than left to `:hover`/`:focus-visible` alone — the same
  // state a future native Client's touch/keyboard model can reuse directly
  // — and `selected` is what "arriving on a row with j/k arms it" cashes
  // out to: `VirtualizedThreadList`'s `moveSelection` sets it exactly the
  // way a click does, so one state covers all three triggers.
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const armed = hovered || focused || selected || previewArmed;

  // The Snooze popover (#76): its own local toggle, mirroring
  // `ThreadDetailPane`'s `pickerOpen` for `LabelPicker` — one open control
  // at a time, closed by picking an option, submitting the custom form, or
  // Escape (`SnoozeMenu`'s own doc comment).
  const [snoozeMenuOpen, setSnoozeMenuOpen] = useState(false);

  const row = (
    <div
      className={`thread-row${unread ? " unread" : ""}${selected ? " selected" : ""}${thread.pinned ? " pinned" : ""}`}
      data-tier={tier ?? undefined}
      data-armed={armed}
      data-group-preview={previewArmed || undefined}
      style={
        {
          height,
          transform: swipe.offsetX ? `translateX(${swipe.offsetX}px)` : undefined,
          transition: swipe.settling ? undefined : "none",
        } as CSSProperties
      }
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      role="option"
      aria-selected={selected}
      {...swipe.handlers}
    >
      {/* Reserved space, left of the Avatar (#66 user stories 10-11, #76):
          fixed width whether armed or not, so arming the cluster never
          shifts the Avatar, the sender column, or any other row — only
          these controls' own opacity changes. Never overlaps or replaces
          the Avatar, so a Done/Snooze click is never confused with a
          selection. */}
      <span className="row-done-slot">
        {onArchive ? (
          <button
            type="button"
            className="row-done"
            aria-label={`Mark "${subjectLabel}" Done`}
            title="Done (e)"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onArchive();
            }}
          >
            <Pictogram name="check" size={13} />
          </button>
        ) : null}
        {onSnooze ? (
          <button
            type="button"
            className="row-snooze"
            aria-label={`Snooze "${subjectLabel}"`}
            aria-haspopup="menu"
            aria-expanded={snoozeMenuOpen}
            title="Snooze"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              setSnoozeMenuOpen((open) => !open);
            }}
          >
            <Pictogram name="snooze" size={13} />
          </button>
        ) : null}
      </span>
      <Avatar name={participantLabel} unread={unread} />
      <span className="sender">{participantLabel}</span>
      <span className="subject-line">
        <span className="subject">{subjectLabel}</span>
        {headlineSegments ? (
          <span className="snippet headline">
            {headlineSegments.map((segment) =>
              segment.matched ? (
                <mark key={segment.offset}>{segment.text}</mark>
              ) : (
                <span key={segment.offset}>{segment.text}</span>
              ),
            )}
          </span>
        ) : thread.snippet ? (
          <span className="snippet">{thread.snippet}</span>
        ) : null}
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
      {folderPill ? <span className="folder-pill">{folderPill}</span> : null}
      {actionBadge ? <span className="action-badge">{actionBadge}</span> : null}
      {gatekeeperBadge ? (
        <span className={`gatekeeper-badge gatekeeper-badge-${gatekeeperBadge}`}>
          {gatekeeperBadge === "held" ? "Held" : "Blocked"}
        </span>
      ) : null}
      {thread.pinned ? <Pictogram name="pin" size={13} className="pin" /> : null}
      {thread.starred ? <Pictogram name="star" size={13} className="star" /> : null}
      <span className="time">{formatRowTime(thread.lastMessageAt)}</span>
    </div>
  );

  // The popover renders outside `.thread-row-swipe` below, never inside it:
  // that wrapper's `overflow: hidden` (needed to clip the swipe drag itself
  // to the row's own bounds) would clip a floated popover too. `onSnooze`'s
  // own presence — not `snoozeMenuOpen` — decides whether it's ever wired
  // up here; the ternary just decides whether it's currently rendered.
  const menu =
    snoozeMenuOpen && onSnooze ? (
      <SnoozeMenu
        thread={thread}
        onSnooze={(until) => {
          onSnooze(until);
          setSnoozeMenuOpen(false);
        }}
        onClose={() => setSnoozeMenuOpen(false)}
      />
    ) : null;

  if (!onArchive && !onSnooze) return row; // no swipe wiring: skip the reveal wrapper entirely

  return (
    <div className="thread-row-outer">
      <div className="thread-row-swipe">
        <div
          className={`swipe-reveal ${swipe.revealing ?? ""}`}
          style={{ opacity: revealStrength } as CSSProperties}
          aria-hidden="true"
        >
          {swipe.revealing === "snooze" ? (
            <span className="swipe-reveal-snooze">
              <Pictogram name="snooze" size={16} /> Snooze
            </span>
          ) : (
            // "Done" (#66 user story 8) — the act, on the row a swipe commits
            // through `onArchive`; the destination it lands in stays named
            // Archive (story 9) wherever that's what the row is naming instead.
            <span className="swipe-reveal-archive">
              <Pictogram name="check" size={16} /> Done
            </span>
          )}
        </div>
        {row}
      </div>
      {menu}
    </div>
  );
}
