import type { TaskThreadLink } from "@mail/shared";
import { Link } from "@tanstack/react-router";
import { ThreadLinkChip } from "../notes/thread-link-block.js";

/**
 * A Task's mail chip (#258): reads the Thread Link **field**
 * (`@mail/shared#taskSchema`'s own doc comment — "only the field drives
 * chips"), never the body, so it renders the same whether or not a Task's
 * document also happens to carry a Thread Link block. Reuses
 * `notes/thread-link-block.tsx#ThreadLinkChip` unchanged for the chip
 * itself — same rendering, same "inert once the Thread is gone" posture —
 * wrapped in the same `/mail?thread=…` navigation
 * `thread-link-block.tsx#ThreadLinkView`'s editable branch already gives the
 * block.
 */
export function TaskThreadLinkChip({ threadLink }: { threadLink: TaskThreadLink }) {
  return (
    <Link
      to="/mail"
      search={{ thread: threadLink.threadId }}
      className="thread-link task-thread-link-chip"
      aria-label={`Open "${threadLink.subject || "(no subject)"}" in Mail`}
    >
      <ThreadLinkChip
        subject={threadLink.subject}
        participants={threadLink.participants}
        date={threadLink.date}
      />
    </Link>
  );
}
