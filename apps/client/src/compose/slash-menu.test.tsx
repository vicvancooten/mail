import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { composeEditorExtensions } from "./editor-extensions.js";
import {
  filterSlashMenuItems,
  SLASH_MENU_ITEMS,
  type SlashMenuItem,
  SlashMenuList,
  type SlashMenuListHandle,
} from "./slash-menu.js";

/**
 * The Notion-style slash menu (finding #3, compose-spec §Editor): its two
 * load-bearing halves tested independently of the live `@tiptap/suggestion`
 * plugin (which needs a real browser's Floating UI/ResizeObserver stack to
 * mount) — `mail-signature-extension.test.ts`'s own doc comment is why a
 * real headless `Editor` and its own commands, not simulated DOM typing, is
 * the honest way to assert a ProseMirror transform's *result*.
 *
 * 1. `filterSlashMenuItems`/`SLASH_MENU_ITEMS[i].run` — what a selection
 *    actually does to the document.
 * 2. `SlashMenuList` — the popup's own keyboard nav and click handling,
 *    rendered directly rather than through the plugin's `ReactRenderer`.
 */

afterEach(cleanup);

describe("filterSlashMenuItems", () => {
  it("lists everything for an empty query", () => {
    expect(filterSlashMenuItems("").map((item) => item.title)).toEqual([
      "Heading",
      "Bulleted list",
      "Numbered list",
      "Blockquote",
    ]);
  });

  it("filters case-insensitively by title, substring match", () => {
    expect(filterSlashMenuItems("bul").map((item) => item.title)).toEqual(["Bulleted list"]);
    expect(filterSlashMenuItems("LIST").map((item) => item.title)).toEqual([
      "Bulleted list",
      "Numbered list",
    ]);
  });

  it("is empty for a query matching no command", () => {
    expect(filterSlashMenuItems("xyz")).toEqual([]);
  });
});

describe("SLASH_MENU_ITEMS — each command's actual ProseMirror transform", () => {
  let editor: Editor | undefined;

  afterEach(() => {
    editor?.destroy();
    editor = undefined;
  });

  function editorWithEmptyParagraph(): Editor {
    editor = new Editor({
      extensions: composeEditorExtensions("Write something…"),
      content: { type: "doc", content: [{ type: "paragraph" }] },
    });
    return editor;
  }

  function itemNamed(title: string): SlashMenuItem {
    const item = SLASH_MENU_ITEMS.find((entry) => entry.title === title);
    if (!item) throw new Error(`no slash menu item named ${title}`);
    return item;
  }

  it("Heading turns the block into a level-2 heading", () => {
    const e = editorWithEmptyParagraph();
    itemNamed("Heading").run(e, { from: 1, to: 1 });
    expect(e.getJSON().content?.[0]).toMatchObject({ type: "heading", attrs: { level: 2 } });
  });

  it("Bulleted list turns the block into a bullet list", () => {
    const e = editorWithEmptyParagraph();
    itemNamed("Bulleted list").run(e, { from: 1, to: 1 });
    expect(e.getJSON().content?.[0]?.type).toBe("bulletList");
  });

  it("Numbered list turns the block into an ordered list", () => {
    const e = editorWithEmptyParagraph();
    itemNamed("Numbered list").run(e, { from: 1, to: 1 });
    expect(e.getJSON().content?.[0]?.type).toBe("orderedList");
  });

  it("Blockquote turns the block into a blockquote", () => {
    const e = editorWithEmptyParagraph();
    itemNamed("Blockquote").run(e, { from: 1, to: 1 });
    expect(e.getJSON().content?.[0]?.type).toBe("blockquote");
  });

  it("deletes the `/query` range before applying the block type", () => {
    // The shape of what the live plugin actually calls this with: "/head"
    // typed at the start of the block, `range` spanning it.
    const e = new Editor({
      extensions: composeEditorExtensions("Write something…"),
      content: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "/head" }] }],
      },
    });
    editor = e;
    itemNamed("Heading").run(e, { from: 1, to: 6 }); // "/head" is 5 chars, doc positions 1..6
    // Only `content[0]` is asserted: `TableKit`'s own trailing-node rule
    // appends a fresh empty paragraph after a doc whose last block is a
    // heading (so there is always somewhere to click below it) — schema
    // behaviour this test isn't about, not something a passing `content`
    // length here would mean anything about.
    const content = e.getJSON().content ?? [];
    expect(content[0]).toMatchObject({ type: "heading", attrs: { level: 2 } });
    expect(content[0]?.content ?? []).toEqual([]); // "/head" itself is gone, not carried into the heading
  });
});

describe("SlashMenuList", () => {
  it("renders every item and runs the clicked one", () => {
    const command = vi.fn();
    render(<SlashMenuList items={SLASH_MENU_ITEMS} command={command} />);

    expect(screen.getByText("Heading")).not.toBeNull();
    expect(screen.getByText("Bulleted list")).not.toBeNull();

    fireEvent.click(screen.getByText("Blockquote"));
    expect(command).toHaveBeenCalledWith(itemByTitle("Blockquote"));
  });

  it("shows 'No matches' for an empty item list", () => {
    render(<SlashMenuList items={[]} command={vi.fn()} />);
    expect(screen.getByText("No matches")).not.toBeNull();
  });

  it("the first item is selected by default", () => {
    render(<SlashMenuList items={SLASH_MENU_ITEMS} command={vi.fn()} />);
    expect(screen.getByRole("option", { name: /Heading/ }).getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it("ArrowDown/ArrowUp move the selection (with wraparound) and Enter runs it — the imperative handle the live plugin drives", () => {
    const command = vi.fn();
    const ref = createRef<SlashMenuListHandle>();
    render(<SlashMenuList ref={ref} items={SLASH_MENU_ITEMS} command={command} />);
    let result: boolean | undefined;
    const keyDown = (key: string) =>
      act(() => {
        result = ref.current?.onKeyDown({
          event: { key } as KeyboardEvent,
          view: {} as never,
          range: { from: 0, to: 0 },
        });
      });

    keyDown("ArrowDown");
    expect(result).toBe(true);
    expect(
      screen.getByRole("option", { name: /Bulleted list/ }).getAttribute("aria-selected"),
    ).toBe("true");

    // Wraps back to the first item from the last.
    keyDown("ArrowUp"); // back to Heading
    keyDown("ArrowUp"); // wraps to Blockquote (the last item)
    expect(screen.getByRole("option", { name: /Blockquote/ }).getAttribute("aria-selected")).toBe(
      "true",
    );

    keyDown("Enter");
    expect(result).toBe(true);
    expect(command).toHaveBeenCalledWith(itemByTitle("Blockquote"));

    // A key this handle doesn't own is left for the plugin/editor to handle.
    keyDown("a");
    expect(result).toBe(false);
  });
});

function itemByTitle(title: string): SlashMenuItem {
  const item = SLASH_MENU_ITEMS.find((entry) => entry.title === title);
  if (!item) throw new Error(`no slash menu item named ${title}`);
  return item;
}
