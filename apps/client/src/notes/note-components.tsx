import type { Components } from "@blocknote/react";
import { Check } from "lucide-react";
import {
  DropdownMenu as DropdownMenuPrimitive,
  Popover as PopoverPrimitive,
  Tooltip as TooltipPrimitive,
} from "radix-ui";
import { type ComponentProps, createContext, type ReactNode, useContext } from "react";

/**
 * The Note editor's own `ComponentsContext` value (#191, ADR-0024): the
 * pieces `BlockNoteViewRaw` needs before it will render *any* default
 * chrome at all — without one, every default UI prop it's given is forced
 * to `false` (`@blocknote/react`'s own `BlockNoteView.tsx`: "Disable
 * default UI components if no components context is found"). BlockNote
 * ships three of these — `@blocknote/mantine`, `@blocknote/ariakit`,
 * `@blocknote/shadcn` — and the ticket rules out all three (a second full
 * component library beside this repo's own Radix/shadcn one, in Mantine's
 * case; Base UI plus another lucide/tailwind-merge range, in shadcn's).
 * "Themed core, no adapter package" therefore means *this* file: the same
 * role those packages play, built on the Radix primitives already in
 * `apps/client/src/components/ui/` instead of a published adapter — costing
 * no dependency beyond BlockNote itself, exactly as ADR-0024 asks, since
 * Radix was already here.
 *
 * Scoped to what this app's restricted schema (`note-schema.ts`) and this
 * ticket's own four named pieces — "the side menu, drag handle, slash menu
 * and formatting toolbar" — actually reach: `FormattingToolbar` and
 * `LinkToolbar` share one `Toolbar` implementation (BlockNote's own
 * adapters do the same); `SideMenu`, `SuggestionMenu` (the slash menu) and
 * the `Generic.Menu`/`Generic.Popover`/`Generic.Form` primitives they and
 * `CreateLinkButton` are built from are real. `ColorStyleButton` and
 * `TableCellMergeButton` never mount in the first place — both self-hide
 * when their style/feature isn't in the schema (`BasicTextStyleButton.tsx`'s
 * `checkBasicTextStyleInSchema` is the same guard) — so no color swatch
 * grid or table-merge UI is needed here. `FilePanel`, `Comments`,
 * `Versioning`, `AttributionTooltip` and `GridSuggestionMenu` are likewise
 * unreachable (no file-family block, no collaboration extension, no emoji
 * grid menu is registered) and are stubbed only to satisfy `Components`'
 * type — see the bottom of this file.
 */

function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------
// Toolbar (FormattingToolbar and LinkToolbar both render through this)
// ---------------------------------------------------------------------------

function ToolbarRoot({
  className,
  children,
  onMouseEnter,
  onMouseLeave,
}: ComponentProps<Components["FormattingToolbar"]["Root"]>) {
  return (
    <div
      role="toolbar"
      aria-label="Formatting"
      className={cn("note-toolbar", className)}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {children}
    </div>
  );
}

