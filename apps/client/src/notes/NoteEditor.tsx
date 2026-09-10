import type { PartialBlock } from "@blocknote/core";
import { filterSuggestionItems, insertOrUpdateBlockForSlashMenu } from "@blocknote/core/extensions";
// BlockNote's own structural CSS (block layout, nesting, code/table
// rendering) — the part of its chrome this app doesn't hand-write itself.
// Loaded ahead of `note-editor.css`, which retargets the `--bn-*` custom
// properties both of these read.
import "@blocknote/core/style.css";
import "@blocknote/react/style.css";
import {
  BlockNoteViewRaw,
  ComponentsContext,
  DragHandleMenu,
  FormattingToolbarController,
  LinkToolbarController,
  RemoveBlockItem,
  SideMenu,
  SideMenuController,
  SuggestionMenuController,
  useCreateBlockNote,
  useDictionary,
} from "@blocknote/react";
import type { NoteDocument } from "@mail/shared";
import { Tooltip } from "radix-ui";
import { useMemo, useState } from "react";
import type { CachedThread } from "../store/index.js";
import { noteComponents } from "./note-components.js";
import "./note-editor.css";
import { noteDictionary, noteSchema } from "./note-schema.js";
import { getNoteSlashMenuItems } from "./note-slash-menu-items.js";
import { ThreadLinkPickerDialog } from "./ThreadLinkPickerDialog.js";

/**
 * The one place a Note's block document is opened or closed — never a
 * second, read-only renderer (#191's own acceptance line). `editable`
 * toggles `BlockNoteViewRaw`'s own prop, which is what every default
 * button/controller (`BasicTextStyleButton`, `SideMenuController`, …)
 * already reads to hide itself; a read-only Note therefore shows its
 * content, a Checklist's own tick included, with no chrome floating over
 * it and no way to change it.
 */
export interface NoteEditorProps {
  document: NoteDocument;
  editable?: boolean;
  onChange?: (document: NoteDocument) => void;
  className?: string;
}

/** A Note's block menu (the drag handle's own click target): just Delete — no per-block Colors (this app's schema never registers a color style; see `note-editor.css`'s own doc comment) and no table-header toggles, which only ever apply to a Table's first row/column and aren't part of this ticket's scope. */
function NoteDragHandleMenu() {
  const dict = useDictionary();
  return (
    <DragHandleMenu>
      <RemoveBlockItem>{dict.drag_handle.delete_menuitem}</RemoveBlockItem>
    </DragHandleMenu>
  );
}

function NoteSideMenu() {
  return <SideMenu dragHandleMenu={NoteDragHandleMenu} />;
}

export function NoteEditor({ document, editable = true, onChange, className }: NoteEditorProps) {
  const editor = useCreateBlockNote({
    schema: noteSchema,
    dictionary: noteDictionary,
    initialContent: document as PartialBlock<
      typeof noteSchema.blockSchema,
      typeof noteSchema.inlineContentSchema,
      typeof noteSchema.styleSchema
    >[],
  });

  // The Thread Link slash item's own picker (#195, `ThreadLinkPickerDialog.tsx`'s
  // own doc comment) — gated on `editable` the same way the picker itself
  // is: a read-only preview (`NoteCard.tsx`'s grid) never opens a slash
  // menu in the first place (typing is disabled), so mounting one live-query
  // subscription per card on the grid would be pure waste.
  const [threadLinkPickerOpen, setThreadLinkPickerOpen] = useState(false);

  const getSlashMenuItems = useMemo(
    () => async (query: string) =>
      filterSuggestionItems(
        getNoteSlashMenuItems(editor, () => setThreadLinkPickerOpen(true)),
        query,
      ),
    [editor],
  );

  const pickThreadLink = (thread: CachedThread) => {
    insertOrUpdateBlockForSlashMenu(editor, {
      type: "threadLink",
      props: {
        threadId: thread.id,
        subject: thread.subject,
        participants:
          thread.participants.map((p) => p.name ?? p.address).join(", ") || "(no sender)",
        date: thread.lastMessageAt ?? new Date().toISOString(),
      },
    });
    setThreadLinkPickerOpen(false);
  };

  return (
    <Tooltip.Provider delayDuration={300}>
      <ComponentsContext.Provider value={noteComponents}>
        <BlockNoteViewRaw
          editor={editor}
          editable={editable}
          className={[className, !editable && "note-editor-readonly"].filter(Boolean).join(" ")}
          onChange={() => onChange?.(editor.document as unknown as NoteDocument)}
        >
          <FormattingToolbarController />
          <LinkToolbarController />
          <SideMenuController sideMenu={NoteSideMenu} />
          <SuggestionMenuController triggerCharacter="/" getItems={getSlashMenuItems} />
        </BlockNoteViewRaw>
        {editable ? (
          <ThreadLinkPickerDialog
            open={threadLinkPickerOpen}
            onOpenChange={setThreadLinkPickerOpen}
            onPick={pickThreadLink}
          />
        ) : null}
      </ComponentsContext.Provider>
    </Tooltip.Provider>
  );
}
