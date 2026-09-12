import { MoreHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu.js";
import { type Action, type ActionContext, actionLabel } from "./types.js";

/**
 * One dropdown, built the same way for each of the Reader's three groups
 * (#289): the Reply group's overflow, the Mail group's overflow, and the
 * Integrations group's "Send to…" menu — one item per available action, a
 * submenu for one with `choices` (Label's toggles, folded in here since the
 * Mail group has no inline picker of its own the way it did pre-#289). Built
 * the same way `ActionMenu` builds the right-click menu, just
 * Dropdown-triggered rather than right-click/long-press-triggered — the
 * shared menu primitive both dismiss on outside click and Escape for free
 * (Radix). With no actions available (no Thread, or every one of this
 * group's actions unavailable) it renders nothing rather than a trigger with
 * an empty menu.
 */
export function ReaderOverflowMenu({
  ctx,
  actions,
  label,
  trigger,
  triggerClassName = "reading-more",
}: {
  ctx: ActionContext;
  /** This group's own actions, already narrowed to what's available — `registry.ts#mailOverflowActions`, `#replyOverflowActions` or `#sendToActions`. */
  actions: readonly Action[];
  /** The trigger's accessible name — `More mail actions for "Quarterly numbers"`, `Send "Quarterly numbers" to…`. */
  label: string;
  /** The trigger button's contents — an icon-only "⋯" glyph by default (Reply's and Mail's own overflow); Integrations's "Send to…" passes its own icon-plus-text. */
  trigger?: ReactNode;
  triggerClassName?: string;
}) {
  if (actions.length === 0) return null;

  const ordinary = actions.filter((action) => !action.destructive);
  const destructive = actions.filter((action) => action.destructive);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={triggerClassName} aria-label={label} title={label}>
          {trigger ?? <MoreHorizontal size={15} />}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent aria-label={label} align="end" className="min-w-48">
        {ordinary.map((action) => {
          const Icon = action.icon;
          const choices = action.choices?.(ctx) ?? [];
          // Label (#43) is the one overflow entry with both `choices` and a
          // real Popover to open (`needsPicker`, `ThreadDetailPane`'s own
          // anchored Popover around the Mail group) — when that Popover is
          // reachable, prefer it over the plain toggles-only submenu below,
          // so the overflow's own "Label" item still reaches the free-text
          // "new label" field the same way the pre-#289 inline button did.
          // A row's own right-click menu (`ActionMenu.tsx`, no `openPicker`
          // for anything but the open Thread) keeps the submenu, same as
          // always.
          const preferPicker = Boolean(action.needsPicker && ctx.openPicker);
          if (!preferPicker && action.choices && choices.length > 0) {
            return (
              <DropdownMenuSub key={action.id}>
                <DropdownMenuSubTrigger>
                  <Icon size={14} />
                  {actionLabel(action, ctx)}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {choices.map((choice) =>
                    choice.checked === undefined ? (
                      <DropdownMenuItem key={choice.id} onSelect={() => choice.run()}>
                        {choice.label}
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuCheckboxItem
                        key={choice.id}
                        checked={choice.checked}
                        onSelect={() => choice.run()}
                      >
                        {choice.label}
                      </DropdownMenuCheckboxItem>
                    ),
                  )}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            );
          }
          return (
            <DropdownMenuItem key={action.id} onSelect={() => action.run(ctx)}>
              <Icon size={14} />
              {actionLabel(action, ctx)}
              {action.binding ? (
                <DropdownMenuShortcut>
                  <kbd className="keycap">{action.binding.display}</kbd>
                </DropdownMenuShortcut>
              ) : null}
            </DropdownMenuItem>
          );
        })}
        {destructive.length > 0 && ordinary.length > 0 ? <DropdownMenuSeparator /> : null}
        {destructive.map((action) => {
          const Icon = action.icon;
          return (
            <DropdownMenuItem
              key={action.id}
              variant="destructive"
              onSelect={() => action.run(ctx)}
            >
              <Icon size={14} />
              {actionLabel(action, ctx)}
              {action.binding ? (
                <DropdownMenuShortcut>
                  <kbd className="keycap">{action.binding.display}</kbd>
                </DropdownMenuShortcut>
              ) : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
