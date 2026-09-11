import { createReactBlockSpec } from "@blocknote/react";
import { Link } from "@tanstack/react-router";
import { Link2 } from "lucide-react";

/**
 * The Thread Link block (#195): the one block that references mail,
 * mirroring how `compose/mail-quote-extension.tsx`'s `MailQuote` is a
 * custom snapshot-atom node in the compose editor — except this is
 * BlockNote, not TipTap, so the "atom, never editable in place" shape is
 * `content: "none"` rather than `atom: true`. There is nothing here for a
 * User to type into: a Thread Link's props (`packages/shared/src/notes.ts`'s
 * own doc comment) are the *whole* of what this block ever shows, so the
 * only way to change what it says is to delete it and insert a fresh one
 * from the slash menu (`note-slash-menu-items.tsx`) — never an in-place
 * edit.
 *
 * The snapshot is deliberately inert once the Thread it names is gone: this
 * block never re-reads mail to render itself, so nothing here ever looks up
 * `threadId` against the Local Cache. Clicking it only *navigates* — to
 * `/mail?thread=…`, the same deep link `router/routes.tsx#mailRoute`'s own
 * `MailSearch` already understands — a Thread that no longer exists there
 * just lands on an empty reading pane, the same as any other stale deep
 * link.
 */
export const createThreadLinkBlockSpec = () =>
  createReactBlockSpec(
    {
      type: "threadLink",
      propSchema: {
        threadId: { default: "" },
        subject: { default: "" },
        participants: { default: "" },
        date: { default: "" },
      },
      content: "none",
    },
    {
      render: ThreadLinkView,
    },
  )();

/** `props.date` is a Thread's own `lastMessageAt` (ISO) — malformed input (an opaque block written by something else) falls back to the raw string rather than showing "Invalid Date". */
function formatSnapshotDate(date: string): string {
  if (!date) return "";
  const parsed = new Date(date);
  return Number.isNaN(parsed.getTime()) ? date : parsed.toLocaleString();
}

/** The mail chip itself, exported for Tasks' own field-driven chip (#258, `tasks/TaskThreadLinkChip.tsx`) — the same rendering, over a Task's `threadLink` field rather than a block's props. */
export function ThreadLinkChip({
  subject,
  participants,
  date,
}: {
  subject: string;
  participants: string;
  date: string;
}) {
  const label = subject || "(no subject)";
  const formattedDate = formatSnapshotDate(date);
  return (
    <span className="thread-link-chip">
      <Link2 size={14} className="thread-link-icon" aria-hidden="true" />
      <span className="thread-link-text">
        <span className="thread-link-subject">{label}</span>
        {participants || formattedDate ? (
          <span className="thread-link-meta">
            {participants}
            {participants && formattedDate ? " · " : ""}
            {formattedDate}
          </span>
        ) : null}
      </span>
    </span>
  );
}

function ThreadLinkView({
  block,
  editor,
}: {
  block: { props: { threadId: string; subject: string; participants: string; date: string } };
  editor: { isEditable: boolean };
}) {
  const { threadId, subject, participants, date } = block.props;

  // The grid card's own read-only preview renders this same block
  // (`NoteCard.tsx`'s "through the same read-only editor") nested inside
  // that card's own `Link` to the Note itself — a second, nested navigation
  // target there would either be invalid HTML (an `<a>` inside an `<a>`) or
  // fight the outer Link for the click. `editor.isEditable` is what tells
  // the two contexts apart: the dialog (`NoteDialog.tsx`, always editable)
  // is where a Thread Link is actually clickable; the preview is inert.
  if (!editor.isEditable) {
    return (
      <span contentEditable={false}>
        <ThreadLinkChip subject={subject} participants={participants} date={date} />
      </span>
    );
  }

  return (
    <Link
      to="/mail"
      search={{ thread: threadId }}
      className="thread-link"
      aria-label={`Open "${subject || "(no subject)"}" in Mail`}
      contentEditable={false}
    >
      <ThreadLinkChip subject={subject} participants={participants} date={date} />
    </Link>
  );
}
