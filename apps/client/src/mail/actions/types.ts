import type { Label, Message } from "@mail/shared";
import type { LucideIcon } from "lucide-react";
import type { CachedComposition, CachedThread, ScreenerSenderGroup } from "../../store/index.js";
import type { OnReply } from "../ThreadDetailPane.js";
import type { Triage } from "../useTriage.js";

/**
 * The Action registry's own vocabulary (#94). One entry per thing the User
 * can do, holding everything every surface needs to show it and run it —
 * `label`, `icon`, `binding`, `availability`, `run` — so that adding an
 * action is one entry rather than an edit in the row cluster, the reader
 * toolbar, four `keydown` listeners, the Command Palette and the Shortcut
 * Sheet. See `registry.ts` for the entries themselves and
 * `ActionsProvider.tsx` for the single `keydown` listener that owns every
 * binding here.
 */

/** The Palette's and the Shortcut Sheet's grouping — an action's home section. */
export const ACTION_SECTIONS = ["Compose", "Triage", "Navigation", "Search", "Help"] as const;
export type ActionSection = (typeof ACTION_SECTIONS)[number];

/**
 * Where an action may appear beyond the Command Palette and the Shortcut
 * Sheet, which list *every* non-contextual action whether or not it can run
 * right now (#79). Menus, by contrast, never show an unavailable action.
 *
 * The Reader's own three groups (#289, replacing #143's primary/secondary/more
 * tiers): Reply (`reader-reply-primary`/`reader-reply-overflow`), Mail
 * (`reader-mail-primary`/`reader-mail-overflow`) and Integrations
 * (`reader-send-to`). Each group's overflow is a dropdown built the same way
 * (`actions/ReaderOverflowMenu.tsx`) — a new overflow action is nothing more
 * than adding its tag to `surfaces`.
 */
export type ActionSurface =
  /** The Thread row's hover cluster (`ThreadRow`'s reserved whitespace and `.row-actions`). */
  | "row-hover"
  /** The Reply group's inline primary — Reply or Reply All, whichever `chooseReplyMode` picked (`reading/reply-mode.ts`). Both `reply` and `reply-all` carry this tag; the pane renders only the one the Thread's participant count picked. */
  | "reader-reply-primary"
  /** The Reply group's overflow — the reply form *not* showing inline, plus Forward. */
  | "reader-reply-overflow"
  /** The Mail group's inline, always-visible run — Done, Snooze, Trash. */
  | "reader-mail-primary"
  /** The Mail group's overflow — Pin, Star, Label, Mark unread, Spam, Block, Approve. */
  | "reader-mail-overflow"
  /** The Integrations group's "Send to…" menu — Add to Tasks, Save to Notes. */
  | "reader-send-to"
  /** The right-click / long-press menu on a row, the reader, a Screener row or a Draft row. */
  | "menu";

/**
 * One key binding, in the two forms every surface needs: the `KeyboardEvent.key`
 * values that actually fire it, and the keycap the Palette, the Sheet and
 * the menus print.
 */
export interface ActionBinding {
  keys: readonly string[];
  /** The keycap face — `"E"`, `"#"`, `"⌘K"`. */
  display: string;
  /** ⌘ (or Ctrl) must be held for this binding to fire. */
  meta?: boolean;
}

/** One option under an action that picks between several things rather than committing one — Snooze's presets, Label's toggles. Menus render these as a submenu. */
export interface ActionChoice {
  id: string;
  label: string;
  /** Present for a choice that is a toggle rather than a one-way pick (a Label already on the Thread). */
  checked?: boolean;
  run: () => void;
}

/** Why an action can't run right now — menus hide it, the Palette lists it disabled with this as its reason (#79). */
export type ActionAvailability = { available: true } | { available: false; reason: string };

/** The Time Group header the pointer is on — `VirtualizedThreadList`'s own header cluster, handed to the registry so the header's right-click menu lists the same three things its buttons do (#66, #77, #78). */
export interface GroupActionTarget {
  label: string;
  collapsed: boolean;
  onDoneAll: () => void;
  onMarkAllRead: () => void;
  onToggleCollapsed: () => void;
  /** Absent for a group that is not a valid bulk-Triage target (Pinned, Undated) — the two bulk entries then report themselves unavailable rather than being silently dropped. */
  bulkAvailable: boolean;
}

/** The Screener row the pointer is on (#56) — a held sender, not a Thread, so its three Verdicts are their own registry entries. */
export interface ScreenerActionTarget {
  sender: ScreenerSenderGroup;
  onApprove: () => void;
  onDeny: () => void;
  onBlock: () => void;
}

/** The Drafts row the pointer is on (#74, #101): Open and Delete. */
export interface DraftActionTarget {
  draft: CachedComposition;
  onOpen: () => void;
  onDelete: () => void;
}

