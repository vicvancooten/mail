import { createContext, type ReactNode, useContext, useEffect, useRef } from "react";
import { ACTIONS } from "./registry.js";
import type { Action, ActionContext } from "./types.js";

const ActionsReactContext = createContext<ActionContext | null>(null);

/**
 * Hands the Action registry's context to every surface below it (#94) —
 * the row's hover cluster and its right-click menu, the reader toolbar and
 * its menu, the Time Group header menu, the Screener's and the Drafts'
 * rows. Built once in `MailSection`, so there is exactly one notion of
 * "the Thread this is about", and passed by React context rather than
 * threaded through `SplitView`/`ListView`/`StreamView`/`SearchResultsView`
 * as a fifth prop each.
 *
 * A surface rendered with no provider above it (a unit test rendering one
 * component on its own) simply shows no menu — `useActions()` returns
 * `null` and every menu wrapper renders its children untouched.
 */
export function ActionsProvider({
  value,
  children,
}: {
  value: ActionContext;
  children: ReactNode;
}) {
  return <ActionsReactContext.Provider value={value}>{children}</ActionsReactContext.Provider>;
}

export function useActions(): ActionContext | null {
  return useContext(ActionsReactContext);
}

/** True while the User is typing into a field — every binding below goes quiet, the guard all four of the listeners this hook replaced already shared. */
function isTyping(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  return Boolean(
    target &&
      (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable),
  );
}

function matchesBinding(action: Action, event: KeyboardEvent): boolean {
  const binding = action.binding;
  if (!binding) return false;
  const modified = event.metaKey || event.ctrlKey;
  if (Boolean(binding.meta) !== modified) return false;
  return binding.keys.includes(event.key);
}

/**
 * **The** `keydown` listener (#94's first acceptance box: "exactly one
 * `keydown` listener owns triage bindings"). Replaces the four that used to
 * split the same scheme between `useTriage`, `ThreadDetailPane`,
 * `VirtualizedThreadList` and `MailSection` — with `useComposeShortcut`'s
 * `c` folded in as well, since it is one more entry in the same registry.
 *
 * Every binding comes from the registry, and an action only runs when its
 * own `availability` says it can, so a key press and a menu click take the
 * identical path. Contextual actions (a Time Group header's, a Screener
 * row's, a Draft row's) are deliberately skipped: they are about whatever
 * the pointer is on, and the Screener owns its own modal scheme.
 *
 * `disabled` covers the surfaces that take the whole keyboard for
 * themselves — the composer (#45's "the composer owns every key"), the
 * Screener, and the Palette/Sheet overlays, which handle their own keys and
 * must not have `e` archive something behind them.
 */
export function useActionKeyboard(ctx: ActionContext, disabled: boolean): void {
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  useEffect(() => {
    if (disabled) return;
    function handleKeyDown(event: KeyboardEvent) {
      const typing = isTyping(event);
      const current = ctxRef.current;
      for (const action of ACTIONS) {
        if (action.contextual) continue;
        if (!matchesBinding(action, event)) continue;
        // A bare letter means nothing while the User is typing one; a
        // modified binding (⌘K) still does, which is why the guard is per
        // action rather than one early return over the whole listener.
        if (typing && !action.binding?.meta) return;
        if (!action.availability(current).available) return;
        if (action.binding?.preventDefault) event.preventDefault();
        action.run(current);
        return;
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [disabled]);
}
