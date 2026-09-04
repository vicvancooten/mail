import type { Message } from "@mail/shared";
import type { CachedThread } from "../../store/index.js";
import type { OnReply } from "../ThreadDetailPane.js";
import type { Triage } from "../useTriage.js";

/**
 * The Command Palette's own sections (#79): the grouping the palette and
 * the Shortcut Sheet both render — one registry, two surfaces, so neither
 * can drift from the other or from the bindings actually wired elsewhere
 * (`useTriage.ts`, `ThreadDetailPane.tsx`, `useComposeShortcut.ts`,
 * `MailSection.tsx`'s own keydown listener).
 */
export const COMMAND_SECTIONS = ["Compose", "Triage", "Navigation", "Search", "Help"] as const;
export type CommandSection = (typeof COMMAND_SECTIONS)[number];

export interface PaletteCommand {
  id: string;
  label: string;
  section: CommandSection;
  /** The display form of its binding — `"⌘K"`, `"E"`, `"?"` — or `null` for a command with no key of its own (#79's "lists unbound commands too": Mark read/unread lost its `u` binding to "back to list" and is reachable from here only). */
  shortcut: string | null;
  /** Absent for a command that documents a binding owned by another component's own local state (Label — `ThreadDetailPane`'s `pickerOpen`) rather than duplicating it here; the Palette lists it but can't run it. */
  run?: () => void;
  /** Present (whether or not `run` is) when there's nothing to run it on right now — no Thread selected, no message loaded yet. The Palette still lists the command (disabled), same "documents itself" reasoning as an unbound command. */
  disabledReason?: string;
}

/** Everything `buildCommands` needs to know about "the Thread the User has open right now" — whichever pairing of `selectedThreadId`/`triage` is live (the ordinary Inbox one, or Search's, per `MailSection`'s own two `useTriage` instances) and whatever `ThreadDetailPane` itself would use to pick the reply target. */
export interface CommandContext {
  selectedThread: CachedThread | null;
  triage: Triage;
  /** The newest Message in the open Thread, if loaded — reply/reply-all/forward's target, matching `ThreadDetailPane`'s own default before any scroll has reported an open Message. */
  latestMessage: Message | null;
  onReply: OnReply;
  onCompose: () => void;
  /** "Back to list" (`u`, rebound from mark-unread — #79) — whichever `onBack`/`onClearSelection` the current view already wires to `ThreadDetailPane`. */
  onBackToList: () => void;
  onOpenScreener: () => void;
  screenerCount: number;
  onFocusSearch: () => void;
  onOpenShortcutSheet: () => void;
}

/**
 * The one registry (#79's "every command in the Client with its binding"):
 * builds the full command list for the current moment — which Thread (if
 * any) is open decides which Triage commands are actually runnable, not
 * which are listed. `run` throws for a command with `disabledReason` — call
 * sites (`CommandPalette.tsx`) must check that first, same contract a
 * disabled `<button>` already keeps with its own `onClick`.
 */
export function buildCommands(ctx: CommandContext): PaletteCommand[] {
  const thread = ctx.selectedThread;
  const noThread = "Nothing selected — pick a Thread first.";
  const noMessage = "No message loaded to reply to yet.";

  const replyTarget = (mode: "reply" | "replyAll" | "forward"): PaletteCommand => {
    const label = mode === "reply" ? "Reply" : mode === "replyAll" ? "Reply all" : "Forward";
    const shortcut = mode === "reply" ? "R" : mode === "replyAll" ? "A" : "F";
    const message = ctx.latestMessage;
    if (!thread || !message) {
      return {
        id: `reply-${mode}`,
        label,
        section: "Triage",
        shortcut,
        disabledReason: !thread ? noThread : noMessage,
      };
    }
    return {
      id: `reply-${mode}`,
      label,
      section: "Triage",
      shortcut,
      run: () => ctx.onReply(message, mode),
    };
  };

  const threadCommand = (
    id: string,
    label: string,
    shortcut: string | null,
    run: (threadId: string) => void,
  ): PaletteCommand =>
    thread
      ? { id, label, section: "Triage", shortcut, run: () => run(thread.id) }
      : { id, label, section: "Triage", shortcut, disabledReason: noThread };

  return [
    { id: "compose", label: "Compose", section: "Compose", shortcut: "C", run: ctx.onCompose },

    threadCommand("done", "Mark Done (archive)", "E", ctx.triage.archive),
    threadCommand("trash", "Move to Trash", "#", ctx.triage.trash),
    threadCommand("star", "Toggle star", "S", ctx.triage.toggleStar),
    threadCommand("pin", "Toggle pin", "P", ctx.triage.togglePin),
    // List-only, like Label below: which preset (or a custom pick) is a
    // choice `SnoozeMenu` makes, not a boolean this registry can flip on
    // its own — `ThreadDetailPane`'s own `h` binding opens that popover.
    { id: "snooze", label: "Snooze", section: "Triage", shortcut: "H" },
    // Unbound (#79): `u` moved to "Back to list" — this stays reachable
    // from the mouse (`ThreadDetailPane`'s Mark read/unread button) and
    // from here, with no key of its own any more.
    thread
      ? {
          id: "toggle-read",
          label: thread.unreadCount > 0 ? "Mark as read" : "Mark as unread",
          section: "Triage",
          shortcut: null,
          run: () => ctx.triage.toggleRead(thread.id),
        }
      : {
          id: "toggle-read",
          label: "Mark as read/unread",
          section: "Triage",
          shortcut: null,
          disabledReason: noThread,
        },
    replyTarget("reply"),
    replyTarget("replyAll"),
    replyTarget("forward"),
    // Label-only: which Label to apply is a name, not a boolean, and lives
    // in `ThreadDetailPane`'s own `pickerOpen`/`LabelPicker` — listed for
    // discoverability, not run from here.
    { id: "label", label: "Apply/remove label", section: "Triage", shortcut: "L" },
    thread
      ? {
          id: "back-to-list",
          label: "Back to list",
          section: "Navigation",
          shortcut: "U",
          run: ctx.onBackToList,
        }
      : {
          id: "back-to-list",
          label: "Back to list",
          section: "Navigation",
          shortcut: "U",
          disabledReason: noThread,
        },

    { id: "next", label: "Next thread", section: "Navigation", shortcut: "J" },
    { id: "prev", label: "Previous thread", section: "Navigation", shortcut: "K" },
    {
      id: "screener",
      label: "Open the Screener",
      section: "Navigation",
      shortcut: null,
      run: ctx.screenerCount > 0 ? ctx.onOpenScreener : undefined,
      disabledReason: ctx.screenerCount > 0 ? undefined : "Nothing held right now.",
    },

    {
      id: "focus-search",
      label: "Focus search",
      section: "Search",
      shortcut: "/",
      run: ctx.onFocusSearch,
    },
    { id: "command-palette", label: "Command palette", section: "Search", shortcut: "⌘K" },

    {
      id: "shortcut-sheet",
      label: "Keyboard shortcuts",
      section: "Help",
      shortcut: "?",
      run: ctx.onOpenShortcutSheet,
    },
  ];
}
