import type { BlockNoteEditor } from "@blocknote/core";
import { getDefaultSlashMenuItems } from "@blocknote/core/extensions";
import type { DefaultReactSuggestionItem } from "@blocknote/react";
import {
  Code,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListChecks,
  ListOrdered,
  Quote,
  Table,
  Type,
} from "lucide-react";
import type { ComponentType } from "react";
import type { noteSchema } from "./note-schema.js";

/**
 * One icon per slash-menu key this app's restricted schema can still
 * produce (`note-schema.ts`'s own doc comment) — every Lucide glyph, matching
 * the rest of the app's icon language (#86), rather than `@blocknote/react`'s
 * own `getDefaultReactSlashMenuItems`, which draws from `react-icons`.
 * `emoji` has no entry: it's filtered out below before an icon is ever
 * looked up.
 */
const ICONS: Record<string, ComponentType<{ size?: number }>> = {
  paragraph: Type,
  heading: Heading1,
  heading_2: Heading2,
  heading_3: Heading3,
  bullet_list: List,
  numbered_list: ListOrdered,
  check_list: ListChecks,
  quote: Quote,
  code_block: Code,
  table: Table,
};

/**
 * The Note editor's slash menu items: `getDefaultSlashMenuItems` already
 * derives its list from `editor.schema.blockSchema` (each entry guarded by
 * `editorHasBlockWithType`), so restricting `note-schema.ts`'s `blockSpecs`
 * is what keeps heading levels 4-6, Toggle Heading/List and every media
 * block off this list without a second, hand-maintained exclusion here —
 * the one item that isn't schema-conditional is `emoji` (it opens a `:`
 * suggestion menu unrelated to any block type), which this app doesn't wire
 * up at all, so it's dropped explicitly.
 */
export function getNoteSlashMenuItems(
  editor: BlockNoteEditor<
    typeof noteSchema.blockSchema,
    typeof noteSchema.inlineContentSchema,
    typeof noteSchema.styleSchema
  >,
): DefaultReactSuggestionItem[] {
  return getDefaultSlashMenuItems(editor)
    .filter((item) => item.key !== "emoji")
    .map((item) => {
      const Icon = ICONS[item.key];
      return { ...item, icon: Icon ? <Icon size={18} /> : undefined };
    });
}
