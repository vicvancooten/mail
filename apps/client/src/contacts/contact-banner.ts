import type { CONTACT_BANNER_SWATCHES, Contact, ContactBanner } from "@mail/shared";

/**
 * The card's own fallback banner (#211's acceptance line: "An unset banner
 * falls back to a deterministic gradient off the Contact's id"). Still what
 * every card and the Person Page's own hero (#212) fall back to once a
 * Contact's real `banner` is `null` — see `contactBannerStyle` below, the
 * one place that picks between the two.
 *
 * Deterministic and client-only: two hues derived from a cheap string hash
 * of the id, so the same Contact always gets the same gradient — across a
 * remount, a re-sort, another device signed into the same account — without
 * persisting a single byte for it.
 */
export function bannerStyleFor(contactId: string): string {
  const hash = hashString(contactId);
  const hueA = hash % 360;
  const hueB = (hueA + 40 + (hash % 60)) % 360;
  return `linear-gradient(135deg, hsl(${hueA}, 65%, 55%), hsl(${hueB}, 70%, 45%))`;
}

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

/**
 * The Person Page's own "Change banner" set (#212, this ticket's own
 * acceptance line: "the fixed swatch set") — `@mail/design-tokens`' five
 * avatar-tile tints (`mail/Avatar.tsx`'s own `TILES`), reused here rather
 * than the picker growing a second palette. Labels are for the swatch
 * picker's own buttons; the CSS itself reads the same `--tile-*-bg` custom
 * property `Avatar.tsx`/`mail.css` already define.
 */
export const CONTACT_BANNER_SWATCH_LABELS: Record<
  (typeof CONTACT_BANNER_SWATCHES)[number],
  string
> = {
  a: "Violet",
  b: "Teal",
  c: "Amber",
  d: "Rose",
  e: "Slate",
};

export function contactBannerSwatchStyle(swatch: (typeof CONTACT_BANNER_SWATCHES)[number]): string {
  return `var(--tile-${swatch}-bg)`;
}

/**
 * What a Contact's own hero (`ContactDialog.tsx`) and its card
 * (`ContactCard.tsx`) actually render behind the avatar — a real `banner`
 * once a User sets one (#212), falling back to `bannerStyleFor`'s
 * deterministic gradient otherwise (#211's own posture, unchanged for a
 * Contact that has never had one set).
 */
export function contactBannerStyle(contact: Pick<Contact, "id" | "banner">): string {
  const banner = contact.banner;
  if (banner === null) return bannerStyleFor(contact.id);
  return contactBannerCssValue(banner);
}

function contactBannerCssValue(banner: ContactBanner): string {
  if (banner.kind === "swatch") return contactBannerSwatchStyle(banner.swatch);
  // `JSON.stringify` doubles as a CSS string-literal escaper here — both
  // quote and escape backslashes/quotes, which is all a `url(...)` value
  // needs and a raw image URL could otherwise break out of.
  return `url(${JSON.stringify(banner.url)})`;
}
