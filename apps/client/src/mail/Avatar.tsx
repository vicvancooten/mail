/**
 * A correspondent's mark.
 *
 * Drawn from the address, never fetched: remote images are blocked until a
 * sender is Approved (the Gatekeeper Verdict *is* the image-loading
 * permission), which makes a Gravatar- or BIMI-style avatar a contradiction
 * rather than a missing feature. "Sender avatars" on the follow-up map (#15)
 * is therefore closed by the identity rather than still open.
 *
 * The comp's treatment (#86, `.row-tile` in
 * `docs/design/prototypes/the-instrument.html`): a round tile of initials,
 * filled with one of five tinted fill/ink pairs
 * (`@mail/design-tokens`' avatar tiles) picked deterministically off the
 * name, so the same correspondent keeps the same tile forever. Five tints
 * rather than a hue per sender — a scanned list wants enough variety to
 * tell rows apart and not one saturated circle per row fighting the subject
 * line for the eye.
 *
 * Size and unread badge are the caller's business: every surface that shows
 * one of these sets its own diameter in CSS (`.mail-avatar` and the
 * per-tier overrides in `mail.css`), because a Thread row, a reading pane
 * and the header all want a different one.
 */

const TILES = ["a", "b", "c", "d", "e"] as const;

/** A stable hash of the seed — the same input picks the same tile in every session and on every device. */
function tileFor(seed: string): (typeof TILES)[number] {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return TILES[hash % TILES.length] ?? "a";
}

function initials(name: string): string {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "");
  return letters.join("") || "?";
}

export function Avatar({
  name,
  unread = false,
  className,
}: {
  name: string;
  /** Unread pins the accent dot to the tile's lower-right corner (the comp's `.unread-badge`). */
  unread?: boolean;
  className?: string;
}) {
  return (
    <span className={`mail-avatar-wrap${className ? ` ${className}` : ""}`} aria-hidden="true">
      <span className="mail-avatar" data-tile={tileFor(name)}>
        {initials(name)}
      </span>
      {unread ? <span className="mail-avatar-unread" /> : null}
    </span>
  );
}
