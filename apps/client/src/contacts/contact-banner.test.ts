import { describe, expect, it } from "vitest";
import { bannerStyleFor, contactBannerStyle, contactBannerSwatchStyle } from "./contact-banner.js";

/** The card's own fallback banner (#211) — deterministic, so a card never re-shuffles color between renders or across devices. */
describe("bannerStyleFor", () => {
  it("is deterministic for the same id", () => {
    expect(bannerStyleFor("contact-1")).toBe(bannerStyleFor("contact-1"));
  });

  it("differs across ids (in general)", () => {
    expect(bannerStyleFor("contact-1")).not.toBe(bannerStyleFor("contact-2"));
  });

  it("is a CSS linear-gradient", () => {
    expect(bannerStyleFor("contact-1")).toMatch(
      /^linear-gradient\(135deg, hsl\(.+\), hsl\(.+\)\)$/,
    );
  });
});

/** `contactBannerStyle` (#212): what the hero and the card actually render — a real `banner` once a User sets one, `bannerStyleFor`'s own deterministic gradient otherwise. */
describe("contactBannerStyle", () => {
  it("falls back to bannerStyleFor when banner is unset", () => {
    expect(contactBannerStyle({ id: "contact-1", banner: null })).toBe(bannerStyleFor("contact-1"));
  });

  it("renders a swatch banner as its design-token CSS variable", () => {
    expect(contactBannerStyle({ id: "contact-1", banner: { kind: "swatch", swatch: "b" } })).toBe(
      contactBannerSwatchStyle("b"),
    );
  });

  it("renders an image banner as a url(...) value, escaping the URL as a JSON string", () => {
    expect(
      contactBannerStyle({
        id: "contact-1",
        banner: { kind: "image", url: 'https://example.com/a"b.png' },
      }),
    ).toBe('url("https://example.com/a\\"b.png")');
  });
});
