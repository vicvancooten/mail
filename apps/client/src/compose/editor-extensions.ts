import type { AnyExtension } from "@tiptap/core";
import { Color } from "@tiptap/extension-color";
import { Highlight } from "@tiptap/extension-highlight";
import { Image } from "@tiptap/extension-image";
import { Placeholder } from "@tiptap/extension-placeholder";
import { TableKit } from "@tiptap/extension-table";
import { TaskItem } from "@tiptap/extension-task-item";
import { TaskList } from "@tiptap/extension-task-list";
import { TextAlign } from "@tiptap/extension-text-align";
import { TextStyle } from "@tiptap/extension-text-style";
import { StarterKit } from "@tiptap/starter-kit";

/**
 * The composer's schema (ADR-0013): a deliberately narrow, mail-safe subset
 * — the exhaustive list `docs/compose-spec.md`'s table names, no more. Every
 * node/mark this array admits must have a case in
 * `apps/sync-backend/src/compose/mail-serializer.ts`; that file's own
 * "unsupported constructs normalise" fallback is what makes an accidental
 * mismatch degrade instead of crash a push, but nothing here should rely on
 * it on purpose.
 *
 * Deliberately **not** registered, matching the spec's "Out" column:
 * heading levels 4–6, font family/size, mentions, callouts/toggles/columns/
 * embeds, merged table cells (no UI ever calls `mergeCells`/`splitCell`,
 * so the capability sits unused rather than being extended away), syntax
 * highlighting, a free hex colour picker.
 */
export function composeEditorExtensions(placeholder: string): AnyExtension[] {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      link: {
        openOnClick: false,
        autolink: true,
        HTMLAttributes: { rel: "noopener noreferrer" },
      },
    }),
    TextStyle,
    Color,
    Highlight.configure({ multicolor: true }),
    TextAlign.configure({ types: ["paragraph", "heading"] }),
    TaskList,
    TaskItem.configure({ nested: false }),
    TableKit.configure({ table: { resizable: false } }),
    Image,
    Placeholder.configure({ placeholder }),
  ];
}
