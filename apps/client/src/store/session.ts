import { labelId, labelNameFromId } from "@mail/shared";

/**
 * Who is signed in, as a fact the Local Cache layer can reach.
 *
 * Until #186 the Client never needed to know: every id it had to *predict*
 * was derived from a Mail Account, and a Mail Account is something it already
 * holds a row for. A Label is now User-scoped (ADR-0023), and its id is still
 * deterministic — that is what makes applying a brand-new Label a single
 * offline Optimistic Action (`packages/shared/src/labels.ts`) — so the
 * prediction now needs the signed-in User's id, in code paths that are not
 * React components and have no `useAuth` to reach for: `store/reads.ts`'s
 * `base ⊕ pending` overlay above all.
 *
 * `AuthProvider` is the only writer, mirroring its own `authenticated` state,
 * and `AuthGate` is what makes the invariant hold in practice: nothing that
 * reads mail is mounted before the session resolves. The two helpers below
 * still answer safely when it hasn't — a Label id simply cannot be predicted
 * yet, and a name falls back to the id verbatim — rather than throwing inside
 * a render.
 */

let currentUserId: string | null = null;

export function setSessionUserId(userId: string | null): void {
  currentUserId = userId;
}

export function sessionUserId(): string | null {
  return currentUserId;
}

/**
 * The `Label.id` a name resolves to for the signed-in User — the same id
 * `sync/mutations.ts` will derive server-side for the matching `applyLabel`.
 * `null` before the session is known, which every caller reads as "no
 * optimistic prediction to make this frame".
 */
export function labelIdForName(name: string): string | null {
  return currentUserId === null ? null : labelId(currentUserId, name);
}

/**
 * A Label's display name straight from its id, for a Label applied offline
 * that the `Label` collection has not carried back yet (`labelNameFromId`'s
 * own doc comment). Falls back to the id verbatim, which is also what an
 * unknown-session render gets.
 */
export function labelNameForId(id: string): string {
  return currentUserId === null ? id : labelNameFromId(currentUserId, id);
}
