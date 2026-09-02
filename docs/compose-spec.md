# Compose & sending spec

Resolves [#20](https://github.com/vicvancooten/mail/issues/20). Owns **composition**: the editor, how
its output becomes a message, reply/forward construction, signatures, the attachment interaction,
recipient autocomplete, and send-time behaviour.

It does **not** own storage — where Drafts and attachment bytes live is
[ADR-0012](./adr/0012-drafts-live-in-the-sync-backend-and-push-to-imap.md) — nor the send delay, which
is [ADR-0007](./adr/0007-undo-send-is-a-backend-held-pending-send.md). Hard-to-reverse decisions from
this spec are recorded as
[ADR-0013](./adr/0013-composition-document-model.md) (document model and serialisation) and
[ADR-0014](./adr/0014-compose-works-offline.md) (offline compose). Scope is bounded by
[`poc-scope.md`](./poc-scope.md): rich-text signatures and scheduled send are post-PoC.

## Editor

**TipTap v3** (ProseMirror), lazy-loaded so it never touches the <1s cold-start budget.
Notion-style authoring: slash menu, drag handles, markdown input rules, selection bubble menu. The
slash menu and input rules fire only at the start of an empty block, so they cannot collide with
prose.

The slash menu (`compose/slash-menu.tsx`) is a small, fixed set — Heading, Bulleted list, Numbered
list, Blockquote — filterable by typing, navigable with arrow keys, selected with Enter or a click,
dismissible with Esc; every command calls a command the toolbar already exposes, no new node types.
Drag handles are not built for the PoC — see Out of scope.

Schema (exhaustive — see ADR-0013 for why):

| In | Out |
| --- | --- |
| Headings h1–h3 | h4–h6 |
| Paragraphs, bold, italic, underline, strike | Font family / size pickers |
| Links | Mentions |
| `ul`, `ol`, task lists | Callouts, toggles, columns, embeds |
| Blockquote, `hr` | Merged table cells (`colspan`/`rowspan`) |
| Inline code, code blocks | Syntax-highlight classes |
| Images (inline or attachment) | Free hex colour picker |
| Tables with a header row | |
| Text align | |
| Colour + highlight from a fixed ~8-value palette | |

### Outgoing HTML

Produced by a dedicated **mail serialiser** walking the document — never the rendered DOM.
Inline styles only: no `<style>` block, no classes, no custom properties, no flex, no grid.

- Tables: real `<table>` with inline `border-collapse`, per-cell padding and border, `width:100%`.
- Images: `max-width:100%;height:auto`.
- Task lists: `☐` / `☑` text plus styled spans — never `<input type="checkbox">`, which is stripped
  nearly everywhere.
- Code blocks: inline-styled `<pre>`.
- The body wrapper carries an explicit `color` and `background-color` rather than inheriting, so a
  dark-mode recipient client cannot land us on dark-on-dark. (The mirror of what
  [research 0005](./research/0005-html-email-rendering-sanitization.md) found on the reading side.)

MIME shape is ADR-0012's: `multipart/mixed` [ `multipart/related` [ `multipart/alternative`
[ `text/plain`, `text/html` ], inline parts ], attachments ]. **Always** `multipart/alternative`, even
for an unformatted document.

### Plaintext alternative

Hybrid: the document model is walked directly for authored content; the opaque quote subtree goes
through `html-to-text`, whose output is then `> `-prefixed line by line at the right depth.

- Headings → a bare text line with a blank line after (no `#`).
- Lists → `- ` / `1. `; blockquote → `> `; code blocks verbatim, indented.
- Links → `text <url>`. Tables → pipe-delimited rows.
- **Emphasis is dropped**, not rendered as `*bold*`.
- Signature preceded by the RFC 3676 `-- ` sigdash.
- No hard wrapping, no `format=flowed`: one line per paragraph, `charset=utf-8`, reflowed by the
  receiving client. `format=flowed` is the real fix for the phone-vs-terminal dilemma and is a
  candidate later refinement.

## Reply, reply-all, forward

### Quoted original

One opaque `mailQuote` node holding the sanitized original HTML, collapsed behind a `···` expander,
not editable in place, emitted verbatim inside a `<blockquote>`. Deletable whole; an explicit one-way
**"edit quoted text"** converts it into schema nodes with a warning (the real use case is trimming a
long quote on a forward).

- Reply attribution: `On <date>, <Name> <addr> wrote:`
- Forward: the conventional `---------- Forwarded message ---------` block with From / Date / Subject
  / To, attachments carried (materialised backend-side per ADR-0012).

### Recipients

- **Reply**: `To` = the original's `Reply-To` if present, else `From`.
- **Reply-all**: that, plus the original `To` and `Cc`, minus the sending Mail Account's own address,
  deduplicated on normalized address while keeping the best display name seen.
