/**
 * A correspondent's mark.
 *
 * Drawn from the address, never fetched: remote images are blocked until a
 * sender is Approved (the Gatekeeper Verdict *is* the image-loading
 * permission), which makes a Gravatar- or BIMI-style avatar a contradiction
 * rather than a missing feature. "Sender avatars" on the follow-up map (#15)
 * is therefore closed by the identity rather than still open.
 *
 * In a list row this is the kraft plate slotted into the frame's stile: one
 * stock, one colour, initials only. Twenty-four saturated hue circles down a
 * list is noise in a surface whose whole job is being scanned, so the plate
 * is uniform and the eye is left free for the subject line. `ring` renders
 * the full circular date stamp instead — a broken ring rotated
 * deterministically off the address, so the same correspondent carries the
 * same mark forever — for the places with room for it.
 */

function stampRotation(seed: string): number {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 360;
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
  ring = false,
  unread = false,
}: {
  name: string;
  ring?: boolean;
  /** Unread inverts the plate: the item has not been cancelled yet. */
  unread?: boolean;
}) {
  if (ring) {
    return (
      <span className="mail-cds" aria-hidden="true">
        <svg viewBox="0 0 64 64" focusable="false" aria-hidden="true">
          <circle
            cx="32"
            cy="32"
            r="27"
            fill="none"
            stroke="currentColor"
            strokeWidth="3.5"
            strokeDasharray="140 30"
            transform={`rotate(${stampRotation(name)} 32 32)`}
          />
          <text x="32" y="38" textAnchor="middle" fill="currentColor" className="mail-cds-text">
            {initials(name)}
          </text>
        </svg>
      </span>
    );
  }

  return (
    <span className={`mail-avatar${unread ? " unread" : ""}`} aria-hidden="true">
      {initials(name)}
    </span>
  );
}
