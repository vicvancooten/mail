import {
  BlockNoteSchema,
  createHeadingBlockSpec,
  defaultBlockSpecs,
  defaultInlineContentSpecs,
  defaultStyleSpecs,
} from "@blocknote/core";
import { en } from "@blocknote/core/locales";
import { createThreadLinkBlockSpec } from "./thread-link-block.js";

/**
 * The Note editor's own BlockNote schema (#191, ADR-0024): exactly the "In"
 * column of the ticket's table, nothing else. Every block/style/inline-
 * content spec BlockNote ships that isn't listed here (image, file, audio,
 * video, toggleListItem, divider; the `code`/`textColor`/`backgroundColor`
 * marks; `mention`) is simply never registered — the slash menu and
 * formatting toolbar both derive their contents from this schema
 * (`getDefaultSlashMenuItems`, `BasicTextStyleButton`, `BlockTypeSelect`),
 * so an unregistered type is unreachable from either without this file
 * maintaining a second, separate exclusion list.
 *
 * `packages/shared/src/notes.ts` is the wire-side half of this same
 * restriction — see its own docstring for how the two divide the work.
 */
export const noteSchema = BlockNoteSchema.create({
  blockSpecs: {
    paragraph: defaultBlockSpecs.paragraph,
    // Headings h1-h3 only, never toggleable — see that ticket's own
    // "Out: Toggle blocks" row. `allowToggleHeadings: false` removes the
    // `isToggleable` prop from the heading's own propSchema entirely, which
    // is what `getDefaultSlashMenuItems` reads to decide whether to offer a
    // "Toggle Heading" slash item at all.
    heading: createHeadingBlockSpec({ levels: [1, 2, 3], allowToggleHeadings: false }),
    bulletListItem: defaultBlockSpecs.bulletListItem,
    numberedListItem: defaultBlockSpecs.numberedListItem,
    // BlockNote's own name for the Checklist rename (#191's own line): the
    // block type stays `checkListItem`, only its label changes — see
    // `noteDictionary` below.
    checkListItem: defaultBlockSpecs.checkListItem,
    // BlockNote's own block type name for a blockquote.
    quote: defaultBlockSpecs.quote,
    codeBlock: defaultBlockSpecs.codeBlock,
    // Merged cells (`colspan`/`rowspan`) are Out; this app never enables the
    // `tables.splitCells` editor option that merging (and un-merging)
    // requires, so a Note's tables can never grow one.
    table: defaultBlockSpecs.table,
    // Thread Link (#195): the one block that references mail
    // (`thread-link-block.tsx`'s own doc comment) — its props were declared
    // in `packages/shared/src/notes.ts` by #191, this is the slice that
    // renders and inserts it.
    threadLink: createThreadLinkBlockSpec(),
  },
  styleSpecs: {
    bold: defaultStyleSpecs.bold,
    italic: defaultStyleSpecs.italic,
    underline: defaultStyleSpecs.underline,
    strike: defaultStyleSpecs.strike,
  },
  inlineContentSpecs: {
    text: defaultInlineContentSpecs.text,
    link: defaultInlineContentSpecs.link,
  },
});

/**
 * BlockNote's own English dictionary, with the Checklist rename (#191's own
 * line) applied: "Check List" (BlockNote's default) becomes "Checklist"
 * everywhere a block's own dictionary entry is the label — the slash menu
 * item and the formatting toolbar's "Turn into" dropdown both read
 * `slash_menu.check_list.title` (`@blocknote/react`'s `BlockTypeSelect`
 * reuses the same slash-menu dictionary entries for its own item labels),
 * so one override reaches both.
 */
export const noteDictionary = {
  ...en,
  slash_menu: {
    ...en.slash_menu,
    check_list: {
      ...en.slash_menu.check_list,
      title: "Checklist",
    },
  },
};
