import { globalActions, NO_PICKER } from "../actions/registry.js";
import { type ActionContext, type ActionSection, actionLabel } from "../actions/types.js";

export type { ActionSection as CommandSection } from "../actions/types.js";
/**
 * The Command Palette's own sections (#79) — the grouping the Palette and
 * the Shortcut Sheet both render. Re-exported from the Action registry
 * (#94) rather than declared here: the registry is the one list, and this
 * file is now only the adapter that turns it into palette rows.
 */
export { ACTION_SECTIONS as COMMAND_SECTIONS } from "../actions/types.js";

export interface PaletteCommand {
  id: string;
  label: string;
  section: ActionSection;
  /** The display form of its binding — `"⌘K"`, `"E"`, `"?"` — or `null` for a command with no key of its own (#79's "lists unbound commands too"). */
  shortcut: string | null;
  /** Absent for a command that can't run in this moment — the Palette lists it disabled, same "documents itself" reasoning as an unbound command. */
  run?: () => void;
  /** Why it can't run, straight from the action's own `availability` — so the sentence the Palette shows and the reason a menu hid the action are the same one. */
  disabledReason?: string;
}

/**
 * Every non-contextual action as a palette row (#79's "every command in the
 * Client with its binding", #94's one registry). Availability decides
 * whether a row is runnable, never whether it is *listed*: the Palette is
 * the Client's discoverability surface, so an action with nothing to act on
 * still appears, disabled, with the reason its own `availability` gave.
 *
 * The one gate this adapter adds beyond `availability` is `needsPicker`:
 * Snooze and Label commit through a picker, which only the reading pane and
 * the menus have, so running them from here with no Thread open would
 * quietly do nothing. Menus (which run a `choices` entry directly) and the
 * row cluster (which owns its own Popover) are unaffected.
 */
export function buildCommands(ctx: ActionContext): PaletteCommand[] {
  return globalActions().map((action) => {
    const availability = action.availability(ctx);
    const shortcut = action.binding?.display ?? null;
    const label = actionLabel(action, ctx);
    if (!availability.available) {
      return {
        id: action.id,
        label,
        section: action.section,
        shortcut,
        disabledReason: availability.reason,
      };
    }
    if (action.needsPicker && !ctx.openPicker) {
      return { id: action.id, label, section: action.section, shortcut, disabledReason: NO_PICKER };
    }
    return { id: action.id, label, section: action.section, shortcut, run: () => action.run(ctx) };
  });
}
