import { labelNameFromId } from "@mail/shared";
import {
  Ban,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  CornerUpLeft,
  Forward,
  Keyboard,
  Layers,
  MailOpen,
  PenSquare,
  Pin,
  Reply,
  ReplyAll,
  Search,
  Shield,
  SkipForward,
  Star,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import { SNOOZE_PRESETS } from "../snooze-presets.js";
import { currentReaderHandle } from "./surface-handles.js";
import type { Action, ActionChoice, ActionContext } from "./types.js";

/**
 * The one Action registry (#94). Every surface — the row's hover cluster,
 * the single `keydown` listener, the Command Palette, the Shortcut Sheet,
 * the Time Group header menu, swipe, and the right-click / long-press
 * context menu — reads this array and nothing else, so a new action is one
 * entry here rather than seven edits that can drift apart.
 *
 * The bindings are the scheme #42 and #79 settled, unchanged: `e` Done,
 * `#`/Backspace/Delete Trash, `s` Star, `p` Pin, `h` Snooze, `L` Label,
 * `r`/`a`/`f` reply/reply-all/forward, `j`/`k` (and the arrows, and `l`)
 * movement, `u` back to list, `c` Compose, `/` search, `⌘K` the Palette,
 * `?` this list. What changes here is *who owns them*: one listener
 * (`ActionsProvider`), not four.
 *
 * `availability` is the whole of an action's "can this run right now"
 * story. Menus hide what it rejects; the Palette lists it disabled with the
 * reason it gave (#79's "lists unbound and unavailable commands too"), so
 * the same sentence explains it in both places.
 */

const NO_THREAD = "Nothing selected — pick a Thread first.";
const NO_MESSAGE = "No message loaded to reply to yet.";
export const NO_PICKER = "Open the Thread first — its picker lives in the reading pane.";

const available = { available: true } as const;
const unavailable = (reason: string) => ({ available: false, reason }) as const;

/** Available exactly when a Thread is in hand — the shape most Triage entries below need. */
function needsThread(ctx: ActionContext) {
  return ctx.thread ? available : unavailable(NO_THREAD);
}

function replyAction(
  id: string,
  label: string,
  mode: "reply" | "replyAll" | "forward",
  display: string,
  key: string,
  icon: Action["icon"],
): Action {
  return {
    id,
    label,
    icon,
    section: "Triage",
    binding: { keys: [key], display },
    surfaces: ["menu"],
    availability: (ctx) =>
      !ctx.thread
        ? unavailable(NO_THREAD)
        : ctx.latestMessage
          ? available
          : unavailable(NO_MESSAGE),
    run: (ctx) => {
      // Whichever Message the reader has scrolled to, if one is mounted —
      // `ctx.latestMessage` is what made the action *available* (it comes
      // from the Local Cache and re-renders), the handle is what makes it
      // act on the Message actually on screen (#47).
      const target = currentReaderHandle()?.replyTarget ?? ctx.latestMessage;
      if (target) ctx.onReply(target, mode);
    },
  };
}

/** Snooze's presets as menu choices — the same `SNOOZE_PRESETS` the reader's and the row's Popovers render, minus the custom-time field a menu has no room for (that stays on the Popover, which `run` opens). */
function snoozeChoices(ctx: ActionContext): ActionChoice[] {
  const thread = ctx.thread;
  if (!thread) return [];
  return SNOOZE_PRESETS.map((preset) => ({
    id: preset.label,
    label: preset.label,
    run: () => ctx.triage.snooze(thread.id, preset.until(new Date()).toISOString()),
  }));
}

/** Label's toggles as menu choices — the Mail Account's known Labels plus anything the Thread already carries that hasn't synced back yet, exactly as `LabelPicker` resolves them. Naming a brand-new Label needs a text field, so that stays on the Popover. */
function labelChoices(ctx: ActionContext): ActionChoice[] {
  const thread = ctx.thread;
  if (!thread) return [];
  const known = new Map(ctx.labels.map((label) => [label.id, label.name]));
  for (const id of thread.labelIds) {
    if (!known.has(id)) known.set(id, labelNameFromId(thread.mailAccountId, id));
  }
  return [...known.entries()]
    .sort((left, right) => left[1].localeCompare(right[1]))
    .map(([id, name]) => ({
      id,
      label: name,
      checked: thread.labelIds.includes(id),
      run: () =>
        thread.labelIds.includes(id)
          ? ctx.triage.removeLabel(thread.id, name)
          : ctx.triage.applyLabel(thread.id, name),
    }));
}

export const ACTIONS: readonly Action[] = [
  {
    id: "compose",
    label: "Compose",
    icon: PenSquare,
    section: "Compose",
    binding: { keys: ["c"], display: "C", preventDefault: true },
    surfaces: [],
    availability: () => available,
    run: (ctx) => ctx.onCompose(),
  },

  // Done is the App's primary verb (CONTEXT.md): the act, with Archive as
  // the place it lands. It is the one Triage action with reserved
  // whitespace of its own on every row.
  {
    id: "done",
    label: "Mark Done (archive)",
    icon: CheckCircle2,
    section: "Triage",
    binding: { keys: ["e"], display: "E" },
    surfaces: ["row-hover", "reader", "menu"],
    availability: needsThread,
    run: (ctx) => {
      if (ctx.thread) ctx.triage.archive(ctx.thread.id);
    },
  },
  {
    id: "snooze",
    label: "Snooze",
    icon: Clock,
    section: "Triage",
    binding: { keys: ["h"], display: "H" },
    surfaces: ["row-hover", "reader", "menu"],
    availability: needsThread,
    needsPicker: "snooze",
    // The keyboard and the Palette open a picker (the reading pane's own
    // Popover); a menu runs one of `choices` directly, and the row cluster
    // renders its own Popover — three routes to the same instant, one
    // entry.
    run: (ctx) => ctx.openPicker?.("snooze"),
    choices: snoozeChoices,
  },
  {
    id: "label",
    label: "Apply/remove label",
    icon: Tag,
    section: "Triage",
    binding: { keys: ["L"], display: "L" },
    surfaces: ["reader", "menu"],
    availability: needsThread,
    needsPicker: "label",
    run: (ctx) => ctx.openPicker?.("label"),
    choices: labelChoices,
  },
  {
    id: "pin",
    label: (ctx) => (ctx.thread?.pinned ? "Unpin" : "Pin"),
    icon: Pin,
    section: "Triage",
    binding: { keys: ["p"], display: "P" },
    surfaces: ["row-hover", "reader", "menu"],
    availability: needsThread,
    run: (ctx) => {
      if (ctx.thread) ctx.triage.togglePin(ctx.thread.id);
    },
  },
  {
    id: "star",
    label: (ctx) => (ctx.thread?.starred ? "Unstar" : "Star"),
    icon: Star,
    section: "Triage",
    binding: { keys: ["s"], display: "S" },
    surfaces: ["reader", "menu"],
    availability: needsThread,
    run: (ctx) => {
      if (ctx.thread) ctx.triage.toggleStar(ctx.thread.id);
    },
  },
  // Unbound since #79 gave `u` to "back to list" — reachable from the
  // reader toolbar, the menus and the Palette, with no key of its own.
  {
    id: "toggle-read",
    label: (ctx) =>
      !ctx.thread
        ? "Mark as read/unread"
        : ctx.thread.unreadCount > 0
          ? "Mark as read"
          : "Mark as unread",
    icon: MailOpen,
    section: "Triage",
    binding: null,
    surfaces: ["reader", "menu"],
    availability: needsThread,
    run: (ctx) => {
      if (ctx.thread) ctx.triage.toggleRead(ctx.thread.id);
    },
  },
  replyAction("reply", "Reply", "reply", "R", "r", Reply),
  replyAction("reply-all", "Reply all", "replyAll", "A", "a", ReplyAll),
  replyAction("forward", "Forward", "forward", "F", "f", Forward),
  {
    id: "trash",
    label: "Move to Trash",
    icon: Trash2,
    section: "Triage",
    binding: { keys: ["#", "Backspace", "Delete"], display: "#", preventDefault: true },
    surfaces: ["reader", "menu"],
    destructive: true,
    availability: needsThread,
    run: (ctx) => {
      if (ctx.thread) ctx.triage.trash(ctx.thread.id);
    },
  },

  {
    id: "next-thread",
    label: "Next thread",
    icon: ChevronDown,
    section: "Navigation",
    binding: { keys: ["j", "ArrowDown", "l", "ArrowRight"], display: "J", preventDefault: true },
    surfaces: [],
    availability: (ctx) =>
      ctx.threadCount > 0 ? available : unavailable("Nothing in this list yet."),
    run: (ctx) => ctx.onMove(1),
  },
  {
    id: "prev-thread",
    label: "Previous thread",
    icon: ChevronUp,
    section: "Navigation",
    binding: { keys: ["k", "ArrowUp", "ArrowLeft"], display: "K", preventDefault: true },
    surfaces: [],
    availability: (ctx) =>
      ctx.threadCount > 0 ? available : unavailable("Nothing in this list yet."),
    run: (ctx) => ctx.onMove(-1),
  },
  {
    id: "back-to-list",
    label: "Back to list",
    icon: CornerUpLeft,
    section: "Navigation",
    binding: { keys: ["u"], display: "U" },
    surfaces: [],
    availability: needsThread,
    run: (ctx) => ctx.onBackToList(),
  },
  {
    id: "screener",
    label: "Open the Screener",
    icon: Shield,
    section: "Navigation",
    binding: null,
    surfaces: [],
    availability: (ctx) =>
      ctx.screenerCount > 0 ? available : unavailable("Nothing held right now."),
    run: (ctx) => ctx.onOpenScreener(),
  },
  // Stream (#105, CONTEXT.md): entered deliberately, never a toggle — the
  // Palette command and Mail's own entry point (`TopBar.tsx`) both run this
  // one action. Unbound, like Screener above: no key was carved out for it.
  {
    id: "open-stream",
    label: "Open Stream",
    icon: Layers,
    section: "Navigation",
    binding: null,
    surfaces: [],
    availability: () => available,
    run: (ctx) => ctx.onOpenStream(),
  },
  // Skip (CONTEXT.md's Stream): only ever available while Stream's own
  // stack is mounted (`ctx.streamSkip`) — everywhere else this is a
  // disabled Palette row explaining why, same as Snooze/Label without a
  // picker in reach. Also what makes right-clicking a Stream card show
  // Skip in its menu, for free, alongside Done/Trash/Snooze/Reply.
  {
    id: "stream-skip",
    label: "Skip",
    icon: SkipForward,
    section: "Triage",
    binding: { keys: ["n"], display: "N" },
    surfaces: ["menu"],
    availability: (ctx) => (ctx.streamSkip ? available : unavailable("Only available in Stream.")),
    run: (ctx) => ctx.streamSkip?.(),
  },

  {
    id: "focus-search",
    label: "Focus search",
    icon: Search,
    section: "Search",
    binding: { keys: ["/"], display: "/", preventDefault: true },
    surfaces: [],
    availability: () => available,
    run: (ctx) => ctx.onFocusSearch(),
  },
  {
    id: "command-palette",
    label: "Command palette",
    icon: Search,
    section: "Search",
    binding: { keys: ["k"], display: "⌘K", meta: true, preventDefault: true },
    surfaces: [],
    availability: () => available,
    run: (ctx) => ctx.onOpenPalette(),
  },

  {
    id: "shortcut-sheet",
    label: "Keyboard shortcuts",
    icon: Keyboard,
    section: "Help",
    binding: { keys: ["?"], display: "?", preventDefault: true },
    surfaces: [],
    availability: () => available,
    run: (ctx) => ctx.onOpenShortcutSheet(),
  },

  // ── Contextual: menu-only, about whatever the pointer is on ──────────
  // The Time Group header's own three (#66, #77, #78) — the same wiring
  // its armed buttons use, so right-clicking the header and reaching for
  // its cluster do the same thing.
  {
    id: "group-done",
    label: (ctx) => (ctx.group ? `Done with ${ctx.group.label}` : "Group Done"),
    icon: Check,
    section: "Triage",
    binding: null,
    surfaces: ["menu"],
    contextual: true,
    availability: (ctx) =>
      !ctx.group
        ? unavailable("No Time Group here.")
        : ctx.group.bulkAvailable
          ? available
          : unavailable("This group can't be cleared in one action."),
    run: (ctx) => ctx.group?.onDoneAll(),
  },
  {
    id: "group-mark-read",
    label: (ctx) => (ctx.group ? `Mark ${ctx.group.label} read` : "Mark group read"),
    icon: MailOpen,
    section: "Triage",
    binding: null,
    surfaces: ["menu"],
    contextual: true,
    availability: (ctx) =>
      !ctx.group
        ? unavailable("No Time Group here.")
        : ctx.group.bulkAvailable
          ? available
          : unavailable("This group can't be marked read in one action."),
    run: (ctx) => ctx.group?.onMarkAllRead(),
  },
  {
    id: "group-collapse",
    label: (ctx) => (ctx.group?.collapsed ? "Expand group" : "Collapse group"),
    icon: ChevronUp,
    section: "Navigation",
    binding: null,
    surfaces: ["menu"],
    contextual: true,
    availability: (ctx) => (ctx.group ? available : unavailable("No Time Group here.")),
    run: (ctx) => ctx.group?.onToggleCollapsed(),
  },

  // The Screener's three Verdicts (#56). Contextual, so the global
  // listener leaves `a`/`d`/`b` alone — the Screener is a modal surface
  // that owns its own keyboard scheme; these entries exist so its rows get
  // the same menu every other row has, with the same keycaps printed.
  {
    id: "screener-approve",
    label: "Approve sender",
    icon: Check,
    section: "Triage",
    binding: { keys: ["a"], display: "A" },
    surfaces: ["menu"],
    contextual: true,
    availability: (ctx) => (ctx.screenerSender ? available : unavailable("No held sender here.")),
    run: (ctx) => ctx.screenerSender?.onApprove(),
  },
  {
    id: "screener-deny",
    label: "Deny sender",
    icon: X,
    section: "Triage",
    binding: { keys: ["d"], display: "D" },
    surfaces: ["menu"],
    contextual: true,
    availability: (ctx) => (ctx.screenerSender ? available : unavailable("No held sender here.")),
    run: (ctx) => ctx.screenerSender?.onDeny(),
  },
  {
    id: "screener-block",
    label: "Block sender",
    icon: Ban,
    section: "Triage",
    binding: { keys: ["b"], display: "B" },
    surfaces: ["menu"],
    contextual: true,
    destructive: true,
    availability: (ctx) => (ctx.screenerSender ? available : unavailable("No held sender here.")),
    run: (ctx) => ctx.screenerSender?.onBlock(),
  },

  // Drafts (#74, #101): Open and Delete, both menu-only like every other
  // contextual entry — a Draft row has no reserved-whitespace or hover
  // cluster control of its own, same restraint `ThreadRow`'s own doc comment
  // gives Trash ("stays one keystroke away ... and one right-click away
  // ... [but] no row-level hover or swipe control of its own").
  {
    id: "draft-open",
    label: "Open draft",
    icon: PenSquare,
    section: "Compose",
    binding: null,
    surfaces: ["menu"],
    contextual: true,
    availability: (ctx) => (ctx.draft ? available : unavailable("No draft here.")),
    run: (ctx) => ctx.draft?.onOpen(),
  },
  {
    id: "draft-delete",
    label: "Delete draft",
    icon: Trash2,
    section: "Compose",
    binding: null,
    surfaces: ["menu"],
    contextual: true,
    destructive: true,
    availability: (ctx) => (ctx.draft ? available : unavailable("No draft here.")),
    run: (ctx) => ctx.draft?.onDelete(),
  },
];

/** One action by id — the surfaces that render a specific control (the row's Done check, the reader's Reply button) look their own entry up rather than re-stating its label or binding. */
export function actionById(id: string): Action | undefined {
  return ACTIONS.find((action) => action.id === id);
}

/** Every non-contextual action, in registry order — what the Palette and the Shortcut Sheet list, available or not. */
export function globalActions(): readonly Action[] {
  return ACTIONS.filter((action) => !action.contextual);
}

/** The actions a menu on `ctx` should show: flagged for menus, and available — "menus never show unavailable actions" (#94). */
export function menuActions(ctx: ActionContext): readonly Action[] {
  return ACTIONS.filter(
    (action) => action.surfaces.includes("menu") && action.availability(ctx).available,
  );
}

/** The actions a surface renders as its own controls — the row's hover cluster (`"row-hover"`) or the reader toolbar (`"reader"`) — available ones only, in registry order. */
export function surfaceActions(
  ctx: ActionContext,
  surface: "row-hover" | "reader",
): readonly Action[] {
  return ACTIONS.filter(
    (action) => action.surfaces.includes(surface) && action.availability(ctx).available,
  );
}
