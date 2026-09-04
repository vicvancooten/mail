import type { ThreadParticipant } from "@mail/shared";
import { labelNameFromId } from "@mail/shared";
import { Check, Clock, type LucideIcon, Pin, Star } from "lucide-react";
import { type CSSProperties, type ReactElement, type ReactNode, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover.js";
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
 * One control in the row's hover cluster, as the Action registry describes
 * it (#94). `VirtualizedThreadList` builds these from the registry's
 * `"row-hover"`-flagged, currently-available actions, so flagging a new
 * action for hover is one registry entry and nothing here — this component
 * only decides how a hover control *looks*, never which ones exist.
 *
 * Done is the exception, and stays `onArchive` below: it does not live in
 * this cluster at all but in the row's own reserved whitespace on the left
 * (the comp's `.row-check`), which is a layout decision rather than an
 * action one.
 */
export interface RowHoverAction {
  id: string;
  /** The control's accessible name, already naming the Thread it acts on. */
  label: string;
  /** Its tooltip — the label plus its keycap, where it has one. */
  title: string;
  icon: LucideIcon;
  /** Pressed state, for a control that toggles something the row displays (Pin). */
  on?: boolean;
  /** Renders as a Popover of Snooze presets instead of a plain button — the pick is a time, not a boolean (#76). */
  picker?: "snooze";
  run?: () => void;
  onPick?: (until: string) => void;
}

/**
 * Shared row markup for the Split and List views (Stream mode doesn't use a
 * list row at all — the point of that mode is not having a list), rebuilt in
 * #87 against the comp's own `.thread-row`
 * (`docs/design/prototypes/the-instrument.html`): a rounded row floating on
 * the page ground with no rule under it and no plate behind it, reserved
 * whitespace on the left holding the row's **Done** action and its segment
 * of the group's timeline spine, the correspondent's round tile, one
 * baseline-aligned line of sender + subject, and a fixed-width meta column
 * on the right where the timestamp trades place with the row's hover
 * actions. Selection is the comp's `--color-accent-soft` tint, never an ink
 * inversion; unread is weight and ink on the sender plus the tile's own
 * accent dot, never a badge beside the row.
 *
 * `pinned`/`labelIds` (#43) render as the comp's small `--color-warn` pin
 * glyph inline after the sender and a couple of quiet chips after the
 * subject — label names come straight off `labelNameFromId`, no `Label`
 * collection lookup needed for a row to render correctly the instant an
 * offline apply lands.
 *
 * The outer element is a `<div role="option">`, not a `<button>` (#75): the
 * row's own **Done** / **Snooze** / **Pin** controls (below) are real,
 * independently focusable `<button>`s, and a button cannot legally nest
 * inside another interactive element. Selecting the row is still one click
 * anywhere on it — the click bubbles to `onSelect` the same way it always
 * has — and keyboard selection has never gone through per-row focus here
 * anyway (`j`/`k`, the Action registry's single listener), so nothing about
 * that path changes.
 *
 * `onArchive`/`onSnooze` (#44, #76, `poc-scope.md` §Clients & notifications)
 * wire the row into `useSwipeToTriage` *and* their own row controls below —
 * optional because `VirtualizedThreadList` has one non-triage caller path in
 * tests, and because the swipe hook is already a no-op for anything but a
 * touch pointer, so wiring it unconditionally would cost nothing either way;
 * optional just avoids threading unused callbacks through call sites that
 * truly have none. There is deliberately no `onTrash` here: Trash stays one
 * keystroke away (the registry's `#`/Backspace/Delete binding) and one
 * right-click away (`contextMenu` below), but per #66's own row-cluster/
 * swipe design ("swipe right marks Done, swipe left snoozes") it has no
 * row-level hover or swipe control of its own.
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
  onTogglePin,
  hoverActions,
  contextMenu,
  headline = null,
  folderPill = null,
  actionBadge = null,
  gatekeeperBadge = null,
  accountBadge = null,
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
  /** #43/#87: the comp's row-hover actions are Snooze *and* Pin — same optional-wiring posture as the two above, so search's non-triage rows simply render neither. */
  onTogglePin?: () => void;
  /** The hover cluster, straight from the Action registry (#94). Given, it replaces the `onSnooze`/`onTogglePin` pair above entirely; omitted (a caller with no registry context above it), those two still render exactly as they always have. */
  hoverActions?: readonly RowHoverAction[];
  /** Wraps the rendered row in its right-click / long-press menu (#94) — `VirtualizedThreadList` supplies `ActionMenu`; a row rendered with no registry context above it simply has none. */
  contextMenu?: (row: ReactNode) => ReactElement;
  /** The `ts_headline` fragment (search-ux-spec.md §The row), pre-parsed for `<mark>` rendering. `null`/`undefined`: keep the ordinary Snippet. */
  headline?: string | null;
  /** The non-Inbox folder pill (search-ux-spec.md: "Search crosses folders, and 'where did this end up' is half the question"). */
  folderPill?: string | null;
  /** "The row stays in place, visibly changed" (search-ux-spec.md §Acting on a result) once a triage action has been taken on a result row that isn't in the Inbox any more. */
  actionBadge?: string | null;
  /** Held/Blocked (#56, poc-spec.md: "search returns held and blocked mail badged") — search results only. */
  gatekeeperBadge?: "held" | "blocked" | null;
  /** Which Mail Account this row came from (#80) — search results only, and only once Scope spans more than one account. */
  accountBadge?: string | null;
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

  // The hover cluster the registry describes (#94), or — for a caller with
  // no registry context above it (a unit test, search's non-triage rows) —
  // the same two controls its own props have always asked for. One render
  // path either way, so the comp's cluster can never drift between them.
  const legacyCluster: RowHoverAction[] = [];
  if (onSnooze) {
    legacyCluster.push({
      id: "snooze",
      label: `Snooze "${subjectLabel}"`,
      title: "Snooze",
      icon: Clock,
      picker: "snooze",
      onPick: onSnooze,
    });
  }
  if (onTogglePin) {
    legacyCluster.push({
      id: "pin",
      label: `${thread.pinned ? "Unpin" : "Pin"} "${subjectLabel}"`,
      title: "Pin (p)",
      icon: Pin,
      on: thread.pinned,
      run: onTogglePin,
    });
  }
  const cluster: readonly RowHoverAction[] = hoverActions ?? legacyCluster;

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
      {/* The comp's `.row-check`: reserved whitespace to the left of the
          tile, holding this row's segment of the group's timeline spine and
          its own Done action — invisible at rest, so the resting list is
          nothing but correspondents and subjects. It never touches or
          overlays the tile, because the checkmark is an action ("archive
          this"), not a selection state, and because a fixed slot means
          arming the row shifts nothing else in it. */}
      <span className="row-check">
        {onArchive ? (
          <button
            type="button"
            className="done-btn"
            aria-label={`Mark "${subjectLabel}" Done`}
            title="Done (e)"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onArchive();
            }}
          >
            <Check size={12} />
          </button>
        ) : null}
      </span>
      <Avatar name={participantLabel} unread={unread} />
      <span className="row-line">
        <span className="row-sender">{participantLabel}</span>
        {thread.pinned ? <Pin size={10} className="row-pin" /> : null}
        {thread.starred ? <Star size={10} className="row-star" /> : null}
        <span className="row-subject">
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
        </span>
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
      {accountBadge ? <span className="account-badge">{accountBadge}</span> : null}
      {folderPill ? <span className="folder-pill">{folderPill}</span> : null}
      {actionBadge ? <span className="action-badge">{actionBadge}</span> : null}
      {gatekeeperBadge ? (
        <span className={`gatekeeper-badge gatekeeper-badge-${gatekeeperBadge}`}>
          {gatekeeperBadge === "held" ? "Held" : "Blocked"}
        </span>
      ) : null}
      {/* The comp's `.row-meta`: one fixed-width column in which the
          timestamp and the row's hover actions occupy the same box, so
          revealing the actions never widens the row or nudges the subject.
          A row with no triage wired (search) simply keeps the time. */}
      <span className="row-meta">
        <span className="row-time">{formatRowTime(thread.lastMessageAt)}</span>
        {cluster.length > 0 ? (
          <span className="row-actions">
            {cluster.map((action) => {
              const Icon = action.icon;
              if (action.picker === "snooze") {
                return (
                  <Popover key={action.id} open={snoozeMenuOpen} onOpenChange={setSnoozeMenuOpen}>
                    <PopoverTrigger asChild>
                      <button
                        type="button"
                        aria-label={action.label}
                        title={action.title}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => event.stopPropagation()}
                      >
                        <Icon size={13} />
                      </button>
                    </PopoverTrigger>
                    <PopoverContent
                      align="end"
                      className="w-auto min-w-[200px] p-1.5"
                      // `PopoverContent` portals out of `.thread-row`'s DOM, but
                      // React still bubbles its synthetic click through the
                      // *React* tree it's declared in — straight up to this
                      // row's own `onClick={onSelect}` — unless stopped here.
                      onClick={(event) => event.stopPropagation()}
                    >
                      <SnoozeMenu
                        thread={thread}
                        onSnooze={(until) => {
                          action.onPick?.(until);
                          setSnoozeMenuOpen(false);
                        }}
                        onClose={() => setSnoozeMenuOpen(false)}
                      />
                    </PopoverContent>
                  </Popover>
                );
              }
              return (
                <button
                  key={action.id}
                  type="button"
                  className={action.on ? "on" : undefined}
                  aria-label={action.label}
                  aria-pressed={action.on}
                  title={action.title}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    action.run?.();
                  }}
                >
                  <Icon size={13} />
                </button>
              );
            })}
          </span>
        ) : null}
      </span>
    </div>
  );

  // Right-click / long-press, on the row and on the swipe wrapper alike, so
  // the menu answers wherever the pointer actually is (#94).
  const withMenu = (content: ReactElement): ReactElement =>
    contextMenu ? contextMenu(content) : content;

  if (!onArchive && !onSnooze) return withMenu(row); // no swipe wiring: skip the reveal wrapper entirely

  return withMenu(
    <div className="thread-row-outer">
      <div className="thread-row-swipe">
        <div
          className={`swipe-reveal ${swipe.revealing ?? ""}`}
          style={{ opacity: revealStrength } as CSSProperties}
          aria-hidden="true"
        >
          {swipe.revealing === "snooze" ? (
            <span className="swipe-reveal-snooze">
              <Clock size={16} /> Snooze
            </span>
          ) : (
            // "Done" (#66 user story 8) — the act, on the row a swipe commits
            // through `onArchive`; the destination it lands in stays named
            // Archive (story 9) wherever that's what the row is naming instead.
            <span className="swipe-reveal-archive">
              <Check size={16} /> Done
            </span>
          )}
        </div>
        {row}
      </div>
    </div>,
  );
}
