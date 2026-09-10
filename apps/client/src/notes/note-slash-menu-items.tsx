import type { BlockNoteEditor } from "@blocknote/core";
import { getDefaultSlashMenuItems } from "@blocknote/core/extensions";
import type { DefaultReactSuggestionItem } from "@blocknote/react";
import {
  Code,
  Heading1,
  Heading2,
  Heading3,
  Link2,
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
 *
 * Thread Link (#195) is the one entry BlockNote's own
 * `getDefaultSlashMenuItems` can never produce — it only knows its own
 * built-in block types, never a custom one this app registers
 * (`note-schema.ts`) — so it's appended by hand here instead of picked up
 * automatically. Unlike every other item, its `onItemClick` doesn't insert
 * anything itself: a Thread Link's props are a whole Thread's snapshot,
 * which nothing at slash-menu-click time knows yet, so this only opens the
 * picker (`ThreadLinkPickerDialog.tsx`, mounted once by `NoteEditor.tsx`)
 * that does the actual, deferred insert once a Thread is chosen.
 */
export function getNoteSlashMenuItems(
  editor: BlockNoteEditor<
    typeof noteSchema.blockSchema,
    typeof noteSchema.inlineContentSchema,
    typeof noteSchema.styleSchema
  >,
  onOpenThreadLinkPicker: () => void,
): DefaultReactSuggestionItem[] {
  // Explicitly `DefaultReactSuggestionItem[]`, not inferred from the `.map`
  // callback's own return type (`DefaultSuggestionItem & {icon}`, which
  // still carries BlockNote's own dictionary-keyed `key`) — the
  // hand-written Thread Link item below has no such `key` (there is no
  // dictionary entry for a custom block), and `DefaultReactSuggestionItem`
  // itself never requires one.
  const items: DefaultReactSuggestionItem[] = getDefaultSlashMenuItems(editor)
    .filter((item) => item.key !== "emoji")
    .map((item) => {
      const Icon = ICONS[item.key];
      return { ...item, icon: Icon ? <Icon size={18} /> : undefined };
    });

  items.push({
    title: "Thread Link",
    subtext: "Link a mail Thread",
    aliases: ["thread", "mail", "link"],
    icon: <Link2 size={18} />,
    onItemClick: onOpenThreadLinkPicker,
  });

  return items;
}
