import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import type { ScreenerSenderGroup } from "../../store/index.js";
import { Avatar } from "../Avatar.js";
import { MessageBody } from "../reading/MessageBody.js";
import { useThreadMessages } from "../reading/useThreadMessages.js";
import { ScreenerActions } from "./ScreenerActions.js";

/**
 * The Screener's View dialog (#102, grill Q16/Q17/Q28/Q29): "opens a Dialog:
 * the decision actions on top, then a stack ... of that sender's held
 * Threads rendered through the existing sandboxed reader (`MessageBody`),
 * remote images blocked, links inert (no bridge in this context), dates and
 * subjects visible." A real shadcn `Dialog`, not a hand-rolled overlay
 * (grill's standing "full shadcn for every floating primitive" decision).
 *
 * `interactive={false}` on every `MessageBody` (its own doc comment, #102)
 * is what makes "remote images blocked" and "links inert" true without a
 * second sandbox config to keep in sync — the reader's ordinary "Load remote
 * images" opt-in simply never renders here, and the click bridge is never
 * wired, so a link does nothing rather than opening. There is no per-message
 * override to seed either: an Unscreened Sender has no Verdict yet, so
 * `remoteImagesAllowed` is already `false` server-side, and this dialog
 * never offers a way around that ahead of a decision.
 *
 * Acting closes the dialog and steps to the next Unscreened Sender — for
 * free, not as extra code: `group` is looked up live against the Screener's
 * own `groups` (`Screener.tsx`), and a decision's `enqueueMutation` drops
 * the sender out of that list on the very same tick (`store/reads.ts`'s
 * overlay), so `group` becomes `null` and the dialog closes the instant any
 * of the actions above fire — exactly the row's own "decided" disappearance,
 * just from inside the dialog instead of from the list.
 */
export function ScreenerViewDialog({
  group,
  onClose,
  onApprove,
  onDeny,
  onBlock,
  onBlockDomain,
  onSpam,
  onBlockAlias,
}: {
  /** `null` closes the dialog — also what a decision made from inside it resolves to, see the doc comment above. */
  group: ScreenerSenderGroup | null;
  onClose: () => void;
  onApprove: () => void;
  onDeny: () => void;
  onBlock: () => void;
  onBlockDomain: () => void;
  onSpam: () => void;
  onBlockAlias: () => void;
}) {
  const displayName = group ? (group.name ?? group.address) : "";

  return (
    <Dialog open={group !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="screener-view-dialog sm:max-w-2xl">
        {group ? (
          <>
            <DialogHeader>
              <div className="screener-view-identity">
                <Avatar name={displayName} />
                <div className="screener-view-sender">
                  <DialogTitle>{displayName}</DialogTitle>
                  {group.name ? (
                    <span className="screener-view-address">{group.address}</span>
                  ) : null}
                </div>
              </div>
              <ScreenerActions
                group={group}
                onApprove={onApprove}
                onDeny={onDeny}
                onBlock={onBlock}
                onBlockDomain={onBlockDomain}
                onSpam={onSpam}
                onBlockAlias={onBlockAlias}
              />
            </DialogHeader>
            <div className="screener-view-threads">
              {group.threadIds.map((threadId) => (
                <HeldThreadReading key={threadId} threadId={threadId} />
              ))}
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** One held Thread's own share of the stack: every Message it holds, oldest first, each read-only (see the module doc comment above). */
function HeldThreadReading({ threadId }: { threadId: string }) {
  const { messages, loading, error } = useThreadMessages(threadId);

  if (error) return <p className="screener-view-thread-error">Couldn't load this message.</p>;
  if (!messages) {
    return loading ? <p className="screener-view-thread-loading">Loading…</p> : null;
  }

  return (
    <section className="screener-view-thread">
      {messages.map((message) => (
        <article className="screener-view-message" key={message.id}>
          <header className="screener-view-message-header">
            <span className="screener-view-message-subject">
              {message.subject || "(no subject)"}
            </span>
            <time className="screener-view-message-date" dateTime={message.sentAt}>
              {new Date(message.sentAt).toLocaleString()}
            </time>
          </header>
          <MessageBody message={message} interactive={false} />
        </article>
      ))}
    </section>
  );
}
