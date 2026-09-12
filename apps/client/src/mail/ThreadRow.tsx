import type { RegionFormatSettings, ThreadParticipant } from "@mail/shared";
import { Check, Clock, type LucideIcon, Pin, Star, Trash2 } from "lucide-react";
import { type CSSProperties, type ReactElement, type ReactNode, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover.js";
import { type CachedThread, labelNameForId } from "../store/index.js";
import { Avatar } from "./Avatar.js";
import { SnoozeMenu } from "./SnoozeMenu.js";
import { parseHeadline } from "./search/headline.js";
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
 * subject — label names come straight off `labelNameForId`, no `Label`
 * collection lookup needed for a row to render correctly the instant an
 * offline apply lands.
 *
 * The outer element is a `<div role="option">`, not a `<button>` (#75): the
 * row's own **Done** / **Snooze** / **Pin** controls (below) are real,
 * independently focusable `<button>`s, and a button cannot legally nest
 * inside another interactive element. Selecting the row is still one click
 * anywhere on it — the click bubbles to `onSelect` the same way it always
 * has.
 *
 * `tabbable` (#275) makes the list a real roving-tabindex listbox: exactly
 * one row is ever in the Tab order (`tabIndex={0}`), the rest sit at `-1` —
 * `VirtualizedThreadList` decides which by matching `thread.id` against its
 * own roving id (the selection, or the first row when nothing is selected
 * yet), never this component's own `selected` alone, since Auto-advance
 * moves DOM focus a beat after it moves `selected` and the two would
 * otherwise disagree mid-transition. `j`/`k`/Arrow movement (the Action
 * registry's single listener) and Auto-advance both drive real
 * `HTMLElement.focus()` calls at the mover (`VirtualizedThreadList`'s
 * `moveSelection`/`focusThread`), keyed off `data-thread-id` below — this
 * component only renders whichever tab stop it's told to be.
 *
 * `onArchive`/`onTrash`/`onSnooze` (#44, #76, #149, `poc-scope.md` §Clients &
 * notifications) wire the row into `useSwipeToTriage` *and* their own row
 * controls below — optional because `VirtualizedThreadList` has one
 * non-triage caller path in tests, and because the swipe hook is already a
 * no-op for anything but a touch pointer, so wiring it unconditionally would
 * cost nothing either way; optional just avoids threading unused callbacks
 * through call sites that truly have none. Per #149's "one gesture module...
 * right = Done, left = Trash" (#133), `onTrash` is swipe left's own commit —
 * Trash otherwise stays one keystroke away (the registry's `#`/Backspace/
 * Delete binding) and one right-click away (`contextMenu` below), with no
 * hover-cluster control of its own (unlike Snooze/Pin below): the swipe *is*
 * its row-level control. `onSnooze` no longer wires into the swipe at all
 * (#149 removes Snooze from swipe) — it only builds the hover cluster's
 * Snooze button now, which #134's `hoverCapable` already keeps permanently
 * visible on a touch device instead of hover-revealed, so losing swipe-to-
 * Snooze costs nothing there.
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
  onOpenSheet,
  onArchive,
  onTrash,
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
  pointerArmed = false,
  hoverCapable = true,
  tabbable = true,
  region,
}: {
  thread: CachedThread;
  selected: boolean;
  onSelect: () => void;
  /** Double-click opens the Reader Sheet (#292): the Reader over the list, in a Dialog, rather than replacing or moving alongside it — the list underneath is never touched, so its scroll position, selection and Time Group collapse survive the Sheet closing untouched. Optional: a caller with no Sheet to open (search's non-triage rows, a unit test) simply renders a row where double-click does nothing beyond `onSelect`'s own single-click behavior. */
  onOpenSheet?: () => void;
  onArchive?: () => void;
  /** #149: swipe left's own commit — "one gesture module... right = Done, left = Trash" (#133). No hover-cluster button of its own; the swipe is Trash's only row-level control. */
  onTrash?: () => void;
  /** #76: `until` is an ISO datetime — the row cluster's Snooze button opens `SnoozeMenu` for a preset/custom pick. No longer a swipe outcome (#149); the hover cluster is this row's only Snooze control now. */
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
  /** True once this row is the one now sitting under the pointer's last
   * known screen position, forced by `VirtualizedThreadList` after a Triage
   * action (Done) removes a row and the next one slides up under a
   * *stationary* pointer (#152) — no `mouseenter` fires just because the
   * content moved, so without this the row would sit unarmed until the User
   * actually moves the mouse, and a same-spot click would open the mail
   * that just arrived there instead of repeating Done. Same "force armed
   * without claiming hovered/focused/selected" posture as `previewArmed`
   * above, kept as its own prop rather than reusing it: `previewArmed` also
   * drives `data-group-preview`, which this has nothing to do with. */
  pointerArmed?: boolean;
  /** `useHoverCapable()` (#134): `(hover: hover) and (pointer: fine)`, not a viewport breakpoint. `false` drops the row's own Done glyph and its reserved gutter entirely — swipe right is the row's Done gesture on touch — and switches the hover cluster (Snooze/Pin) from hover-revealed to permanently visible, the phone alternative. Defaults `true` so a caller with no capability read above it (most unit tests) keeps today's hover-revealed row. */
  hoverCapable?: boolean;
  /** This row's own roving-tabindex slot (#275): `true` puts it in the Tab order (`tabIndex={0}`), `false` takes it out (`-1`) — `VirtualizedThreadList` sets this for exactly one row at a time. Defaults `true` so a caller rendering a single row with no list around it (`ThreadRow.test.tsx`) keeps today's always-tabbable behavior. */
  tabbable?: boolean;
  /** Region Settings (#304) — `formatRowTime`'s own locale/zone, plus `clockFormat` for `SnoozeMenu`'s preset/custom times. Optional: a caller with no Region Settings read above it (most unit tests) keeps today's browser-default row time. */
  region?: Pick<RegionFormatSettings, "locale" | "clockFormat" | "timeZone">;
}) {
  const unread = thread.unreadCount > 0;
  const participantLabel = thread.participants.map(describeParticipant).join(", ") || "(no sender)";
  const visibleLabelIds = thread.labelIds.slice(0, MAX_ROW_LABEL_CHIPS);
  const overflowLabelCount = thread.labelIds.length - visibleLabelIds.length;
  const headlineSegments = headline ? parseHeadline(headline) : null;
  const subjectLabel = thread.subject || "(no subject)";

  const swipe = useSwipeToTriage({
    onArchive: onArchive ?? (() => {}),
    onTrash: onTrash ?? (() => {}),
  });
  const revealStrength = Math.min(Math.abs(swipe.offsetX) / SWIPE_COMMIT_THRESHOLD_PX, 1);

  // The row cluster's armed state (#66, #75: "every armed state is real
  // component state, not a CSS-only trick"). Hover and focus are tracked
  // here rather than left to `:hover`/`:focus-visible` alone — the same
  // state a future native Client's touch/keyboard model can reuse directly
  // — and `selected` is what "arriving on a row with j/k arms it" cashes
  // out to: `VirtualizedThreadList`'s `moveSelection` sets it exactly the
  // way a click does, so one state covers all three triggers. This still
  // drives the meta column's Snooze/Pin reveal (`data-armed` below).
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const armed = hovered || focused || selected || previewArmed || pointerArmed;
  // The Done check's own, narrower arming (#295): the open/selected Thread
  // is not "at rest" in the same sense a merely-scrolled-past row is, but
  // Done is an action, not a selection readout — an open Thread showing a
  // permanent check reads as "you've already dealt with this", which isn't
  // true. So Done reveals on hover, focus, and the two forced-arm cases
  // (`previewArmed`, `pointerArmed`) alone, never on `selected` — the one
  // deliberate split from `armed` above.
  const doneArmed = hovered || focused || previewArmed || pointerArmed;

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
      data-done-armed={doneArmed}
      data-group-preview={previewArmed || undefined}
      data-hover-capable={hoverCapable}
      style={
        {
          height,
          transform: swipe.offsetX ? `translateX(${swipe.offsetX}px)` : undefined,
          transition: swipe.settling ? undefined : "none",
        } as CSSProperties
      }
      tabIndex={tabbable ? 0 : -1}
      onClick={(event) => {
        // `event.detail` is the native click count (1, 2, 3…) — the second
        // click of a double-click carries `2`, which `onDoubleClick` below
        // already owns. The first click still selects, instantly, the same
        // as an ordinary single click always has: the Sheet opens *over*
        // whatever the list just selected, and closing it touches nothing
        // further — no delayed/undone select to keep every other click in
        // this list instant for (#292's own "the list ... is unchanged"
        // is about the Sheet's close, not about a double-click's own first
        // click never having been a click).
        if (event.detail > 1) return;
        onSelect();
      }}
      onDoubleClick={onOpenSheet}
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
      data-thread-id={thread.id}
      {...swipe.handlers}
    >
      {/* The comp's `.row-check`: reserved whitespace to the left of the
          tile, holding this row's segment of the group's timeline spine and
          its own Done action — invisible at rest, so the resting list is
          nothing but correspondents and subjects. It never touches or
          overlays the tile, because the checkmark is an action ("archive
          this"), not a selection state, and because a fixed slot means
          arming the row shifts nothing else in it. A touch-only pointer has
          no hover to reveal it (#134): swipe right is the row's own Done
          gesture there, so this whole slot — gutter included — goes
          unrendered rather than sitting reserved and empty. */}
      {hoverCapable ? (
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
      ) : null}
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
                {labelNameForId(id)}
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
        <span className="row-time">{formatRowTime(thread.lastMessageAt, new Date(), region)}</span>
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
                        region={region}
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

  if (!onArchive && !onTrash) return withMenu(row); // no swipe wiring: skip the reveal wrapper entirely

  return withMenu(
    <div className="thread-row-outer">
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