/**
 * Everything the registry needs to know about "right now": which Thread an
 * action would act on, what can run it, and which contextual target (a Time
 * Group header, a Screener row, a Draft row) the pointer is on.
 *
 * Built once, in `MailSection`, and handed to every surface through
 * `ActionsProvider` — there is no second notion of "the current Thread"
 * anywhere. A surface acting on something *other* than the current Thread
 * (right-clicking a row that isn't selected) narrows the context with
 * `withThread` rather than inventing its own.
 */
export interface ActionContext {
  /** The Thread this context is about — the open one, or the row a menu was raised on. */
  thread: CachedThread | null;
  triage: Triage;
  /** The newest Message of `thread`, once loaded — reply/reply-all/forward's target. `null` for a Thread whose bodies aren't in reach (any row but the open one). */
  latestMessage: Message | null;
  /** The Mail Account's known Labels, for Label's own choices. */
  labels: readonly Label[];
  onReply: OnReply;
  onCompose: () => void;
  onBackToList: () => void;
  onOpenScreener: () => void;
  screenerCount: number;
  /**
   * Opens the phone bottom bar's Folders sheet (#155) — the Sidebar's own
   * `MobileSheet`, controlled from here rather than a floating in-body
   * toggle now that the bottom bar is the one place that opens it. `null`
   * nowhere: every publisher has *some* honest answer (Stream's exits back
   * to the list, the Hub's own fallback navigates to Mail first), the same
   * "always runnable" shape `onOpenStream` already has.
   */
  onOpenFolders: () => void;
  onFocusSearch: () => void;
  onOpenPalette: () => void;
  onOpenShortcutSheet: () => void;
  /** Enters Stream (#105) from wherever Mail is right now — always runnable, the same "screener" reasoning: no Thread needed to reach for it. */
  onOpenStream: () => void;
  /**
   * "Add to Notes" (#195): creates a Note at once around a Thread Link
   * snapshot of `thread` — no intermediate sheet, unlike a future "Add to
   * Tasks". Takes the Thread directly rather than reading `ctx.thread`
   * itself, the same shape `onReply` already has, so the registry's own
   * `run` stays a one-line forward to whatever this context is wired to
   * (`mail/MailSection.tsx`'s own handler, which builds the snapshot, calls
   * `store/notes.ts#createNoteFromThreadLink`, announces Undo, and — via its
   * own `onAddToNotes` prop, `router/MailRoute.tsx`'s own navigation — opens
   * the new Note's dialog).
   */
  onAddToNotes: (thread: CachedThread) => void;
  /**
   * "Add to Tasks" (#258): unlike "Add to Notes", this only opens the sheet
   * that asks for a Task List and a Due (`mail/AddToTasksSheet.tsx`) — the
   * registry's own `run` stays a one-line forward, same shape as
   * `onAddToNotes`, to `mail/MailSection.tsx`'s own handler, which holds the
   * sheet's open state and the Thread it's about.
   */
  onAddToTasks: (thread: CachedThread) => void;
  /**
   * "Open in new window" (#292): a real browser window, not a route change
   * — `window.open` against the standalone Reader route
   * (`router/ReaderRoute.tsx`, `/mail/reader/$threadId`), so the Thread stays
   * open there while the User works elsewhere in this one. Takes the Thread
   * directly, same shape as `onAddToNotes`/`onAddToTasks` above, so the
   * registry's own `run` (`registry.ts`'s `open-in-new-window`) stays a
   * one-line forward to wherever this context is wired
   * (`mail/MailSection.tsx`'s own handler).
   */
  onOpenInNewWindow: (thread: CachedThread) => void;
  /** Moves the selection one Thread `delta` — the list's own collapse-aware mover where one is mounted (`surface-handles.ts`), else the flat neighbour. */
  onMove: (delta: 1 | -1) => void;
  /** How many Threads the current list holds — what makes next/prev available at all. */
  threadCount: number;
  /** Opens the Snooze or Label picker on the surface currently showing `thread` (the reader's own Popovers). `null` where nothing is showing it, which is what makes those two actions unavailable from the Palette then. */
  openPicker: ((which: "snooze" | "label") => void) | null;
  group: GroupActionTarget | null;
  screenerSender: ScreenerActionTarget | null;
  draft: DraftActionTarget | null;
  /**
   * Skip (CONTEXT.md's Stream): present only while Stream's own stack is
   * mounted (`stream/StreamStack.tsx`), `null` everywhere else — the same
   * "absence gates availability" shape `openPicker` uses. Leaves the current
   * Thread in the Inbox and moves the stack on without any Triage call.
   */
  streamSkip: (() => void) | null;
}