function ToolbarButton(props: ComponentProps<Components["FormattingToolbar"]["Button"]>) {
  const {
    className,
    mainTooltip,
    secondaryTooltip,
    icon,
    onClick,
    isSelected,
    isDisabled,
    children,
    label,
  } = props;

  const button = (
    <button
      type="button"
      className={cn("note-toolbar-button", isSelected && "is-active", className)}
      onClick={onClick}
      disabled={isDisabled}
      aria-pressed={isSelected}
      aria-label={label ?? mainTooltip}
    >
      {icon}
      {children}
    </button>
  );

  if (!mainTooltip) {
    return button;
  }

  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{button}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content className="note-tooltip" sideOffset={6}>
          {mainTooltip}
          {secondaryTooltip ? (
            <span className="note-tooltip-shortcut">{secondaryTooltip}</span>
          ) : null}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

function ToolbarSelect({
  items,
  isDisabled,
}: ComponentProps<Components["FormattingToolbar"]["Select"]>) {
  const active = items.find((item) => item.isSelected) ?? items[0];

  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>
        <button type="button" className="note-toolbar-select" disabled={isDisabled}>
          {active?.icon}
          <span>{active?.text}</span>
        </button>
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content className="note-menu-dropdown" align="start" sideOffset={4}>
          {items.map((item) => (
            <DropdownMenuPrimitive.Item
              key={item.text}
              className="note-menu-item"
              disabled={item.isDisabled}
              onSelect={item.onClick}
            >
              {item.icon}
              <span>{item.text}</span>
              {item.isSelected ? <Check size={14} /> : null}
            </DropdownMenuPrimitive.Item>
          ))}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}

// ---------------------------------------------------------------------------
// SideMenu (drag handle + add-block button)
// ---------------------------------------------------------------------------

function SideMenuRoot({ className, children }: ComponentProps<Components["SideMenu"]["Root"]>) {
  return <div className={cn("note-side-menu", className)}>{children}</div>;
}

function SideMenuButton(props: ComponentProps<Components["SideMenu"]["Button"]>) {
  const { className, onClick, icon, onDragStart, onDragEnd, draggable, children, label } = props;
  return (
    <button
      type="button"
      className={cn("note-side-menu-button", className)}
      onClick={onClick}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      aria-label={label}
      title={label}
    >
      {icon}
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// SuggestionMenu (the slash menu)
// ---------------------------------------------------------------------------

function SuggestionMenuRoot({
  id,
  className,
  children,
}: ComponentProps<Components["SuggestionMenu"]["Root"]>) {
  return (
    <div id={id} role="listbox" className={cn("note-suggestion-menu", className)}>
      {children}
    </div>
  );
}

function SuggestionMenuEmptyItem({
  className,
  children,
}: ComponentProps<Components["SuggestionMenu"]["EmptyItem"]>) {
  return <div className={cn("note-suggestion-empty", className)}>{children}</div>;
}

function SuggestionMenuItem({
  id,
  className,
  isSelected,
  onClick,
  item,
}: ComponentProps<Components["SuggestionMenu"]["Item"]>) {
  return (
    <div
      id={id}
      role="option"
      // Not itself in the tab order: the slash menu's own text-cursor input
      // owns focus and drives selection with the arrow keys and
      // `aria-activedescendant`, the same combobox/listbox pattern cmdk
      // uses elsewhere in this app (`mail/command-palette/`).
      tabIndex={-1}
      aria-selected={isSelected}
      className={cn("note-suggestion-item", isSelected && "is-selected", className)}
      // mousedown (not click) so the editor's selection never loses focus
      // to this row before the item's own action runs.
      onMouseDown={(event) => {
        event.preventDefault();
        onClick();
      }}
    >
      <span className="note-suggestion-item-icon">{item.icon}</span>
      <span className="note-suggestion-item-text">
        <span className="note-suggestion-item-title">{item.title}</span>
        {item.subtext ? <span className="note-suggestion-item-subtext">{item.subtext}</span> : null}
      </span>
      {item.badge ? <span className="note-suggestion-item-badge">{item.badge}</span> : null}
    </div>
  );
}

function SuggestionMenuLabel({
  className,
  children,
}: ComponentProps<Components["SuggestionMenu"]["Label"]>) {
  return <div className={cn("note-suggestion-label", className)}>{children}</div>;
}

function SuggestionMenuLoader({
  className,
}: ComponentProps<Components["SuggestionMenu"]["Loader"]>) {
  return <div className={cn("note-suggestion-loader", className)} />;
}

// ---------------------------------------------------------------------------
// Generic.Menu (the formatting toolbar's "Turn into" dropdown, the drag
// handle's block menu)
// ---------------------------------------------------------------------------

/**
 * `Components.Generic.Menu.Root` carries `position`, but Radix's own
 * `DropdownMenuPrimitive.Content` takes `side`/`align` instead, one level
 * down at `Dropdown` — this context is this file's own internal wiring to
 * carry that one prop the one level down it needs to travel, invisible to
 * every caller of the `Components` contract itself.
 */
const MenuPositionContext = createContext<string | undefined>(undefined);

function splitPosition(position: string | undefined): {
  side: "top" | "right" | "bottom" | "left";
  align: "start" | "end" | "center";
} {
  const [side, align] = (position ?? "bottom").split("-") as [string, string | undefined];
  return {
    side: (["top", "right", "bottom", "left"] as const).includes(side as never)
      ? (side as "top" | "right" | "bottom" | "left")
      : "bottom",
    align: align === "start" || align === "end" ? align : "center",
  };
}

function MenuRoot({
  sub,
  onOpenChange,
  position,
  children,
}: ComponentProps<Components["Generic"]["Menu"]["Root"]>) {
  if (sub) {
    return <DropdownMenuPrimitive.Sub>{children}</DropdownMenuPrimitive.Sub>;
  }
  return (
    <MenuPositionContext.Provider value={position}>
      <DropdownMenuPrimitive.Root onOpenChange={onOpenChange}>
        {children}
      </DropdownMenuPrimitive.Root>
    </MenuPositionContext.Provider>
  );
}

function MenuTrigger({ children, sub }: ComponentProps<Components["Generic"]["Menu"]["Trigger"]>) {
  if (sub) {
    return <DropdownMenuPrimitive.SubTrigger asChild>{children}</DropdownMenuPrimitive.SubTrigger>;
  }
  return <DropdownMenuPrimitive.Trigger asChild>{children}</DropdownMenuPrimitive.Trigger>;
}

function MenuDropdown({
  className,
  children,
  sub,
}: ComponentProps<Components["Generic"]["Menu"]["Dropdown"]>) {
  const position = useContext(MenuPositionContext);
  const { side, align } = splitPosition(position);

  if (sub) {
    return (
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.SubContent className={cn("note-menu-dropdown", className)}>
          {children}
        </DropdownMenuPrimitive.SubContent>
      </DropdownMenuPrimitive.Portal>
    );
  }

  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        className={cn("note-menu-dropdown", className)}
        side={side}
        align={align}
        sideOffset={4}
      >
        {children}
      </DropdownMenuPrimitive.Content>
    </DropdownMenuPrimitive.Portal>
  );
}

function MenuItem({
  className,
  children,
  subTrigger,
  icon,
  checked,
  onClick,
}: ComponentProps<Components["Generic"]["Menu"]["Item"]>) {
  if (subTrigger) {
    return (
      <DropdownMenuPrimitive.SubTrigger className={cn("note-menu-item", className)}>
        {icon}
        {children}
      </DropdownMenuPrimitive.SubTrigger>
    );
  }
  return (
    <DropdownMenuPrimitive.Item className={cn("note-menu-item", className)} onSelect={onClick}>
      {icon}
      <span>{children}</span>
      {checked ? <Check size={14} /> : null}
    </DropdownMenuPrimitive.Item>
  );
}

function MenuDivider({ className }: ComponentProps<Components["Generic"]["Menu"]["Divider"]>) {
  return <DropdownMenuPrimitive.Separator className={cn("note-menu-divider", className)} />;
}

function MenuLabel({
  className,
  children,
}: ComponentProps<Components["Generic"]["Menu"]["Label"]>) {
  return (
    <DropdownMenuPrimitive.Label className={cn("note-menu-label", className)}>
      {children}
    </DropdownMenuPrimitive.Label>
  );
}

function MenuButton(props: ComponentProps<Components["Generic"]["Menu"]["Button"]>) {
  const { className, onClick, icon, children, label } = props;
  return (
    <button
      type="button"
      className={cn("note-menu-button", className)}
      onClick={onClick}
      aria-label={label}
      title={label}
    >
      {icon}
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Generic.Form (CreateLinkButton's URL/text fields)
// ---------------------------------------------------------------------------

function FormRoot({ children }: ComponentProps<Components["Generic"]["Form"]["Root"]>) {
  return <div className="note-form">{children}</div>;
}

function FormTextInput(props: ComponentProps<Components["Generic"]["Form"]["TextInput"]>) {
  const { className, label, icon, rightSection, onSubmit, ref, ...rest } = props;
  return (
    <label className={cn("note-form-field", className)}>
      {icon}
      <input
        ref={ref}
        aria-label={label}
        {...rest}
        onKeyDown={(event) => {
          rest.onKeyDown?.(event);
          if (event.key === "Enter") {
            onSubmit?.();
          }
        }}
      />
      {rightSection}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Generic.Popover (CreateLinkButton's own edit-link popover)
// ---------------------------------------------------------------------------

function PopoverRoot({
  open,
  onOpenChange,
  children,
}: ComponentProps<Components["Generic"]["Popover"]["Root"]>) {
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={onOpenChange}>
      {children}
    </PopoverPrimitive.Root>
  );
}

function PopoverTrigger({ children }: ComponentProps<Components["Generic"]["Popover"]["Trigger"]>) {
  return <PopoverPrimitive.Trigger asChild>{children}</PopoverPrimitive.Trigger>;
}

function PopoverContent({
  className,
  variant,
  children,
}: ComponentProps<Components["Generic"]["Popover"]["Content"]>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        className={cn("note-popover", `note-popover-${variant}`, className)}
        sideOffset={6}
      >
        {children}
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  );
}

// ---------------------------------------------------------------------------
// Never invoked by this app's feature set (no file-family block is
// registered, no comments/versioning extension is wired up, no attribution
// marks or emoji grid menu exist) — stubbed only so `Components` is
// complete. A future ticket that turns one of these back on replaces its
// stub here rather than adding a new context.
// ---------------------------------------------------------------------------

// `Record<string, unknown>`, not a narrow `{children?}` shape: every slot
// below has its own required fields, and a props type that's *entirely*
// optional doesn't structurally satisfy any of them ("has no properties in
// common").
function Unreachable(props: Record<string, unknown>) {
  return (props.children as ReactNode) ?? null;
}

export const noteComponents: Components = {
  FormattingToolbar: { Root: ToolbarRoot, Button: ToolbarButton, Select: ToolbarSelect },
  LinkToolbar: { Root: ToolbarRoot, Button: ToolbarButton, Select: ToolbarSelect },
  SideMenu: { Root: SideMenuRoot, Button: SideMenuButton },
  SuggestionMenu: {
    Root: SuggestionMenuRoot,
    EmptyItem: SuggestionMenuEmptyItem,
    Item: SuggestionMenuItem,
    Label: SuggestionMenuLabel,
    Loader: SuggestionMenuLoader,
  },
  FilePanel: {
    Root: Unreachable,
    Button: Unreachable,
    FileInput: Unreachable,
    TabPanel: Unreachable,
    TextInput: Unreachable,
  },
  GridSuggestionMenu: {
    Root: Unreachable,
    EmptyItem: Unreachable,
    Item: Unreachable,
    Loader: Unreachable,
  },
  TableHandle: { Root: Unreachable, ExtendButton: Unreachable },
  Comments: {
    Card: Unreachable,
    CardSection: Unreachable,
    ExpandSectionsPrompt: Unreachable,
    Editor: Unreachable,
    Comment: Unreachable,
  },
  Versioning: { Sidebar: Unreachable, Snapshot: Unreachable },
  AttributionTooltip: { Root: Unreachable },
  Generic: {
    Badge: { Root: Unreachable, Group: Unreachable },
    Form: { Root: FormRoot, TextInput: FormTextInput },
    Menu: {
      Root: MenuRoot,
      Trigger: MenuTrigger,
      Dropdown: MenuDropdown,
      Item: MenuItem,
      Divider: MenuDivider,
      Label: MenuLabel,
      Button: MenuButton,
    },
    Popover: { Root: PopoverRoot, Trigger: PopoverTrigger, Content: PopoverContent },
    Toolbar: { Root: ToolbarRoot, Button: ToolbarButton, Select: ToolbarSelect },
  },
};
