import type { ReactNode } from "react";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "../../components/ui/context-menu.js";
import { menuActions } from "./registry.js";
import { type ActionContext, actionLabel } from "./types.js";

/**
 * The right-click / long-press menu (#94), built from the Action registry
 * and nothing else — one shadcn `ContextMenu` (#93: no hand-rolled
 * portals), listing every menu-flagged action that is *available* for
 * `ctx`, each with its own icon and keycap. Radix's own trigger gives touch
 * long-press for free, which is the whole of the phone story: touch has no
 * hover, so the row cluster is out of reach there and this menu is where
 * Trash, Star, Label and Mark read live (per grill Q39, swipe stays Done ⟵
 * / Snooze ⟶ and nothing gains a persistent per-row control).
 *
 * "Menus never show unavailable actions" — the Palette still lists them
 * disabled, which is where discoverability lives (#79). An action with
 * `choices` (Snooze's presets, Label's toggles) renders as a submenu
 * instead of a single item: a Popover cannot legally open inside a menu,
 * and the free-text half of each picker (a custom snooze instant, a
 * brand-new Label name) stays on the reader's own Popover, which the
 * keyboard binding still opens.
 *
 * `ctx` already carries whichever target the menu is about — a Thread
 * (`withThread`), a Time Group header (`withGroup`), a Screener row
 * (`withScreenerSender`), a Draft row (`withDraft`). With no actions
 * available, or no `ctx` at all (a component rendered without
 * `ActionsProvider` above it), the children render untouched rather than
 * under a trigger that would swallow the browser's own menu for nothing.
 */
export function ActionMenu({
  ctx,
  children,
  className,
  asChild,
  label,
}: {
  ctx: ActionContext | null;
  children: ReactNode;
  /** Passed to the trigger, which renders as a plain `<div>` wrapper unless `asChild` is set. */
  className?: string;
  /** Makes the single child the trigger itself, rather than wrapping it — for a child whose own box is load-bearing (the reader pane's flex column, a list row's absolute placement). */
  asChild?: boolean;
  /** The menu's accessible name — "Actions for \"Quarterly numbers\"". */
  label: string;
}) {
  const actions = ctx ? menuActions(ctx) : [];
  if (!ctx || actions.length === 0) return <>{children}</>;

  const ordinary = actions.filter((action) => !action.destructive);
  const destructive = actions.filter((action) => action.destructive);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild={asChild} className={className}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent aria-label={label} className="min-w-48">
        {ordinary.map((action) => {
          const Icon = action.icon;
          const choices = action.choices?.(ctx) ?? [];
          if (action.choices && choices.length > 0) {
            return (
              <ContextMenuSub key={action.id}>
                <ContextMenuSubTrigger>
                  <Icon />
                  {actionLabel(action, ctx)}
                </ContextMenuSubTrigger>
                <ContextMenuSubContent>
                  {choices.map((choice) =>
                    choice.checked === undefined ? (
                      <ContextMenuItem key={choice.id} onSelect={() => choice.run()}>
                        {choice.label}
                      </ContextMenuItem>
                    ) : (
                      <ContextMenuCheckboxItem
                        key={choice.id}
                        checked={choice.checked}
                        onSelect={() => choice.run()}
                      >
                        {choice.label}
                      </ContextMenuCheckboxItem>
                    ),
                  )}
                </ContextMenuSubContent>
              </ContextMenuSub>
            );
          }
          return (
            <ContextMenuItem key={action.id} onSelect={() => action.run(ctx)}>
              <Icon />
              {actionLabel(action, ctx)}
              {action.binding ? (
                <ContextMenuShortcut>
                  <kbd className="keycap">{action.binding.display}</kbd>
                </ContextMenuShortcut>
              ) : null}
            </ContextMenuItem>
          );
        })}
        {destructive.length > 0 && ordinary.length > 0 ? <ContextMenuSeparator /> : null}
        {destructive.map((action) => {
          const Icon = action.icon;
          return (
            <ContextMenuItem key={action.id} variant="destructive" onSelect={() => action.run(ctx)}>
              <Icon />
              {actionLabel(action, ctx)}
              {action.binding ? (
                <ContextMenuShortcut>
                  <kbd className="keycap">{action.binding.display}</kbd>
                </ContextMenuShortcut>
              ) : null}
            </ContextMenuItem>
          );
        })}
      </ContextMenuContent>
    </ContextMenu>
  );
}
