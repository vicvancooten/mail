# A Composition is a structured document, not HTML

The body of a [Composition](../../CONTEXT.md) is stored as the editor's own structured document
(TipTap/ProseMirror JSON) and is the authoritative representation; mail HTML and the plaintext
alternative are **derived** from it at each IMAP push and at submission. The editor's schema is a
deliberately narrow, mail-safe subset, and a **dedicated mail serialiser** — not the DOM the editor
rendered — produces the outgoing HTML. This makes ADR-0007's "structured composition, not pre-built
MIME" concrete.

## Considered Options

- **Store the outgoing HTML as the body**: rejected. Resuming a Draft would then require an
  HTML→document import on every open, so a message with tables and colours degrades a little each
  time it is reopened. The lossy transform belongs at the boundary (once, on the way out), not on the
  round trip.
- **Lexical instead of TipTap/ProseMirror**: rejected. Lighter, but HTML import/export is its weaker
  half, and importing sender HTML for reply quoting is exactly HTML import. ProseMirror's schema is
  the load-bearing part: markup that violates it cannot exist in the document, so the outgoing HTML
  needs no sanitizing pass of its own.
- **Raw ProseMirror**: same engine, weeks more glue, no additional capability.
- **Serialising the editor's rendered DOM**: rejected outright. The on-screen rendering is
  class-based (Tailwind); a recipient gets no `<style>` block, no classes, no custom properties, no
  flex and no grid. Two serialisers over one document is the only shape that lets the composer look
  modern and the mail render in Outlook.
- **Importing the quoted original into the schema**: rejected in favour of an opaque
  pass-through node. Reflowing a sender's own markup is visible to them, and down a long thread the
  quote of *our own* previous message would degrade on every reply.

## Consequences

- **Schema is a fixed, mail-safe list**: headings h1–h3, paragraphs, bold/italic/underline/strike,
  links, `ul`/`ol`, task lists, blockquote, inline code and code blocks, `hr`, images, text align, and
  tables with a header row and **no merged cells**. Colour and highlight come from a fixed ~8-value
  palette rather than a free hex picker, so every value can be vetted once for legibility against a
  recipient client that inverts for dark mode.
- **Notion-*style* is an authoring decision, not a capability one.** Slash menu, drag handles,
  markdown input rules and a selection bubble menu are in; callouts, toggles, columns, embeds and
  mentions are out, because none of them degrade gracefully in mail — a toggle that arrives
  permanently collapsed is worse than not offering one.
- **The quoted original is one opaque node** holding the already-sanitized original HTML
  (`docs/research/0005-html-email-rendering-sanitization.md`), non-editable, collapsed by default, and
  emitted verbatim inside a `<blockquote>` under an attribution line. It can be deleted whole, and an
  explicit one-way "edit quoted text" converts it into schema nodes — so lossiness is available but
  never the default.
- **The document schema is now a migration concern.** A `schema_version` rides on the Composition and
  the document upgrade path is forward-only, the same posture as the DB migrations in
  [ADR-0009](./0009-deployment-is-a-single-image-two-service-compose.md).
- **Every message is `multipart/alternative`**, even an entirely unformatted one. A "plain document →
  `text/plain` only" branch is a second send path exercised rarely and therefore breaking quietly —
  the same reasoning that made Undo Send's `off` mean `N = 0` rather than a bypass in
  [ADR-0007](./0007-undo-send-is-a-backend-held-pending-send.md).
- **Plaintext is a hybrid serialisation**: the document model is walked directly for authored content,
  and the opaque quote subtree goes through `html-to-text` with `> ` prefixing applied to its output.
  Emphasis is dropped rather than rendered as faux-markdown. No hard wrapping and no `format=flowed`:
  one line per paragraph, reflowed by the receiving client, because wrapping at 78 columns is what
  makes plaintext mail look broken on a phone.
