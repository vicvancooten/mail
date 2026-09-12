import { contactDisplayName } from "@mail/shared";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "../components/ui/button.js";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "../components/ui/hover-card.js";
import { useHoverCapable } from "../hooks/use-hover-capable.js";
import { Avatar } from "../mail/Avatar.js";
import { formatRowTime } from "../mail/time-groups.js";
import { useRecentThreadsForSender } from "../store/index.js";
import { useContactByAddress } from "./contact-by-address.js";
import { contactPhotoSrc } from "./contact-photo.js";
import { PromoteCorrespondentDialog } from "./PromoteCorrespondentDialog.js";

/**
 * The Reader's Contact Card (#293): hovering (a short Radix delay) or
 * tapping the sender's avatar shows who Contacts knows them as, the last
 * few Threads exchanged with them, and either "Open in Contacts" for a
 * known sender or "Add to Contacts" for a stranger — everything read
 * Local-Cache-only (`useContactByAddress`, `useRecentThreadsForSender`), no
 * server round trip, so the card opens as fast as the Reader itself did.
 *
 * A shadcn `HoverCard` (`components/ui/hover-card.tsx`, new with this
 * ticket — the shared-primitive rule, `DESIGN.md`'s "Transient surfaces"
 * section, #281): outside-click, Escape and "one at a time" all come from
 * Radix, not a hand-rolled listener. On a device whose pointer can't hover
 * (`useHoverCapable`, #134/#143's own capability gate — a pointer/hover
 * *capability* read, not a viewport-width one, so a touch-capable desktop
 * window still gets tap-to-open rather than hover) this component holds its
 * own `open` boolean and hands it to the primitive as `open`/`onOpenChange`,
 * the exact shape `DESIGN.md` carves out for `AccountScope.tsx`'s own
 * toggle: the primitive still owns dismissal, this component only owns
 * *when it opens*.
 *
 * The trigger is a plain `button` around `Avatar` (`AccountScope.tsx`'s own
 * shape) rather than handing `Avatar` itself to `HoverCardTrigger asChild`:
 * `Avatar` doesn't forward a ref or arbitrary props, which Radix's `asChild`
 * clone needs somewhere to land the pointer/focus listeners that open the
 * card in the first place. Wrapping it in a real, focusable `button` also
 * gives tap and keyboard focus a target for free.
 *
 * Also resolves the trigger `Avatar`'s own `photoUrl` once a Contact
 * matches — the one thing every existing `Avatar` caller left unset
 * (`Avatar.tsx`'s own doc comment already anticipated this).
 */
export function SenderContactCard({
  name,
  address,
  threadId,
  avatarClassName,
}: {
  /** The sender's display name off the Thread/Message header, or `null` for a bare address. */
  name: string | null;
  address: string;
  /** The Thread this Card is opened from — left out of its own "recent Threads" list. */
  threadId: string;
  avatarClassName?: string;
}) {
  const hoverCapable = useHoverCapable();
  const [tapOpen, setTapOpen] = useState(false);
  const [addingContact, setAddingContact] = useState(false);

  const contact = useContactByAddress(address);
  const recentThreads = useRecentThreadsForSender(address, { excludeThreadId: threadId });

  // Uncontrolled (Radix's own hover/focus open) where hover exists;
  // controlled by this component's own tap toggle where it doesn't — see
  // this file's own doc comment on why that split still leaves Radix as the
  // one thing that ever calls `onOpenChange`.
  const controlledProps = hoverCapable ? {} : { open: tapOpen, onOpenChange: setTapOpen };

  const triggerName = contact ? contactDisplayName(contact) : (name ?? address);
  const triggerPhoto = contact ? contactPhotoSrc(contact) : null;

  return (
    <>
      <HoverCard {...controlledProps}>
        <HoverCardTrigger
          asChild
          onClick={hoverCapable ? undefined : () => setTapOpen((open) => !open)}
        >
          <button
            type="button"
            className="sender-contact-card-trigger"
            aria-label={`Contact card for ${triggerName}`}
          >
            <Avatar name={triggerName} photoUrl={triggerPhoto} className={avatarClassName} />
          </button>
        </HoverCardTrigger>
        <HoverCardContent className="sender-contact-card">
          <div className="sender-contact-card-identity">
            <Avatar name={triggerName} photoUrl={triggerPhoto} />
            <span className="sender-contact-card-names">
              <span className="sender-contact-card-name">{triggerName}</span>
              <span className="sender-contact-card-address">{address}</span>
            </span>
          </div>

          {recentThreads === undefined ? null : recentThreads.length > 0 ? (
            <ul className="sender-contact-card-threads">
              {recentThreads.map((thread) => (
                <li key={thread.id} className="sender-contact-card-thread">
                  <span className="sender-contact-card-thread-subject">
                    {thread.subject || "(no subject)"}
                  </span>
                  <span className="sender-contact-card-thread-time">
                    {formatRowTime(thread.lastMessageAt)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="sender-contact-card-empty">No other recent Threads with this address.</p>
          )}

          {contact ? (
            <Button asChild size="sm" variant="outline">
              <Link to="/contacts/$contactId" params={{ contactId: contact.id }}>
                Open in Contacts
              </Link>
            </Button>
          ) : (
            <Button type="button" size="sm" onClick={() => setAddingContact(true)}>
              Add to Contacts
            </Button>
          )}
        </HoverCardContent>
      </HoverCard>
      {addingContact ? (
        <PromoteCorrespondentDialog
          person={{ address, name }}
          onClose={() => setAddingContact(false)}
        />
      ) : null}
    </>
  );
}