export interface Action {
  id: string;
  /** A function where the label depends on the Thread — Mark as read/unread is one word for two states. */
  label: string | ((ctx: ActionContext) => string);
  icon: LucideIcon;
  section: ActionSection;
  binding: ActionBinding | null;
  surfaces: readonly ActionSurface[];
  availability: (ctx: ActionContext) => ActionAvailability;
  run: (ctx: ActionContext) => void;
  /** Menus render these as a submenu instead of running `run` directly (Snooze's presets, Label's toggles). `run` stays the keyboard/Palette path, opening the surface's own Popover. */
  choices?: (ctx: ActionContext) => ActionChoice[];
  /**
   * This action opens a picker rather than committing on its own, and so
   * needs a surface that *has* one. Every menu and the row cluster do (the
   * row's own Snooze Popover, `choices` in a menu); the Command Palette and
   * the keyboard only do while the reading pane is open, which is what this
   * flag lets the Palette say (`command-palette/commands.ts`) instead of
   * offering a command that would quietly do nothing.
   */
  needsPicker?: "snooze" | "label";
  /** Trash and the Screener's Block: shown apart, in danger ink. */
  destructive?: boolean;
  /**
   * True for an action about *whatever the pointer is on* — a Time Group
   * header, a Screener row, a Draft row. Those have no meaning without a
   * pointer, so contextual actions are menu-only: never listed in the
   * Palette or the Shortcut Sheet, and never bound by the global `keydown`
   * listener (the Screener owns its own modal scheme).
   */
  contextual?: boolean;
}

/** This action's label for the moment `ctx` describes. */
export function actionLabel(action: Action, ctx: ActionContext): string {
  return typeof action.label === "function" ? action.label(ctx) : action.label;
}

/**
 * The same context, narrowed to a different Thread — what a row's own
 * right-click menu acts on. Anything that was true only of the *open*
 * Thread (its loaded Messages, the reader's pickers) is dropped, so the
 * registry's own `availability` reports reply/label/snooze honestly for a
 * row nobody has opened rather than acting on the wrong Thread.
 */
export function withThread(ctx: ActionContext, thread: CachedThread): ActionContext {
  if (ctx.thread?.id === thread.id) return ctx;
  return { ...ctx, thread, latestMessage: null, openPicker: null };
}

/** The same context, carrying the Time Group header a menu was raised on. */
export function withGroup(ctx: ActionContext, group: GroupActionTarget): ActionContext {
  return { ...ctx, group };
}

/** The same context, carrying the Screener row a menu was raised on. */
export function withScreenerSender(
  ctx: ActionContext,
  target: ScreenerActionTarget,
): ActionContext {
  return { ...ctx, screenerSender: target };
}

/** The same context, carrying the Draft row a menu was raised on. */
export function withDraft(ctx: ActionContext, target: DraftActionTarget): ActionContext {
  return { ...ctx, draft: target };
}

/** Undo's own no-op — what the archive/trash/snooze no-ops below return, since real ones return an Undo handle (#95, ADR-0019). */
const NOOP_UNDO = () => {};

/** Every `Triage` method as a no-op — for a surface that only reads an action's `label`, `icon`, `binding` and `section` and never runs one (the Shortcut Sheet), and for tests. */
export const NOOP_TRIAGE: Triage = {
  archive: () => NOOP_UNDO,
  trash: () => NOOP_UNDO,
  snooze: () => NOOP_UNDO,
  toggleStar: () => {},
  toggleRead: () => {},
  togglePin: () => {},
  applyLabel: () => {},
  removeLabel: () => {},
  spamSender: () => NOOP_UNDO,
  blockSender: () => NOOP_UNDO,
  approveSender: () => NOOP_UNDO,
};

/**
 * A context with nothing open and nothing wired — what the Shortcut Sheet
 * builds its read-only list against (every row's `label` and `binding` is
 * the same regardless of what happens to be selected), and the base a test
 * overrides one field of.
 */
export function noopActionContext(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    thread: null,
    triage: NOOP_TRIAGE,
    latestMessage: null,
    labels: [],
    onReply: () => {},
    onCompose: () => {},
    onBackToList: () => {},
    onOpenScreener: () => {},
    screenerCount: 0,
    onOpenFolders: () => {},
    onFocusSearch: () => {},
    onOpenPalette: () => {},
    onOpenShortcutSheet: () => {},
    onOpenStream: () => {},
    onAddToNotes: () => {},
    onAddToTasks: () => {},
    onOpenInNewWindow: () => {},
    onMove: () => {},
    threadCount: 0,
    openPicker: null,
    group: null,
    screenerSender: null,
    draft: null,
    streamSkip: null,
    ...overrides,
  };
}
