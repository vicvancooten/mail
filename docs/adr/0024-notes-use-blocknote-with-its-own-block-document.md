# Notes use BlockNote and its own block document; compose keeps TipTap

The Notes App wants a Notion-like editing experience: a side menu with a drag handle, nested blocks,
toggles, checklists, a slash menu. Compose already has a TipTap editor and a ProseMirror-JSON
document model ([ADR-0013](0013-composition-document-model.md)). We decided that **Notes use
BlockNote**, that a Note's body is **BlockNote's block document** (blocks with id, type, props,
inline content and children) validated by a deliberately loose shared schema in the manner of the
compose one, and that **compose is untouched**. Two editors share one ProseMirror, since BlockNote
is TipTap v3 underneath at a range the repo's TipTap already satisfies. Decided in the #166 grilling,
2026-09-07.

## Considered Options

- **TipTap with Notion-like extensions added by hand**: rejected. The chrome BlockNote ships (side
  menu, drag handle, nesting, toggles, suggestion menus) is months of glue to rebuild, and the User
  has a concrete preference from experience.
- **BlockNote for Notes with a conversion layer to ProseMirror JSON** so both editors share the
  compose document schema: rejected. Notes never become email, so a shared schema buys nothing and
  costs a lossy conversion on every save.
- **BlockNote for compose too, now**: ruled out of scope for the Hub Apps map. Its HTML export needs
  a DOM (jsdom on the server, or a new walker over block JSON replacing the mail serialiser), its
  lossy export flattens nesting into data attributes rather than email-friendly markup, toggle
  headings and heading levels 4 to 6 have no email form, and the signature and quote nodes would be
  re-modelled as custom blocks. Notes on BlockNote first is the honest way to learn whether it fits
  this codebase before ADR-0013 is reopened.

## Consequences

- **Thread Link is a custom BlockNote block**, insertable from the slash menu, the way MailQuote is a
  custom TipTap node in compose. It is the one block that references mail.
- **Notes ship text-only.** Image, file, audio and video blocks are off until "Attachments on Notes"
  is decided; code blocks and tables are on.
- **The UI kit is chosen in the spec** by whichever themes closest to The Instrument. The shadcn kit
  is built on Base UI rather than the repo's Radix and pins older lucide and tailwind-merge ranges,
  so Mantine, Ariakit or a themed core are the realistic candidates.
- **Card previews on the Notes grid render blocks read-only** through the same editor in
  non-editable mode, so a checklist previews as a checklist and no second renderer exists.
- **Collaboration stays optional.** BlockNote's Yjs integration is peer-only and is the route if
  multiplayer ever arrives; until then the last-write-wins save channel of
  [ADR-0023](0023-app-data-rides-the-sync-protocol-under-sync-scopes.md) is enough.
- **Two editor libraries in one Client is an accepted interim cost**, roughly 180 kB gzipped for
  BlockNote core beyond TipTap. If Notes proves BlockNote, swapping compose is a fresh effort with its
  own ADR, not a resumption of this one.
