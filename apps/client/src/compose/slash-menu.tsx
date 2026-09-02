import type { Editor, Range } from "@tiptap/core";
import { Extension } from "@tiptap/core";
import { ReactRenderer } from "@tiptap/react";
import { exitSuggestion, Suggestion, type SuggestionKeyDownProps } from "@tiptap/suggestion";
import { forwardRef, useEffect, useImperativeHandle, useState } from "react";
import { Pictogram, type PictogramName } from "../brand/Pictogram.js";

/**
 * The Notion-style slash menu (compose-spec §Editor, "Notion-style
 * authoring: slash menu, drag handles, markdown input rules, selection
 * bubble menu"). Typing `/` at the start of an empty block opens a small,
 * filterable popup of block-type commands — the same commands
 * `ComposeToolbar.tsx` already exposes on click, just reachable without
 * leaving the keyboard.
 *
 * Deliberately a small, fixed command set (four entries) rather than every
 * node `editor-extensions.ts` registers: the toolbar is already the
 * exhaustive picture, and compose-spec's own "the slash menu ... fire[s]
 * only at the start of an empty block" is the whole scope this needs to
 * cover. No new node types — every command here is a `StarterKit`/existing
 * extension command the toolbar already calls.
 */

export interface SlashMenuItem {
  title: string;
  icon: PictogramName;
  run: (editor: Editor, range: Range) => void;
}

/** Exported for `slash-menu.test.ts` — the filter and each item's `run` are the load-bearing logic here. */
export const SLASH_MENU_ITEMS: SlashMenuItem[] = [
  {
    title: "Heading",
    icon: "heading",
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).toggleHeading({ level: 2 }).run(),
  },
  {
    title: "Bulleted list",
    icon: "list",
    run: (editor, range) => editor.chain().focus().deleteRange(range).toggleBulletList().run(),
  },
  {
    title: "Numbered list",
    icon: "list-ordered",
    run: (editor, range) => editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
  },
  {
    title: "Blockquote",
    icon: "quote",
    run: (editor, range) => editor.chain().focus().deleteRange(range).toggleBlockquote().run(),
  },
];

/** Case-insensitive substring match on title — shared by the live `Suggestion` `items()` callback and its own test. */
export function filterSlashMenuItems(query: string): SlashMenuItem[] {
  return SLASH_MENU_ITEMS.filter((item) => item.title.toLowerCase().includes(query.toLowerCase()));
}

export interface SlashMenuListProps {
  items: SlashMenuItem[];
  command: (item: SlashMenuItem) => void;
}

export interface SlashMenuListHandle {
  onKeyDown: (props: SuggestionKeyDownProps) => boolean;
}

/**
 * The popup itself: arrow keys move a selection, Enter runs it, a click runs
 * whatever was clicked. `onKeyDown` is called from the `Suggestion` render
 * lifecycle below, not from a DOM listener here — the editor still owns the
 * keyboard while this is open, which is what lets typing keep filtering.
 * Exported for `slash-menu.test.ts` to drive directly.
 */
export const SlashMenuList = forwardRef<SlashMenuListHandle, SlashMenuListProps>(
  function SlashMenuList({ items, command }, ref) {
    const [selected, setSelected] = useState(0);

    // A filtered-down list must not leave `selected` pointing past the end,
    // or at a now-different row than the User was looking at.
    // biome-ignore lint/correctness/useExhaustiveDependencies: `items` (a prop, re-filtered on every keystroke) is the one dependency this needs to reset on.
    useEffect(() => {
      setSelected(0);
    }, [items]);

    useImperativeHandle(
      ref,
      () => ({
        onKeyDown: ({ event }) => {
          if (items.length === 0) return false;
          if (event.key === "ArrowDown") {
            setSelected((current) => (current + 1) % items.length);
            return true;
          }
          if (event.key === "ArrowUp") {
            setSelected((current) => (current - 1 + items.length) % items.length);
            return true;
          }
          if (event.key === "Enter") {
            const item = items[selected];
            if (item) command(item);
            return true;
          }
          return false;
        },
      }),
      [items, selected, command],
    );

    if (items.length === 0) {
      return (
        <div className="slash-menu" role="listbox" aria-label="Insert block">
          <div className="slash-menu-empty">No matches</div>
        </div>
      );
    }

    return (
      <div className="slash-menu" role="listbox" aria-label="Insert block">
        {items.map((item, index) => (
          <button
            key={item.title}
            type="button"
            role="option"
            aria-selected={index === selected}
            className={`slash-menu-item${index === selected ? " active" : ""}`}
            // Same reasoning as `ComposeToolbar.tsx`'s own buttons: a click
            // must not steal the editor's focus/selection before `command`'s
            // own `deleteRange` runs against it.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => command(item)}
          >
            <Pictogram name={item.icon} size={14} />
            {item.title}
          </button>
        ))}
      </div>
    );
  },
);

/**
 * The `/`-triggered `@tiptap/suggestion` plugin, wired into a bare
 * `Extension` the same way every other node/mark in `editor-extensions.ts`
 * registers. `startOfLine: true` is what makes this "fire only at the start
 * of an empty block" (compose-spec): a match can only begin where the block
 * itself begins, so there is never preceding text — typed or otherwise — for
 * it to collide with, and no separate emptiness check is needed.
 */
export function createSlashMenuExtension() {
  return Extension.create({
    name: "slashMenu",
    addProseMirrorPlugins() {
      return [
        Suggestion<SlashMenuItem, SlashMenuItem>({
          editor: this.editor,
          char: "/",
          startOfLine: true,
          items: ({ query }) => filterSlashMenuItems(query),
          // `props` here is exactly the item the popup's own `command(item)`
          // call below was given — `run` is that item's action.
          command: ({ editor, range, props }) => {
            props.run(editor, range);
          },
          render: () => {
            let component: ReactRenderer<SlashMenuListHandle, SlashMenuListProps> | undefined;
            let unmount: (() => void) | undefined;

            return {
              onStart: (props) => {
                component = new ReactRenderer(SlashMenuList, {
                  editor: props.editor,
                  props: { items: props.items, command: props.command },
                });
                // Managed mounting: the plugin owns positioning (anchored to
                // the `/`, repositioned on scroll/resize) — no manual
                // Floating UI wiring needed here.
                unmount = props.mount(component.element);
              },
              onUpdate: (props) => {
                component?.updateProps({ items: props.items, command: props.command });
              },
              onKeyDown: (props) => {
                if (props.event.key === "Escape") {
                  unmount?.();
                  component?.destroy();
                  // Clears the plugin's own suggestion state too, not just
                  // the popup — the recommended way (`@tiptap/suggestion`'s
                  // own doc comment) to dismiss without a document edit.
                  exitSuggestion(props.view);
                  return true;
                }
                return component?.ref?.onKeyDown(props) ?? false;
              },
              onExit: () => {
                unmount?.();
                component?.destroy();
              },
            };
          },
        }),
      ];
    },
  });
}