- **Bcc** behind a toggle: kept in the Draft, kept in the `Sent` `APPEND` (so you can see who you
  Bcc'd), stripped from the transmitted headers, one envelope recipient per address.
- Pasting into a recipient field splits on comma / semicolon / newline and parses `Name <addr>`,
  chipping each.
- Address validation is **syntactic only** — no MX probe, no SMTP callout. The send is the
  verification and the bounce is the answer.

Known accepted gap: Mail Accounts have no concept of **aliases**, so mail addressed to an alias leaves
that alias in the reply-all set. Modelling aliases also touches Gatekeeper's sender normalization;
deferred (see Out of scope).

### Threading headers

- A reply points at **the specific message the User had open**, not blindly the newest in the Thread.
- `In-Reply-To` = that message's `Message-ID`. `References` = its `References` + its `Message-ID`.
- Truncate `References` against the 998-octet header limit by **keeping the first and the last ~20**,
  dropping the middle: the root is what threads you into the conversation, the tail is what threads
  you locally.
- **The Sync Backend mints the `Message-ID`** at submission and stores it on the Composition *before*
  handing anything to Nodemailer, so an ADR-0007 transient-failure retry can never produce two
  messages with two ids; the `Sent` `APPEND` carries the identical id.
- Subject prefixed `Re: ` / `Fwd: ` only when not already present — never stacked.

## Signature

One plain-text signature per Mail Account (rich-text signatures are post-PoC).

- **Inserted into the document when the composer opens**, as a distinct schema node, on new mail,
  replies and forwards alike — visible, editable, trimmable. Trimming a signature is the single most
  common thing anyone does to one; a backend-appended signature cannot be trimmed.
- Positioned **above** the quoted block (top-posting; no settings toggle at PoC).
- The distinct node is what lets a From-account switch swap the signature in place without heuristics.
- Serialised as plain paragraphs in HTML, and after the `-- ` sigdash in plaintext.

## Attachments

Bytes upload **immediately on drop/select**, so the size budget is enforced against reality and
"send" stays instant. The Composition row is created lazily on first content (keystroke or attach) —
one path shared by autosave and attach.

- Drop anywhere on the composer surface = attachment. **Paste an image into the body = inline**
  (Content-ID, `disposition: inline`), with a per-image toggle between the two.
- Per-attachment row with progress, retry-on-failure, remove.
- Budget bar appears past 50% of the instance limit (default 25MB **encoded**). Oversize is refused at
  *selection* time, showing the math — 25MB encoded ≈ 18MB of files — not a bare "too big".
- Forwarded attachments are fetched backend-side from IMAP and appear instantly as attached with no
  progress: they never traverse the Client.
- Offline, blob bytes live in the Local Cache and upload with the queue (ADR-0014).
- **Send is disabled while an upload is in flight** ("uploading 2 files") rather than letting a Pending
  Send block inside the ADR-0007 sweeper on a Client-side upload that may never finish.

## Recipient autocomplete

Backend is truth, with a synced slice for instant first-keystroke results.

- A **Correspondent** aggregate table in the Sync Backend, built incrementally at ingest and at send:
  normalized address, best-known display name, `sent_count`, `received_count`, `last_seen_at`, **scoped
  to a Mail Account** — the same scoping instinct as Gatekeeper verdicts, so work contacts do not leak
  into a personal From field.
- Ranking: sent-weight ≫ received-weight, with recency decay.
- The Client syncs the **top ~500 by score** as a normal synced collection, so the first keystroke is
  local and instant (the <50ms feedback bar), and queries the backend in parallel for the long tail.
  Full history cannot live in the Local Cache
  ([ADR-0009](./adr/0009-client-local-cache-is-a-disposable-indexeddb-cache.md)).
- CardDAV later becomes a **second source feeding the same ranked merge**, not a replacement.

## Composer surface & keys

One composer at a time: a docked overlay bottom-right that expands to full screen, with the Drafts
view as the way to switch between in-progress Compositions. Multiple live composers would multiply the
offline-autosave, version-conflict and `imap_draft_uid` surface to buy what the Drafts list already
covers, and would make triage keyboard focus ambiguous.

**Sending Mail Account**: replies and forwards always use the Mail Account that received the message.
New compose uses a User-scoped default-account preference (falling back to the only/first account),
with a picker in the composer header. Switching mid-compose is allowed — ADR-0012 already specifies
the IMAP-draft move, and blobs are keyed to the Composition — and swaps the signature and the
autocomplete scope with it. It does **not** rewrite an existing reply's threading headers.

| Key | Action |
| --- | --- |
| `c` | Compose |
| `r` / `a` / `f` | Reply / reply-all / forward |
| `Cmd/Ctrl+Enter` | Send |
| `Cmd/Ctrl+K` | Insert link |
| `Esc` | Close the composer, leaving a Draft |

`Esc` **never discards.** Discard is an explicit trash button, confirmed only when there is content.
While the composer is open it owns every key and the triage shortcuts are inert; closing restores them.

## Send-time validation & failure

- **Blocking**: no syntactically valid recipient; over budget.
- **Warn once, then send**: empty subject, empty body.
- **Permanent failure** (ADR-0007 returns the Composition to a Draft): badged **Send failed** with the
  SMTP rejection text **verbatim** — `550 5.7.1 relay denied` is actionable, "something went wrong" is
  not — plus the Web Push [#17](https://github.com/vicvancooten/mail/issues/17) already owes us, plus a
  persistent in-app banner until resolved. A mail you believe you sent and didn't is the
  highest-stakes silent failure in the product.

## Out of scope

Ruled out here, noted for the [follow-up map](https://github.com/vicvancooten/mail/issues/15):

- **Drag handles** — a per-block grip that reorders top-level blocks via drag-and-drop. Named
  alongside the slash menu under "Notion-style authoring", but a from-scratch drag-and-drop
  implementation (block-boundary decorations, drag state, a reorder transaction) is disproportionate
  to this fix batch next to the slash menu, which had `@tiptap/suggestion` already staged for it and
  is the more load-bearing of the two primitives. TODO: implement for the PoC follow-up, or drop from
  scope explicitly if the map doesn't need it.
- **Mail Account aliases** — reply-all leaves an alias in the recipient set; also touches Gatekeeper
  sender normalization.
- **"You wrote 'attached' but attached nothing"** — delightful, cheap, and not in the PoC cut.
- **`List-Post` / reply-to-list** — list-awareness arrives as one coherent piece with the deferred
  `List-Id` verdict work, not half of it now.
- **`format=flowed`** plaintext — a MIME-level concern Nodemailer will not do for us.
- Rich-text signatures, scheduled send, CardDAV contacts — already deferred by `poc-scope.md`.
