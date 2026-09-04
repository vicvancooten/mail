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
 */
export type ActionSurface =
  /** The Thread row's hover cluster (`ThreadRow`'s reserved whitespace and `.row-actions`). */
  | "row-hover"
  /** The reader toolbar's run of icon buttons (`ThreadDetailPane`). */
  | "reader"
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
  /** Calls `preventDefault()` before running — for keys the browser would otherwise act on (Backspace, `/`). */
  preventDefault?: boolean;
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

/** The Drafts row the pointer is on (#74). Delete lands with #101; today the only thing a Draft row can do is open. */
export interface DraftActionTarget {
  draft: CachedComposition;
  onOpen: () => void;
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
  onFocusSearch: () => void;
  onOpenPalette: () => void;
  onOpenShortcutSheet: () => void;
  /** Moves the selection one Thread `delta` — the list's own collapse-aware mover where one is mounted (`surface-handles.ts`), else the flat neighbour. */
  onMove: (delta: 1 | -1) => void;
  /** How many Threads the current list holds — what makes next/prev available at all. */
  threadCount: number;
  /** Opens the Snooze or Label picker on the surface currently showing `thread` (the reader's own Popovers). `null` where nothing is showing it, which is what makes those two actions unavailable from the Palette then. */
  openPicker: ((which: "snooze" | "label") => void) | null;
  group: GroupActionTarget | null;
  screenerSender: ScreenerActionTarget | null;
  draft: DraftActionTarget | null;
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

/** Every `Triage` method as a no-op — for a surface that only reads an action's `label`, `icon`, `binding` and `section` and never runs one (the Shortcut Sheet), and for tests. */
export const NOOP_TRIAGE: Triage = {
  archive: () => {},
  trash: () => {},
  snooze: () => {},
  toggleStar: () => {},
  toggleRead: () => {},
  togglePin: () => {},
  applyLabel: () => {},
  removeLabel: () => {},
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
    onFocusSearch: () => {},
    onOpenPalette: () => {},
    onOpenShortcutSheet: () => {},
    onMove: () => {},
    threadCount: 0,
    openPicker: null,
    group: null,
    screenerSender: null,
    draft: null,
    ...overrides,
  };
}
