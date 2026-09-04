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

/**
 * The stroked cut, for the places the mark sits among stroke icons rather
 * than standing on its own: the App Switcher's hub mark, where a solid,
 * heavy postmark beside a row of 1.6px Lucide glyphs would read as a
 * different vocabulary. Same mechanism — broken ring, trailing killer bars
 * — drawn on the 24 grid every icon in the shell shares, so the weights
 * line up (`docs/design/prototypes/the-instrument.html`, `#i-postmark`).
 */
const STROKE_RING = { cx: 9, cy: 12, r: 6.5, dash: "32 9", rotate: 140 };
const STROKE_BARS = [
  { y: 9, x2: 22.5 },
  { y: 12, x2: 22.5 },
  { y: 15, x2: 20.5 },
];

export function Mark({
  size = 32,
  title,
  className,
  stroke = false,
}: {
  size?: number;
  /** Given: the mark is an image with this label. Omitted: it is decorative. */
  title?: string;
  className?: string;
  /** Draw the stroked cut instead of the solid one — see `STROKE_RING`. */
  stroke?: boolean;
}) {
  // Below ~26px the three bars close the ring's break up and the mark reads
  // as a struck disc; the small cut ships two, as the favicon does.
  const bars = size < 26 ? BARS_2 : BARS_3;

  if (stroke) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        className={className}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.7}
        strokeLinecap="round"
        role={title ? "img" : undefined}
        aria-label={title}
        aria-hidden={title ? undefined : true}
        focusable="false"
      >
        <circle
          cx={STROKE_RING.cx}
          cy={STROKE_RING.cy}
          r={STROKE_RING.r}
          strokeDasharray={STROKE_RING.dash}
          transform={`rotate(${STROKE_RING.rotate} ${STROKE_RING.cx} ${STROKE_RING.cy})`}
        />
        {STROKE_BARS.map((bar) => (
          <line key={bar.y} x1="16.5" y1={bar.y} x2={bar.x2} y2={bar.y} />
        ))}
      </svg>
    );
  }

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
