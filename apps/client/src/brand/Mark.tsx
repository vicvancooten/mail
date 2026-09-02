/**
 * The Wicket postmark.
 *
 * A circular date stamp broken at the lower left — the wicket you pass
 * through single file — struck by killer bars, the cancellation that marks an
 * item as accepted and processed. It is the mechanism, not a picture of an
 * envelope.
 *
 * The ring is a dashed circle rather than an arc path so the gap's position is
 * a rotation and can never drift with its endpoints. Below roughly 20px the
 * third bar closes the gap up, so `Mark` drops to two bars at small sizes —
 * the same reduction the favicon ships.
 */

/**
 * Geometry, fixed once so every cut of the mark agrees.
 *
 * r=32 gives a circumference of 201.06, so a 40-unit gap is 71.6 degrees;
 * rotating by 171 puts that break at the lower left. The bars *trail* the
 * stamp rather than crossing into it — bars cut through the ring and the
 * whole mark reads as a currency glyph instead of a postmark.
 */
const RING = { cx: 44, cy: 64, r: 32, width: 8.5, dash: "161 40", rotate: 171 };
const BARS_3 = [47.75, 59.75, 71.75];
const BARS_2 = [51.75, 67.75];

export function Mark({
  size = 32,
  title,
  className,
}: {
  size?: number;
  /** Given: the mark is an image with this label. Omitted: it is decorative. */
  title?: string;
  className?: string;
}) {
  // Below ~26px the three bars close the ring's break up and the mark reads
  // as a struck disc; the small cut ships two, as the favicon does.
  const bars = size < 26 ? BARS_2 : BARS_3;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 128 128"
      className={className}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <circle
        cx={RING.cx}
        cy={RING.cy}
        r={RING.r}
        fill="none"
        stroke="currentColor"
        strokeWidth={RING.width}
        strokeDasharray={RING.dash}
        transform={`rotate(${RING.rotate} ${RING.cx} ${RING.cy})`}
      />
      {bars.map((y) => (
        <rect key={y} x="72" y={y} width="48" height="8.5" rx="1" fill="currentColor" />
      ))}
    </svg>
  );
}

/**
 * The wordmark: the postmark beside the name, set on the widest label stock
 * the type program has. Used on the login plate and the app's own header.
 */
export function Wordmark({ size = 26 }: { size?: number }) {
  return (
    <span className="wordmark">
      <Mark size={size} />
      <span className="wordmark-name">Wicket</span>
    </span>
  );
}
