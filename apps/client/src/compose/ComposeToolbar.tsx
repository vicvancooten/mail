import { COMPOSE_HIGHLIGHT_COLORS, COMPOSE_TEXT_COLORS } from "@mail/shared";
import type { Editor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Code,
  Heading,
  Heading1,
  Heading3,
  Highlighter,
  Italic,
  Link,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  Palette,
  Quote,
  Strikethrough,
  Table,
  Underline,
} from "lucide-react";
import { useState } from "react";

/**
 * The composer's authoring surface (compose-spec §Editor): a fixed toolbar
 * for block-level structure plus the two swatch pickers, and a selection
 * bubble menu (Notion-style) for the inline marks that matter most while
 * text is already selected. Every command here targets exactly one node/mark
 * the schema in `editor-extensions.ts` registers — there is no button for
 * anything `docs/compose-spec.md`'s "Out" column names.
 */
export function ComposeToolbar({ editor }: { editor: Editor }) {
  return (
    <div className="compose-toolbar" role="toolbar" aria-label="Formatting">
      <ToolbarButton
        editor={editor}
        label="Heading 1"
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
        active={editor.isActive("heading", { level: 1 })}
      >
        <Heading1 size={16} />
      </ToolbarButton>
      <ToolbarButton
        editor={editor}
        label="Heading 2"
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        active={editor.isActive("heading", { level: 2 })}
      >
        <Heading size={16} />
      </ToolbarButton>
      <ToolbarButton
        editor={editor}
        label="Heading 3"
        onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
        active={editor.isActive("heading", { level: 3 })}
      >
        <Heading3 size={16} />
      </ToolbarButton>
      <Divider />
      <ToolbarButton
        editor={editor}
        label="Bulleted list"
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        active={editor.isActive("bulletList")}
      >
        <List size={16} />
      </ToolbarButton>
      <ToolbarButton
        editor={editor}
        label="Numbered list"
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        active={editor.isActive("orderedList")}
      >
        <ListOrdered size={16} />
      </ToolbarButton>
      <ToolbarButton
        editor={editor}
        label="Task list"
        onClick={() => editor.chain().focus().toggleTaskList().run()}
        active={editor.isActive("taskList")}
      >
        <ListChecks size={16} />
      </ToolbarButton>
      <ToolbarButton
        editor={editor}
        label="Quote"
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
        active={editor.isActive("blockquote")}
      >
        <Quote size={16} />
      </ToolbarButton>
      <ToolbarButton
        editor={editor}
        label="Code block"
        onClick={() => editor.chain().focus().toggleCodeBlock().run()}
        active={editor.isActive("codeBlock")}
      >
        <Code size={16} />
      </ToolbarButton>
      <ToolbarButton
        editor={editor}
        label="Divider"
        onClick={() => editor.chain().focus().setHorizontalRule().run()}
      >
        <Minus size={16} />
      </ToolbarButton>
      <ToolbarButton
        editor={editor}
        label="Table"
        onClick={() =>
          editor.chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run()
        }
      >
        <Table size={16} />
      </ToolbarButton>
      <Divider />
      <ToolbarButton
        editor={editor}
        label="Align left"
        onClick={() => editor.chain().focus().setTextAlign("left").run()}
        active={editor.isActive({ textAlign: "left" })}
      >
        <AlignLeft size={16} />
      </ToolbarButton>
      <ToolbarButton
        editor={editor}
        label="Align center"
        onClick={() => editor.chain().focus().setTextAlign("center").run()}
        active={editor.isActive({ textAlign: "center" })}
      >
        <AlignCenter size={16} />
      </ToolbarButton>
      <ToolbarButton
        editor={editor}
        label="Align right"
        onClick={() => editor.chain().focus().setTextAlign("right").run()}
        active={editor.isActive({ textAlign: "right" })}
      >
        <AlignRight size={16} />
      </ToolbarButton>
      <Divider />
      <ColorPicker editor={editor} />
      <HighlightPicker editor={editor} />
    </div>
  );
}

