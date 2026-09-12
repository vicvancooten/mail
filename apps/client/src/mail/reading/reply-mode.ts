import type { CachedThread } from "../../store/index.js";

/** Matches `compose/reply.ts`'s own `normalizedAddress` — trim and lowercase, so a self-address comparison is case- and whitespace-insensitive the same way reply-all's own recipient filtering already is. */
function normalizedAddress(address: string): string {
  return address.trim().toLowerCase();
}

/**
 * How many of `thread.participants` are not the Mail Account that owns this
 * Thread (#289) — what the Reader's reply group uses to decide its primary
 * button. `selfAddress` is `null` for a Thread whose owning Mail Account
 * hasn't resolved yet (a fresh sync, an account mid-removal); every
 * participant counts as "other" then, the same fallback `chooseReplyMode`
 * below inherits.
 */
export function otherParticipantCount(
  thread: Pick<CachedThread, "participants">,
  selfAddress: string | null,
): number {
  if (!selfAddress) return thread.participants.length;
  const self = normalizedAddress(selfAddress);
  return thread.participants.filter(
    (participant) => normalizedAddress(participant.address) !== self,
  ).length;
}

/**
 * The Reply group's primary (#289's own acceptance line): Reply All when
 * more than one other participant is on the Thread, else Reply. Whichever
 * this picks, the other reply form joins Forward in the Reply group's
 * overflow (`registry.ts#replyOverflowActions`) rather than disappearing.
 */
export function chooseReplyMode(
  thread: Pick<CachedThread, "participants">,
  selfAddress: string | null,
): "reply" | "replyAll" {
  return otherParticipantCount(thread, selfAddress) > 1 ? "replyAll" : "reply";
}
