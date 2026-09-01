/**
 * Placeholder avatar: deterministic colour + initials derived from a name
 * or address, adopted from `prototype/triage-loop-ui`. A real avatar source
 * (BIMI / Gravatar / favicon) is still open on the map — see "Sender
 * avatars" in the follow-up map (#15) — so this stays a stand-in rather
 * than trying to anticipate that decision.
 */

function hue(seed: string): number {
  let h = 0;
  for (const char of seed) h = (h * 31 + char.charCodeAt(0)) >>> 0;
  return h % 360;
}

function initials(name: string): string {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "");
  return letters.join("") || "?";
}

export function Avatar({ name }: { name: string }) {
  return (
    <span className="mail-avatar" style={{ background: `hsl(${hue(name)} 55% 42%)` }}>
      {initials(name)}
    </span>
  );
}