/** The Notion-style selection bubble menu: marks worth reaching without leaving the selection. */
export function ComposeBubbleMenu({ editor }: { editor: Editor }) {
  return (
    <BubbleMenu editor={editor} className="compose-bubble-menu">
      <ToolbarButton
        editor={editor}
        label="Bold"
        onClick={() => editor.chain().focus().toggleBold().run()}
        active={editor.isActive("bold")}
      >
        <Bold size={14} />
      </ToolbarButton>
      <ToolbarButton
        editor={editor}
        label="Italic"
        onClick={() => editor.chain().focus().toggleItalic().run()}
        active={editor.isActive("italic")}
      >
        <Italic size={14} />
      </ToolbarButton>
      <ToolbarButton
        editor={editor}
        label="Underline"
        onClick={() => editor.chain().focus().toggleUnderline().run()}
        active={editor.isActive("underline")}
      >
        <Underline size={14} />
      </ToolbarButton>
      <ToolbarButton
        editor={editor}
        label="Strikethrough"
        onClick={() => editor.chain().focus().toggleStrike().run()}
        active={editor.isActive("strike")}
      >
        <Strikethrough size={14} />
      </ToolbarButton>
      <ToolbarButton
        editor={editor}
        label="Insert link"
        onClick={() => insertLink(editor)}
        active={editor.isActive("link")}
      >
        <Link size={14} />
      </ToolbarButton>
    </BubbleMenu>
  );
}

/** `Cmd/Ctrl+K` and the bubble menu's link button share this exact prompt-and-set flow. */
export function insertLink(editor: Editor): void {
  const previous = editor.getAttributes("link").href as string | undefined;
  // A placeholder for a proper link dialog — functionally complete, polish deferred.
  const url = window.prompt("Link URL", previous ?? "https://");
  if (url === null) return;
  if (url.trim().length === 0) {
    editor.chain().focus().extendMarkRange("link").unsetLink().run();
    return;
  }
  editor.chain().focus().extendMarkRange("link").setLink({ href: url.trim() }).run();
}

function ToolbarButton({
  label,
  onClick,
  active,
  children,
}: {
  editor: Editor;
  label: string;
  onClick: () => void;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={`compose-toolbar-button${active ? " active" : ""}`}
      title={label}
      aria-label={label}
      aria-pressed={active}
      // A toolbar click must not steal focus/selection from the editor —
      // `onMouseDown`'s preventDefault is what keeps the selection intact
      // for a command like `toggleBold` to act on.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <span className="compose-toolbar-divider" aria-hidden="true" />;
}

function ColorPicker({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="compose-swatch-picker">
      <ToolbarButton editor={editor} label="Text colour" onClick={() => setOpen((o) => !o)}>
        <Palette size={16} />
      </ToolbarButton>
      {open && (
        <div className="compose-swatch-menu" role="menu">
          {COMPOSE_TEXT_COLORS.map((color) => (
            <button
              key={color.name}
              type="button"
              className="compose-swatch"
              style={{ backgroundColor: color.value }}
              aria-label={color.name}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                editor.chain().focus().setColor(color.value).run();
                setOpen(false);
              }}
            />
          ))}
          <button
            type="button"
            className="compose-swatch-clear"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              editor.chain().focus().unsetColor().run();
              setOpen(false);
            }}
          >
            Clear
          </button>
        </div>
      )}
    </div>
  );
}

function HighlightPicker({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="compose-swatch-picker">
      <ToolbarButton editor={editor} label="Highlight" onClick={() => setOpen((o) => !o)}>
        <Highlighter size={16} />
      </ToolbarButton>
      {open && (
        <div className="compose-swatch-menu" role="menu">
          {COMPOSE_HIGHLIGHT_COLORS.map((color) => (
            <button
              key={color.name}
              type="button"
              className="compose-swatch"
              style={{ backgroundColor: color.value }}
              aria-label={color.name}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                editor.chain().focus().toggleHighlight({ color: color.value }).run();
                setOpen(false);
              }}
            />
          ))}
          <button
            type="button"
            className="compose-swatch-clear"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              editor.chain().focus().unsetHighlight().run();
              setOpen(false);
            }}
          >
            Clear
          </button>
        </div>
      )}
    </div>
  );
}
