import type { InvitationCard } from "@mail/shared";
import { useEffect, useState } from "react";
import { fetchInvitationCards } from "../../api/invitations.js";

/**
 * The Reader's invite card(s) for an opened Thread (#240) — `useThreadMessages
 * .ts`'s own shape exactly (a per-tab in-memory cache, no Local Cache
 * involvement: an Invitation carries no delta protocol at PoC scope, same
 * posture a Message body has). `threadId === ""` is a deliberate no-op, the
 * same Rules-of-Hooks accommodation `useThreadMessages` documents.
 *
 * `InviteCard.tsx` holds its own local override for `myResponseStatus`
 * right after a successful Answer, rather than this hook re-fetching —
 * `POST /calendars/series/:seriesId/answer` already hands back everything
 * the card needs to update instantly (ADR-0025: "edits are optimistic",
 * and here there is no offline queue at all to be optimistic *about* — the
 * request already completed by the time the button's own handler returns).
 */
const cache = new Map<string, InvitationCard[]>();

export interface InvitationCardsState {
  cards: InvitationCard[] | null;
  loading: boolean;
  error: boolean;
}

export function useInvitationCards(threadId: string): InvitationCardsState {
  const [state, setState] = useState<InvitationCardsState>(() => {
    const cached = threadId ? cache.get(threadId) : undefined;
    return cached
      ? { cards: cached, loading: false, error: false }
      : { cards: null, loading: threadId !== "", error: false };
  });

  useEffect(() => {
    if (!threadId) {
      setState({ cards: null, loading: false, error: false });
      return;
    }
    const cached = cache.get(threadId);
    if (cached) {
      setState({ cards: cached, loading: false, error: false });
      return;
    }

    let cancelled = false;
    setState({ cards: null, loading: true, error: false });
    fetchInvitationCards(threadId)
      .then(({ cards }) => {
        if (cancelled) return;
        cache.set(threadId, cards);
        setState({ cards, loading: false, error: false });
      })
      .catch(() => {
        if (!cancelled) setState({ cards: null, loading: false, error: true });
      });

    return () => {
      cancelled = true;
    };
  }, [threadId]);

  return state;
}
