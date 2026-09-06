import { MoreHorizontal } from "lucide-react";
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
import { moreReaderActions } from "./registry.js";
import { type ActionContext, actionLabel } from "./types.js";

/**
 * The Reader's "More" menu (#143): every surface's own way to reach the
 * `reader-more` tier — Read/unread, Forward, Spam, Approve, Block (#144) —
 * plus Pin, Star and Label too on a touch-capable phone,
 * where `ThreadDetailPane` doesn't render the secondary run inline
 * (`includeSecondary`, `registry.ts#moreReaderActions`).
 *
 * Built the same way `ActionMenu` builds the right-click menu — one item per
 * available action, a submenu for one with `choices` (Label's toggles, when
 * folded in here on phone) — just Dropdown- rather than Context-triggered,
 * since this one opens from its own button rather than a right-click. With
 * nothing available (no thread, or every More-tier action unavailable) it
 * renders nothing rather than an overflow button with an empty menu.
 */
export function ReaderMoreMenu({
  ctx,
  includeSecondary,
  label,
}: {
  ctx: ActionContext;
  /** Folds the secondary tier in alongside `reader-more` — the touch-capable-phone case. */
  includeSecondary: boolean;
  /** The trigger's accessible name — `More actions for "Quarterly numbers"`. */
  label: string;
}) {
  const actions = moreReaderActions(ctx, { includeSecondary });
  if (actions.length === 0) return null;

  const ordinary = actions.filter((action) => !action.destructive);
  const destructive = actions.filter((action) => action.destructive);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="reading-more" aria-label={label} title="More">
          <MoreHorizontal size={15} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent aria-label={label} align="end" className="min-w-48">
        {ordinary.map((action) => {
          const Icon = action.icon;
          const choices = action.choices?.(ctx) ?? [];
          if (action.choices && choices.length > 0) {
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
